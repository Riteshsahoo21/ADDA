import { getRealtimeSocket } from './realtime';
import type { AvatarBody } from '@/three/player/avatarStyle';

export type RoomPose = 'idle' | 'walk' | 'run' | 'jump' | 'crouch_idle' | 'crouch_walk' | 'sit_enter' | 'sit_idle' | 'sit_exit' | 'lounger_idle';
export type RoomMotionSnapshot = { x: number; y: number; z: number; yaw: number; pose: RoomPose };
export type RoomPeer = { userId: string; name: string; avatar: AvatarBody; x: number; y?: number; z: number; yaw: number; pose?: RoomPose };
export type RoomPeerMotion = { peer: RoomPeer; receivedAt: number };
export type RoomMessage = { id: string; room: string; userId: string; name: string; body: string; createdAt: number };
export type RoomRadioSync = { enabled: boolean; trackIndex: number; seekSeconds?: number; lastUpdated?: number };
export type RoomJoin = {
  peers: RoomPeer[];
  messages: RoomMessage[];
  radio?: RoomRadioSync;
  shardId?: string;
  shardIndex?: number;
  totalInShard?: number;
  ownerId?: string;
};

export async function sendRoomMessage(body: string): Promise<void> {
  const socket = await getRealtimeSocket();
  return new Promise((resolve, reject) => socket.timeout(8000).emit('room:message', body, (error: Error | null, result?: { ok: boolean; error?: string }) => {
    if (error || !result?.ok) reject(new Error(result?.error || 'Could not send room message.'));
    else resolve();
  }));
}

export async function kickRoomPeer(targetUserId: string): Promise<void> {
  const socket = await getRealtimeSocket();
  return new Promise((resolve, reject) => socket.timeout(8000).emit('room:kick', { targetUserId }, (error: Error | null, result?: { ok: boolean; error?: string }) => {
    if (error || !result?.ok) reject(new Error(result?.error || 'Could not kick player.'));
    else resolve();
  }));
}

export async function inviteToRoom(inviteeIds: string[]): Promise<number> {
  const socket = await getRealtimeSocket();
  return new Promise((resolve, reject) => socket.timeout(8000).emit('room:invite', { inviteeIds }, (error: Error | null, result?: { ok: boolean; value?: { invitedCount: number }; error?: string }) => {
    if (error || !result?.ok) reject(new Error(result?.error || 'Could not send room invites.'));
    else resolve(result.value?.invitedCount ?? 0);
  }));
}
