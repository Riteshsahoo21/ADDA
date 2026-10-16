import { io, type Socket } from 'socket.io-client';
import { API_BASE_URL, authStorage } from './auth-client';
import type { ChatMessage } from './social-api';

export type ChatTarget = { kind: 'direct' | 'group'; id: string };
export type LiveMessage = ChatMessage & { kind: ChatTarget['kind']; targetId: string };
export type TypingEvent = ChatTarget & { userId: string; name: string; typing: boolean };
type Result<T> = { ok: true; value: T } | { ok: false; error: string };

let socket: Socket | null = null;
let socketToken: string | null = null;

function waitConnected(live: Socket): Promise<Socket> {
  if (live.connected) return Promise.resolve(live);
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); live.off('connect', connected); live.off('connect_error', failed); };
    const connected = () => { cleanup(); resolve(live); };
    const failed = (error: Error) => { cleanup(); reject(error); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Live connection timed out.')); }, 10_000);
    live.once('connect', connected);
    live.once('connect_error', failed);
    if (!live.active) live.connect();
  });
}

export async function getRealtimeSocket(): Promise<Socket> {
  const token = await authStorage.getAccessToken();
  if (!token) throw new Error('Please sign in again.');
  if (socket && socketToken === token) {
    if (!socket.connected) socket.connect();
    return waitConnected(socket);
  }
  socket?.disconnect();
  socketToken = token;
  socket = io(API_BASE_URL, { auth: { token }, transports: ['websocket'], reconnection: true, autoConnect: true });
  return waitConnected(socket);
}

export function disconnectRealtime() {
  socket?.disconnect();
  socket = null;
  socketToken = null;
}

export async function sendLiveMessage(target: ChatTarget, body: string, clientId: string): Promise<LiveMessage> {
  const live = await getRealtimeSocket();
  if (!live.connected) throw new Error('Connecting to ADDA. Try again in a moment.');
  return new Promise((resolve, reject) => {
    live.timeout(10_000).emit('chat:send', { target, body, clientId }, (error: Error | null, result?: Result<LiveMessage>) => {
      if (error) reject(new Error('Message was not confirmed. Tap send again.'));
      else if (!result || !result.ok) reject(new Error(result?.error || 'Could not send message.'));
      else resolve(result.value);
    });
  });
}

export function makeClientMessageId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}
