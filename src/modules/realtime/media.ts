import { networkInterfaces, cpus } from 'node:os';
import type { Server, Socket } from 'socket.io';
import * as mediasoup from 'mediasoup';
import type { Consumer, Producer, Router, WebRtcTransport, Worker } from 'mediasoup/types';
import { env } from '../../config/env.js';
import { canJoinCallMedia } from './calls.js';

type MediaKey = { kind: 'call' | 'room'; id: string; position?: { x: number; z: number } };
type Peer = {
  socket: Socket;
  userId: string;
  transports: Map<string, WebRtcTransport>;
  producers: Map<string, Producer>;
  consumers: Map<string, Consumer>;
  position: { x: number; z: number };
  lastAudibleHash?: string;
};
type Session = {
  key: string;
  router: Router;
  workerIndex: number;
  peers: Map<string, Peer>;
  audibleTimer?: NodeJS.Timeout | null;
};
type Ack<T> = (result: { ok: true; value: T } | { ok: false; error: string }) => void;

const sessions = new Map<string, Promise<Session>>();

// Worker configuration:
// Base load: Hard capped at 2 cores (25% CPU) so 6 cores remain totally free.
// High load: Dynamically scales up to 4 cores max when traffic surges, keeping 4 cores strictly reserved for OS/Node/DB.
const MIN_WORKERS = 2;
const MAX_WORKERS = 4;
const PORTS_PER_WORKER = 2500;
const BASE_RTC_PORT = 40000;

let workers: Worker[] = [];
let workerInitPromise: Promise<Worker[]> | null = null;
let isScaling = false;

const audibleRadius = 12;
const disconnectRadius = 15; // Hysteresis threshold to prevent connect/disconnect thrashing

const KNOWN_BASE_ROOMS = new Set(['loft', 'roof', 'tea', 'beach']);

function isKnownRoom(id: string): boolean {
  if (KNOWN_BASE_ROOMS.has(id)) return true;
  if (id.startsWith('group:')) return true;
  const base = id.split(':')[0];
  return KNOWN_BASE_ROOMS.has(base);
}

function publicAddress() {
  if (env.mediaAnnouncedAddress) return env.mediaAnnouncedAddress;
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) if (entry.family === 'IPv4' && !entry.internal) return entry.address;
  }
  return '127.0.0.1';
}

function validKey(value: unknown): value is MediaKey {
  return !!value && typeof value === 'object' && 'kind' in value && 'id' in value &&
    (value.kind === 'call' && typeof value.id === 'string' && value.id.length < 150 ||
      value.kind === 'room' && typeof value.id === 'string' && value.id.length < 150 && isKnownRoom(value.id));
}

function sessionKey(value: MediaKey) { return `${value.kind}:${value.id}`; }

async function createWorkerInstance(index: number): Promise<Worker> {
  const rtcMinPort = BASE_RTC_PORT + (index * PORTS_PER_WORKER);
  const rtcMaxPort = rtcMinPort + PORTS_PER_WORKER - 1;
  const worker = await mediasoup.createWorker({
    logLevel: 'warn',
    rtcMinPort,
    rtcMaxPort,
  });
  console.log(`[mediasoup] Worker #${index} online on UDP/TCP ports ${rtcMinPort}-${rtcMaxPort}`);
  worker.on('died', () => {
    console.error(`[mediasoup] Worker #${index} died. Re-initializing replacement worker...`);
    const idx = workers.indexOf(worker);
    if (idx !== -1) {
      createWorkerInstance(index).then(replacement => {
        workers[idx] = replacement;
      }).catch(err => console.error(`[mediasoup] Worker #${index} replacement failed`, err));
    }
  });
  return worker;
}

async function ensureBaseWorkers(): Promise<Worker[]> {
  if (!workerInitPromise) {
    workerInitPromise = (async () => {
      const created: Worker[] = [];
      for (let i = 0; i < MIN_WORKERS; i++) {
        const worker = await createWorkerInstance(i);
        created.push(worker);
      }
      workers = created;
      console.log(`[mediasoup] Initialized base pool with ${MIN_WORKERS} workers (cores 0-1). Dynamic scaling up to ${MAX_WORKERS} enabled.`);
      return created;
    })();
  }
  return workerInitPromise;
}

function getTotalActivePeerCount(): number {
  let total = 0;
  for (const pending of sessions.values()) {
    // If promise is resolved, count peers
    // Note: pending is Promise<Session>
  }
  return total;
}

async function getWorker(): Promise<{ worker: Worker; workerIndex: number }> {
  await ensureBaseWorkers();

  // Dynamic Scale-Up: If traffic is high (>= 3 active sessions), scale up to 4 workers on demand
  const activeSessionCount = sessions.size;
  if (activeSessionCount >= 3 && workers.length < MAX_WORKERS && !isScaling) {
    isScaling = true;
    const nextIdx = workers.length;
    console.log(`[mediasoup] High load detected (${activeSessionCount} active media sessions). Scaling up worker pool: launching Worker #${nextIdx} (Core #${nextIdx})...`);
    createWorkerInstance(nextIdx)
      .then(newWorker => {
        workers.push(newWorker);
        console.log(`[mediasoup] Worker pool dynamically scaled to ${workers.length} cores.`);
      })
      .catch(err => console.error('[mediasoup] Failed to scale worker pool', err))
      .finally(() => { isScaling = false; });
  }

  // Count active sessions per worker to pick the least loaded worker
  const usage = new Array(workers.length).fill(0);
  for (const pending of sessions.values()) {
    // Check if session has resolved
    const session = await Promise.race([pending, Promise.resolve(null)]);
    if (session && session.workerIndex < workers.length) {
      usage[session.workerIndex] += (session.peers.size + 1);
    }
  }

  let bestIdx = 0;
  let minLoad = usage[0];
  for (let i = 1; i < workers.length; i++) {
    if (usage[i] < minLoad) {
      minLoad = usage[i];
      bestIdx = i;
    }
  }

  return { worker: workers[bestIdx], workerIndex: bestIdx };
}

async function getSession(key: string): Promise<Session> {
  let pending = sessions.get(key);
  if (!pending) {
    pending = (async () => {
      const { worker, workerIndex } = await getWorker();
      const router = await worker.createRouter({
        mediaCodecs: [
          {
            kind: 'audio',
            mimeType: 'audio/opus',
            clockRate: 48000,
            channels: 2,
            parameters: {
              'sprop-stereo': 0,
              'stereo': 0,
              'usedtx': 1,
              'useinbandfec': 1,
            },
          },
          { kind: 'video', mimeType: 'video/VP8', clockRate: 90000 },
        ],
      });
      return { key, router, workerIndex, peers: new Map() };
    })();
    sessions.set(key, pending);
    pending.catch(() => sessions.delete(key));
  }
  return pending;
}

function visible(session: Session, listener: Peer, speaker: Peer) {
  if (session.key.startsWith('call:')) return true;
  const dist = Math.hypot(listener.position.x - speaker.position.x, listener.position.z - speaker.position.z);
  // Hysteresis: if listener already has an active consumer for this speaker's producer, allow up to disconnectRadius (15)
  // to prevent rapid connect/disconnect churning at the audible boundary
  const isAlreadyConsuming = [...listener.consumers.values()].some(c => speaker.producers.has(c.producerId));
  const maxRadius = isAlreadyConsuming ? disconnectRadius : audibleRadius;
  return dist <= maxRadius;
}

function availableProducers(session: Session, peer: Peer) {
  return [...session.peers.values()]
    .filter(other => other !== peer && visible(session, peer, other))
    .flatMap(other => [...other.producers.values()].map(producer => ({
      producerId: producer.id,
      userId: other.userId,
      kind: producer.kind,
      distance: session.key.startsWith('room:')
        ? Math.round(Math.hypot(peer.position.x - other.position.x, peer.position.z - other.position.z) * 10) / 10
        : undefined,
    })));
}

function getAudibleHash(producers: ReturnType<typeof availableProducers>) {
  if (producers.length === 0) return '';
  return producers.map(p => `${p.producerId}:${p.distance ?? 0}`).sort().join(';');
}

function broadcastAudible(session: Session) {
  for (const peer of session.peers.values()) {
    const available = availableProducers(session, peer);
    const allowed = new Set(available.map(producer => producer.producerId));

    for (const [id, consumer] of peer.consumers) {
      if (!allowed.has(consumer.producerId)) {
        consumer.close();
        peer.consumers.delete(id);
      }
    }

    // Change detection: only emit to peer if audible set or distance meaningfully changed!
    // Prevents sending thousands of duplicate socket messages per second.
    const hash = getAudibleHash(available);
    if (peer.lastAudibleHash !== hash) {
      peer.lastAudibleHash = hash;
      peer.socket.emit('media:audible', available);
    }
  }
}

function scheduleAudible(session: Session) {
  if (session.audibleTimer) return;
  session.audibleTimer = setTimeout(() => {
    session.audibleTimer = null;
    broadcastAudible(session);
  }, 100);
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

  for (const transport of peer.transports.values()) transport.close();
  peer.consumers.clear();
  peer.producers.clear();
  peer.transports.clear();
  session.peers.delete(socket.id);

  socket.to(`media:${key}`).emit('media:peer-left', { userId: peer.userId });
  socket.leave(`media:${key}`);
  broadcastAudible(session);

  if (session.peers.size === 0) {
    if (session.audibleTimer) {
      clearTimeout(session.audibleTimer);
      session.audibleTimer = null;
    }
    session.router.close();
    sessions.delete(key);
  }
}

export async function closeMediaSession(rawKey: string): Promise<void> {
  const key = rawKey.startsWith('room:') ? rawKey : `room:${rawKey}`;
  const pending = sessions.get(key) ?? sessions.get(rawKey);
  if (!pending) return;
  try {
    const session = await pending;
    if (session.audibleTimer) {
      clearTimeout(session.audibleTimer);
      session.audibleTimer = null;
    }
    for (const peer of session.peers.values()) {
      for (const transport of peer.transports.values()) {
        try { transport.close(); } catch {}
      }
      peer.consumers.clear();
      peer.producers.clear();
      peer.transports.clear();
    }
    session.peers.clear();
    try { session.router.close(); } catch {}
    sessions.delete(key);
    sessions.delete(rawKey);
    console.log(`[media] Forcibly closed media session and router for ${rawKey}`);
  } catch (err) {
    console.warn(`[media] Failed closing session for ${rawKey}:`, err);
  }
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
    } catch (error) {
      ack?.({ ok: false, error: error instanceof Error ? error.message : 'Media request failed.' });
    }
  };

  socket.on('media:join', async (value: unknown, ack?: Ack<{ rtpCapabilities: Router['rtpCapabilities']; producers: ReturnType<typeof availableProducers>; peers: { userId: string; x: number; z: number }[] }>) => {
    try {
      if (!validKey(value)) throw new Error('Invalid media room.');
      if (value.kind === 'call' && !canJoinCallMedia(value.id, selfId)) throw new Error('Call unavailable.');

      // Auto-bind 3D rooms to the user's specific room shard (e.g. 'beach:1' instead of generic 'beach')
      const rawId = value.id;
      const effectiveId = (value.kind === 'room' && typeof socket.data.roomId === 'string' && socket.data.roomId.startsWith(rawId))
        ? socket.data.roomId
        : rawId;

      const key = sessionKey({ kind: value.kind, id: effectiveId });
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
      ack?.({
        ok: true,
        value: {
          rtpCapabilities: session.router.rtpCapabilities,
          producers: availableProducers(session, peer),
          peers: [...session.peers.values()].filter(other => other !== peer).map(other => ({ userId: other.userId, ...other.position })),
        },
      });
      broadcastAudible(session);
    } catch (error) {
      ack?.({ ok: false, error: error instanceof Error ? error.message : 'Could not join media.' });
    }
  });

  socket.on('media:create-transport', (ack?: Ack<{ id: string; iceParameters: unknown; iceCandidates: unknown; dtlsParameters: unknown }>) => {
    void withPeer(async (session, peer) => {
      const announcedAddress = publicAddress();
      const transport = await session.router.createWebRtcTransport({
        listenInfos: [
          { protocol: 'udp', ip: '0.0.0.0', announcedAddress },
          { protocol: 'tcp', ip: '0.0.0.0', announcedAddress },
        ],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
        initialAvailableOutgoingBitrate: 1_000_000,
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
      producer.on('transportclose', () => {
        peer.producers.delete(producer.id);
        broadcastAudible(session);
      });
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
      consumer.on('producerclose', () => {
        peer.consumers.delete(consumer.id);
        socket.emit('media:producer-removed', { producerId: input.producerId });
      });
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
      scheduleAudible(session);
    });
  });

  socket.on('media:leave', () => { void leaveMedia(socket); });
  socket.on('disconnect', () => { void leaveMedia(socket); });
}
