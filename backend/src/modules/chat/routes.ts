import { randomUUID } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import { auth } from '../auth/auth.js';
import { pool } from '../../db/pool.js';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../../config/env.js';
import { invalidateUserDeviceCache } from '../realtime/cache.js';
import { processDeliveryAck, processReadAck } from '../realtime/server.js';
import { hasAcceptedPolicy, isBlockedPair } from '../social/safety.js';

type Target = { kind: 'direct' | 'group'; id: string };
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
chatRoutes.use(run(async (_request, response, next) => {
  if (!(await hasAcceptedPolicy(response.locals.userId))) {
    response.status(403).json({ error: 'Accept the ADDA Community Guidelines before continuing.', code: 'POLICY_REQUIRED' }); return;
  }
  next();
}));

async function memberIds(userId: string, target: Target): Promise<string[] | null> {
  if (target.kind === 'direct') {
    if (await isBlockedPair(userId, target.id)) return null;
    const [a, b] = [userId, target.id].sort();
    const result = await pool.query('SELECT 1 FROM contact WHERE "userA" = $1 AND "userB" = $2', [a, b]);
    return result.rowCount ? [userId, target.id] : null;
  }
  const result = await pool.query<{ userId: string }>('SELECT "userId" FROM "chat_group_member" WHERE "groupId" = $1', [target.id]);
  return result.rows.some(row => row.userId === userId) ? result.rows.map(row => row.userId) : null;
}

chatRoutes.post('/devices', run(async (request, response) => {
  const { deviceId, publicKey } = request.body ?? {};
  if (!validId(deviceId) || !validBytes(publicKey, 32)) { response.status(400).json({ error: 'Invalid device key.' }); return; }
  const existing = await pool.query<{ userId: string; publicKey: string; revokedAt: string | null }>(
    'SELECT "userId", "publicKey", "revokedAt" FROM chat_device WHERE id = $1', [deviceId]);
  if (existing.rowCount) {
    const saved = existing.rows[0];
    if (saved.userId !== response.locals.userId) {
      await pool.query('UPDATE chat_device SET "userId" = $1, "publicKey" = $2, "revokedAt" = NULL WHERE id = $3', [response.locals.userId, publicKey, deviceId]);
    } else if (saved.publicKey !== publicKey || saved.revokedAt) {
      await pool.query('UPDATE chat_device SET "publicKey" = $1, "revokedAt" = NULL WHERE id = $2', [publicKey, deviceId]);
    }
  } else {
    // Keep multiple devices active (support multi-phone / multi-device). Only cap if excessive (> 10)
    await pool.query(
      `UPDATE chat_device SET "revokedAt" = now()
       WHERE id IN (
         SELECT id FROM chat_device
         WHERE "userId" = $1 AND "revokedAt" IS NULL
         ORDER BY "createdAt" DESC
         OFFSET 9
       )`,
      [response.locals.userId]
    );
    await pool.query('INSERT INTO chat_device (id, "userId", "publicKey") VALUES ($1, $2, $3)', [deviceId, response.locals.userId, publicKey]);
  }
  invalidateUserDeviceCache(response.locals.userId);
  response.json({ deviceId });
}));

chatRoutes.get('/devices', run(async (_request, response) => {
  const result = await pool.query('SELECT id, "createdAt" FROM chat_device WHERE "userId" = $1 AND "revokedAt" IS NULL ORDER BY "createdAt" DESC', [response.locals.userId]);
  response.json(result.rows);
}));

chatRoutes.delete('/devices/:id', run(async (request, response) => {
  const deviceId = request.params.id;
  if (!validId(deviceId)) { response.status(400).json({ error: 'Invalid device.' }); return; }
  await pool.query('UPDATE chat_device SET "revokedAt" = now() WHERE id = $1 AND "userId" = $2 AND "revokedAt" IS NULL', [deviceId, response.locals.userId]);
  await pool.query('DELETE FROM chat_spool WHERE "recipientDeviceId" = $1', [deviceId]);
  invalidateUserDeviceCache(response.locals.userId);
  response.json({ ok: true });
}));

chatRoutes.get('/keys/:kind/:id', run(async (request, response) => {
  const target = { kind: request.params.kind as Target['kind'], id: request.params.id };
  if (!validTarget(target)) { response.status(400).json({ error: 'Invalid chat.' }); return; }
  const members = await memberIds(response.locals.userId, target);
  if (!members) { response.status(403).json({ error: 'Chat unavailable.' }); return; }
  const result = await pool.query<{ deviceId: string; userId: string; publicKey: string }>(
    'SELECT id AS "deviceId", "userId", "publicKey" FROM chat_device WHERE "userId" = ANY($1::text[]) AND "revokedAt" IS NULL ORDER BY "userId", id', [members]);
  response.json({ members, devices: result.rows });
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
  if (!item) { response.status(404).json({ error: 'Media unavailable.' }); return; }

  // Auto-confirm if object already exists in R2 (resolves receiver race conditions)
  if (!item.confirmed) {
    try {
      await r2.send(new HeadObjectCommand({ Bucket: env.r2Bucket, Key: item.objectKey }));
      await pool.query('UPDATE chat_media SET confirmed = true WHERE id = $1', [request.params.id]);
      item.confirmed = true;
    } catch {
      response.status(404).json({ error: 'Media unavailable.' });
      return;
    }
  }

  const callerId = response.locals.userId as string;
  let allowed = false;
  if (callerId === item.ownerId) {
    allowed = true;
  } else if (item.kind === 'direct') {
    allowed = callerId === item.targetId;
  } else if (item.kind === 'group') {
    const member = await pool.query('SELECT 1 FROM "chat_group_member" WHERE "groupId" = $1 AND "userId" = $2', [item.targetId, callerId]);
    allowed = (member.rowCount ?? 0) > 0;
  }
  if (!allowed) { response.status(403).json({ error: 'Media unavailable.' }); return; }
  const url = await getSignedUrl(r2, new GetObjectCommand({ Bucket: env.r2Bucket, Key: item.objectKey }), { expiresIn: 300 });
  response.json({ url });
}));

chatRoutes.post('/delivery-ack', run(async (request, response) => {
  const { messageId, senderId } = request.body ?? {};
  if (typeof messageId !== 'string' || !messageId || messageId.length > 100 ||
    typeof senderId !== 'string' || !senderId || senderId.length > 100) {
    response.status(400).json({ error: 'Invalid delivery ack.' });
    return;
  }
  const selfId = response.locals.userId as string;
  await processDeliveryAck(messageId, selfId, senderId);
  response.json({ ok: true });
}));

chatRoutes.post('/read-ack', run(async (request, response) => {
  const { messageIds, senderId } = request.body ?? {};
  if (!Array.isArray(messageIds) || messageIds.length === 0 || messageIds.length > 100 ||
    !messageIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 100) ||
    typeof senderId !== 'string' || !senderId || senderId.length > 100) {
    response.status(400).json({ error: 'Invalid read ack.' });
    return;
  }
  const selfId = response.locals.userId as string;
  await processReadAck(messageIds, selfId, senderId);
  response.json({ ok: true });
}));

export async function retryDeliveredMediaCleanup(): Promise<void> {
  if (!r2) return;
  try {
    const orphaned = await pool.query<{ objectKey: string }>(
      'SELECT "objectKey" FROM media_object_deletion ORDER BY "createdAt" LIMIT 50');
    for (const item of orphaned.rows) {
      await r2.send(new DeleteObjectCommand({ Bucket: env.r2Bucket, Key: item.objectKey }));
      await pool.query('DELETE FROM media_object_deletion WHERE "objectKey" = $1', [item.objectKey]);
    }
    const stale = await pool.query<{ id: string; objectKey: string }>(
      `SELECT id, "objectKey" FROM chat_media 
       WHERE confirmed = false AND "createdAt" < now() - INTERVAL '24 hours' LIMIT 50`
    );
    for (const item of stale.rows) {
      await r2.send(new DeleteObjectCommand({ Bucket: env.r2Bucket, Key: item.objectKey })).catch(() => {});
      await pool.query('DELETE FROM chat_media WHERE id = $1', [item.id]);
    }
  } catch (e) {
    console.warn('[ADDA] Media cleanup warning:', e);
  }
}

