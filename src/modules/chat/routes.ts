import { randomUUID } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import { auth } from '../auth/auth.js';
import { pool } from '../../db/pool.js';
import { publishEncryptedChatUpdate } from '../realtime/server.js';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../../config/env.js';
import { sendEncryptedChatPush } from '../realtime/push.js';

type Target = { kind: 'direct' | 'group'; id: string };
type KeyEnvelope = { deviceId: string; wrappedKey: string; wrapNonce: string };
const idPattern = /^[a-zA-Z0-9_-]{8,100}$/;
const base64Pattern = /^[A-Za-z0-9+/]+={0,2}$/;
const validBase64 = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && base64Pattern.test(value);
const validBytes = (value: unknown, length: number) => validBase64(value, Math.ceil(length / 3) * 4) &&
  Buffer.from(value as string, 'base64').length === length && Buffer.from(value as string, 'base64').toString('base64') === value;
const validId = (value: unknown): value is string => typeof value === 'string' && idPattern.test(value);
const validTarget = (value: unknown): value is Target => !!value && typeof value === 'object' && 'kind' in value && 'id' in value &&
  (value.kind === 'direct' || value.kind === 'group') && validId(value.id);
const run = (handler: RequestHandler): RequestHandler => (request, response, next) => { Promise.resolve(handler(request, response, next)).catch(next); };
const mediaLimit = 25 * 1024 * 1024;
const r2Ready = !!(env.r2AccountId && env.r2Bucket && env.r2AccessKeyId && env.r2SecretAccessKey);
const r2 = r2Ready ? new S3Client({
  region: 'auto', endpoint: `https://${env.r2AccountId}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: env.r2AccessKeyId, secretAccessKey: env.r2SecretAccessKey },
}) : null;

export const chatRoutes = Router();
chatRoutes.use(run(async (request, response, next) => {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) if (typeof value === 'string') headers.set(key, value);
  const session = await auth.api.getSession({ headers });
  if (!session) { response.status(401).json({ error: 'Sign in to continue.' }); return; }
  response.locals.userId = session.user.id;
  next();
}));

async function memberIds(userId: string, target: Target): Promise<string[] | null> {
  if (target.kind === 'direct') {
    const [a, b] = [userId, target.id].sort();
    const result = await pool.query('SELECT 1 FROM contact WHERE "userA" = $1 AND "userB" = $2', [a, b]);
    return result.rowCount ? [userId, target.id] : null;
  }
  const result = await pool.query<{ userId: string }>('SELECT "userId" FROM chat_group_member WHERE "groupId" = $1', [target.id]);
  return result.rows.some(row => row.userId === userId) ? result.rows.map(row => row.userId) : null;
}

chatRoutes.post('/devices', run(async (request, response) => {
  const { deviceId, publicKey } = request.body ?? {};
  if (!validId(deviceId) || !validBytes(publicKey, 32)) { response.status(400).json({ error: 'Invalid device key.' }); return; }
  const existing = await pool.query<{ userId: string; publicKey: string; revokedAt: string | null }>(
    'SELECT "userId", "publicKey", "revokedAt" FROM chat_device WHERE id = $1', [deviceId]);
  if (existing.rowCount) {
    const saved = existing.rows[0];
    if (saved.userId !== response.locals.userId || saved.publicKey !== publicKey || saved.revokedAt) {
      response.status(409).json({ error: 'Device ID or key changed. Restore the original device key or register a new device.' }); return;
    }
  } else {
    const count = await pool.query<{ count: string }>('SELECT COUNT(*) AS count FROM chat_device WHERE "userId" = $1 AND "revokedAt" IS NULL', [response.locals.userId]);
    if (Number(count.rows[0].count) >= 5) { response.status(409).json({ error: 'This account has five chat devices. Remove an old device in Profile first.' }); return; }
    await pool.query('INSERT INTO chat_device (id, "userId", "publicKey") VALUES ($1, $2, $3)', [deviceId, response.locals.userId, publicKey]);
  }
  response.json({ deviceId });
}));

chatRoutes.get('/devices', run(async (_request, response) => {
  const result = await pool.query('SELECT id, "createdAt" FROM chat_device WHERE "userId" = $1 AND "revokedAt" IS NULL ORDER BY "createdAt" DESC', [response.locals.userId]);
  response.json(result.rows);
}));

chatRoutes.delete('/devices/:id', run(async (request, response) => {
  const deviceId = request.params.id;
  if (!validId(deviceId)) { response.status(400).json({ error: 'Invalid device.' }); return; }
  const client = await pool.connect();
  let released: string[] = [];
  try {
    await client.query('BEGIN');
    const revoked = await client.query('UPDATE chat_device SET "revokedAt" = now() WHERE id = $1 AND "userId" = $2 AND "revokedAt" IS NULL RETURNING id', [deviceId, response.locals.userId]);
    if (!revoked.rowCount) { await client.query('ROLLBACK'); response.status(404).json({ error: 'Device unavailable.' }); return; }
    const pending = await client.query<{ messageId: string }>('DELETE FROM chat_pending_key WHERE "recipientDeviceId" = $1 RETURNING "messageId"', [deviceId]);
    released = [...new Set(pending.rows.map(row => row.messageId))];
    await client.query('DELETE FROM chat_receipt_event WHERE "recipientDeviceId" = $1', [deviceId]);
    for (const messageId of released) {
      await client.query('DELETE FROM chat_pending_payload p WHERE p."messageId" = $1 AND NOT EXISTS (SELECT 1 FROM chat_pending_key k WHERE k."messageId" = p."messageId")', [messageId]);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  response.json({ ok: true });
  for (const messageId of released) void cleanupDeliveredMedia(messageId).catch(error => console.warn('[ADDA] Encrypted media cleanup failed:', error));
}));

chatRoutes.get('/keys/:kind/:id', run(async (request, response) => {
  const target = { kind: request.params.kind, id: request.params.id };
  if (!validTarget(target)) { response.status(400).json({ error: 'Invalid chat.' }); return; }
  const members = await memberIds(response.locals.userId, target);
  if (!members) { response.status(403).json({ error: 'Chat unavailable.' }); return; }
  const result = await pool.query<{ deviceId: string; userId: string; publicKey: string }>(
    'SELECT id AS "deviceId", "userId", "publicKey" FROM chat_device WHERE "userId" = ANY($1::text[]) AND "revokedAt" IS NULL ORDER BY "userId", id', [members]);
  response.json({ members, devices: result.rows });
}));

chatRoutes.post('/send', run(async (request, response) => {
  const { messageId, senderDeviceId, target, ciphertext, nonce, keys, mediaIds = [] } = request.body ?? {};
  if (!validId(messageId) || !validId(senderDeviceId) || !validTarget(target) ||
      !validBase64(ciphertext, 8192) || Buffer.from(ciphertext, 'base64').length < 17 || !validBytes(nonce, 24) ||
      !Array.isArray(mediaIds) || mediaIds.length > 4 || !mediaIds.every(validId) ||
      !Array.isArray(keys) || keys.length > 256 || !keys.every((key: KeyEnvelope) =>
        key && validId(key.deviceId) && validBytes(key.wrappedKey, 48) && validBytes(key.wrapNonce, 24))) {
    response.status(400).json({ error: 'Invalid encrypted message.' }); return;
  }
  const senderId = response.locals.userId as string;
  const members = await memberIds(senderId, target);
  if (!members) { response.status(403).json({ error: 'Chat unavailable.' }); return; }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sender = await client.query('SELECT 1 FROM chat_device WHERE id = $1 AND "userId" = $2 AND "revokedAt" IS NULL', [senderDeviceId, senderId]);
    if (!sender.rowCount) { await client.query('ROLLBACK'); response.status(403).json({ error: 'Register this device first.' }); return; }
    const prior = await client.query<{ senderId: string }>('SELECT "senderId" FROM chat_sent_id WHERE "messageId" = $1', [messageId]);
    if (prior.rowCount) {
      await client.query('ROLLBACK');
      response.status(prior.rows[0].senderId === senderId ? 200 : 409).json(prior.rows[0].senderId === senderId ? { messageId, duplicate: true, recipients: members.filter(id => id !== senderId) } : { error: 'Message ID belongs to another user.' });
      return;
    }
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [senderId]);
    const recent = await client.query<{ minute: string; day: string }>(
      `SELECT COUNT(*) FILTER (WHERE "createdAt" > now() - interval '1 minute') AS minute,
       COUNT(*) AS day FROM chat_sent_id WHERE "senderId" = $1 AND "createdAt" > now() - interval '1 day'`, [senderId]);
    if (Number(recent.rows[0].minute) >= 60 || Number(recent.rows[0].day) >= 1000) {
      await client.query('ROLLBACK'); response.status(429).json({ error: 'Too many messages. Please slow down.' }); return;
    }
    const devices = await client.query<{ deviceId: string; userId: string }>(
      'SELECT id AS "deviceId", "userId" FROM chat_device WHERE "userId" = ANY($1::text[]) AND "revokedAt" IS NULL ORDER BY id FOR SHARE', [members]);
    const expected = devices.rows.filter(row => row.deviceId !== senderDeviceId);
    const actualIds = keys.map((key: KeyEnvelope) => key.deviceId);
    if (new Set(actualIds).size !== expected.length || expected.some(row => !actualIds.includes(row.deviceId))) {
      await client.query('ROLLBACK'); response.status(409).json({ error: 'Device keys changed. Refresh keys and encrypt this message again.' }); return;
    }
    if (members.some(id => id !== senderId && !devices.rows.some(row => row.userId === id))) {
      await client.query('ROLLBACK'); response.status(409).json({ error: 'A recipient must open the updated app before encrypted messages can be sent.' }); return;
    }
    if (mediaIds.length) {
      const media = await client.query<{ id: string }>('SELECT id FROM chat_media WHERE id = ANY($1::text[]) AND "ownerId" = $2 AND kind = $3 AND "targetId" = $4 AND confirmed = true AND "messageId" IS NULL FOR UPDATE',
        [mediaIds, senderId, target.kind, target.id]);
      if (media.rowCount !== mediaIds.length || new Set(mediaIds).size !== mediaIds.length) {
        await client.query('ROLLBACK'); response.status(409).json({ error: 'Encrypted media upload is unavailable or already sent.' }); return;
      }
    }
    await client.query('INSERT INTO chat_sent_id ("messageId", "senderId") VALUES ($1, $2)', [messageId, senderId]);
    if (mediaIds.length) await client.query('UPDATE chat_media SET "messageId" = $1 WHERE id = ANY($2::text[])', [messageId, mediaIds]);
    for (const recipientId of members.filter(id => id !== senderId)) {
      await client.query('INSERT INTO chat_delivery_state ("messageId", "senderId", "recipientId") VALUES ($1, $2, $3)', [messageId, senderId, recipientId]);
    }
    if (expected.length) {
      await client.query('INSERT INTO chat_pending_payload ("messageId", "senderId", "senderDeviceId", kind, "targetId", ciphertext, nonce) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [messageId, senderId, senderDeviceId, target.kind, target.id, ciphertext, nonce]);
      for (const key of keys as KeyEnvelope[]) {
        const device = expected.find(row => row.deviceId === key.deviceId)!;
        await client.query('INSERT INTO chat_pending_key (id, "messageId", "recipientId", "recipientDeviceId", "wrappedKey", "wrapNonce") VALUES ($1, $2, $3, $4, $5, $6)',
          [randomUUID(), messageId, device.userId, device.deviceId, key.wrappedKey, key.wrapNonce]);
      }
    }
    await client.query('COMMIT');
    response.status(201).json({ messageId, recipients: members.filter(id => id !== senderId) });
    publishEncryptedChatUpdate(members);
    void pool.query<{ name: string }>('SELECT name FROM "user" WHERE id = $1', [senderId])
      .then(result => sendEncryptedChatPush(members.filter(id => id !== senderId), target, result.rows[0]?.name ?? 'ADDA'))
      .catch(error => console.warn('[ADDA] Chat push failed:', error));
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}));

chatRoutes.get('/pending', run(async (request, response) => {
  const deviceId = request.query.deviceId;
  if (!validId(deviceId)) { response.status(400).json({ error: 'Invalid device.' }); return; }
  const selfId = response.locals.userId as string;
  const device = await pool.query('SELECT 1 FROM chat_device WHERE id = $1 AND "userId" = $2 AND "revokedAt" IS NULL', [deviceId, selfId]);
  if (!device.rowCount) { response.status(403).json({ error: 'Device unavailable.' }); return; }
  const messages = await pool.query(
    `SELECT k.id AS "deliveryId", p."messageId", p."senderId", p."senderDeviceId", d."publicKey" AS "senderPublicKey", u.name AS "senderName",
      p.kind, p."targetId", p.ciphertext, p.nonce, p."createdAt", k."wrappedKey", k."wrapNonce"
     FROM chat_pending_key k JOIN chat_pending_payload p ON p."messageId" = k."messageId"
     JOIN chat_device d ON d.id = p."senderDeviceId" JOIN "user" u ON u.id = p."senderId"
     WHERE k."recipientDeviceId" = $1 ORDER BY p."createdAt", k.id LIMIT 100`, [deviceId]);
  const receipts = await pool.query(
    'SELECT id, "messageId", "actorId", kind, "createdAt" FROM chat_receipt_event WHERE "recipientDeviceId" = $1 ORDER BY "createdAt", id LIMIT 100', [deviceId]);
  response.json({ messages: messages.rows, receipts: receipts.rows, hasMore: messages.rowCount === 100 || receipts.rowCount === 100 });
}));

chatRoutes.post('/ack', run(async (request, response) => {
  const { deviceId, deliveryId } = request.body ?? {};
  if (!validId(deviceId) || !validId(deliveryId)) { response.status(400).json({ error: 'Invalid delivery.' }); return; }
  const selfId = response.locals.userId as string;
  const client = await pool.connect();
  let senderId: string | undefined;
  let deletedMessageId: string | undefined;
  try {
    await client.query('BEGIN');
    const delivered = await client.query<{ messageId: string; senderId: string }>(
      `DELETE FROM chat_pending_key k USING chat_pending_payload p, chat_device d
       WHERE k.id = $1 AND k."recipientDeviceId" = $2 AND k."recipientId" = $3 AND p."messageId" = k."messageId"
       AND d.id = k."recipientDeviceId" AND d."revokedAt" IS NULL
       RETURNING k."messageId", p."senderId"`, [deliveryId, deviceId, selfId]);
    if (delivered.rowCount) {
      const row = delivered.rows[0]; senderId = row.senderId;
      await client.query('UPDATE chat_delivery_state SET "deliveredAt" = COALESCE("deliveredAt", now()) WHERE "messageId" = $1 AND "recipientId" = $2', [row.messageId, selfId]);
      if (selfId !== senderId) {
        const senderDevices = await client.query<{ id: string }>('SELECT id FROM chat_device WHERE "userId" = $1 AND "revokedAt" IS NULL', [senderId]);
        for (const device of senderDevices.rows) {
          await client.query('INSERT INTO chat_receipt_event (id, "messageId", "recipientId", "recipientDeviceId", "actorId", kind) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING',
            [randomUUID(), row.messageId, senderId, device.id, selfId, 'delivered']);
        }
      }
      const removed = await client.query('DELETE FROM chat_pending_payload p WHERE p."messageId" = $1 AND NOT EXISTS (SELECT 1 FROM chat_pending_key k WHERE k."messageId" = p."messageId") RETURNING p."messageId"', [row.messageId]);
      if (removed.rowCount) deletedMessageId = row.messageId;
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  response.json({ ok: true });
  if (senderId) publishEncryptedChatUpdate([senderId]);
  if (deletedMessageId) void cleanupDeliveredMedia(deletedMessageId).catch(error => console.warn('[ADDA] Encrypted media cleanup failed:', error));
}));

async function cleanupDeliveredMedia(messageId: string) {
  if (!r2) return;
  const media = await pool.query<{ id: string; objectKey: string }>(
    'SELECT id, "objectKey" FROM chat_media WHERE "messageId" = $1 AND NOT EXISTS (SELECT 1 FROM chat_pending_payload WHERE "messageId" = $1)', [messageId]);
  for (const item of media.rows) {
    await r2.send(new DeleteObjectCommand({ Bucket: env.r2Bucket, Key: item.objectKey }));
    await pool.query('DELETE FROM chat_media WHERE id = $1', [item.id]);
  }
}

export async function retryDeliveredMediaCleanup() {
  if (!r2) return;
  const waiting = await pool.query<{ messageId: string }>(
    'SELECT DISTINCT m."messageId" FROM chat_media m WHERE m."messageId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM chat_pending_payload p WHERE p."messageId" = m."messageId") LIMIT 100');
  for (const item of waiting.rows) await cleanupDeliveredMedia(item.messageId);
}

chatRoutes.post('/read', run(async (request, response) => {
  const { deviceId, messageIds } = request.body ?? {};
  if (!validId(deviceId) || !Array.isArray(messageIds) || messageIds.length > 100 || !messageIds.every(validId)) {
    response.status(400).json({ error: 'Invalid read receipts.' }); return;
  }
  const selfId = response.locals.userId as string;
  const device = await pool.query('SELECT 1 FROM chat_device WHERE id = $1 AND "userId" = $2 AND "revokedAt" IS NULL', [deviceId, selfId]);
  if (!device.rowCount) { response.status(403).json({ error: 'Device unavailable.' }); return; }
  // Delivery state proves that this user received the message even after the sender ACKs its receipt event.
  const eligible = await pool.query<{ messageId: string; senderId: string; senderDeviceId: string }>(
    `SELECT DISTINCT s."messageId", s."senderId", e.id AS "senderDeviceId"
     FROM chat_delivery_state s JOIN chat_device e ON e."userId" = s."senderId" AND e."revokedAt" IS NULL
     WHERE s."messageId" = ANY($2::text[]) AND s."recipientId" = $1 AND s."deliveredAt" IS NOT NULL`, [selfId, messageIds]);
  await pool.query('UPDATE chat_delivery_state SET "readAt" = COALESCE("readAt", now()) WHERE "messageId" = ANY($1::text[]) AND "recipientId" = $2 AND "deliveredAt" IS NOT NULL', [messageIds, selfId]);
  for (const item of eligible.rows) {
    await pool.query('INSERT INTO chat_receipt_event (id, "messageId", "recipientId", "recipientDeviceId", "actorId", kind) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING',
      [randomUUID(), item.messageId, item.senderId, item.senderDeviceId, selfId, 'read']);
  }
  response.json({ ok: true });
  publishEncryptedChatUpdate([...new Set(eligible.rows.map(row => row.senderId))]);
}));

chatRoutes.post('/receipt-ack', run(async (request, response) => {
  const { deviceId, receiptIds } = request.body ?? {};
  if (!validId(deviceId) || !Array.isArray(receiptIds) || receiptIds.length > 100 || !receiptIds.every(validId)) {
    response.status(400).json({ error: 'Invalid receipt acknowledgement.' }); return;
  }
  await pool.query('DELETE FROM chat_receipt_event WHERE id = ANY($1::text[]) AND "recipientDeviceId" = $2 AND "recipientId" = $3',
    [receiptIds, deviceId, response.locals.userId]);
  response.json({ ok: true });
}));

chatRoutes.post('/media/upload', run(async (request, response) => {
  if (!r2) { response.status(503).json({ error: 'Encrypted media storage is not configured yet.' }); return; }
  const { target, mediaKind, contentLength } = request.body ?? {};
  if (!validTarget(target) || !['image', 'video'].includes(mediaKind) || !Number.isInteger(contentLength) || contentLength < 1 || contentLength > mediaLimit) {
    response.status(400).json({ error: 'Choose an image or video under 25 MB.' }); return;
  }
  if (!(await memberIds(response.locals.userId, target))) { response.status(403).json({ error: 'Chat unavailable.' }); return; }
  const mediaId = randomUUID();
  const objectKey = `encrypted/${mediaId}`;
  await pool.query('INSERT INTO chat_media (id, "ownerId", kind, "targetId", "objectKey", "contentLength", "mediaKind") VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [mediaId, response.locals.userId, target.kind, target.id, objectKey, contentLength, mediaKind]);
  const url = await getSignedUrl(r2, new PutObjectCommand({ Bucket: env.r2Bucket, Key: objectKey, ContentType: 'application/octet-stream' }), { expiresIn: 600 });
  response.status(201).json({ mediaId, url, contentType: 'application/octet-stream' });
}));

chatRoutes.post('/media/:id/confirm', run(async (request, response) => {
  if (!r2) { response.status(503).json({ error: 'Encrypted media storage is not configured yet.' }); return; }
  const result = await pool.query<{ objectKey: string; contentLength: string }>('SELECT "objectKey", "contentLength" FROM chat_media WHERE id = $1 AND "ownerId" = $2', [request.params.id, response.locals.userId]);
  if (!result.rowCount) { response.status(404).json({ error: 'Media unavailable.' }); return; }
  const item = result.rows[0];
  const head = await r2.send(new HeadObjectCommand({ Bucket: env.r2Bucket, Key: item.objectKey }));
  if (head.ContentLength !== Number(item.contentLength)) { response.status(409).json({ error: 'Encrypted upload size did not match.' }); return; }
  await pool.query('UPDATE chat_media SET confirmed = true WHERE id = $1', [request.params.id]);
  response.json({ ok: true });
}));

chatRoutes.get('/media/:id/download', run(async (request, response) => {
  if (!r2) { response.status(503).json({ error: 'Encrypted media storage is not configured yet.' }); return; }
  const result = await pool.query<{ ownerId: string; kind: Target['kind']; targetId: string; objectKey: string; confirmed: boolean }>(
    'SELECT "ownerId", kind, "targetId", "objectKey", confirmed FROM chat_media WHERE id = $1', [request.params.id]);
  const item = result.rows[0];
  if (!item || !item.confirmed) { response.status(404).json({ error: 'Media unavailable.' }); return; }
  const callerId = response.locals.userId as string;
  let allowed = false;
  if (item.kind === 'direct') {
    allowed = callerId === item.ownerId || callerId === item.targetId;
  } else if (item.kind === 'group') {
    const member = await pool.query('SELECT 1 FROM chat_group_member WHERE "groupId" = $1 AND "userId" = $2', [item.targetId, callerId]);
    allowed = (member.rowCount ?? 0) > 0;
  }
  if (!allowed) { response.status(403).json({ error: 'Media unavailable.' }); return; }
  const url = await getSignedUrl(r2, new GetObjectCommand({ Bucket: env.r2Bucket, Key: item.objectKey }), { expiresIn: 300 });
  response.json({ url });
}));
