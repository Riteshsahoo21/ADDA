import type { Server, Socket } from 'socket.io';
import type { RoomPeer, RoomPose } from './rooms.js';
import { decodeMotion, encodeMotionBatch, isNewerSequence, type MotionState } from './motion-codec.js';

type Entry = { peer: RoomPeer; state: MotionState; acceptedAt: number; hasPosition: boolean; critical: boolean };
type Delivery = { seq: number; at: number };
type Shard = {
  entries: Map<string, Entry>;
  delivered: Map<string, Map<string, Delivery>>;
  timer: ReturnType<typeof setInterval>;
};

const MOTION_TICK_MS = 100;
const NEAR_DISTANCE = 18;
const FAR_UPDATE_MS = 500;
const MAX_SPEED = 5;

export class RoomMotionHub {
  private readonly shards = new Map<string, Shard>();
  private readonly ids = new Set<number>();
  private nextId = 1;

  constructor(private readonly io: Server) {}

  allocateId() {
    for (let attempt = 0; attempt < 65535; attempt++) {
      const id = this.nextId;
      this.nextId = id === 65535 ? 1 : id + 1;
      if (!this.ids.has(id)) { this.ids.add(id); return id; }
    }
    throw new Error('Room motion IDs exhausted');
  }

  join(shardId: string, socket: Socket, peer: RoomPeer) {
    let shard = this.shards.get(shardId);
    if (!shard) {
      const timer = setInterval(() => this.flush(shardId), MOTION_TICK_MS);
      timer.unref?.();
      shard = { entries: new Map(), delivered: new Map(), timer };
      this.shards.set(shardId, shard);
    }
    shard.entries.set(socket.id, {
      peer,
      state: { motionId: peer.motionId, seq: 0, x: peer.x, y: peer.y ?? 0, z: peer.z, yaw: peer.yaw, vx: 0, vz: 0, pose: peer.pose ?? 'idle' },
      acceptedAt: 0,
      hasPosition: false,
      critical: false,
    });
  }

  leave(shardId: string | undefined, socketId: string, motionId?: number) {
    if (motionId) this.ids.delete(motionId);
    if (!shardId) return;
    const shard = this.shards.get(shardId);
    if (!shard) return;
    shard.entries.delete(socketId);
    shard.delivered.delete(socketId);
    for (const delivered of shard.delivered.values()) delivered.delete(socketId);
    if (!shard.entries.size) {
      clearInterval(shard.timer);
      this.shards.delete(shardId);
    }
  }

  receive(socket: Socket, input: unknown) {
    const state = decodeMotion(input);
    if (!state) return false;
    return this.accept(socket, state);
  }

  receiveLegacy(socket: Socket, input: { x: number; y?: number; z: number; yaw: number; pose?: RoomPose }) {
    const shardId = socket.data.roomId as string | undefined;
    const entry = shardId ? this.shards.get(shardId)?.entries.get(socket.id) : undefined;
    if (!entry) return false;
    const now = Date.now();
    const dt = Math.max(0.05, (now - entry.acceptedAt) / 1000);
    const moving = input.pose === 'walk' || input.pose === 'run' || input.pose === 'crouch_walk';
    return this.accept(socket, {
      motionId: entry.peer.motionId,
      seq: (entry.state.seq + 1) & 0xffff,
      x: input.x,
      y: input.y ?? entry.peer.y ?? 0,
      z: input.z,
      yaw: input.yaw,
      vx: moving && entry.hasPosition ? (input.x - entry.peer.x) / dt : 0,
      vz: moving && entry.hasPosition ? (input.z - entry.peer.z) / dt : 0,
      pose: input.pose ?? entry.peer.pose ?? 'idle',
    }, true);
  }

  private accept(socket: Socket, state: MotionState, legacy = false) {
    const shardId = socket.data.roomId as string | undefined;
    const shard = shardId ? this.shards.get(shardId) : undefined;
    const entry = shard?.entries.get(socket.id);
    if (!shardId || !shard || !entry ||
      (!legacy && !isNewerSequence(state.seq, entry.state.seq) && entry.hasPosition) ||
      ![state.x, state.y, state.z, state.yaw, state.vx, state.vz].every(Number.isFinite) ||
      Math.abs(state.x) > 100 || Math.abs(state.z) > 100 || state.y < 0 || state.y > 3 ||
      Math.hypot(state.vx, state.vz) > MAX_SPEED + 0.1) return false;

    const now = Date.now();
    const seconds = (now - entry.acceptedAt) / 1000;
    const poseChanged = state.pose !== entry.state.pose;
    if (entry.hasPosition && (
      (seconds < (poseChanged ? 0.025 : 0.04)) ||
      Math.hypot(state.x - entry.state.x, state.z - entry.state.z) > MAX_SPEED * Math.max(seconds, 0) + 0.7
    )) return false;

    entry.state = { ...state, motionId: entry.peer.motionId };
    entry.acceptedAt = now;
    entry.hasPosition = true;
    entry.critical = entry.critical || poseChanged;
    Object.assign(entry.peer, {
      x: state.x, y: state.y, z: state.z, yaw: state.yaw,
      vx: state.vx, vz: state.vz, pose: state.pose,
    });

    // Older app versions still receive their original movement event.
    for (const socketId of this.io.sockets.adapter.rooms.get(`presence:${shardId}`) ?? []) {
      if (socketId === socket.id) continue;
      const recipient = this.io.sockets.sockets.get(socketId);
      if (!recipient || recipient.data.motionProtocol === 2) continue;
      if (poseChanged) recipient.emit('room:peer', entry.peer);
      else recipient.volatile.emit('room:peer', entry.peer);
    }
    return true;
  }

  flush(shardId: string) {
    const shard = this.shards.get(shardId);
    if (!shard) return;
    const now = Date.now();
    for (const [recipientId, recipient] of shard.entries) {
      const socket = this.io.sockets.sockets.get(recipientId);
      if (!socket || socket.data.motionProtocol !== 2) continue;
      let delivered = shard.delivered.get(recipientId);
      if (!delivered) { delivered = new Map(); shard.delivered.set(recipientId, delivered); }
      const batch: MotionState[] = [];
      let reliable = false;
      for (const [senderId, sender] of shard.entries) {
        if (senderId === recipientId || !sender.hasPosition) continue;
        const last = delivered.get(senderId);
        if (last?.seq === sender.state.seq) continue;
        const near = Math.hypot(recipient.peer.x - sender.peer.x, recipient.peer.z - sender.peer.z) <= NEAR_DISTANCE;
        if (!near && !sender.critical && last && now - last.at < FAR_UPDATE_MS) continue;
        batch.push(sender.state);
        reliable ||= sender.critical;
        delivered.set(senderId, { seq: sender.state.seq, at: now });
      }
      if (!batch.length) continue;
      const packet = encodeMotionBatch(batch);
      if (reliable) socket.emit('room:motion-batch', packet);
      else socket.volatile.emit('room:motion-batch', packet);
    }
    for (const entry of shard.entries.values()) entry.critical = false;
  }
}
