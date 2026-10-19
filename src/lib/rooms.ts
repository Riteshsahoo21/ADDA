import { getRealtimeSocket } from './realtime';
import type { AvatarBody } from '@/three/player/avatarStyle';

export type RoomPose = 'idle' | 'walk' | 'run' | 'jump' | 'crouch_idle' | 'crouch_walk' | 'sit_enter' | 'sit_idle' | 'sit_exit' | 'lounger_idle';
export type RoomMotionSnapshot = { x: number; y: number; z: number; yaw: number; pose: RoomPose };
export type RoomPeer = { userId: string; name: string; avatar: AvatarBody; x: number; y?: number; z: number; yaw: number; pose?: RoomPose };
export type RoomMessage = { id: string; room: string; userId: string; name: string; body: string; createdAt: number };
export type RoomRadioSync = { enabled: boolean; trackIndex: number; seekSeconds?: number; lastUpdated?: number };
export type RoomJoin = { peers: RoomPeer[]; messages: RoomMessage[]; radio?: RoomRadioSync };

export async function sendRoomMessage(body: string): Promise<void> {
  const socket = await getRealtimeSocket();
  return new Promise((resolve, reject) => socket.timeout(8000).emit('room:message', body, (error: Error | null, result?: { ok: boolean; error?: string }) => {
    if (error || !result?.ok) reject(new Error(result?.error || 'Could not send room message.'));
    else resolve();
  }));
}
