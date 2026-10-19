import { Device, type types as MediasoupTypes } from 'mediasoup-client';
import { MediaStream, mediaDevices, registerGlobals, type MediaStreamTrack } from 'react-native-webrtc';
import type { Socket } from 'socket.io-client';
import { getRealtimeSocket } from './realtime';
import type { PlayerSnapshot, RoomPose } from './rooms';

export type MediaRoom = { kind: 'call' | 'room'; id: string };
export type RemoteTrack = { producerId: string; userId: string; kind: 'audio' | 'video'; stream: MediaStream };
export type RoomPeer = { userId: string; x: number; z: number };
type ProducerInfo = { producerId: string; userId: string; kind: 'audio' | 'video'; distance?: number };
type MotionProducerInfo = { dataProducerId: string; userId: string };
type MotionPacket = Pick<PlayerSnapshot, 'x' | 'y' | 'z' | 'r' | 'pose'>;
const motionPoses = new Set<RoomPose>(['idle', 'walk', 'run', 'jump', 'crouch_idle', 'crouch_walk', 'sit_enter', 'sit_idle', 'sit_exit', 'lounger_idle']);
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
  private motionProducer: MediasoupTypes.DataProducer | null = null;
  private motionConsumers = new Map<string, MediasoupTypes.DataConsumer>();
  private pendingMotion = new Map<string, MotionProducerInfo>();
  private motionSyncing = false;
  private onMotion: (snapshot: PlayerSnapshot) => void = () => {};
  private syncing: Promise<void> | null = null;
  private latestProducers: ProducerInfo[] | null = null;
  private closed = false;
  private onTracks: (tracks: RemoteTrack[]) => void;
  private onFailure: (error: string) => void;
  private onPeers: (peers: RoomPeer[]) => void;
  private onLocal: (stream: MediaStream) => void;
  private peers = new Map<string, RoomPeer>();
  private onPeerLeft = ({ userId }: { userId: string }) => { this.peers.delete(userId); this.onPeers([...this.peers.values()]); };
  private onAudible = (producers: ProducerInfo[]) => {
    if (!this.device || !this.recvTransport) this.latestProducers = producers;
    else void this.queueSync(producers);
  };
  private onRemoved = ({ producerId }: { producerId: string }) => { this.remove(producerId); };
  private onNewMotionProducer = (info: MotionProducerInfo) => {
    if (!info?.dataProducerId || !info?.userId) return;
    this.pendingMotion.set(info.dataProducerId, info);
    void this.syncMotion();
  };
  private onMotionProducerRemoved = ({ dataProducerId }: { dataProducerId: string }) => {
    this.pendingMotion.delete(dataProducerId);
    this.motionConsumers.get(dataProducerId)?.close();
    this.motionConsumers.delete(dataProducerId);
  };

  constructor(onTracks: (tracks: RemoteTrack[]) => void, onFailure: (error: string) => void, onPeers: (peers: RoomPeer[]) => void = () => {}, onLocal: (stream: MediaStream) => void = () => {}) {
    this.onTracks = onTracks;
    this.onFailure = onFailure;
    this.onPeers = onPeers;
    this.onLocal = onLocal;
  }

  get local() { return this.localStream; }
  setMotionListener(listener: (snapshot: PlayerSnapshot) => void) { this.onMotion = listener; }

  async join(room: MediaRoom, video: boolean, position?: { x: number; z: number }) {
    registerGlobals();
    const socket = await getRealtimeSocket();
    this.socket = socket;
    socket.on('media:audible', this.onAudible);
    socket.on('media:producer-removed', this.onRemoved);
    socket.on('media:peer-left', this.onPeerLeft);
    if (room.kind === 'room') {
      socket.on('media:new-data-producer', this.onNewMotionProducer);
      socket.on('media:data-producer-removed', this.onMotionProducerRemoved);
    }
    const joined = await request<{ rtpCapabilities: MediasoupTypes.RtpCapabilities; producers: ProducerInfo[]; peers: RoomPeer[]; dataProducers: MotionProducerInfo[] }>(socket, 'media:join', { ...room, position });
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
    if (room.kind === 'room') {
      send.on('producedata', ({ sctpStreamParameters, label, protocol }, callback, errback) => {
        void request<{ id: string }>(socket, 'media:produce-data', { transportId: send.id, sctpStreamParameters, label, protocol }).then(callback, errback);
      });
      for (const info of joined.dataProducers ?? []) this.pendingMotion.set(info.dataProducerId, info);
      this.motionProducer = await send.produceData({ ordered: false, maxRetransmits: 0, label: 'motion', protocol: 'json' });
      void this.syncMotion();
    }
    const stream = await mediaDevices.getUserMedia({ audio: true, video });
    if (this.closed) { stream.getTracks().forEach(track => track.stop()); return; }
    this.localStream = stream;
    this.onLocal(stream);
    stream.getAudioTracks().forEach(track => { track.enabled = !this.muted; });
    stream.getVideoTracks().forEach(track => { track.enabled = !this.cameraOff; });
    for (const track of stream.getTracks()) {
      const producer = await send.produce({ track: track as unknown as globalThis.MediaStreamTrack, stopTracks: false,
        ...(track.kind === 'audio' ? { codecOptions: { opusDtx: true, opusFec: true } } : {}) });
      this.producing.push(producer);
    }
    if (this.cameraOff) {
      this.producing.filter(p => p.kind === 'video').forEach(p => {
        try { p.pause(); } catch {}
      });
    }
    // Receiving another participant must not hold up publishing or the local preview.
    void this.queueSync(this.latestProducers ?? joined.producers);
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
  async setCameraOff(off: boolean): Promise<MediaStream | null> {
    this.cameraOff = off;
    if (off) {
      this.localStream?.getVideoTracks().forEach(track => { track.enabled = false; });
      this.producing.filter(p => p.kind === 'video').forEach(p => {
        try { p.pause(); } catch {}
      });
      return this.localStream;
    }

    const existingVideo = this.localStream?.getVideoTracks() || [];
    if (existingVideo.length > 0) {
      existingVideo.forEach(track => { track.enabled = true; });
      this.producing.filter(p => p.kind === 'video').forEach(p => {
        try { p.resume(); } catch {}
      });
      return this.localStream;
    }

    if (this.sendTransport && !this.closed) {
      try {
        const videoStream = await mediaDevices.getUserMedia({ audio: false, video: true });
        const track = videoStream.getVideoTracks()[0];
        if (track) {
          track.enabled = true;
          if (!this.localStream) {
            this.localStream = new MediaStream();
          }
          this.localStream.addTrack(track);
          this.onLocal(this.localStream);
          const producer = await this.sendTransport.produce({
            track: track as unknown as globalThis.MediaStreamTrack,
            stopTracks: false,
          });
          this.producing.push(producer);
        }
      } catch (err) {
        console.warn('Failed to acquire camera video track:', err);
      }
    }
    return this.localStream;
  }
  flipCamera() {
    const videoTrack = this.localStream?.getVideoTracks()[0];
    if (videoTrack && typeof (videoTrack as any)._switchCamera === 'function') {
      (videoTrack as any)._switchCamera();
    }
  }
  sendMotion(snapshot: MotionPacket): boolean {
    const producer = this.motionProducer;
    if (!producer || producer.readyState !== 'open' || producer.bufferedAmount > 16_384) return false;
    try {
      producer.send(JSON.stringify(snapshot));
      return true;
    } catch { return false; }
  }

  private async syncMotion() {
    if (this.motionSyncing || !this.recvTransport || !this.socket || this.closed) return;
    this.motionSyncing = true;
    try {
      while (this.pendingMotion.size && !this.closed && this.recvTransport && this.socket) {
        const [id, info] = this.pendingMotion.entries().next().value as [string, MotionProducerInfo];
        this.pendingMotion.delete(id);
        if (this.motionConsumers.has(id)) continue;
        const options = await request<MediasoupTypes.DataConsumerOptions>(this.socket, 'media:consume-data', {
          transportId: this.recvTransport.id, dataProducerId: id,
        });
        if (this.closed || !this.recvTransport) return;
        const consumer = await this.recvTransport.consumeData(options);
        if (this.closed) { consumer.close(); return; }
        this.motionConsumers.set(id, consumer);
        consumer.on('message', (message: unknown) => {
          try {
            const packet = JSON.parse(typeof message === 'string' ? message : String(message)) as Partial<MotionPacket>;
            if (!Number.isFinite(packet.x) || !Number.isFinite(packet.y) || !Number.isFinite(packet.z) ||
                !Number.isFinite(packet.r) || Math.abs(packet.x!) > 100 || Math.abs(packet.z!) > 100 ||
                !motionPoses.has(packet.pose as RoomPose)) return;
            this.onMotion({ id: info.userId, x: packet.x!, y: packet.y!, z: packet.z!, r: packet.r!, pose: packet.pose as RoomPose, time: Date.now() });
          } catch { /* Ignore malformed unreliable packets. */ }
        });
        consumer.on('close', () => { this.motionConsumers.delete(id); });
      }
    } catch (error) {
      if (!this.closed) this.onFailure(`Movement connection failed: ${String(error)}`);
    } finally {
      this.motionSyncing = false;
      if (this.pendingMotion.size && !this.closed) void this.syncMotion();
    }
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
    this.socket?.off('media:peer-left', this.onPeerLeft);
    this.socket?.off('media:new-data-producer', this.onNewMotionProducer);
    this.socket?.off('media:data-producer-removed', this.onMotionProducerRemoved);
    this.socket?.emit('media:leave');
    for (const id of this.consumers.keys()) this.remove(id);
    this.producing.forEach(producer => producer.close());
    this.motionProducer?.close();
    this.motionProducer = null;
    for (const consumer of this.motionConsumers.values()) consumer.close();
    this.motionConsumers.clear();
    this.pendingMotion.clear();
    this.sendTransport?.close();
    this.recvTransport?.close();
    this.localStream?.getTracks().forEach(track => track.stop());
    this.localStream = null;
  }
}
