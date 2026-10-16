import { getRealtimeSocket, type ChatTarget } from './realtime';

export type CallMedia = 'audio' | 'video';
export type CallInfo = { id: string; target: ChatTarget; media: CallMedia; callerId: string; callerName: string; members: string[]; joined: string[]; expiresAt: number; usingRelay: boolean };
type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export async function callRequest<T>(event: string, payload: unknown): Promise<T> {
  const socket = await getRealtimeSocket();
  if (!socket.connected) throw new Error('Connecting to ADDA. Try again in a moment.');
  return new Promise((resolve, reject) => {
    socket.timeout(8000).emit(event, payload, (error: Error | null, result?: Result<T>) => {
      if (error) reject(new Error('Call request timed out.'));
      else if (!result || !result.ok) reject(new Error(result?.error || 'Call unavailable.'));
      else resolve(result.value);
    });
  });
}
