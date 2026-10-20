import { getRealtimeSocket } from './realtime';
import type { AvatarBody } from '@/three/player/avatarStyle';

export type RoomPose = 'idle' | 'walk' | 'run' | 'jump' | 'crouch_idle' | 'crouch_walk' | 'sit_enter' | 'sit_idle' | 'sit_exit' | 'lounger_idle';
export type RoomMotionSnapshot = { x: number; y: number; z: number; yaw: number; vx: number; vz: number; pose: RoomPose };
export type PlayerSnapshot = { id: string; x: number; y: number; z: number; r: number; pose: RoomPose; time: number };
export type RoomPeer = { userId: string; name: string; avatar: AvatarBody; motionId?: number; x: number; y?: number; z: number; yaw: number; vx?: number; vz?: number; pose?: RoomPose };
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

export async function deleteCurrentRoom(): Promise<void> {
  const socket = await getRealtimeSocket();
  return new Promise((resolve, reject) => socket.timeout(8000).emit('room:delete', {}, (error: Error | null, result?: { ok: boolean; error?: string }) => {
    if (error || !result?.ok) reject(new Error(result?.error || 'Could not delete room.'));
    else resolve();
  }));
}

export async function inviteToRoom(userIds: string[]): Promise<number> {
  const socket = await getRealtimeSocket();
  return new Promise((resolve, reject) => socket.timeout(10000).emit('room:invite', { inviteeIds: userIds }, (error: Error | null, result?: { ok: boolean; value?: { invitedCount: number }; error?: string }) => {
    if (error || !result?.ok) reject(new Error(result?.error || 'Could not send invitation.'));
    else resolve(result.value?.invitedCount ?? 0);
  }));
}

export async function inviteGroupToRoom(targetGroupId: string): Promise<number> {
  const socket = await getRealtimeSocket();
  return new Promise((resolve, reject) => socket.timeout(10000).emit('room:invite-group', { targetGroupId }, (error: Error | null, result?: { ok: boolean; value?: { invitedCount: number }; error?: string }) => {
    if (error || !result?.ok) reject(new Error(result?.error || 'Could not invite group.'));
    else resolve(result.value?.invitedCount ?? 0);
  }));
}

export async function fetchPublicRooms(): Promise<import('./social-api').PublicServerInfo[]> {
  const { socialApi } = await import('./social-api');
  const res = await socialApi<{ rooms: import('./social-api').PublicServerInfo[] }>('/rooms/public');
  return res.rooms || [];
}

export async function createRoomServer(payload: {
  roomKind: string;
  isPrivate: boolean;
  name?: string;
  maxPlayers?: number;
  groupInvites?: string[];
  userInvites?: string[];
}): Promise<import('./social-api').PublicServerInfo> {
  const { socialApi } = await import('./social-api');
  const res = await socialApi<{ ok: boolean; room: import('./social-api').PublicServerInfo }>('/rooms', 'POST', payload);
  return res.room;
}

export async function deleteRoomServer(roomId: string): Promise<void> {
  const { socialApi } = await import('./social-api');
  await socialApi(`/rooms/${roomId}`, 'DELETE');
}
