import type { Server, Socket } from 'socket.io';

type RoomId = 'loft' | 'roof' | 'tea' | 'beach';
type AvatarBody = 'man' | 'uncle' | 'photo_boy' | 'self' | 'woman' | 'chinese_woman' | 'nepali_woman' | 'white_top_woman';
type RoomPose = 'idle' | 'walk' | 'run' | 'jump' | 'crouch_idle' | 'crouch_walk' | 'sit_enter' | 'sit_idle' | 'sit_exit';
type RoomPeer = { userId: string; name: string; avatar: AvatarBody; x: number; y?: number; z: number; yaw: number; pose?: RoomPose };
type RoomMessage = { id: string; room: RoomId; userId: string; name: string; body: string; createdAt: number };
type Ack<T> = (reply: { ok: true; value: T } | { ok: false; error: string }) => void;

const roomIds = new Set(['loft', 'roof', 'tea', 'beach']);
const avatars = new Set(['man', 'uncle', 'photo_boy', 'self', 'woman', 'chinese_woman', 'nepali_woman', 'white_top_woman']);
const poses = new Set<RoomPose>(['idle', 'walk', 'run', 'jump', 'crouch_idle', 'crouch_walk', 'sit_enter', 'sit_idle', 'sit_exit']);
const peers = new Map<string, RoomPeer>();
const messages = new Map<RoomId, RoomMessage[]>();
const channel = (room: RoomId) => `presence:${room}`;

export function attachRoomHandlers(io: Server, socket: Socket) {
  const userId = socket.data.userId as string;
  const name = socket.data.name as string;
  const leave = () => {
    const room = socket.data.roomId as RoomId | undefined;
    socket.data.roomId = undefined;
    peers.delete(socket.id);
    if (room) { socket.leave(channel(room)); socket.to(channel(room)).emit('room:peer-left', { userId }); }
  };
  socket.on('room:join', (input: { room?: string; avatar?: string }, ack?: Ack<{ peers: RoomPeer[]; messages: RoomMessage[] }>) => {
    if (!input || !roomIds.has(input.room ?? '') || !avatars.has(input.avatar ?? '')) {
      ack?.({ ok: false, error: 'Invalid room or avatar.' }); return;
    }
    leave();
    const room = input.room as RoomId;
    const peer: RoomPeer = { userId, name, avatar: input.avatar as AvatarBody, x: 0, z: 0, yaw: 0 };
    socket.data.roomId = room;
    socket.join(channel(room));
    peers.set(socket.id, peer);
    const existing = [...io.sockets.adapter.rooms.get(channel(room)) ?? []]
      .filter(id => id !== socket.id).map(id => peers.get(id)).filter((value): value is RoomPeer => !!value);
    ack?.({ ok: true, value: { peers: existing, messages: messages.get(room) ?? [] } });
    socket.to(channel(room)).emit('room:peer', peer);
  });
  socket.on('room:position', (input: { x?: number; y?: number; z?: number; yaw?: number; pose?: RoomPose }) => {
    const room = socket.data.roomId as RoomId | undefined;
    const peer = peers.get(socket.id);
    if (!room || !peer || !Number.isFinite(input?.x) || !Number.isFinite(input?.z) || !Number.isFinite(input?.yaw) ||
      Math.abs(input.x!) > 100 || Math.abs(input.z!) > 100 ||
      (input.y !== undefined && (!Number.isFinite(input.y) || input.y < 0 || input.y > 3)) ||
      (input.pose !== undefined && !poses.has(input.pose))) return;
    Object.assign(peer, { x: input.x!, z: input.z!, yaw: input.yaw! });
    if (input.y !== undefined) peer.y = input.y;
    if (input.pose !== undefined) peer.pose = input.pose;
    socket.to(channel(room)).volatile.emit('room:peer', peer);
  });
  socket.on('room:message', (body: unknown, ack?: Ack<RoomMessage>) => {
    const room = socket.data.roomId as RoomId | undefined;
    const value = typeof body === 'string' ? body.trim() : '';
    if (!room || !value || value.length > 500) { ack?.({ ok: false, error: 'Enter a message of up to 500 characters.' }); return; }
    const message: RoomMessage = { id: `${socket.id}:${Date.now()}:${Math.random()}`, room, userId, name, body: value, createdAt: Date.now() };
    const history = messages.get(room) ?? [];
    history.push(message);
    if (history.length > 50) history.shift();
    messages.set(room, history);
    io.to(channel(room)).emit('room:message', message);
    ack?.({ ok: true, value: message });
  });
  socket.on('room:leave', leave);
  socket.on('disconnect', leave);
}
