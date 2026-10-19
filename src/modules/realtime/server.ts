import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { auth } from '../auth/auth.js';
import { env } from '../../config/env.js';
import { pool } from '../../db/pool.js';
import { attachCallHandlers } from './calls.js';
import { attachMediaHandlers } from './media.js';
import { attachRoomHandlers } from './rooms.js';
import { attachPushHandlers, sendEncryptedChatPush } from './push.js';
import { getCachedGroupMembers, getRecipientDevices, invalidateUserDeviceCache } from './cache.js';

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
const userRoom = (id: string) => `user:${id}`;
const chatRoom = ({ kind, id }: ChatTarget) => `chat:${kind}:${id}`;
const validTarget = (value: unknown): value is ChatTarget =>
  !!value && typeof value === 'object' && 'kind' in value && 'id' in value &&
  (value.kind === 'direct' || value.kind === 'group') && typeof value.id === 'string' && value.id.length > 0 && value.id.length < 100;

async function canAccess(userId: string, target: ChatTarget): Promise<boolean> {
  if (target.kind === 'group') {
    const result = await pool.query('SELECT 1 FROM "chat_group_member" WHERE "groupId" = $1 AND "userId" = $2', [target.id, userId]);
    return result.rowCount === 1;
  }
  const [a, b] = [userId, target.id].sort();
  const result = await pool.query('SELECT 1 FROM "contact" WHERE "userA" = $1 AND "userB" = $2', [a, b]);
  return result.rowCount === 1;
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

export function publishFriendUpdate(userIds: string[], payload?: unknown): void {
  io?.to(userIds.map(userRoom)).emit('friends:updated', payload);
}

export function publishEncryptedChatUpdate(userIds: string[]): void {
  if (userIds.length) io?.to([...new Set(userIds)].map(userRoom)).emit('chat:encrypted:update');
}

export function publishEncryptedEnvelope(userId: string, envelope: unknown): void {
  io?.to(userRoom(userId)).emit('chat:encrypted:envelope', envelope);
}

export function publishGroupUpdate(groupId: string, userIds: string[]): void {
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
    maxHttpBufferSize: 65_536,
  });

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (typeof token !== 'string' || !token) return next(new Error('Sign in to continue.'));
      const session = await auth.api.getSession({ headers: new Headers({ Authorization: `Bearer ${token}` }) });
      if (!session) return next(new Error('Sign in to continue.'));
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

    attachCallHandlers(io!, socket);
    attachMediaHandlers(io!, socket);
    attachRoomHandlers(io!, socket);
    attachPushHandlers(socket);

    // Drain pending offline messages for this user/device upon connection
    void drainOfflineSpool(socket, selfId, selfDeviceId);

    // Allow client to trigger explicit spool drain upon device initialization or reconnect
    socket.on('chat:drain_spool', (data?: { deviceId?: string }) => {
      const devId = data?.deviceId || selfDeviceId || (socket.data.deviceId as string | undefined);
      if (data?.deviceId) socket.data.deviceId = data.deviceId;
      void drainOfflineSpool(socket, selfId, devId);
    });

    const typingAt = new Map<string, number>();
    const typingTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const typingRevision = new Map<string, number>();
    const emitTyping = async (target: ChatTarget, typing: boolean, revision: number) => {
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
        keys: Array<{ deviceId: string; wrappedKey: string; wrapNonce: string }>;
        mediaId?: string;
        previewText?: string;
        mentions?: string[];
      },
      ack?: (res: { ok: boolean; timestamp?: string; error?: string }) => void
    ) => {
      try {
        const { messageId, senderDeviceId, target, ciphertext, nonce, keys, mediaId, previewText, mentions } = payload;
        if (!messageId || !senderDeviceId || !validTarget(target) || !ciphertext || !nonce || !Array.isArray(keys)) {
          ack?.({ ok: false, error: 'Invalid message structure.' });
          return;
        }

        const createdAt = new Date().toISOString();

        // 1. Return immediate ACK to sender (Single Gray Tick ✓ achieved in < 25ms!)
        ack?.({ ok: true, timestamp: createdAt });

        // 2. Resolve recipient IDs via VPS RAM in-memory cache
        const recipientUserIds: string[] = [];
        if (target.kind === 'direct') {
          recipientUserIds.push(target.id);
        } else {
          const allMembers = await getCachedGroupMembers(target.id);
          recipientUserIds.push(...allMembers.filter(uid => uid !== selfId));
        }

        if (recipientUserIds.length === 0) return;

        // 3. Resolve device public keys using in-memory cache
        const [devices, senderDevices] = await Promise.all([
          getRecipientDevices(recipientUserIds),
          getRecipientDevices([selfId])
        ]);

        const senderDevice = senderDevices.find(d => d.deviceId === senderDeviceId);
        let senderPublicKey = (payload as any).senderPublicKey || senderDevice?.publicKey || '';
        if (!senderPublicKey) {
          const freshDev = await pool.query<{ publicKey: string }>(
            'SELECT "publicKey" FROM chat_device WHERE id = $1 AND "userId" = $2 AND "revokedAt" IS NULL',
            [senderDeviceId, selfId]
          );
          if (freshDev.rows.length > 0) {
            senderPublicKey = freshDev.rows[0].publicKey;
            invalidateUserDeviceCache(selfId);
          }
        }

        // Link media to message if attached
        if (mediaId) {
          void pool.query('UPDATE chat_media SET "messageId" = $1 WHERE id = $2 AND "ownerId" = $3', [messageId, mediaId, selfId]).catch(() => {});
        }

        // 4. Memory-first dispatch: Synchronous O(1) check which recipient devices are online
        const spoolRows: any[] = [];
        const pushUserIds = new Set<string>();
        const offlineEnvelopesByUser = new Map<string, DirectEnvelope>();

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

          // Synchronous O(1) in-memory room check (0.001ms)
          const isOnline = io!.sockets.adapter.rooms.has(userRoom(dev.userId));

          if (isOnline) {
            // RECIPIENT ONLINE: Forward directly down recipient's open socket in 0ms!
            io!.to(userRoom(dev.userId)).emit('chat:envelope', envelope);

            // Also spool in case socket connection drops before write to SQLite
            spoolRows.push([
              messageId, selfId, senderDeviceId, dev.userId, dev.deviceId,
              target.kind, target.id, ciphertext, nonce, keyEntry.wrappedKey, keyEntry.wrapNonce,
              senderPublicKey, socket.data.name || 'ADDA', createdAt
            ]);
          } else {
            // RECIPIENT OFFLINE: Spool in PostgreSQL
            spoolRows.push([
              messageId, selfId, senderDeviceId, dev.userId, dev.deviceId,
              target.kind, target.id, ciphertext, nonce, keyEntry.wrappedKey, keyEntry.wrapNonce,
              senderPublicKey, socket.data.name || 'ADDA', createdAt
            ]);
            pushUserIds.add(dev.userId);
            if (!offlineEnvelopesByUser.has(dev.userId)) {
              offlineEnvelopesByUser.set(dev.userId, envelope);
            }
          }
        }

        // Asynchronously persist spool batch
        if (spoolRows.length > 0) {
          void pool.query(`
            INSERT INTO chat_spool (
              "messageId", "senderId", "senderDeviceId", "recipientId", "recipientDeviceId",
              kind, "targetId", ciphertext, nonce, "wrappedKey", "wrapNonce",
              "senderPublicKey", "senderName", "createdAt"
            )
            SELECT * FROM UNNEST(
              $1::text[], $2::text[], $3::text[], $4::text[], $5::text[],
              $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::text[],
              $12::text[], $13::text[], $14::timestamptz[]
            )
          `, [
            spoolRows.map(r => r[0]), spoolRows.map(r => r[1]), spoolRows.map(r => r[2]),
            spoolRows.map(r => r[3]), spoolRows.map(r => r[4]), spoolRows.map(r => r[5]),
            spoolRows.map(r => r[6]), spoolRows.map(r => r[7]), spoolRows.map(r => r[8]),
            spoolRows.map(r => r[9]), spoolRows.map(r => r[10]), spoolRows.map(r => r[11]),
            spoolRows.map(r => r[12]), spoolRows.map(r => r[13]),
          ]).catch(e => console.warn('[ADDA] Spool insert warning:', e));
        }

        // Send high-priority FCM push with complete envelope payload for instant background SQLite ingestion
        if (pushUserIds.size > 0) {
          void sendEncryptedChatPush(
            [...pushUserIds],
            target,
            socket.data.name || 'ADDA',
            selfId,
            previewText,
            undefined,
            offlineEnvelopesByUser,
            mentions
          ).catch((e) => console.warn('[ADDA] Push send warning:', e));
        }
      } catch (err: any) {
        ack?.({ ok: false, error: err?.message || 'Send error' });
      }
    });

    // ========================================================
    // WHATSAPP-GRADE HOT-PATH 2: DELIVERY ACK (Double Gray Tick ✓✓)
    // ========================================================
    socket.on('chat:ack_delivery', (data: { messageId: string; senderId: string }) => {
      if (!data?.messageId || !data?.senderId) return;
      void processDeliveryAck(data.messageId, selfId, data.senderId);
    });

    // ========================================================
    // WHATSAPP-GRADE HOT-PATH 3: READ ACK (Double Blue Tick ✓✓)
    // ========================================================
    socket.on('chat:ack_read', (data: { messageIds: string[]; senderId: string }) => {
      if (!Array.isArray(data?.messageIds) || !data?.senderId || data.messageIds.length === 0) return;
      void processReadAck(data.messageIds, selfId, data.senderId);
    });

    // ========================================================
    // WHATSAPP DELETE FOR EVERYONE
    // ========================================================
    socket.on('chat:delete_for_everyone', async (data: { messageId: string; target: ChatTarget }) => {
      if (!data?.messageId || !validTarget(data?.target)) return;
      try {
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

export async function processDeliveryAck(messageId: string, recipientId: string, senderId: string): Promise<void> {
  try {
    const del = await pool.query<{ senderId: string; kind: string; targetId: string }>(
      'DELETE FROM chat_spool WHERE "messageId" = $1 AND "recipientId" = $2 RETURNING "senderId", kind, "targetId"',
      [messageId, recipientId]
    );
    const row = del.rows[0];
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
        // Group chat: check if all group members have received and saved
        const pending = await pool.query('SELECT 1 FROM chat_spool WHERE "messageId" = $1 LIMIT 1', [messageId]);
        if ((pending.rowCount ?? 0) === 0) {
          io.to(userRoom(senderId)).emit('chat:msg_status', {
            messageId,
            status: 'delivered'
          });
        }
      }
    }
  } catch (err) {
    console.warn('[ADDA Spool] processDeliveryAck error:', err);
  }
}

export async function processReadAck(messageIds: string[], recipientId: string, senderId: string): Promise<void> {
  if (messageIds.length === 0) return;
  try {
    if (io) {
      io.to(userRoom(senderId)).emit('chat:msg_status', {
        messageIds,
        status: 'read',
        recipientId
      });
    }

    await pool.query(
      'DELETE FROM chat_spool WHERE "messageId" = ANY($1::text[]) AND "recipientId" = $2',
      [messageIds, recipientId]
    );
  } catch (err) {
    console.warn('[ADDA Spool] processReadAck error:', err);
  }
}
