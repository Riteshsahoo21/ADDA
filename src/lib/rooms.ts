import { getRealtimeSocket } from './realtime';
import type { AvatarBody } from '@/three/player/avatarStyle';

export type RoomPeer = { userId: string; name: string; avatar: AvatarBody; x: number; z: number; yaw: number };
export type RoomMessage = { id: string; room: string; userId: string; name: string; body: string; createdAt: number };
export type RoomJoin = { peers: RoomPeer[]; messages: RoomMessage[] };

export async function sendRoomMessage(body: string): Promise<void> {
  const socket = await getRealtimeSocket();
  return new Promise((resolve, reject) => socket.timeout(8000).emit('room:message', body, (error: Error | null, result?: { ok: boolean; error?: string }) => {
    if (error || !result?.ok) reject(new Error(result?.error || 'Could not send room message.'));
    else resolve();
  }));
}
