import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import type { Socket } from 'socket.io';
import { env } from '../../config/env.js';
import { pool } from '../../db/pool.js';

const enabled = !!env.googleApplicationCredentials;
if (enabled) initializeApp({ credential: applicationDefault() });

export function attachPushHandlers(socket: Socket) {
  const userId = socket.data.userId as string;
  socket.on('push:register', async (token: unknown, ack?: (reply: { ok: boolean; error?: string }) => void) => {
    if (typeof token !== 'string' || token.length < 32 || token.length > 4096) { ack?.({ ok: false, error: 'Invalid push token.' }); return; }
    try {
      await pool.query('INSERT INTO push_device (token, "userId") VALUES ($1, $2) ON CONFLICT (token) DO UPDATE SET "userId" = $2, "updatedAt" = now()', [token, userId]);
      ack?.({ ok: true });
    } catch { ack?.({ ok: false, error: 'Could not register notifications.' }); }
  });
  socket.on('push:unregister', async (token: unknown) => {
    if (typeof token === 'string') await pool.query('DELETE FROM push_device WHERE token = $1 AND "userId" = $2', [token, userId]);
  });
}

export async function sendCallPush(userIds: string[], call: { id: string; callerName: string; media: 'audio' | 'video'; target: { kind: string } }) {
  if (!enabled || userIds.length === 0) return;
  const result = await pool.query<{ token: string }>('SELECT token FROM push_device WHERE "userId" = ANY($1::text[])', [userIds]);
  const tokens = result.rows.map(row => row.token);
  for (let start = 0; start < tokens.length; start += 500) {
    const batch = tokens.slice(start, start + 500);
    const response = await getMessaging().sendEachForMulticast({
      tokens: batch,
      notification: { title: `${call.callerName} is calling`, body: `Incoming ${call.target.kind === 'group' ? 'group ' : ''}${call.media} call` },
      data: { kind: 'call', callId: call.id, callerName: call.callerName, media: call.media },
      android: { priority: 'high', ttl: 45_000, notification: { channelId: 'adda_calls', priority: 'high', sound: 'default' } },
    });
    if (response.failureCount) {
      const codes = response.responses.filter(item => !item.success).map(item => item.error?.code ?? 'unknown');
      console.warn('[ADDA] Call push delivery failed:', response.failureCount, [...new Set(codes)].join(', '));
    }
    const stale = batch.filter((_token, index) => ['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'].includes(response.responses[index].error?.code ?? ''));
    if (stale.length) await pool.query('DELETE FROM push_device WHERE token = ANY($1::text[])', [stale]);
  }
}

export async function sendEncryptedChatPush(
  userIds: string[],
  target: { kind: 'direct' | 'group'; id: string; name?: string },
  senderName: string,
  senderId: string,
  previewText?: string,
  groupName?: string,
  envelopesByUser?: Map<string, any>,
  mentions?: string[]
) {
  if (!enabled || !userIds.length) return;
  const result = await pool.query<{ token: string; userId: string }>('SELECT token, "userId" FROM push_device WHERE "userId" = ANY($1::text[])', [userIds]);
  if (!result.rows.length) return;

  const chatName = target.name || (target.kind === 'group' ? (groupName || 'Group') : senderName);
  const title = target.kind === 'group' ? chatName : senderName;
  const body = previewText || (target.kind === 'group' ? `${senderName}: New message` : 'New message');
  const chatId = target.kind === 'direct' ? senderId : target.id;

  for (let start = 0; start < result.rows.length; start += 500) {
    const batch = result.rows.slice(start, start + 500);
    const messages = batch.map(row => {
      const envObj = envelopesByUser?.get(row.userId);
      const isMentioned = Boolean(mentions && (mentions.includes(row.userId) || mentions.includes('@everyone')));
      const notifTitle = isMentioned && target.kind === 'group'
        ? `${chatName} • ${senderName} mentioned you`
        : title;
      const notifBody = isMentioned && target.kind === 'group'
        ? `@You: ${previewText || 'New message'}`
        : body;

      const dataPayload: Record<string, string> = {
        kind: 'chat',
        chatKind: target.kind,
        chatId,
        chatName,
        name: chatName,
        senderName,
        isMention: isMentioned ? 'true' : 'false'
      };
      if (envObj) {
        dataPayload.envelope = JSON.stringify(envObj);
      }
      return {
        token: row.token,
        notification: { title: notifTitle, body: notifBody },
        data: dataPayload,
        android: {
          priority: 'high' as const,
          notification: {
            channelId: isMentioned ? 'adda_mentions' : 'adda_messages',
            priority: 'high' as const
          }
        },
      };
    });

    const sent = await getMessaging().sendEach(messages);
    const stale: string[] = [];
    sent.responses.forEach((res, index) => {
      if (!res.success && ['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'].includes(res.error?.code ?? '')) {
        stale.push(batch[index].token);
      }
    });
    if (stale.length) await pool.query('DELETE FROM push_device WHERE token = ANY($1::text[])', [stale]);
  }
}

export async function sendRoomInvitePush(
  userIds: string[],
  invite: {
    inviterName: string;
    groupName: string;
    roomKind: string;
    groupId: string;
    roomId: string;
    ownerId: string;
  }
) {
  if (!enabled || !userIds.length) return;
  const result = await pool.query<{ token: string; userId: string }>(
    'SELECT token, "userId" FROM push_device WHERE "userId" = ANY($1::text[])',
    [userIds]
  );
  if (!result.rows.length) return;

  const roomTitle = invite.roomKind === 'beach' ? 'Goa Beach'
    : invite.roomKind === 'tea' ? 'Tea Party'
    : invite.roomKind === 'roof' ? 'School Rooftop'
    : 'Loft 16';

  const title = `${invite.inviterName} invited you to Hangout!`;
  const body = `Join ${invite.inviterName} in ${invite.groupName}'s room (${roomTitle})`;

  for (let start = 0; start < result.rows.length; start += 500) {
    const batch = result.rows.slice(start, start + 500);
    const messages = batch.map(row => ({
      token: row.token,
      notification: { title, body },
      data: {
        kind: 'room_invite',
        groupId: invite.groupId,
        roomId: invite.roomId,
        roomKind: invite.roomKind,
        ownerId: invite.ownerId,
        groupName: invite.groupName,
        inviterName: invite.inviterName,
      },
      android: {
        priority: 'high' as const,
        notification: {
          channelId: 'adda_messages',
          priority: 'high' as const,
          sound: 'default',
        },
      },
    }));

    const sent = await getMessaging().sendEach(messages);
    const stale: string[] = [];
    sent.responses.forEach((res, index) => {
      if (!res.success && ['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'].includes(res.error?.code ?? '')) {
        stale.push(batch[index].token);
      }
    });
    if (stale.length) await pool.query('DELETE FROM push_device WHERE token = ANY($1::text[])', [stale]);
  }
}

