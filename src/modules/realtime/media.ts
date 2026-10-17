import { networkInterfaces } from 'node:os';
import type { Server, Socket } from 'socket.io';
import * as mediasoup from 'mediasoup';
import type { Consumer, Producer, Router, WebRtcTransport, Worker } from 'mediasoup/types';
import { env } from '../../config/env.js';
import { canJoinCallMedia } from './calls.js';

type MediaKey = { kind: 'call' | 'room'; id: string; position?: { x: number; z: number } };
type Peer = { socket: Socket; userId: string; transports: Map<string, WebRtcTransport>; producers: Map<string, Producer>; consumers: Map<string, Consumer>; position: { x: number; z: number } };
type Session = { key: string; router: Router; peers: Map<string, Peer> };
type Ack<T> = (result: { ok: true; value: T } | { ok: false; error: string }) => void;
const sessions = new Map<string, Promise<Session>>();
let workerPromise: Promise<Worker> | null = null;
const audibleRadius = 12;

function publicAddress() {
  if (env.mediaAnnouncedAddress) return env.mediaAnnouncedAddress;
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) if (entry.family === 'IPv4' && !entry.internal) return entry.address;
  }
  return '127.0.0.1';
}
function validKey(value: unknown): value is MediaKey {
  return !!value && typeof value === 'object' && 'kind' in value && 'id' in value &&
    (value.kind === 'call' && typeof value.id === 'string' && value.id.length < 100 ||
      value.kind === 'room' && (value.id === 'loft' || value.id === 'roof' || value.id === 'tea'));
}
function sessionKey(value: MediaKey) { return `${value.kind}:${value.id}`; }
async function getWorker() {
  workerPromise ??= mediasoup.createWorker({ logLevel: 'warn' });
  return workerPromise;
}
async function getSession(key: string): Promise<Session> {
  let pending = sessions.get(key);
  if (!pending) {
    pending = (async () => {
      const worker = await getWorker();
      const router = await worker.createRouter({ mediaCodecs: [
        { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
        { kind: 'video', mimeType: 'video/VP8', clockRate: 90000 },
      ] });
      return { key, router, peers: new Map() };
    })();
    sessions.set(key, pending);
    pending.catch(() => sessions.delete(key));
  }
  return pending;
}
function visible(session: Session, listener: Peer, speaker: Peer) {
  if (session.key.startsWith('call:')) return true;
  return Math.hypot(listener.position.x - speaker.position.x, listener.position.z - speaker.position.z) <= audibleRadius;
}
function availableProducers(session: Session, peer: Peer) {
  return [...session.peers.values()].filter(other => other !== peer && visible(session, peer, other))
    .flatMap(other => [...other.producers.values()].map(producer => ({ producerId: producer.id, userId: other.userId, kind: producer.kind,
      distance: session.key.startsWith('room:') ? Math.hypot(peer.position.x - other.position.x, peer.position.z - other.position.z) : undefined })));
}
function broadcastAudible(session: Session) {
  for (const peer of session.peers.values()) {
    const available = availableProducers(session, peer);
    const allowed = new Set(available.map(producer => producer.producerId));
    for (const [id, consumer] of peer.consumers) {
      if (!allowed.has(consumer.producerId)) { consumer.close(); peer.consumers.delete(id); }
    }
    peer.socket.emit('media:audible', available);
  }
}
async function leaveMedia(socket: Socket) {
  const key = socket.data.mediaKey as string | undefined;
  socket.data.mediaKey = undefined;
  if (!key) return;
  const pending = sessions.get(key);
  if (!pending) return;
  const session = await pending;
  const peer = session.peers.get(socket.id);
  if (!peer) return;
  for (const consumer of peer.consumers.values()) consumer.close();
  for (const producer of peer.producers.values()) producer.close();
  for (const transport of peer.transports.values()) transport.close();
  session.peers.delete(socket.id);
  socket.to(`media:${key}`).emit('media:peer-left', { userId: peer.userId });
  socket.leave(`media:${key}`);
  broadcastAudible(session);
  if (session.peers.size === 0) { session.router.close(); sessions.delete(key); }
}

export function attachMediaHandlers(io: Server, socket: Socket) {
  const selfId = socket.data.userId as string;
  const withPeer = async <T>(handler: (session: Session, peer: Peer) => Promise<T>, ack?: Ack<T>) => {
    try {
      const key = socket.data.mediaKey as string | undefined;
      if (!key || !sessions.has(key)) throw new Error('Join media first.');
      const session = await sessions.get(key)!;
      const peer = session.peers.get(socket.id);
      if (!peer) throw new Error('Join media first.');
      ack?.({ ok: true, value: await handler(session, peer) });
    } catch (error) { ack?.({ ok: false, error: error instanceof Error ? error.message : 'Media request failed.' }); }
  };
  socket.on('media:join', async (value: unknown, ack?: Ack<{ rtpCapabilities: Router['rtpCapabilities']; producers: ReturnType<typeof availableProducers>; peers: { userId: string; x: number; z: number }[] }>) => {
    try {
      if (!validKey(value)) throw new Error('Invalid media room.');
      if (value.kind === 'call' && !canJoinCallMedia(value.id, selfId)) throw new Error('Call unavailable.');
      const key = sessionKey(value);
      if (socket.data.mediaKey !== key) await leaveMedia(socket);
      const session = await getSession(key);
      let peer = session.peers.get(socket.id);
      if (!peer) {
        const position = value.kind === 'room' && Number.isFinite(value.position?.x) && Number.isFinite(value.position?.z) &&
          Math.abs(value.position!.x) <= 100 && Math.abs(value.position!.z) <= 100 ? value.position! : { x: 0, z: 0 };
        peer = { socket, userId: selfId, transports: new Map(), producers: new Map(), consumers: new Map(), position };
        session.peers.set(socket.id, peer);
        socket.data.mediaKey = key;
        socket.join(`media:${key}`);
        if (value.kind === 'room') socket.to(`media:${key}`).emit('media:peer-position', { userId: selfId, ...position });
      }
      ack?.({ ok: true, value: { rtpCapabilities: session.router.rtpCapabilities, producers: availableProducers(session, peer),
        peers: [...session.peers.values()].filter(other => other !== peer).map(other => ({ userId: other.userId, ...other.position })) } });
    } catch (error) { ack?.({ ok: false, error: error instanceof Error ? error.message : 'Could not join media.' }); }
  });
  socket.on('media:create-transport', (ack?: Ack<{ id: string; iceParameters: unknown; iceCandidates: unknown; dtlsParameters: unknown }>) => {
    void withPeer(async (session, peer) => {
      const announcedAddress = publicAddress();
      const transport = await session.router.createWebRtcTransport({
        listenInfos: [
          { protocol: 'udp', ip: '0.0.0.0', announcedAddress, portRange: { min: 40000, max: 49999 } },
          { protocol: 'tcp', ip: '0.0.0.0', announcedAddress, portRange: { min: 40000, max: 49999 } },
        ], enableUdp: true, enableTcp: true, preferUdp: true,
      });
      peer.transports.set(transport.id, transport);
      return { id: transport.id, iceParameters: transport.iceParameters, iceCandidates: transport.iceCandidates, dtlsParameters: transport.dtlsParameters };
    }, ack);
  });
  socket.on('media:connect-transport', (input: { id?: string; dtlsParameters?: Parameters<WebRtcTransport['connect']>[0]['dtlsParameters'] }, ack?: Ack<null>) => {
    void withPeer(async (_session, peer) => {
      const transport = peer.transports.get(input?.id ?? '');
      if (!transport || !input?.dtlsParameters) throw new Error('Transport unavailable.');
      await transport.connect({ dtlsParameters: input.dtlsParameters });
      return null;
    }, ack);
  });
  socket.on('media:produce', (input: { transportId?: string; kind?: 'audio' | 'video'; rtpParameters?: Parameters<WebRtcTransport['produce']>[0]['rtpParameters'] }, ack?: Ack<{ id: string }>) => {
    void withPeer(async (session, peer) => {
      const transport = peer.transports.get(input?.transportId ?? '');
      if (!transport || !input?.rtpParameters || (input.kind !== 'audio' && input.kind !== 'video')) throw new Error('Invalid media track.');
      if (session.key.startsWith('room:') && input.kind !== 'audio') throw new Error('Rooms support voice only.');
      const producer = await transport.produce({ kind: input.kind, rtpParameters: input.rtpParameters });
      peer.producers.set(producer.id, producer);
      producer.on('transportclose', () => peer.producers.delete(producer.id));
      broadcastAudible(session);
      return { id: producer.id };
    }, ack);
  });
  socket.on('media:consume', (input: { transportId?: string; producerId?: string; rtpCapabilities?: Router['rtpCapabilities'] }, ack?: Ack<{ id: string; producerId: string; kind: string; rtpParameters: unknown }>) => {
    void withPeer(async (session, peer) => {
      const transport = peer.transports.get(input?.transportId ?? '');
      const source = [...session.peers.values()].find(other => other.producers.has(input?.producerId ?? ''));
      if (!transport || !source || source === peer || !visible(session, peer, source) || !input?.rtpCapabilities ||
        !session.router.canConsume({ producerId: input.producerId!, rtpCapabilities: input.rtpCapabilities })) throw new Error('Track unavailable.');
      const consumer = await transport.consume({ producerId: input.producerId!, rtpCapabilities: input.rtpCapabilities, paused: true });
      peer.consumers.set(consumer.id, consumer);
      consumer.on('producerclose', () => { peer.consumers.delete(consumer.id); socket.emit('media:producer-removed', { producerId: input.producerId }); });
      return { id: consumer.id, producerId: input.producerId!, kind: consumer.kind, rtpParameters: consumer.rtpParameters };
    }, ack);
  });
  socket.on('media:resume', (id: unknown, ack?: Ack<null>) => {
    void withPeer(async (_session, peer) => {
      const consumer = typeof id === 'string' ? peer.consumers.get(id) : undefined;
      if (!consumer) throw new Error('Track unavailable.');
      await consumer.resume();
      return null;
    }, ack);
  });
  socket.on('media:position', (input: { x?: number; z?: number }) => {
    const key = socket.data.mediaKey as string | undefined;
    if (!key?.startsWith('room:') || !Number.isFinite(input?.x) || !Number.isFinite(input?.z) || Math.abs(input.x!) > 100 || Math.abs(input.z!) > 100) return;
    void sessions.get(key)?.then(session => {
      const peer = session.peers.get(socket.id);
      if (!peer) return;
      peer.position = { x: input.x!, z: input.z! };
      socket.to(`media:${key}`).volatile.emit('media:peer-position', { userId: peer.userId, x: peer.position.x, z: peer.position.z });
      broadcastAudible(session);
    });
  });
  socket.on('media:leave', () => { void leaveMedia(socket); });
  socket.on('disconnect', () => { void leaveMedia(socket); });
}
