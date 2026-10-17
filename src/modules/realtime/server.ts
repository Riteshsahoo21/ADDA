import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { auth } from '../auth/auth.js';
import { env } from '../../config/env.js';
import { pool } from '../../db/pool.js';
import { attachCallHandlers } from './calls.js';
import { attachMediaHandlers } from './media.js';
import { attachRoomHandlers } from './rooms.js';
import { attachPushHandlers } from './push.js';

type ChatKind = 'direct' | 'group';
type ChatTarget = { kind: ChatKind; id: string };
type ChatMessage = { id: string; body: string; senderId: string; senderName: string; createdAt: string; kind: ChatKind; targetId: string };
type Ack<T> = (result: { ok: true; value: T } | { ok: false; error: string }) => void;

let io: Server | undefined;
const userRoom = (id: string) => `user:${id}`;
const chatRoom = ({ kind, id }: ChatTarget) => `chat:${kind}:${id}`;
const validTarget = (value: unknown): value is ChatTarget =>
  !!value && typeof value === 'object' && 'kind' in value && 'id' in value &&
  (value.kind === 'direct' || value.kind === 'group') && typeof value.id === 'string' && value.id.length > 0 && value.id.length < 100;

async function canAccess(userId: string, target: ChatTarget): Promise<boolean> {
  if (target.kind === 'group') {
    const result = await pool.query('SELECT 1 FROM "chat_group_member" WHERE "groupId" = $1 AND "userId" = $2', [target.id, userId]);
    return result.rowCount === 1;
  }
  const [a, b] = [userId, target.id].sort();
  const result = await pool.query('SELECT 1 FROM "contact" WHERE "userA" = $1 AND "userB" = $2', [a, b]);
  return result.rowCount === 1;
}

async function listeners(target: ChatTarget, senderId: string): Promise<string[]> {
  if (target.kind === 'direct') return [senderId, target.id];
  const result = await pool.query<{ userId: string }>('SELECT "userId" FROM "chat_group_member" WHERE "groupId" = $1', [target.id]);
  return result.rows.map(row => row.userId);
}

export async function publishMessage(message: ChatMessage): Promise<void> {
  if (message.kind === 'direct') {
    io?.to(userRoom(message.senderId)).emit('chat:message', message);
    io?.to(userRoom(message.targetId)).emit('chat:message', { ...message, targetId: message.senderId });
    return;
  }
  const ids = await listeners({ kind: message.kind, id: message.targetId }, message.senderId);
  io?.to(ids.map(userRoom)).emit('chat:message', message);
}

export function publishFriendUpdate(userIds: string[]): void {
  io?.to(userIds.map(userRoom)).emit('friends:updated');
}

export function publishEncryptedChatUpdate(userIds: string[]): void {
  if (userIds.length) io?.to([...new Set(userIds)].map(userRoom)).emit('chat:encrypted:update');
}

export function attachRealtime(httpServer: HttpServer): Server {
  io = new Server(httpServer, {
    cors: { origin: env.corsOrigins, credentials: true },
    maxHttpBufferSize: 65_536,
  });
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (typeof token !== 'string' || !token) return next(new Error('Sign in to continue.'));
      const session = await auth.api.getSession({ headers: new Headers({ Authorization: `Bearer ${token}` }) });
      if (!session) return next(new Error('Sign in to continue.'));
      socket.data.userId = session.user.id;
      socket.data.name = session.user.name;
      next();
    } catch { next(new Error('Could not verify session.')); }
  });
  io.on('connection', (socket: Socket) => {
    const selfId = socket.data.userId as string;
    socket.join(userRoom(selfId));
    attachCallHandlers(io!, socket);
    attachMediaHandlers(io!, socket);
    attachRoomHandlers(io!, socket);
    attachPushHandlers(socket);
    const typingAt = new Map<string, number>();
    const typingTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const typingRevision = new Map<string, number>();
    const emitTyping = async (target: ChatTarget, typing: boolean, revision: number) => {
      const ids = (await listeners(target, selfId)).filter(id => id !== selfId);
      if (typingRevision.get(chatRoom(target)) !== revision) return;
      if (ids.length) io!.to(ids.map(userRoom)).emit('chat:typing', { ...target, id: target.kind === 'direct' ? selfId : target.id, userId: selfId, name: socket.data.name, typing });
    };
    const stopTyping = (room: string) => {
      if (!typingAt.has(room)) return;
      const timer = typingTimers.get(room);
      if (timer) clearTimeout(timer);
      typingTimers.delete(room);
      typingAt.delete(room);
      const revision = (typingRevision.get(room) ?? 0) + 1;
      typingRevision.set(room, revision);
      const parts = room.split(':');
      if (parts.length === 3) void emitTyping({ kind: parts[1] as ChatKind, id: parts[2] }, false, revision).catch(() => {});
    };

    socket.on('chat:join', async (target: unknown, ack?: Ack<null>) => {
      try {
        if (!validTarget(target) || !(await canAccess(selfId, target))) throw new Error('Chat unavailable.');
        socket.join(chatRoom(target));
        ack?.({ ok: true, value: null });
      } catch (error) { ack?.({ ok: false, error: error instanceof Error ? error.message : 'Could not join chat.' }); }
    });
    socket.on('chat:leave', (target: unknown) => {
      if (validTarget(target)) { stopTyping(chatRoom(target)); socket.leave(chatRoom(target)); }
    });
    socket.on('chat:typing', (input: unknown) => {
      if (!input || typeof input !== 'object' || !('target' in input) || !('typing' in input) || !validTarget(input.target)) return;
      const target = input.target;
      const room = chatRoom(target);
      if (!socket.rooms.has(room) || typeof input.typing !== 'boolean') return;
      const now = Date.now();
      if (!input.typing) { stopTyping(room); return; }
      const previous = typingAt.get(room) ?? 0;
      typingAt.set(room, now);
      const old = typingTimers.get(room);
      if (old) clearTimeout(old);
      typingTimers.set(room, setTimeout(() => stopTyping(room), 3500));
      if (now - previous >= 1200) {
        const revision = (typingRevision.get(room) ?? 0) + 1;
        typingRevision.set(room, revision);
        void emitTyping(target, true, revision).catch(() => {});
      }
    });
    socket.on('chat:send', (_input: unknown, ack?: Ack<ChatMessage>) => {
      ack?.({ ok: false, error: 'Update ADDA to send encrypted messages.' });
    });
    socket.on('disconnect', () => { for (const room of typingTimers.keys()) stopTyping(room); });
  });
  return io;
}
