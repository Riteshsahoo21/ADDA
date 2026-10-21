import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { auth } from '../auth/auth.js';
import { env } from '../../config/env.js';
import { pool } from '../../db/pool.js';
import { attachCallHandlers } from './calls.js';
import { attachRoomHandlers } from './rooms.js';
import { attachPushHandlers, sendEncryptedChatPush } from './push.js';
import {
  getCachedGroupMembers,
  getRecipientDevices,
  invalidateUserDeviceCache,
  getDevicePublicKey,
  checkCanAccessCached,
  isMessageProcessed,
  markMessageProcessed,
} from './cache.js';
import { hasAcceptedPolicy, isBlockedPair } from '../social/safety.js';

type ChatKind = 'direct' | 'group';
type ChatTarget = { kind: ChatKind; id: string };
type ChatMessage = { id: string; body: string; senderId: string; senderName: string; createdAt: string; kind: ChatKind; targetId: string };
type Ack<T> = (result: { ok: true; value: T } | { ok: false; error: string }) => void;

export type DirectEnvelope = {
  deliveryId?: string;
  messageId: string;
  senderId: string;
  senderDeviceId: string;
  senderPublicKey: string;
  senderName: string;
  kind: ChatKind;
  targetId: string;
  ciphertext: string;
  nonce: string;
  wrappedKey: string;
  wrapNonce: string;
  recipientDeviceId: string;
  createdAt: string;
};

let io: Server | undefined;
const chatRateBuckets = new Map<string, { startedAt: number; count: number }>();
function chatRateAllowed(userId: string): boolean {
  const now = Date.now();
  if (chatRateBuckets.size > 10_000) {
    for (const [id, bucket] of chatRateBuckets) if (now - bucket.startedAt > 120_000) chatRateBuckets.delete(id);
  }
  const bucket = chatRateBuckets.get(userId);
  if (!bucket || now - bucket.startedAt >= 60_000) {
    chatRateBuckets.set(userId, { startedAt: now, count: 1 });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= 60;
}
const userRoom = (id: string) => `user:${id}`;
const deviceRoom = (id: string) => `device:${id}`;
const chatRoom = ({ kind, id }: ChatTarget) => `chat:${kind}:${id}`;
const validTarget = (value: unknown): value is ChatTarget =>
  !!value && typeof value === 'object' && 'kind' in value && 'id' in value &&
  (value.kind === 'direct' || value.kind === 'group') && typeof value.id === 'string' && value.id.length > 0 && value.id.length < 100;

async function canAccess(userId: string, target: ChatTarget): Promise<boolean> {
  return checkCanAccessCached(userId, target);
}

async function listeners(target: ChatTarget, senderId: string): Promise<string[]> {
  if (target.kind === 'direct') return [senderId, target.id];
  const result = await pool.query<{ userId: string }>('SELECT "userId" FROM "chat_group_member" WHERE "groupId" = $1', [target.id]);
  return result.rows.map(row => row.userId);
}

export async function publishMessage(message: ChatMessage): Promise<void> {
  if (message.kind === 'direct') {
    io?.to(userRoom(message.senderId)).emit('chat:message', message);
    io?.to(userRoom(message.targetId)).emit('chat:message', { ...message, targetId: message.senderId });
    return;
  }
  const ids = await listeners({ kind: message.kind, id: message.targetId }, message.senderId);
  io?.to(ids.map(userRoom)).emit('chat:message', message);
}

import { invalidateSocialBundleCache } from '../social/cache.js';

export function publishFriendUpdate(userIds: string[], payload?: unknown): void {
  invalidateSocialBundleCache(userIds);
  io?.to(userIds.map(userRoom)).emit('friends:updated', payload);
}

export function publishEncryptedChatUpdate(userIds: string[]): void {
  if (userIds.length) io?.to([...new Set(userIds)].map(userRoom)).emit('chat:encrypted:update');
}

export function publishEncryptedEnvelope(userId: string, envelope: unknown): void {
  io?.to(userRoom(userId)).emit('chat:encrypted:envelope', envelope);
}

export function publishGroupUpdate(groupId: string, userIds: string[]): void {
  invalidateSocialBundleCache(userIds);
  if (userIds.length) io?.to([...new Set(userIds)].map(userRoom)).emit('group:updated', { groupId });
}

export function publishGroupRoomUpdate(userIds: string[], payload: unknown): void {
  if (userIds.length) io?.to([...new Set(userIds)].map(userRoom)).emit('group:room_updated', payload);
}

export function getIO(): Server | undefined {
  return io;
}

export function publishPublicRoomsUpdate(): void {
  io?.emit('rooms:public_updated');
}

async function drainOfflineSpool(socket: Socket, userId: string, deviceId?: string) {
  try {
    const spooled = await pool.query<{
      id: string;
      messageId: string;
      senderId: string;
      senderDeviceId: string;
      senderPublicKey: string;
      senderName: string;
      kind: ChatKind;
      targetId: string;
      ciphertext: string;
      nonce: string;
      wrappedKey: string;
      wrapNonce: string;
      recipientDeviceId: string;
      createdAt: string;
    }>(
      `SELECT id, "messageId", "senderId", "senderDeviceId", "senderPublicKey", "senderName",
              kind, "targetId", ciphertext, nonce, "wrappedKey", "wrapNonce",
              "recipientDeviceId", "createdAt"
       FROM chat_spool
       WHERE "recipientId" = $1 AND ($2::text IS NULL OR $2 = '' OR "recipientDeviceId" = $2)
       ORDER BY "createdAt" ASC
       LIMIT 300`,
      [userId, deviceId ?? null]
    );

    if (spooled.rowCount && spooled.rowCount > 0) {
      console.log(`[ADDA Spool] Draining ${spooled.rowCount} messages for user ${userId} (device: ${deviceId || 'any'})`);
      for (const row of spooled.rows) {
        socket.emit('chat:envelope', {
          deliveryId: row.id,
          messageId: row.messageId,
          senderId: row.senderId,
          senderDeviceId: row.senderDeviceId,
          senderPublicKey: row.senderPublicKey,
          senderName: row.senderName,
          kind: row.kind,
          targetId: row.targetId,
          ciphertext: row.ciphertext,
          nonce: row.nonce,
          wrappedKey: row.wrappedKey,
          wrapNonce: row.wrapNonce,
          recipientDeviceId: row.recipientDeviceId,
          createdAt: row.createdAt,
        });
      }
    }
  } catch (e) {
    console.warn('[ADDA] Drain spool warning:', e);
  }
}

export function attachRealtime(httpServer: HttpServer): Server {
  io = new Server(httpServer, {
    cors: { origin: env.corsOrigins, credentials: true },
    maxHttpBufferSize: 10_000_000,
  });

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (typeof token !== 'string' || !token) return next(new Error('Sign in to continue.'));
      const session = await auth.api.getSession({ headers: new Headers({ Authorization: `Bearer ${token}` }) });
      if (!session) return next(new Error('Sign in to continue.'));
      if (!(await hasAcceptedPolicy(session.user.id))) return next(new Error('Accept the ADDA Community Guidelines.'));
      socket.data.userId = session.user.id;
      socket.data.name = session.user.name;
      const deviceId = socket.handshake.auth?.deviceId;
      if (typeof deviceId === 'string' && deviceId) {
        socket.data.deviceId = deviceId;
      }
      next();
    } catch {
      next(new Error('Could not verify session.'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const selfId = socket.data.userId as string;
    const selfDeviceId = socket.data.deviceId as string | undefined;
    socket.join(userRoom(selfId));
    if (selfDeviceId) socket.join(deviceRoom(selfDeviceId));

    attachCallHandlers(io!, socket);
    attachRoomHandlers(io!, socket);
    attachPushHandlers(socket);

    // Drain pending offline messages for this user/device upon connection if deviceId is known
    if (selfDeviceId) {
      void drainOfflineSpool(socket, selfId, selfDeviceId);
    }

    // Allow client to trigger explicit spool drain upon device initialization or reconnect
    socket.on('chat:drain_spool', (data?: { deviceId?: string }) => {
      const devId = data?.deviceId || selfDeviceId || (socket.data.deviceId as string | undefined);
      if (data?.deviceId) {
        socket.data.deviceId = data.deviceId;
        socket.join(deviceRoom(data.deviceId));
      }
      void drainOfflineSpool(socket, selfId, devId);
    });

    const typingAt = new Map<string, number>();
    const typingTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const typingRevision = new Map<string, number>();
    const emitTyping = async (target: ChatTarget, typing: boolean, revision: number) => {
      if (!(await canAccess(selfId, target))) return;
      const ids = (await listeners(target, selfId)).filter(id => id !== selfId);
      if (typingRevision.get(chatRoom(target)) !== revision) return;
      if (ids.length) io!.to(ids.map(userRoom)).emit('chat:typing', { ...target, id: target.kind === 'direct' ? selfId : target.id, userId: selfId, name: socket.data.name, typing });
    };
    const stopTyping = (room: string) => {
      if (!typingAt.has(room)) return;
      const timer = typingTimers.get(room);
      if (timer) clearTimeout(timer);
      typingTimers.delete(room);
      typingAt.delete(room);
      const revision = (typingRevision.get(room) ?? 0) + 1;
      typingRevision.set(room, revision);
      const parts = room.split(':');
      if (parts.length === 3) void emitTyping({ kind: parts[1] as ChatKind, id: parts[2] }, false, revision).catch(() => {});
    };

    socket.on('chat:join', async (target: unknown, ack?: Ack<null>) => {
      try {
        if (!validTarget(target) || !(await canAccess(selfId, target))) throw new Error('Chat unavailable.');
        socket.join(chatRoom(target));
        ack?.({ ok: true, value: null });
      } catch (error) { ack?.({ ok: false, error: error instanceof Error ? error.message : 'Could not join chat.' }); }
    });
    socket.on('chat:leave', (target: unknown) => {
      if (validTarget(target)) { stopTyping(chatRoom(target)); socket.leave(chatRoom(target)); }
    });
    socket.on('chat:typing', (input: unknown) => {
      if (!input || typeof input !== 'object' || !('target' in input) || !('typing' in input) || !validTarget(input.target)) return;
      const target = input.target;
      const room = chatRoom(target);
      if (!socket.rooms.has(room) || typeof input.typing !== 'boolean') return;
      const now = Date.now();
      if (!input.typing) { stopTyping(room); return; }
      const previous = typingAt.get(room) ?? 0;
      typingAt.set(room, now);
      const old = typingTimers.get(room);
      if (old) clearTimeout(old);
      typingTimers.set(room, setTimeout(() => stopTyping(room), 3500));
      if (now - previous >= 1200) {
        const revision = (typingRevision.get(room) ?? 0) + 1;
        typingRevision.set(room, revision);
        void emitTyping(target, true, revision).catch(() => {});
      }
    });

    // ========================================================
    // WHATSAPP-GRADE HOT-PATH 1: INSTANT SOCKET ENCRYPTED SEND
    // ========================================================
    socket.on('chat:send_instant', async (
      payload: {
        messageId: string;
        senderDeviceId: string;
        target: ChatTarget;
        ciphertext: string;
        nonce: string;
        keys: Array<{ deviceId: string; publicKey?: string; wrappedKey: string; wrapNonce: string }>;
        mediaId?: string;
        mentions?: string[];
      },
      ack?: (res: { ok: boolean; timestamp?: string; error?: string }) => void
    ) => {
      try {
        const { messageId, senderDeviceId, target, ciphertext, nonce, keys, mediaId, mentions } = payload;
        if (typeof messageId !== 'string' || messageId.length > 100 || !messageId ||
          typeof senderDeviceId !== 'string' || senderDeviceId.length > 100 || !senderDeviceId ||
          !validTarget(target) || typeof ciphertext !== 'string' || !ciphertext ||
          typeof nonce !== 'string' || nonce.length > 256 || !nonce || !Array.isArray(keys) ||
          (mediaId != null && (typeof mediaId !== 'string' || mediaId.length > 100)) ||
          (mentions != null && (!Array.isArray(mentions) || mentions.length > 50 ||
            !mentions.every(id => typeof id === 'string' && id.length <= 100))) ||
          !keys.every(key => typeof key?.deviceId === 'string' && key.deviceId.length <= 100 &&
            (key.publicKey == null || (typeof key.publicKey === 'string' && key.publicKey.length <= 100)) &&
            typeof key.wrappedKey === 'string' && key.wrappedKey.length <= 1024 &&
            typeof key.wrapNonce === 'string' && key.wrapNonce.length <= 256)) {
          ack?.({ ok: false, error: 'Invalid message structure.' });
          return;
        }

        // 1. IN-MEMORY DEDUPLICATION (0ms)
        const previous = isMessageProcessed(messageId);
        if (previous) {
          if (previous.senderId === selfId) {
            ack?.({ ok: true, timestamp: previous.timestamp });
          } else {
            ack?.({ ok: false, error: 'Message ID already used.' });
          }
          return;
        }

        if (ciphertext.length > 32_768 || keys.length > 100) {
          ack?.({ ok: false, error: 'Chat unavailable.' });
          return;
        }
        if (!chatRateAllowed(selfId)) {
          ack?.({ ok: false, error: 'Too many messages. Please wait a moment.' });
          return;
        }
        if (!(await canAccess(selfId, target))) {
          ack?.({ ok: false, error: 'Chat unavailable.' });
          return;
        }

        const senderPublicKey = await getDevicePublicKey(senderDeviceId, selfId);
        if (!senderPublicKey) {
          ack?.({ ok: false, error: 'Register this device before sending.' });
          return;
        }

        const createdAt = new Date().toISOString();

        // 2. RESOLVE RECIPIENTS & CACHED DEVICES (0ms in RAM)
        const recipientUserIds: string[] = [];
        if (target.kind === 'direct') {
          recipientUserIds.push(target.id);
        } else {
          const allMembers = await getCachedGroupMembers(target.id);
          recipientUserIds.push(...allMembers.filter(uid => uid !== selfId));
        }

        const devices = await getRecipientDevices(recipientUserIds);
        if (target.kind === 'direct' && devices.length === 0) {
          ack?.({ ok: false, error: 'Recipient device keys are unavailable.' });
          return;
        }
        if (devices.some(device => !keys.some(key => key.deviceId === device.deviceId &&
          (key.publicKey == null || key.publicKey === device.publicKey)))) {
          ack?.({ ok: false, error: 'Recipient device keys changed. Refresh and try again.' });
          return;
        }

        // 3. BUILD ENVELOPES IN MEMORY (0.1ms)
        const spoolRows: any[] = [];
        const pushUserIds = new Set<string>();
        const offlineEnvelopesByUser = new Map<string, DirectEnvelope>();
        const envelopes: Array<{ userId: string; envelope: DirectEnvelope }> = [];

        for (const dev of devices) {
          const keyEntry = keys.find(k => k.deviceId === dev.deviceId);
          if (!keyEntry) continue;

          const envelope: DirectEnvelope = {
            messageId,
            senderId: selfId,
            senderDeviceId,
            senderPublicKey,
            senderName: socket.data.name || 'ADDA',
            kind: target.kind,
            targetId: target.id,
            ciphertext,
            nonce,
            wrappedKey: keyEntry.wrappedKey,
            wrapNonce: keyEntry.wrapNonce,
            recipientDeviceId: dev.deviceId,
            createdAt,
          };

          const isOnline = io!.sockets.adapter.rooms.has(deviceRoom(dev.deviceId)) ||
                           io!.sockets.adapter.rooms.has(userRoom(dev.userId));

          envelopes.push({ userId: dev.userId, envelope });
          if (!isOnline) {
            pushUserIds.add(dev.userId);
            if (!offlineEnvelopesByUser.has(dev.userId)) {
              offlineEnvelopesByUser.set(dev.userId, envelope);
            }
          }

          spoolRows.push([
            messageId, selfId, senderDeviceId, dev.userId, dev.deviceId,
            target.kind, target.id, ciphertext, nonce, keyEntry.wrappedKey, keyEntry.wrapNonce,
            senderPublicKey, socket.data.name || 'ADDA', createdAt
          ]);
        }

        // One atomic database round trip saves the sent ID and every encrypted
        // recipient envelope before we notify phones or confirm the send.
        const persistSql = `
          WITH sent AS (
            INSERT INTO chat_sent_id ("messageId", "senderId", kind, "targetId")
            VALUES ($1, $2, $3, $4)
            ON CONFLICT DO NOTHING RETURNING "messageId"
          )
          INSERT INTO chat_spool (
            "messageId", "senderId", "senderDeviceId", "recipientId", "recipientDeviceId",
            kind, "targetId", ciphertext, nonce, "wrappedKey", "wrapNonce",
            "senderPublicKey", "senderName", "createdAt"
          )
          SELECT pending.* FROM UNNEST(
            $5::text[], $6::text[], $7::text[], $8::text[], $9::text[],
            $10::text[], $11::text[], $12::text[], $13::text[], $14::text[],
            $15::text[], $16::text[], $17::text[], $18::timestamptz[]
          ) AS pending
          WHERE EXISTS (SELECT 1 FROM sent)
        `;
        const persistParams = [
          messageId, selfId, target.kind, target.id,
          ...Array.from({ length: 14 }, (_, index) => spoolRows.map(row => row[index])),
        ];
        if (mediaId) {
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            await client.query(persistSql, persistParams);
            await client.query(
              'UPDATE chat_media SET "messageId" = $1 WHERE id = $2 AND "ownerId" = $3',
              [messageId, mediaId, selfId]
            );
            await client.query('COMMIT');
          } catch (dbErr) {
            await client.query('ROLLBACK').catch(() => {});
            throw dbErr;
          } finally {
            client.release();
          }
        } else {
          await pool.query(persistSql, persistParams);
        }

        if (pushUserIds.size > 0) {
          void sendEncryptedChatPush(
            [...pushUserIds], target, socket.data.name || 'ADDA', selfId,
            undefined, undefined, offlineEnvelopesByUser, mentions
          ).catch((error) => console.warn('[ADDA] Push send warning:', error));
        }

        markMessageProcessed(messageId, selfId, createdAt);
        for (const { userId, envelope } of envelopes) {
          // Send to every connection for this account. A stale device-room
          // membership must not divert an envelope away from the active phone.
          // Each phone ignores envelopes addressed to another device.
          io!.to(userRoom(userId)).emit('chat:envelope', envelope);
        }
        ack?.({ ok: true, timestamp: createdAt });
      } catch (err: any) {
        ack?.({ ok: false, error: err?.message || 'Send error' });
      }
    });

    // ========================================================
    // WHATSAPP-GRADE HOT-PATH 2: DELIVERY ACK (Double Gray Tick ✓✓)
    // ========================================================
    socket.on('chat:ack_delivery', async (data: { messageId: string; senderId: string; recipientDeviceId: string }, ack?: (result: { ok: boolean }) => void) => {
      const deviceId = data?.recipientDeviceId || (socket.data.deviceId as string | undefined);
      if (!data?.messageId || !data?.senderId || !deviceId) { ack?.({ ok: false }); return; }
      ack?.({ ok: await processDeliveryAck(data.messageId, selfId, data.senderId, deviceId) });
    });

    // ========================================================
    // WHATSAPP-GRADE HOT-PATH 3: READ ACK (Double Blue Tick ✓✓)
    // ========================================================
    socket.on('chat:ack_read', async (data: { messageIds: string[]; senderId: string; recipientDeviceId?: string }, ack?: (result: { ok: boolean }) => void) => {
      const deviceId = data?.recipientDeviceId || (socket.data.deviceId as string | undefined);
      if (!Array.isArray(data?.messageIds) || !data?.senderId || !deviceId || data.messageIds.length === 0) { ack?.({ ok: false }); return; }
      ack?.({ ok: await processReadAck(data.messageIds, selfId, data.senderId, deviceId) });
    });

    // ========================================================
    // WHATSAPP DELETE FOR EVERYONE
    // ========================================================
    socket.on('chat:delete_for_everyone', async (data: { messageId: string; target: ChatTarget }) => {
      if (!data?.messageId || !validTarget(data?.target)) return;
      try {
        if (!(await canAccess(selfId, data.target))) return;
        const owned = await pool.query(
          'SELECT 1 FROM chat_sent_id WHERE "messageId" = $1 AND "senderId" = $2 AND kind = $3 AND "targetId" = $4',
          [data.messageId, selfId, data.target.kind, data.target.id]);
        if (!owned.rowCount) return;
        await pool.query('DELETE FROM chat_spool WHERE "messageId" = $1', [data.messageId]).catch(() => {});
        const targetIds = await listeners(data.target, selfId);
        io?.to(targetIds.map(userRoom)).emit('chat:message_deleted', {
          messageId: data.messageId,
          target: data.target,
          deletedBy: selfId,
        });
      } catch (e) {
        console.warn('[ADDA] Delete for everyone warning:', e);
      }
    });

    // ========================================================
    // WHATSAPP EMOJI REACTIONS
    // ========================================================
    socket.on('chat:reaction', async (data: { messageId: string; target: ChatTarget; emoji: string; action?: 'set' | 'remove' }) => {
      if (!data?.messageId || !validTarget(data?.target) || typeof data.emoji !== 'string') return;
      try {
        if (!(await canAccess(selfId, data.target))) return;
        const targetIds = await listeners(data.target, selfId);
        io?.to(targetIds.map(userRoom)).emit('chat:reaction_updated', {
          messageId: data.messageId,
          target: data.target,
          userId: selfId,
          userName: socket.data.name || 'User',
          emoji: data.emoji,
          action: data.action,
        });
      } catch (e) {
        console.warn('[ADDA] Reaction broadcast warning:', e);
      }
    });

    socket.on('disconnect', () => {
      for (const room of typingTimers.keys()) stopTyping(room);
    });
  });

  return io;
}

export async function processDeliveryAck(messageId: string, recipientId: string, senderId: string, recipientDeviceId: string): Promise<boolean> {
  try {
    const del = await pool.query<{ senderId: string; kind: string; targetId: string }>(
      'DELETE FROM chat_spool WHERE "messageId" = $1 AND "recipientId" = $2 AND "recipientDeviceId" = $3 AND "senderId" = $4 RETURNING "senderId", kind, "targetId"',
      [messageId, recipientId, recipientDeviceId, senderId]
    );
    const row = del.rows[0];
    // Duplicate receipts are expected when the global and open-chat listeners
    // both observe the same envelope. Its device copy was already removed.
    if (!row) return true;
    const isGroup = row ? row.kind === 'group' : false;

    if (io) {
      if (!isGroup) {
        // Direct chat: recipient wrote message to SQLite, notify sender immediately (✓✓ Double Grey Tick)
        io.to(userRoom(senderId)).emit('chat:msg_status', {
          messageId,
          status: 'delivered',
          recipientId
        });
      } else {
        // Group chat: notify sender which member delivered, and check if all group members have received and saved
        io.to(userRoom(senderId)).emit('chat:msg_status', {
          messageId,
          status: 'delivered',
          recipientId
        });
        const pending = await pool.query('SELECT 1 FROM chat_spool WHERE "messageId" = $1 LIMIT 1', [messageId]);
        if ((pending.rowCount ?? 0) === 0) {
          io.to(userRoom(senderId)).emit('chat:msg_status', {
            messageId,
            status: 'delivered'
          });
        }
      }
    }
    return true;
  } catch (err) {
    console.warn('[ADDA Spool] processDeliveryAck error:', err);
    return false;
  }
}

export async function processReadAck(messageIds: string[], recipientId: string, senderId: string, recipientDeviceId?: string): Promise<boolean> {
  if (messageIds.length === 0) return false;
  try {
    // Older clients omit the device ID. Keep their pending encrypted copies
    // rather than deleting another signed-in phone's copy by account ID.
    if (recipientDeviceId) {
      await pool.query(
        'DELETE FROM chat_spool WHERE "messageId" = ANY($1::text[]) AND "recipientId" = $2 AND "recipientDeviceId" = $3 AND "senderId" = $4',
        [messageIds, recipientId, recipientDeviceId, senderId]
      );
    }
    if (io) {
      io.to(userRoom(senderId)).emit('chat:msg_status', {
        messageIds,
        status: 'read',
        recipientId
      });
    }

    return true;
  } catch (err) {
    console.warn('[ADDA Spool] processReadAck error:', err);
    return false;
  }
}
