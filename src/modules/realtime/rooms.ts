import type { Server, Socket } from 'socket.io';

export type RoomKind = 'loft' | 'roof' | 'tea' | 'beach';
export type AvatarBody = 'man' | 'uncle' | 'photo_boy' | 'self' | 'woman' | 'chinese_woman' | 'nepali_woman' | 'white_top_woman';
export type RoomPose = 'idle' | 'walk' | 'run' | 'jump' | 'crouch_idle' | 'crouch_walk' | 'sit_enter' | 'sit_idle' | 'sit_exit';
export type RoomPeer = { userId: string; name: string; avatar: AvatarBody; x: number; y?: number; z: number; yaw: number; pose?: RoomPose };
export type RoomMessage = { id: string; room: string; userId: string; name: string; body: string; createdAt: number };
export type Ack<T> = (reply: { ok: true; value: T } | { ok: false; error: string }) => void;

export type RoomRadioState = {
  enabled: boolean;
  trackIndex: number;
  seekSeconds: number;
  lastUpdated: number;
};

export type RoomJoinResponse = {
  peers: RoomPeer[];
  messages: RoomMessage[];
  radio?: RoomRadioState;
  shardId: string;
  shardIndex: number;
  totalInShard: number;
};

export const BASE_ROOM_IDS = new Set<RoomKind>(['loft', 'roof', 'tea', 'beach']);
export const MAX_SHARD_PEERS = 35; // Maximum players per room shard before dynamically spinning up the next instance

const avatars = new Set<AvatarBody>(['man', 'uncle', 'photo_boy', 'self', 'woman', 'chinese_woman', 'nepali_woman', 'white_top_woman']);
const poses = new Set<RoomPose>(['idle', 'walk', 'run', 'jump', 'crouch_idle', 'crouch_walk', 'sit_enter', 'sit_idle', 'sit_exit']);
const peers = new Map<string, RoomPeer>();
const messages = new Map<string, RoomMessage[]>();
const roomRadios = new Map<string, RoomRadioState>();

// Default base radios
const defaultRadios: Record<RoomKind, RoomRadioState> = {
  tea: { enabled: false, trackIndex: 0, seekSeconds: 0, lastUpdated: Date.now() },
  beach: { enabled: false, trackIndex: 1, seekSeconds: 0, lastUpdated: Date.now() },
  loft: { enabled: false, trackIndex: 2, seekSeconds: 0, lastUpdated: Date.now() },
  roof: { enabled: false, trackIndex: 3, seekSeconds: 0, lastUpdated: Date.now() },
};

export const channel = (shardId: string) => `presence:${shardId}`;

export function parseRoomInput(roomInput: string): { baseRoom: RoomKind; shardIndex?: number } | null {
  if (!roomInput || typeof roomInput !== 'string') return null;
  const parts = roomInput.trim().split(':');
  const base = parts[0] as RoomKind;
  if (!BASE_ROOM_IDS.has(base)) return null;
  const shardNum = parts[1] ? parseInt(parts[1], 10) : undefined;
  return { baseRoom: base, shardIndex: shardNum && shardNum > 0 ? shardNum : undefined };
}

export function getShardPeerCount(io: Server, shardId: string): number {
  return io.sockets.adapter.rooms.get(channel(shardId))?.size ?? 0;
}

export function resolveShard(io: Server, baseRoom: RoomKind, preferredShardIndex?: number): { shardId: string; shardIndex: number } {
  // 1. If explicit shard requested, attempt to place user in that shard if below grace capacity
  if (preferredShardIndex && preferredShardIndex > 0) {
    const requestedShardId = `${baseRoom}:${preferredShardIndex}`;
    const count = getShardPeerCount(io, requestedShardId);
    if (count < MAX_SHARD_PEERS + 10) {
      return { shardId: requestedShardId, shardIndex: preferredShardIndex };
    }
  }

  // 2. Auto-assignment: Scan sequentially starting from Shard 1 to pack instances efficiently
  let candidateIndex = 1;
  while (candidateIndex <= 200) {
    const candidateId = `${baseRoom}:${candidateIndex}`;
    const count = getShardPeerCount(io, candidateId);
    if (count < MAX_SHARD_PEERS) {
      return { shardId: candidateId, shardIndex: candidateIndex };
    }
    candidateIndex++;
  }

  return { shardId: `${baseRoom}:1`, shardIndex: 1 };
}

export function attachRoomHandlers(io: Server, socket: Socket) {
  const userId = socket.data.userId as string;
  const name = socket.data.name as string;

  const leave = () => {
    const shardId = socket.data.roomId as string | undefined;
    socket.data.roomId = undefined;
    socket.data.baseRoomId = undefined;
    peers.delete(socket.id);

    if (shardId) {
      socket.leave(channel(shardId));
      socket.to(channel(shardId)).emit('room:peer-left', { userId });
      const remaining = getShardPeerCount(io, shardId);
      if (remaining === 0) {
        const currentRadio = roomRadios.get(shardId);
        if (currentRadio) {
          currentRadio.enabled = false;
          currentRadio.seekSeconds = 0;
          currentRadio.lastUpdated = Date.now();
          roomRadios.set(shardId, currentRadio);
        }
      }
    }
  };

  socket.on('room:join', (input: { room?: string; avatar?: string; shard?: number | string }, ack?: Ack<RoomJoinResponse>) => {
    const parsed = parseRoomInput(input?.room ?? '');
    if (!parsed || !avatars.has(input?.avatar as AvatarBody)) {
      ack?.({ ok: false, error: 'Invalid room or avatar.' });
      return;
    }

    leave();

    const explicitShard = typeof input.shard === 'number'
      ? input.shard
      : typeof input.shard === 'string'
        ? parseInt(input.shard, 10)
        : parsed.shardIndex;

    const { shardId, shardIndex } = resolveShard(io, parsed.baseRoom, explicitShard);
    const peer: RoomPeer = { userId, name, avatar: input.avatar as AvatarBody, x: 0, z: 0, yaw: 0 };

    socket.data.roomId = shardId;
    socket.data.baseRoomId = parsed.baseRoom;
    socket.join(channel(shardId));
    peers.set(socket.id, peer);

    const existingPeers = [...io.sockets.adapter.rooms.get(channel(shardId)) ?? []]
      .filter(id => id !== socket.id)
      .map(id => peers.get(id))
      .filter((value): value is RoomPeer => !!value);

    // Get or initialize radio for this shard
    let currentRadio = roomRadios.get(shardId);
    if (!currentRadio) {
      const baseRadio = defaultRadios[parsed.baseRoom];
      currentRadio = { ...baseRadio, enabled: true, lastUpdated: Date.now() };
      roomRadios.set(shardId, currentRadio);
    } else if (existingPeers.length === 0) {
      currentRadio.enabled = true;
      currentRadio.lastUpdated = Date.now();
    }

    const shardMessages = messages.get(shardId) ?? [];
    ack?.({
      ok: true,
      value: {
        peers: existingPeers,
        messages: shardMessages,
        radio: currentRadio,
        shardId,
        shardIndex,
        totalInShard: existingPeers.length + 1,
      },
    });

    socket.to(channel(shardId)).emit('room:peer', peer);
  });

  socket.on('room:position', (input: { x?: number; y?: number; z?: number; yaw?: number; pose?: RoomPose }) => {
    const shardId = socket.data.roomId as string | undefined;
    const peer = peers.get(socket.id);
    if (!shardId || !peer || !Number.isFinite(input?.x) || !Number.isFinite(input?.z) || !Number.isFinite(input?.yaw) ||
      Math.abs(input.x!) > 100 || Math.abs(input.z!) > 100 ||
      (input.y !== undefined && (!Number.isFinite(input.y) || input.y < 0 || input.y > 3)) ||
      (input.pose !== undefined && !poses.has(input.pose))) return;

    Object.assign(peer, { x: input.x!, z: input.z!, yaw: input.yaw! });
    if (input.y !== undefined) peer.y = input.y;
    if (input.pose !== undefined) peer.pose = input.pose;

    socket.to(channel(shardId)).volatile.emit('room:peer', peer);
  });

  socket.on('room:message', (body: unknown, ack?: Ack<RoomMessage>) => {
    const shardId = socket.data.roomId as string | undefined;
    const value = typeof body === 'string' ? body.trim() : '';
    if (!shardId || !value || value.length > 500) {
      ack?.({ ok: false, error: 'Enter a message of up to 500 characters.' });
      return;
    }
    const message: RoomMessage = {
      id: `${socket.id}:${Date.now()}:${Math.random()}`,
      room: shardId,
      userId,
      name,
      body: value,
      createdAt: Date.now(),
    };
    const history = messages.get(shardId) ?? [];
    history.push(message);
    if (history.length > 50) history.shift();
    messages.set(shardId, history);

    io.to(channel(shardId)).emit('room:message', message);
    ack?.({ ok: true, value: message });
  });

  socket.on('room:radio-sync', (input: { enabled?: boolean; trackIndex?: number; seekSeconds?: number }) => {
    const shardId = socket.data.roomId as string | undefined;
    if (!shardId) return;
    const baseRoom = socket.data.baseRoomId as RoomKind | undefined;
    const fallback = baseRoom ? defaultRadios[baseRoom] : defaultRadios.beach;
    const current = roomRadios.get(shardId) ?? { ...fallback, enabled: true, lastUpdated: Date.now() };

    if (typeof input?.enabled === 'boolean') current.enabled = input.enabled;
    if (typeof input?.trackIndex === 'number' && input.trackIndex >= 0 && input.trackIndex < 100) current.trackIndex = input.trackIndex;
    if (typeof input?.seekSeconds === 'number' && input.seekSeconds >= 0) current.seekSeconds = input.seekSeconds;

    current.lastUpdated = Date.now();
    roomRadios.set(shardId, current);
    socket.to(channel(shardId)).emit('room:radio-sync', current);
  });

  socket.on('room:shards', (roomKindInput: string, ack?: Ack<Array<{ shardId: string; shardIndex: number; count: number }>>) => {
    const parsed = parseRoomInput(roomKindInput);
    if (!parsed) {
      ack?.({ ok: false, error: 'Invalid room.' });
      return;
    }
    const base = parsed.baseRoom;
    const result: Array<{ shardId: string; shardIndex: number; count: number }> = [];
    for (let i = 1; i <= 20; i++) {
      const sid = `${base}:${i}`;
      const count = getShardPeerCount(io, sid);
      if (count > 0 || i === 1) {
        result.push({ shardId: sid, shardIndex: i, count });
      }
    }
    ack?.({ ok: true, value: result });
  });

  socket.on('room:leave', leave);
  socket.on('disconnect', leave);
}
