import { API_BASE_URL, authStorage } from './auth-client';

export type PublicProfile = {
  id: string;
  name: string;
  username: string;
  avatarUrl?: string | null;
  about?: string | null;
  lastMessage?: string | null;
  lastAt?: string | null;
  unreadCount?: number;
};
export type OwnProfile = PublicProfile & { friendCode: string; usernameChangedAt?: string | null; policyVersion?: string | null; policyAcceptedAt?: string | null; requiredPolicyVersion?: string };
export type ChatGroup = {
  id: string;
  name: string;
  description?: string;
  avatarUrl?: string | null;
  memberCount: number;
  createdAt: string;
  lastMessage?: string | null;
  lastAt?: string | null;
  unreadCount?: number;
};
export type GroupMember = {
  id: string;
  name: string;
  username: string;
  about: string;
  avatarUrl: string | null;
  role: 'admin' | 'member';
  joinedAt: string;
  isSelf: boolean;
};
export type GroupDetails = {
  id: string;
  name: string;
  description: string;
  avatarUrl: string | null;
  ownerId: string;
  isAdmin: boolean;
  memberCount: number;
  members: GroupMember[];
};
export type GroupMediaItem = {
  id: string;
  mediaKind: 'photo' | 'video';
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
};
export type ChatMessage = { id: string; body: string; senderId: string; senderName: string; createdAt: string };
export type FriendRequest = {
  id: string;
  senderId: string;
  recipientId: string;
  senderName: string;
  senderUsername: string;
  senderAvatarUrl?: string | null;
  recipientName: string;
  recipientUsername: string;
  recipientAvatarUrl?: string | null;
  createdAt: string;
  updatedAt?: string | null;
  status: 'pending' | 'accepted' | 'declined';
  dismissedBySender?: boolean;
};
export type SocialBundle = {
  me: OwnProfile;
  contacts: PublicProfile[];
  groups: ChatGroup[];
  people: PublicProfile[];
  friendRequests: FriendRequest[];
};

export type PublicServerInfo = {
  id: string;
  roomKind: 'loft' | 'roof' | 'tea' | 'beach';
  creatorId: string;
  creatorName: string;
  creatorAvatarUrl?: string | null;
  name: string;
  code: string;
  isPrivate: boolean;
  peerCount: number;
  maxPlayers?: number;
  createdAt: string;
};

export type ActiveGroupRoom = {
  id: string;
  groupId: string | null;
  groupName: string;
  groupAvatarUrl?: string | null;
  roomKind: 'loft' | 'roof' | 'tea' | 'beach';
  creatorId: string;
  creatorName: string;
  name?: string;
  isPrivate?: boolean;
  createdAt: string;
};

export type RoomInvitation = {
  id: string;
  roomId: string;
  groupId: string | null;
  groupName: string;
  roomKind: 'loft' | 'roof' | 'tea' | 'beach';
  roomName?: string | null;
  inviterId: string;
  inviterName: string;
  inviterAvatarUrl?: string | null;
  createdAt: string;
  isPrivate?: boolean;
};

export type HangoutUpdatesResponse = {
  activeRooms: ActiveGroupRoom[];
  invites: RoomInvitation[];
};

export async function socialApi<T>(path: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'GET', body?: object): Promise<T> {
  const token = await authStorage.getAccessToken();
  if (!token) throw new Error('Please sign in again.');
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/api${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Cannot reach ADDA. Check your connection and try again.');
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
  return result as T;
}
