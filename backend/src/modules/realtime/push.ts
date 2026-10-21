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
      await pool.query('DELETE FROM push_device WHERE "userId" = $1 AND token != $2', [userId, token]);
      await pool.query('INSERT INTO push_device (token, "userId") VALUES ($1, $2) ON CONFLICT (token) DO UPDATE SET "userId" = $2, "updatedAt" = now()', [token, userId]);
      ack?.({ ok: true });
    } catch { ack?.({ ok: false, error: 'Could not register notifications.' }); }
  });
  socket.on('push:unregister', async (token: unknown) => {
    if (typeof token === 'string') await pool.query('DELETE FROM push_device WHERE token = $1 AND "userId" = $2', [token, userId]);
  });
}

export async function sendCallPush(userIds: string[], call: { id: string; callerName: string; media: 'audio' | 'video'; target: { kind: string; id: string } }) {
  if (!enabled || userIds.length === 0) return;
  const uniqueUserIds = [...new Set(userIds.filter(Boolean))];
  if (!uniqueUserIds.length) return;
  const result = await pool.query<{ token: string }>(
    `SELECT DISTINCT ON ("userId") token
     FROM push_device
     WHERE "userId" = ANY($1::text[])
     ORDER BY "userId", "updatedAt" DESC`,
    [uniqueUserIds]
  );
  const tokens = result.rows.map(row => row.token);
  const isGroup = call.target.kind === 'group';
  for (let start = 0; start < tokens.length; start += 500) {
    const batch = tokens.slice(start, start + 500);
    const title = isGroup ? `Group ${call.media} call` : `${call.callerName} is calling`;
    const body = isGroup ? `${call.callerName} started a group ${call.media} call` : `Incoming ${call.media} call`;
    const response = await getMessaging().sendEachForMulticast({
      tokens: batch,
      data: {
        kind: 'call',
        callId: call.id,
        callerName: call.callerName,
        media: call.media,
        chatKind: call.target.kind,
        chatId: call.target.id,
        categoryId: 'incoming_call',
        categoryIdentifier: 'incoming_call',
        title,
        body,
        message: body,
        channelId: 'adda_calls',
        sound: 'default',
        priority: 'max',
      },
      android: {
        priority: 'high',
        ttl: 45_000,
      },
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
  const uniqueUserIds = [...new Set(userIds.filter(Boolean))];
  if (!uniqueUserIds.length) return;
  const result = await pool.query<{ token: string; userId: string }>(
    `SELECT DISTINCT ON ("userId") token, "userId"
     FROM push_device
     WHERE "userId" = ANY($1::text[])
     ORDER BY "userId", "updatedAt" DESC`,
    [uniqueUserIds]
  );
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
    groupName?: string;
    roomKind: string;
    groupId?: string;
    roomId: string;
    ownerId: string;
    roomName?: string;
    isPrivate?: boolean;
  }
) {
  if (!enabled || !userIds.length) return;
  const uniqueUserIds = [...new Set(userIds.filter(Boolean))];
  if (!uniqueUserIds.length) return;
  const result = await pool.query<{ token: string; userId: string }>(
    `SELECT DISTINCT ON ("userId") token, "userId"
     FROM push_device
     WHERE "userId" = ANY($1::text[])
     ORDER BY "userId", "updatedAt" DESC`,
    [uniqueUserIds]
  );
  if (!result.rows.length) return;

  const roomTitle = invite.roomKind === 'beach' ? 'Goa Beach'
    : invite.roomKind === 'tea' ? 'Tea Party'
    : invite.roomKind === 'roof' ? 'School Rooftop'
    : 'Loft 16';

  const title = `${invite.inviterName} invited you to Hangout!`;
  const body = invite.roomName
    ? `Join ${invite.inviterName} in ${invite.roomName} (${roomTitle})`
    : invite.groupName
    ? `Join ${invite.inviterName} in ${invite.groupName}'s room (${roomTitle})`
    : `Join ${invite.inviterName} in ${roomTitle}`;

  for (let start = 0; start < result.rows.length; start += 500) {
    const batch = result.rows.slice(start, start + 500);
    const messages = batch.map(row => ({
      token: row.token,
      notification: { title, body },
      data: {
        kind: 'room_invite',
        groupId: invite.groupId || '',
        roomId: invite.roomId,
        roomKind: invite.roomKind,
        ownerId: invite.ownerId,
        groupName: invite.groupName || '',
        inviterName: invite.inviterName,
        roomName: invite.roomName || '',
        isPrivate: String(Boolean(invite.isPrivate)),
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
    console.log(`[ADDA Push] Dispatched room invite push to ${sent.responses.filter(r => r.success).length}/${batch.length} devices for room ${invite.roomId}`);
    const stale: string[] = [];
    sent.responses.forEach((res, index) => {
      if (!res.success && ['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'].includes(res.error?.code ?? '')) {
        stale.push(batch[index].token);
      }
    });
    if (stale.length) await pool.query('DELETE FROM push_device WHERE token = ANY($1::text[])', [stale]);
  }
}

