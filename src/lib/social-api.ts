import { API_BASE_URL, authStorage } from './auth-client';

export type PublicProfile = { id: string; name: string; username: string; lastMessage?: string | null; lastAt?: string | null };
export type OwnProfile = PublicProfile & { friendCode: string };
export type ChatGroup = { id: string; name: string; memberCount: number; createdAt: string; lastMessage?: string | null; lastAt?: string | null };
export type ChatMessage = { id: string; body: string; senderId: string; senderName: string; createdAt: string };

export async function socialApi<T>(path: string, method: 'GET' | 'POST' | 'PATCH' = 'GET', body?: object): Promise<T> {
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
