import { randomUUID } from 'node:crypto';
import type { Server, Socket } from 'socket.io';
import { pool } from '../../db/pool.js';
import { sendCallPush } from './push.js';
import { isBlockedPair } from '../social/safety.js';

export type CallTarget = { kind: 'direct' | 'group'; id: string };
export type CallMedia = 'audio' | 'video';
export type CallInfo = { id: string; target: CallTarget; media: CallMedia; callerId: string; callerName: string; members: string[]; joined: string[]; expiresAt: number };
type Call = CallInfo & { timer: ReturnType<typeof setTimeout>; declined: Set<string>; pendingSignals: Map<string, Array<{ from: string; signal: unknown }>> };
type Ack<T> = (result: { ok: true; value: T } | { ok: false; error: string }) => void;

const calls = new Map<string, Call>();
export function canJoinCallMedia(callId: string, userId: string): boolean {
  return calls.get(callId)?.joined.includes(userId) ?? false;
}
export function callMediaKind(callId: string): CallMedia | undefined {
  return calls.get(callId)?.media;
}
const userRoom = (id: string) => `user:${id}`;
const safeTarget = (value: unknown): value is CallTarget =>
  !!value && typeof value === 'object' && 'kind' in value && 'id' in value &&
  (value.kind === 'direct' || value.kind === 'group') && typeof value.id === 'string' && value.id.length > 0 && value.id.length < 100;
const publicCall = ({ timer: _timer, declined: _declined, ...call }: Call): CallInfo => call;

async function getMembers(target: CallTarget, callerId: string): Promise<string[]> {
  if (target.kind === 'direct') {
    if (await isBlockedPair(callerId, target.id)) throw new Error('This contact is unavailable.');
    const [a, b] = [callerId, target.id].sort();
    const result = await pool.query('SELECT 1 FROM "contact" WHERE "userA" = $1 AND "userB" = $2', [a, b]);
    if (result.rowCount !== 1) throw new Error('This contact is unavailable.');
    return [callerId, target.id];
  }
  const result = await pool.query<{ userId: string }>('SELECT "userId" FROM "chat_group_member" WHERE "groupId" = $1', [target.id]);
  const ids = result.rows.map(row => row.userId);
  if (!ids.includes(callerId)) throw new Error('This group is unavailable.');
  return ids;
}

function closeCall(io: Server, call: Call, reason: string) {
  clearTimeout(call.timer);
  calls.delete(call.id);
  io.to(call.members.map(userRoom)).emit('call:ended', { callId: call.id, target: call.target, reason });
}

export function attachCallHandlers(io: Server, socket: Socket) {
  const selfId = socket.data.userId as string;
  socket.on('call:pending', (ack?: Ack<CallInfo[]>) => {
    ack?.({
      ok: true,
      value: [...calls.values()]
        .filter(call => call.members.includes(selfId) && !call.joined.includes(selfId) && !call.declined.has(selfId) && (call.target.kind === 'group' ? call.joined.length > 0 : call.expiresAt > Date.now()))
        .map(publicCall),
    });
  });
  socket.on('call:start', async (input: unknown, ack?: Ack<CallInfo>) => {
    try {
      if (!input || typeof input !== 'object' || !('target' in input) || !safeTarget(input.target) ||
        !('media' in input) || (input.media !== 'audio' && input.media !== 'video')) throw new Error('Invalid call.');
      const target = input.target;
      const members = await getMembers(target, selfId);
      const existing = [...calls.values()].find(call => call.target.kind === target.kind && call.target.id === target.id && call.members.includes(selfId) && call.joined.length > 0);
      if (existing) { ack?.({ ok: true, value: publicCall(existing) }); return; }
      const id = randomUUID();
      const expiresAt = target.kind === 'group' ? Date.now() + 86400_000 : Date.now() + 45_000;
      const call: Call = {
        id, target, media: input.media, callerId: selfId, callerName: socket.data.name as string,
        members, joined: [selfId], declined: new Set(), expiresAt,
        pendingSignals: new Map(),
        timer: setTimeout(() => {
          const current = calls.get(id);
          if (current && current.target.kind === 'direct' && current.joined.length === 1) closeCall(io, current, 'No answer');
        }, 45_000),
      };
      calls.set(id, call);
      ack?.({ ok: true, value: publicCall(call) });
      io.to(members.map(userRoom)).emit('call:active', publicCall(call));
      io.to(members.filter(id => id !== selfId).map(userRoom)).emit('call:invite', publicCall(call));
      void sendCallPush(members.filter(id => id !== selfId), call).catch(error => console.warn('[ADDA] Call push failed:', error));
    } catch (error) { ack?.({ ok: false, error: error instanceof Error ? error.message : 'Could not start call.' }); }
  });
  socket.on('call:current', async (target: unknown, ack?: Ack<CallInfo | null>) => {
    try {
      if (!safeTarget(target) || !(await getMembers(target, selfId)).includes(selfId)) throw new Error('Call unavailable.');
      const call = [...calls.values()].find(item => item.target.kind === target.kind && item.target.id === target.id && item.joined.length > 0);
      ack?.({ ok: true, value: call ? publicCall(call) : null });
    } catch (error) { ack?.({ ok: false, error: error instanceof Error ? error.message : 'Could not find call.' }); }
  });
  socket.on('call:join', (callId: unknown, ack?: Ack<CallInfo>) => {
    const call = typeof callId === 'string' ? calls.get(callId) : undefined;
    if (!call || !call.members.includes(selfId)) { ack?.({ ok: false, error: 'Call has ended.' }); return; }
    const newlyJoined = !call.joined.includes(selfId);
    if (newlyJoined) call.joined.push(selfId);
    call.declined.delete(selfId);
    if (call.joined.length > 1) clearTimeout(call.timer);
    ack?.({ ok: true, value: publicCall(call) });
    io.to(call.members.map(userRoom)).emit('call:participant-joined', { callId, userId: selfId, joined: call.joined });

    // Deliver any signals queued while this peer was connecting
    const queued = call.pendingSignals.get(selfId);
    if (queued && queued.length > 0) {
      call.pendingSignals.delete(selfId);
      for (const item of queued) {
        io.to(userRoom(selfId)).emit('call:signal', { callId: call.id, from: item.from, signal: item.signal });
      }
    }
  });
  socket.on('call:ready', (callId: unknown) => {
    const call = typeof callId === 'string' ? calls.get(callId) : undefined;
    if (!call || !call.joined.includes(selfId)) return;
    if (call.target.kind === 'direct') {
      const otherId = call.joined.find(id => id !== selfId);
      if (otherId) io.to(userRoom(otherId)).emit('call:ready', { callId, from: selfId });
    } else {
      for (const otherId of call.joined) {
        if (otherId !== selfId) io.to(userRoom(otherId)).emit('call:ready', { callId, from: selfId });
      }
    }
  });
  socket.on('call:signal', (input: unknown) => {
    if (!input || typeof input !== 'object' || !('callId' in input) || !('to' in input) || !('signal' in input) ||
      typeof input.callId !== 'string' || typeof input.to !== 'string') return;
    const call = calls.get(input.callId);
    if (!call || !call.joined.includes(selfId) || !call.members.includes(input.to)) return;
    if (JSON.stringify(input.signal).length > 65_536) return;

    if (call.joined.includes(input.to)) {
      io.to(userRoom(input.to)).emit('call:signal', { callId: input.callId, from: selfId, signal: input.signal });
    } else {
      // Buffer early ICE candidates or offer until recipient finishes joining
      if (!call.pendingSignals.has(input.to)) call.pendingSignals.set(input.to, []);
      call.pendingSignals.get(input.to)!.push({ from: selfId, signal: input.signal });
    }
  });
  socket.on('call:leave', (callId: unknown) => {
    const call = typeof callId === 'string' ? calls.get(callId) : undefined;
    if (!call || !call.joined.includes(selfId)) return;
    call.joined = call.joined.filter(id => id !== selfId);
    io.to(call.members.map(userRoom)).emit('call:participant-left', { callId, userId: selfId, joined: call.joined });
    if (call.target.kind === 'direct' || call.joined.length === 0) closeCall(io, call, 'Call ended');
  });
  socket.on('call:decline', (callId: unknown) => {
    const call = typeof callId === 'string' ? calls.get(callId) : undefined;
    if (!call || !call.members.includes(selfId) || call.joined.includes(selfId)) return;
    if (call.target.kind === 'direct') closeCall(io, call, 'Declined');
    else {
      call.declined.add(selfId);
      io.to(userRoom(call.callerId)).emit('call:declined', { callId, userId: selfId });
    }
  });
  socket.on('disconnect', () => {
    setTimeout(() => {
      void io.in(userRoom(selfId)).fetchSockets().then(online => {
        if (online.length) return;
        for (const call of [...calls.values()]) {
          if (!call.joined.includes(selfId)) continue;
          call.joined = call.joined.filter(id => id !== selfId);
          io.to(call.members.map(userRoom)).emit('call:participant-left', { callId: call.id, userId: selfId, joined: call.joined });
          if (call.target.kind === 'direct' || call.joined.length === 0) closeCall(io, call, 'Disconnected');
        }
      });
    }, 1500);
  });
}
