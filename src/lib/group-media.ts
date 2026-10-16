import { Device, type types as MediasoupTypes } from 'mediasoup-client';
import { MediaStream, mediaDevices, registerGlobals, type MediaStreamTrack } from 'react-native-webrtc';
import type { Socket } from 'socket.io-client';
import { getRealtimeSocket } from './realtime';

export type MediaRoom = { kind: 'call' | 'room'; id: string };
export type RemoteTrack = { producerId: string; userId: string; kind: 'audio' | 'video'; stream: MediaStream };
export type RoomPeer = { userId: string; x: number; z: number };
type ProducerInfo = { producerId: string; userId: string; kind: 'audio' | 'video'; distance?: number };
type Reply<T> = { ok: true; value: T } | { ok: false; error: string };
type TransportInfo = Parameters<Device['createSendTransport']>[0];

async function request<T>(socket: Socket, event: string, payload?: unknown): Promise<T> {
  if (!socket.connected) throw new Error('Media connection is offline.');
  return new Promise((resolve, reject) => {
    const done = (error: Error | null, reply?: Reply<T>) => {
      if (error) reject(new Error(`${event} timed out.`));
      else if (!reply || !reply.ok) reject(new Error(reply?.error || 'Media request failed.'));
      else resolve(reply.value);
    };
    if (payload === undefined) socket.timeout(12_000).emit(event, done);
    else socket.timeout(12_000).emit(event, payload, done);
  });
}

export class GroupMedia {
  private socket: Socket | null = null;
  private device: Device | null = null;
  private sendTransport: MediasoupTypes.Transport | null = null;
  private recvTransport: MediasoupTypes.Transport | null = null;
  private localStream: MediaStream | null = null;
  private muted = false;
  private playbackMuted = false;
  private mutedUsers = new Set<string>();
  private cameraOff = false;
  private consumers = new Map<string, { consumer: MediasoupTypes.Consumer; info: ProducerInfo; stream: MediaStream }>();
  private producing: MediasoupTypes.Producer[] = [];
  private syncing: Promise<void> | null = null;
  private latestProducers: ProducerInfo[] | null = null;
  private closed = false;
  private onTracks: (tracks: RemoteTrack[]) => void;
  private onFailure: (error: string) => void;
  private onPeers: (peers: RoomPeer[]) => void;
  private peers = new Map<string, RoomPeer>();
  private onPosition = (peer: RoomPeer) => { this.peers.set(peer.userId, peer); this.onPeers([...this.peers.values()]); };
  private onPeerLeft = ({ userId }: { userId: string }) => { this.peers.delete(userId); this.onPeers([...this.peers.values()]); };
  private onAudible = (producers: ProducerInfo[]) => {
    if (!this.device || !this.recvTransport) this.latestProducers = producers;
    else void this.queueSync(producers);
  };
  private onRemoved = ({ producerId }: { producerId: string }) => { this.remove(producerId); };

  constructor(onTracks: (tracks: RemoteTrack[]) => void, onFailure: (error: string) => void, onPeers: (peers: RoomPeer[]) => void = () => {}) {
    this.onTracks = onTracks;
    this.onFailure = onFailure;
    this.onPeers = onPeers;
  }

  get local() { return this.localStream; }

  async join(room: MediaRoom, video: boolean, position?: { x: number; z: number }) {
    registerGlobals();
    const socket = await getRealtimeSocket();
    this.socket = socket;
    socket.on('media:audible', this.onAudible);
    socket.on('media:producer-removed', this.onRemoved);
    socket.on('media:peer-position', this.onPosition);
    socket.on('media:peer-left', this.onPeerLeft);
    const joined = await request<{ rtpCapabilities: MediasoupTypes.RtpCapabilities; producers: ProducerInfo[]; peers: RoomPeer[] }>(socket, 'media:join', { ...room, position });
    if (this.closed) { socket.emit('media:leave'); return; }
    joined.peers.forEach(peer => this.peers.set(peer.userId, peer));
    this.onPeers([...this.peers.values()]);
    const device = await Device.factory({ handlerName: 'ReactNative106' });
    await device.load({ routerRtpCapabilities: joined.rtpCapabilities });
    this.device = device;
    const sendInfo = await request<TransportInfo>(socket, 'media:create-transport');
    const recvInfo = await request<TransportInfo>(socket, 'media:create-transport');
    const send = device.createSendTransport(sendInfo);
    const recv = device.createRecvTransport(recvInfo);
    this.sendTransport = send;
    this.recvTransport = recv;
    for (const transport of [send, recv]) transport.on('connectionstatechange', state => {
      if (!this.closed && state === 'failed') this.onFailure('Voice connection failed. Check the media server or network.');
    });
    for (const transport of [send, recv]) {
      transport.on('connect', ({ dtlsParameters }, callback, errback) => {
        void request(socket, 'media:connect-transport', { id: transport.id, dtlsParameters }).then(() => callback(), errback);
      });
    }
    send.on('produce', ({ kind, rtpParameters }, callback, errback) => {
      void request<{ id: string }>(socket, 'media:produce', { transportId: send.id, kind, rtpParameters }).then(callback, errback);
    });
    const stream = await mediaDevices.getUserMedia({ audio: true, video });
    if (this.closed) { stream.getTracks().forEach(track => track.stop()); return; }
    this.localStream = stream;
    stream.getAudioTracks().forEach(track => { track.enabled = !this.muted; });
    stream.getVideoTracks().forEach(track => { track.enabled = !this.cameraOff; });
    for (const track of stream.getTracks()) {
      const producer = await send.produce({ track: track as unknown as globalThis.MediaStreamTrack, stopTracks: false,
        ...(track.kind === 'audio' ? { codecOptions: { opusDtx: true, opusFec: true } } : {}) });
      this.producing.push(producer);
    }
    await this.queueSync(this.latestProducers ?? joined.producers);
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    this.localStream?.getAudioTracks().forEach(track => { track.enabled = !muted; });
  }
  setPlaybackMuted(muted: boolean) {
    this.playbackMuted = muted;
    this.updatePlaybackVolumes();
  }
  setUserMuted(userId: string, muted: boolean) {
    if (muted) this.mutedUsers.add(userId);
    else this.mutedUsers.delete(userId);
    this.updatePlaybackVolumes();
  }
  setCameraOff(off: boolean) {
    this.cameraOff = off;
    this.localStream?.getVideoTracks().forEach(track => { track.enabled = !off; });
  }
  setPosition(x: number, z: number) {
    this.socket?.volatile.emit('media:position', { x, z });
  }

  private queueSync(producers: ProducerInfo[]) {
    this.latestProducers = producers;
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      while (!this.closed && this.latestProducers) {
        const next = this.latestProducers;
        this.latestProducers = null;
        await this.sync(next);
      }
    })().catch(error => this.onFailure(String(error))).finally(() => {
      this.syncing = null;
      if (this.latestProducers && !this.closed) void this.queueSync(this.latestProducers);
    });
    return this.syncing;
  }

  private async sync(producers: ProducerInfo[]) {
    if (this.closed || !this.device || !this.recvTransport || !this.socket) return;
    const wanted = new Set(producers.map(info => info.producerId));
    for (const id of this.consumers.keys()) if (!wanted.has(id)) this.remove(id);
    for (const info of producers) {
      const current = this.consumers.get(info.producerId);
      if (current) { current.info = info; this.setVolume(current.consumer.track as unknown as MediaStreamTrack, info); continue; }
      const parameters = await request<MediasoupTypes.ConsumerOptions>(this.socket, 'media:consume', {
        transportId: this.recvTransport.id, producerId: info.producerId, rtpCapabilities: this.device.rtpCapabilities,
      });
      if (this.closed) return;
      const consumer = await this.recvTransport.consume(parameters);
      const track = consumer.track as unknown as MediaStreamTrack;
      const stream = new MediaStream([track]);
      this.consumers.set(info.producerId, { consumer, info, stream });
      this.setVolume(track, info);
      await request(this.socket, 'media:resume', consumer.id);
      this.emitTracks();
    }
  }

  private updatePlaybackVolumes() {
    for (const { consumer, info } of this.consumers.values()) {
      this.setVolume(consumer.track as unknown as MediaStreamTrack, info);
    }
  }
  private setVolume(track: MediaStreamTrack, info: ProducerInfo) {
    if (track.kind !== 'audio') return;
    const volume = this.playbackMuted || this.mutedUsers.has(info.userId)
      ? 0
      : typeof info.distance === 'number' ? Math.max(0.2, Math.min(1, 1 - info.distance / 12)) : 1;
    track._setVolume(volume);
  }
  private remove(id: string) {
    const entry = this.consumers.get(id);
    if (!entry) return;
    entry.consumer.close();
    entry.stream.release(false);
    this.consumers.delete(id);
    this.emitTracks();
  }
  private emitTracks() {
    this.onTracks([...this.consumers.entries()].map(([producerId, { info, stream }]) => ({ producerId, userId: info.userId, kind: info.kind, stream })));
  }
  close() {
    this.closed = true;
    this.socket?.off('media:audible', this.onAudible);
    this.socket?.off('media:producer-removed', this.onRemoved);
    this.socket?.off('media:peer-position', this.onPosition);
    this.socket?.off('media:peer-left', this.onPeerLeft);
    this.socket?.emit('media:leave');
    for (const id of this.consumers.keys()) this.remove(id);
    this.producing.forEach(producer => producer.close());
    this.sendTransport?.close();
    this.recvTransport?.close();
    this.localStream?.getTracks().forEach(track => track.stop());
    this.localStream = null;
  }
}
