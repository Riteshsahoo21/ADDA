import { io, type Socket } from 'socket.io-client';
import { API_BASE_URL, authStorage } from './auth-client';
import type { ChatMessage } from './social-api';

export type ChatTarget = { kind: 'direct' | 'group'; id: string };
export type LiveMessage = ChatMessage & { kind: ChatTarget['kind']; targetId: string };
export type TypingEvent = ChatTarget & { userId: string; name: string; typing: boolean };

let socket: Socket | null = null;
let socketToken: string | null = null;
let currentDeviceId: string | null = null;

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

export function setRealtimeDeviceId(deviceId: string | null) {
  currentDeviceId = deviceId;
  if (socket && socket.connected && deviceId) {
    socket.auth = { ...(socket.auth as object), deviceId };
  }
}

export async function getRealtimeSocket(deviceId?: string): Promise<Socket> {
  const token = await authStorage.getAccessToken();
  if (!token) throw new Error('Please sign in again.');
  if (deviceId) currentDeviceId = deviceId;

  if (socket && socketToken === token) {
    if (currentDeviceId && (socket.auth as any)?.deviceId !== currentDeviceId) {
      socket.auth = { token, deviceId: currentDeviceId };
    }
    if (!socket.connected) socket.connect();
    return waitConnected(socket);
  }
  socket?.disconnect();
  socketToken = token;
  socket = io(API_BASE_URL, {
    auth: { token, deviceId: currentDeviceId },
    transports: ['websocket'],
    reconnection: true,
    autoConnect: true,
  });
  return waitConnected(socket);
}

export function getActiveSocket(): Socket | null {
  return socket;
}

export function disconnectRealtime() {
  socket?.disconnect();
  socket = null;
  socketToken = null;
}
