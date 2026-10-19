import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';
import { File, Paths } from 'expo-file-system';
import nacl from 'tweetnacl';
import { socialApi, type OwnProfile } from './social-api';
import { getRealtimeSocket, setRealtimeDeviceId, type ChatTarget } from './realtime';

export type QuotedReply = {
  messageId: string;
  senderId: string;
  senderName: string;
  snippet: string;
  mediaKind?: 'photo' | 'video';
  mediaId?: string;
};

export type LocalMessage = {
  id: string;
  kind: ChatTarget['kind'];
  targetId: string;
  senderId: string;
  senderName: string;
  body: string;
  createdAt: string;
  status: 'queued' | 'sent' | 'delivered' | 'read' | 'received';
  replyTo?: QuotedReply | null;
  mentions?: string[] | null;
  reactions?: Record<string, string> | null;
};

type DeviceKey = { deviceId: string; userId: string; publicKey: string };
type KeyList = { members: string[]; devices: DeviceKey[] };

export type Envelope = {
  deliveryId?: string;
  messageId: string;
  senderId: string;
  senderDeviceId: string;
  senderPublicKey: string;
  senderName: string;
  kind: ChatTarget['kind'];
  targetId: string;
  ciphertext: string;
  nonce: string;
  wrappedKey: string;
  wrapNonce: string;
  recipientDeviceId?: string;
  createdAt: string;
  replyTo?: QuotedReply | null;
  mentions?: string[] | null;
};

type Identity = { userId: string; deviceId: string; secretKey: Uint8Array; publicKey: string; db: SQLite.SQLiteDatabase };

export type EncryptedMedia = {
  type: 'media';
  mediaId: string;
  mediaKind: 'image' | 'video';
  key: string;
  nonce: string;
  mimeType: string;
  createdAt: string;
  senderName: string;
  localUri?: string;
};

const mediaPrefix = '__adda_media__:';

export function mediaFromBody(body: string): EncryptedMedia | null {
  if (!body) return null;
  let jsonStr = '';
  if (body.startsWith('__adda_media__:')) {
    jsonStr = body.slice('__adda_media__:'.length);
  } else if (body.startsWith('[adda-media]:')) {
    jsonStr = body.slice('[adda-media]:'.length);
  } else if (body.startsWith('\u0000adda-media:')) {
    jsonStr = body.slice('\u0000adda-media:'.length);
  } else {
    return null;
  }
  try {
    const data: EncryptedMedia = JSON.parse(jsonStr);
    return data.type === 'media' && typeof data.mediaId === 'string' && (data.mediaKind === 'image' || data.mediaKind === 'video') ? data : null;
  } catch { return null; }
}

export type RoomCardPayload = {
  type: 'room_card';
  roomId: string;
  groupId?: string;
  groupName?: string;
  roomKind: string;
  creatorId: string;
  creatorName: string;
  createdAt: string;
  roomName?: string;
  isPrivate?: boolean;
};

export function roomCardFromBody(body: string): RoomCardPayload | null {
  if (!body || !body.startsWith('__adda_room_card__:')) return null;
  try {
    const data = JSON.parse(body.slice('__adda_room_card__:'.length));
    return data.type === 'room_card' ? data : null;
  } catch {
    return null;
  }
}

export function previewBody(body: string, isMine?: boolean): string {
  if (body === '__adda_deleted__') {
    return isMine ? '🚫 You deleted this message' : '🚫 This message was deleted';
  }
  const roomCard = roomCardFromBody(body);
  if (roomCard) {
    const roomTitle = roomCard.roomKind === 'beach' ? 'Goa Beach'
      : roomCard.roomKind === 'tea' ? 'Tea Party'
      : roomCard.roomKind === 'roof' ? 'School Rooftop'
      : 'Loft 16';
    return `🌴 ${roomCard.creatorName} invited you: ${roomCard.roomName || roomTitle}`;
  }
  const media = mediaFromBody(body);
  return media ? (media.mediaKind === 'image' ? '📷 Photo' : '🎥 Video') : body;
}

export type ChatPreview = {
  kind: string;
  targetId: string;
  senderId: string;
  senderName: string;
  body: string;
  createdAt: string;
};

export function formatChatPreview(
  preview: { kind: string; senderId?: string; senderName?: string; body: string } | undefined,
  currentUserId?: string
): string | null {
  if (!preview) return null;
  const isMine = currentUserId ? preview.senderId === currentUserId : false;

  if (preview.body === '__adda_deleted__') {
    if (isMine) return '🚫 You deleted this message';
    if (preview.kind === 'group' && preview.senderName) {
      return `${preview.senderName}: 🚫 This message was deleted`;
    }
    return '🚫 This message was deleted';
  }

  const media = mediaFromBody(preview.body);
  const coreText = media
    ? (media.mediaKind === 'video' ? '🎥 Video' : '📷 Photo')
    : preview.body;

  if (preview.kind === 'group') {
    const sender = isMine ? 'You' : (preview.senderName || 'Member');
    return `${sender}: ${coreText}`;
  }

  return coreText;
}

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export function bytesToBase64(bytes: Uint8Array): string {
  let output = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    output += alphabet[a >> 2] + alphabet[((a & 3) << 4) | ((b ?? 0) >> 4)] +
      (i + 1 < bytes.length ? alphabet[((b & 15) << 2) | ((c ?? 0) >> 6)] : '=') +
      (i + 2 < bytes.length ? alphabet[c & 63] : '=');
  }
  return output;
}

export function base64ToBytes(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('Invalid encrypted data.');
  const result = new Uint8Array((value.length / 4) * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0));
  let position = 0;
  for (let i = 0; i < value.length; i += 4) {
    const a = alphabet.indexOf(value[i]), b = alphabet.indexOf(value[i + 1]);
    const c = value[i + 2] === '=' ? 0 : alphabet.indexOf(value[i + 2]);
    const d = value[i + 3] === '=' ? 0 : alphabet.indexOf(value[i + 3]);
    result[position++] = (a << 2) | (b >> 4);
    if (position < result.length) result[position++] = ((b & 15) << 4) | (c >> 2);
    if (position < result.length) result[position++] = ((c & 3) << 6) | d;
  }
  return result;
}

// TweetNaCl platform CSPRNG using Expo Crypto
nacl.setPRNG((buffer, size) => {
  for (let offset = 0; offset < size; offset += 1024) buffer.set(Crypto.getRandomBytes(Math.min(1024, size - offset)), offset);
});

let active: Identity | null = null;
let initializing: Promise<void> | null = null;
let cachedProfile: OwnProfile | null = null;

export function setCachedProfile(profile: OwnProfile | ({ id: string; name: string } & Partial<OwnProfile>)) {
  cachedProfile = { ...(cachedProfile || {}), ...profile } as OwnProfile;
}
export function getCachedProfile(): OwnProfile | null { return cachedProfile; }
export function isEncryptedChatReady(): boolean { return active !== null && active.db !== null; }
export function getActiveUserId(): string | null { return active?.userId ?? cachedProfile?.id ?? null; }
export function currentChatDeviceId(): string | null { return active?.deviceId ?? null; }

const keyCache = new Map<string, { keys: KeyList; expiresAt: number }>();
export function clearKeyCache(target?: ChatTarget) {
  if (target) keyCache.delete(`${target.kind}:${target.id}`);
  else keyCache.clear();
}

export async function getOrFetchKeys(target: ChatTarget, forceFresh = false): Promise<KeyList> {
  const cacheKey = `${target.kind}:${target.id}`;
  const hit = keyCache.get(cacheKey);
  // Group keys expire in 15 seconds so new members and device key changes are rapidly picked up.
  // Direct chats cache for 2 minutes.
  const ttl = target.kind === 'group' ? 15 * 1000 : 2 * 60 * 1000;
  if (!forceFresh && hit && hit.expiresAt > Date.now()) {
    return hit.keys;
  }
  const fetched = await socialApi<KeyList>(`/chat/keys/${target.kind}/${encodeURIComponent(target.id)}`);
  keyCache.set(cacheKey, { keys: fetched, expiresAt: Date.now() + ttl });
  return fetched;
}

export async function prefetchChatKeys(target: ChatTarget): Promise<void> {
  try { await getOrFetchKeys(target); } catch {}
}

const listeners = new Set<() => void>();
export function onChatChanged(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function changed() { listeners.forEach(listener => listener()); }

let dbWriteQueue: Promise<unknown> = Promise.resolve();
function withDbLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = dbWriteQueue.then(operation, operation);
  dbWriteQueue = result.then(() => undefined, () => undefined);
  return result;
}

export async function initEncryptedChat(userId: string): Promise<void> {
  if (active?.userId === userId) return;
  if (initializing) {
    await initializing;
    if (active?.userId === userId) return;
  }
  const task = initializeForUser(userId);
  initializing = task;
  try { await task; } finally { if (initializing === task) initializing = null; }
}

async function initializeForUser(userId: string): Promise<void> {
  clearDecryptedMediaCache();
  if (active?.userId === userId) return;
  if (active) { await active.db.closeAsync(); active = null; }

  const secretName = `adda_chat_secret_${userId}`;
  const deviceName = `adda_chat_device_${userId}`;
  let secret = await SecureStore.getItemAsync(secretName);
  let deviceId = await SecureStore.getItemAsync(deviceName);
  if (!secret) { secret = bytesToBase64(nacl.box.keyPair().secretKey); await SecureStore.setItemAsync(secretName, secret); }
  if (!deviceId) { deviceId = Crypto.randomUUID(); await SecureStore.setItemAsync(deviceName, deviceId); }
  const pair = nacl.box.keyPair.fromSecretKey(base64ToBytes(secret));

  setRealtimeDeviceId(deviceId);

  const dbName = `adda-v2-${userId}.db`;
  const schemaSql = `PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS message (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, targetId TEXT NOT NULL, senderId TEXT NOT NULL,
      senderName TEXT NOT NULL, body TEXT NOT NULL, createdAt TEXT NOT NULL, status TEXT NOT NULL,
      replyTo TEXT, mentions TEXT
    );
    CREATE INDEX IF NOT EXISTS message_chat_idx ON message(kind, targetId, createdAt);
    CREATE TABLE IF NOT EXISTS known_key (deviceId TEXT PRIMARY KEY, userId TEXT NOT NULL, publicKey TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pending_read_receipt (messageId TEXT PRIMARY KEY, senderId TEXT NOT NULL);`;

  const db = await SQLite.openDatabaseAsync(dbName);
  await db.execAsync(schemaSql);
  try { await db.execAsync('ALTER TABLE message ADD COLUMN replyTo TEXT;'); } catch {}
  try { await db.execAsync('ALTER TABLE message ADD COLUMN mentions TEXT;'); } catch {}
  try { await db.execAsync('ALTER TABLE message ADD COLUMN reactions TEXT;'); } catch {}

  try {
    await socialApi('/chat/devices', 'POST', { deviceId, publicKey: bytesToBase64(pair.publicKey) });
    active = { userId, deviceId, secretKey: pair.secretKey, publicKey: bytesToBase64(pair.publicKey), db };
    void getRealtimeSocket(deviceId).then(live => {
      live.emit('chat:drain_spool', { deviceId });
      live.on('chat:message_deleted', (payload: { messageId?: string }) => {
        if (payload?.messageId) void handleRemoteMessageDeleted(payload.messageId);
      });
    }).catch(() => {});
  } catch (error) {
    await db.closeAsync();
    throw error;
  }
}

export async function closeEncryptedChat() {
  if (initializing) await initializing.catch(() => {});
  clearDecryptedMediaCache();
  if (active) await active.db.closeAsync();
  active = null;
}

function identity(): Identity {
  if (!active) throw new Error('Encrypted chat is not ready.');
  return active;
}

export function parseRow(row: any): LocalMessage {
  let replyTo: QuotedReply | null = null;
  if (row.replyTo) {
    try {
      replyTo = typeof row.replyTo === 'string' ? JSON.parse(row.replyTo) : row.replyTo;
    } catch {}
  }
  let mentions: string[] | null = null;
  if (row.mentions) {
    try {
      mentions = typeof row.mentions === 'string' ? JSON.parse(row.mentions) : row.mentions;
    } catch {}
  }
  let reactions: Record<string, string> | null = null;
  if (row.reactions) {
    try {
      reactions = typeof row.reactions === 'string' ? JSON.parse(row.reactions) : row.reactions;
    } catch {}
  }
  return {
    ...row,
    replyTo,
    mentions,
    reactions,
  };
}

export async function localMessages(target: ChatTarget): Promise<LocalMessage[]> {
  const rows = await identity().db.getAllAsync<any>(
    'SELECT * FROM message WHERE kind = ? AND targetId = ? ORDER BY createdAt ASC, id ASC LIMIT 300',
    target.kind, target.id
  );
  return rows.map(parseRow);
}

export async function localPreviews(): Promise<ChatPreview[]> {
  return identity().db.getAllAsync<ChatPreview>(
    `SELECT m.kind, m.targetId, m.senderId, m.senderName, m.body, m.createdAt
     FROM message m
     WHERE m.id = (
       COALESCE(
         (SELECT m2.id FROM message m2 WHERE m2.kind = m.kind AND m2.targetId = m.targetId AND m2.body <> '__adda_deleted__' ORDER BY m2.createdAt DESC, m2.id DESC LIMIT 1),
         (SELECT m3.id FROM message m3 WHERE m3.kind = m.kind AND m3.targetId = m.targetId ORDER BY m3.createdAt DESC, m3.id DESC LIMIT 1)
       )
     )`
  );
}

async function pinKeysInternal(db: SQLite.SQLiteDatabase, devices: DeviceKey[]) {
  for (const device of devices) {
    const known = await db.getFirstAsync<{ userId: string; publicKey: string }>('SELECT userId, publicKey FROM known_key WHERE deviceId = ?', device.deviceId);
    if (known) {
      if (known.userId !== device.userId || known.publicKey !== device.publicKey) {
        console.warn(`[ADDA] Updating known device key for device ${device.deviceId} (user: ${device.userId})`);
        await db.runAsync('UPDATE known_key SET userId = ?, publicKey = ? WHERE deviceId = ?', device.userId, device.publicKey, device.deviceId);
      }
    } else {
      await db.runAsync('INSERT OR IGNORE INTO known_key VALUES (?, ?, ?)', device.deviceId, device.userId, device.publicKey);
    }
  }
}

async function pinKeys(devices: DeviceKey[]) {
  const { db } = identity();
  return withDbLock(() => pinKeysInternal(db, devices));
}

// ========================================================
// INSTANT WEBSOCKET ENCRYPTED SEND
// ========================================================
export async function sendEncryptedMessage(
  target: ChatTarget,
  body: string,
  senderName: string,
  existingId?: string,
  replyTo?: QuotedReply | null,
  mentions?: string[] | null
): Promise<LocalMessage> {
  const previewText = body.length > 80 ? body.slice(0, 77) + '...' : body;
  return sendEncryptedContent(target, body, senderName, existingId, undefined, undefined, previewText, replyTo, mentions);
}

const inFlightMessages = new Set<string>();

async function sendEncryptedContent(
  target: ChatTarget,
  body: string,
  senderName: string,
  existingId?: string,
  prefetchedKeys?: KeyList,
  attachedMediaId?: string,
  previewText?: string,
  replyTo?: QuotedReply | null,
  mentions?: string[] | null
): Promise<LocalMessage> {
  const me = identity();
  const messageId = existingId ?? Crypto.randomUUID();

  if (inFlightMessages.has(messageId)) {
    const found = await me.db.getFirstAsync<any>('SELECT * FROM message WHERE id = ?', messageId);
    if (found) return parseRow(found);
  }
  inFlightMessages.add(messageId);

  try {
    const existingRaw = existingId ? await me.db.getFirstAsync<any>('SELECT * FROM message WHERE id = ?', existingId) : null;
    const existing = existingRaw ? parseRow(existingRaw) : null;
    const createdAt = existing?.createdAt ?? new Date().toISOString();
    const effectiveReplyTo = replyTo !== undefined ? replyTo : (existing?.replyTo ?? null);
    const effectiveMentions = mentions !== undefined ? mentions : (existing?.mentions ?? null);
    const message: LocalMessage = {
      id: messageId,
      kind: target.kind,
      targetId: target.id,
      senderId: me.userId,
      senderName,
      body,
      createdAt,
      status: 'queued',
      replyTo: effectiveReplyTo,
      mentions: effectiveMentions,
    };

    // 1. Optimistic SQLite Insert
    await withDbLock(() => me.db.runAsync(
      'INSERT OR IGNORE INTO message (id, kind, targetId, senderId, senderName, body, createdAt, status, replyTo, mentions) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      message.id, message.kind, message.targetId, message.senderId, message.senderName, message.body, message.createdAt, message.status,
      effectiveReplyTo ? JSON.stringify(effectiveReplyTo) : null,
      effectiveMentions ? JSON.stringify(effectiveMentions) : null
    ));
    changed();

    // 2. Encrypt in-memory using TweetNaCl (3ms)
    // For groups, always fetch fresh keys so all members and their current devices are included
    const keyList = prefetchedKeys ?? await getOrFetchKeys(target, target.kind === 'group');
    await pinKeys(keyList.devices);

    const contentKey = nacl.randomBytes(nacl.secretbox.keyLength);
    const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
    const mediaPayload = mediaFromBody(body);
    if (mediaPayload) {
      delete (mediaPayload as any).localUri;
    }
    const payloadObject = {
      ...(mediaPayload ?? { type: 'text', body, createdAt: message.createdAt, senderName }),
      version: 1, messageId, senderId: me.userId, kind: target.kind, targetId: target.id,
      recipients: keyList.members.filter(id => id !== me.userId),
      replyTo: effectiveReplyTo ?? null,
      mentions: effectiveMentions ?? null,
    };
    const payload = new TextEncoder().encode(JSON.stringify(payloadObject));
    const ciphertext = bytesToBase64(nacl.secretbox(payload, nonce, contentKey));

    const keys = keyList.devices.filter(device => device.deviceId !== me.deviceId).map(device => {
      const wrapNonce = nacl.randomBytes(nacl.box.nonceLength);
      return {
        deviceId: device.deviceId,
        wrappedKey: bytesToBase64(nacl.box(contentKey, wrapNonce, base64ToBytes(device.publicKey), me.secretKey)),
        wrapNonce: bytesToBase64(wrapNonce)
      };
    });

    // 3. Emit directly over persistent WebSocket (Single Gray Tick ✓)
    const live = await getRealtimeSocket(me.deviceId);
    live.emit('chat:send_instant', {
      messageId,
      senderDeviceId: me.deviceId,
      senderPublicKey: me.publicKey,
      target,
      ciphertext,
      nonce: bytesToBase64(nonce),
      keys,
      mediaId: attachedMediaId,
      previewText,
      mentions: effectiveMentions && effectiveMentions.length > 0 ? effectiveMentions : undefined
    }, async (ack: any) => {
      if (ack?.ok) {
        await withDbLock(() => me.db.runAsync("UPDATE message SET status = 'sent' WHERE id = ? AND status = 'queued'", messageId));
        changed();
      }
    });

    return message;
  } finally {
    inFlightMessages.delete(messageId);
  }
}

// ========================================================
// BACKGROUND MEDIA UPLOAD & ENCRYPTED DISPATCH
// ========================================================
export async function sendEncryptedMedia(
  target: ChatTarget,
  uri: string,
  mediaKind: 'image' | 'video',
  mimeType: string,
  senderName: string,
  existingMessageId?: string,
  replyTo?: QuotedReply | null,
  mentions?: string[] | null
): Promise<LocalMessage> {
  const source = new File(uri);
  if (source.size < 1 || source.size > 25 * 1024 * 1024 - 16) throw new Error('Choose an image or video under 25 MB.');
  const key = nacl.randomBytes(nacl.secretbox.keyLength);
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const sourceBytes = await source.bytes();
  const encrypted = nacl.secretbox(sourceBytes, nonce, key);

  // In parallel: obtain upload URL and fetch recipient public keys
  const [upload, keyList] = await Promise.all([
    socialApi<{ mediaId: string; url: string; contentType: string }>('/chat/media/upload', 'POST',
      { target, mediaKind, contentLength: encrypted.byteLength }),
    socialApi<KeyList>(`/chat/keys/${target.kind}/${encodeURIComponent(target.id)}`)
  ]);

  encryptedMediaFile(upload.mediaId).write(encrypted);

  // Cache decrypted file immediately so sender sees preview with zero delay
  const decryptedCache = new File(Paths.cache, `adda-media-${upload.mediaId}.${mediaKind === 'image' ? 'jpg' : 'mp4'}`);
  decryptedCache.write(sourceBytes);

  const encryptedFile = new File(Paths.cache, `adda-encrypted-upload-${upload.mediaId}`);
  encryptedFile.write(encrypted);
  try {
    const result = await encryptedFile.upload(upload.url, { httpMethod: 'PUT', headers: { 'Content-Type': upload.contentType } });
    if (result.status < 200 || result.status >= 300) throw new Error('Encrypted upload failed.');
    await socialApi(`/chat/media/${upload.mediaId}/confirm`, 'POST', {});
  } finally { encryptedFile.delete(); }

  const media: EncryptedMedia = {
    type: 'media',
    mediaId: upload.mediaId,
    mediaKind,
    key: bytesToBase64(key),
    nonce: bytesToBase64(nonce),
    mimeType,
    createdAt: new Date().toISOString(),
    senderName,
    localUri: uri
  };

  const previewText = mediaKind === 'video' ? '🎥 Video' : '📷 Photo';
  return sendEncryptedContent(target, mediaPrefix + JSON.stringify(media), senderName, existingMessageId, keyList, upload.mediaId, previewText, replyTo, mentions);
}

export async function openEncryptedMedia(media: EncryptedMedia): Promise<string> {
  if (media.localUri) {
    try {
      const local = new File(media.localUri);
      if (local.exists && local.size > 0) return media.localUri;
    } catch {}
  }
  const destination = new File(Paths.cache, `adda-media-${media.mediaId}.${media.mediaKind === 'image' ? 'jpg' : 'mp4'}`);
  if (destination.exists && destination.size > 0) return destination.uri;
  const encryptedFile = encryptedMediaFile(media.mediaId);
  if (!encryptedFile.exists) await saveEncryptedMedia(media);
  if (destination.exists && destination.size > 0) return destination.uri;
  const plain = nacl.secretbox.open(await encryptedFile.bytes(), base64ToBytes(media.nonce), base64ToBytes(media.key));
  if (!plain) throw new Error('Could not verify encrypted media.');
  destination.write(plain);
  return destination.uri;
}

function encryptedMediaFile(mediaId: string) { return new File(Paths.document, `adda-media-${mediaId}.enc`); }
export function releaseDecryptedMedia(_uri: string) {}

function clearDecryptedMediaCache() {
  for (const item of Paths.cache.list()) {
    if (item instanceof File && item.name.startsWith('adda-media-') && item.exists) item.delete();
  }
}

async function saveEncryptedMedia(media: EncryptedMedia) {
  const destination = encryptedMediaFile(media.mediaId);
  const decryptedCache = new File(Paths.cache, `adda-media-${media.mediaId}.${media.mediaKind === 'image' ? 'jpg' : 'mp4'}`);
  if (destination.exists) {
    const existing = nacl.secretbox.open(await destination.bytes(), base64ToBytes(media.nonce), base64ToBytes(media.key));
    if (existing) {
      if (!decryptedCache.exists || decryptedCache.size === 0) decryptedCache.write(existing);
      return;
    }
    destination.delete();
  }
  const { url } = await socialApi<{ url: string }>(`/chat/media/${encodeURIComponent(media.mediaId)}/download`);
  await File.downloadFileAsync(url, destination, { idempotent: true });
  const verified = nacl.secretbox.open(await destination.bytes(), base64ToBytes(media.nonce), base64ToBytes(media.key));
  if (!verified) { destination.delete(); throw new Error('Could not verify encrypted media.'); }
  decryptedCache.write(verified);
}

// ========================================================
// INCOMING MESSAGE ENVELOPE (WhatsApp Delivery ACK)
// ========================================================
export async function receiveDirectEnvelope(envelope: Envelope): Promise<void> {
  if (!active) {
    const uid = getActiveUserId();
    if (uid) await initEncryptedChat(uid).catch(() => {});
  }
  if (!active) return;
  const me = active;
  if (envelope.recipientDeviceId && envelope.recipientDeviceId !== me.deviceId) return;

  // Immediately emit delivery ACK over socket (or HTTP fallback) to trigger Double Gray Tick (✓✓) on sender
  const live = await getRealtimeSocket(me.deviceId).catch(() => null);
  if (live?.connected) {
    live.emit('chat:ack_delivery', {
      messageId: envelope.messageId,
      senderId: envelope.senderId
    });
  } else {
    void socialApi('/chat/delivery-ack', 'POST', {
      messageId: envelope.messageId,
      senderId: envelope.senderId
    }).catch(() => {});
  }

  await withDbLock(async () => {
    const existing = await me.db.getFirstAsync<{ id: string }>('SELECT id FROM message WHERE id = ?', envelope.messageId);
    if (existing) return;

    try {
      if (!envelope.senderPublicKey) {
        console.warn('[ADDA] Envelope missing senderPublicKey, skipping');
        return;
      }
      await pinKeysInternal(me.db, [{ deviceId: envelope.senderDeviceId, userId: envelope.senderId, publicKey: envelope.senderPublicKey }]);
      const contentKey = nacl.box.open(base64ToBytes(envelope.wrappedKey), base64ToBytes(envelope.wrapNonce), base64ToBytes(envelope.senderPublicKey), me.secretKey);
      if (!contentKey) {
        console.warn('[ADDA] Could not decrypt contentKey for envelope', envelope.messageId);
        return;
      }
      const plaintext = nacl.secretbox.open(base64ToBytes(envelope.ciphertext), base64ToBytes(envelope.nonce), contentKey);
      if (!plaintext) {
        console.warn('[ADDA] Could not decrypt plaintext for envelope', envelope.messageId);
        return;
      }
      const content: unknown = JSON.parse(new TextDecoder().decode(plaintext));
      if (!content || typeof content !== 'object' || !('type' in content) || (content.type !== 'text' && content.type !== 'media')) return;
      if (content.type === 'media' && 'localUri' in content) {
        delete (content as any).localUri;
      }
      const body = content.type === 'media' ? mediaPrefix + JSON.stringify(content) : ('body' in content && typeof content.body === 'string' ? content.body : null);
      if (body === null) return;
      const savedCreatedAt = ('createdAt' in content && typeof content.createdAt === 'string') ? content.createdAt : envelope.createdAt;
      const targetId = envelope.kind === 'direct' ? (envelope.senderId === me.userId ? envelope.targetId : envelope.senderId) : envelope.targetId;
      const incomingReplyTo = ('replyTo' in (content as any) && (content as any).replyTo) ? (content as any).replyTo : null;
      const incomingMentions = ('mentions' in (content as any) && Array.isArray((content as any).mentions)) ? (content as any).mentions : null;

      await me.db.runAsync(
        'INSERT OR IGNORE INTO message (id, kind, targetId, senderId, senderName, body, createdAt, status, replyTo, mentions) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        envelope.messageId, envelope.kind, targetId, envelope.senderId,
        'senderName' in content && typeof content.senderName === 'string' ? content.senderName : envelope.senderName,
        body, savedCreatedAt, envelope.senderId === me.userId ? 'sent' : 'received',
        incomingReplyTo ? JSON.stringify(incomingReplyTo) : null,
        incomingMentions ? JSON.stringify(incomingMentions) : null
      );

      changed();
    } catch (err) {
      console.warn('[ADDA] Direct envelope processing warning:', err);
    }
  });
}

// ========================================================
// INCOMING TICK STATUS UPDATE (Single -> Double -> Blue)
// ==========================================
export async function handleMessageStatusUpdate(update: { messageId?: string; messageIds?: string[]; status: 'delivered' | 'read' }): Promise<void> {
  if (!active) return;
  const me = active;
  const ids = update.messageIds ?? (update.messageId ? [update.messageId] : []);
  if (ids.length === 0) return;

  await withDbLock(async () => {
    for (const id of ids) {
      if (update.status === 'read') {
        await me.db.runAsync("UPDATE message SET status = 'read' WHERE id = ?", id);
      } else if (update.status === 'delivered') {
        await me.db.runAsync("UPDATE message SET status = 'delivered' WHERE id = ? AND status <> 'read'", id);
      }
    }
  });
  changed();
}

// ========================================================
// MARK CHAT READ (WhatsApp Double Blue Tick ✓✓)
// ========================================================
export async function markChatRead(target: ChatTarget): Promise<void> {
  if (!active) return;
  const me = active;

  const rows = await me.db.getAllAsync<{ id: string; senderId: string }>(
    "SELECT id, senderId FROM message WHERE kind = ? AND targetId = ? AND senderId <> ? AND status <> 'read' ORDER BY createdAt DESC LIMIT 100",
    target.kind, target.id, me.userId
  );

  if (rows.length === 0) return;

  const ids = rows.map(r => r.id);
  const otherUserId = target.kind === 'direct' ? target.id : rows[0]?.senderId;

  await withDbLock(async () => {
    for (const id of ids) {
      await me.db.runAsync("UPDATE message SET status = 'read' WHERE id = ?", id);
    }
  });
  changed();

  const live = await getRealtimeSocket(me.deviceId).catch(() => null);
  if (live?.connected && otherUserId) {
    live.emit('chat:ack_read', { messageIds: ids, senderId: otherUserId });
  } else if (otherUserId) {
    void socialApi('/chat/read-ack', 'POST', { messageIds: ids, senderId: otherUserId }).catch(() => {});
    await withDbLock(async () => {
      for (const id of ids) {
        await me.db.runAsync('INSERT OR IGNORE INTO pending_read_receipt VALUES (?, ?)', id, otherUserId);
      }
    });
  }
}

// ========================================================
// RECONNECT SYNC: OUTBOX & READ RECEIPTS FLUSH
// ========================================================
export async function syncEncryptedChat(): Promise<void> {
  if (!active) return;
  const me = active;
  const live = await getRealtimeSocket(me.deviceId).catch(() => null);
  if (!live?.connected) return;

  // Drain pending offline messages for this device
  live.emit('chat:drain_spool', { deviceId: me.deviceId });

  // 1. Flush queued outbox messages
  const queued = await me.db.getAllAsync<LocalMessage>("SELECT * FROM message WHERE senderId = ? AND status = 'queued' ORDER BY createdAt LIMIT 20", me.userId);
  for (const item of queued) {
    try { await sendEncryptedContent({ kind: item.kind, id: item.targetId }, item.body, item.senderName, item.id); }
    catch { /* Keep in outbox */ }
  }

  // 2. Flush pending read receipts
  const receipts = await me.db.getAllAsync<{ messageId: string; senderId: string }>('SELECT messageId, senderId FROM pending_read_receipt');
  if (receipts.length > 0) {
    const bySender = new Map<string, string[]>();
    for (const r of receipts) {
      const list = bySender.get(r.senderId) ?? [];
      list.push(r.messageId);
      bySender.set(r.senderId, list);
    }
    for (const [senderId, messageIds] of bySender.entries()) {
      live.emit('chat:ack_read', { messageIds, senderId });
    }
    await me.db.runAsync('DELETE FROM pending_read_receipt');
  }
}

export async function deleteLocalMessage(messageId: string): Promise<void> {
  const me = identity();
  const row = await me.db.getFirstAsync<LocalMessage>('SELECT body FROM message WHERE id = ?', messageId);
  if (row) {
    const media = mediaFromBody(row.body);
    if (media) {
      try {
        const encryptedFile = encryptedMediaFile(media.mediaId);
        if (encryptedFile.exists) encryptedFile.delete();
        const decryptedCache = new File(Paths.cache, `adda-media-${media.mediaId}.${media.mediaKind === 'image' ? 'jpg' : 'mp4'}`);
        if (decryptedCache.exists) decryptedCache.delete();
      } catch (e) {
        console.warn('Could not clean up media files on delete:', e);
      }
    }
  }
  await withDbLock(async () => {
    await me.db.runAsync('DELETE FROM message WHERE id = ?', messageId);
  });
  changed();
}

export async function markMessageDeletedForEveryone(messageId: string): Promise<void> {
  const me = identity();
  const row = await me.db.getFirstAsync<LocalMessage>('SELECT body FROM message WHERE id = ?', messageId);
  if (row) {
    const media = mediaFromBody(row.body);
    if (media) {
      try {
        const encryptedFile = encryptedMediaFile(media.mediaId);
        if (encryptedFile.exists) encryptedFile.delete();
        const decryptedCache = new File(Paths.cache, `adda-media-${media.mediaId}.${media.mediaKind === 'image' ? 'jpg' : 'mp4'}`);
        if (decryptedCache.exists) decryptedCache.delete();
      } catch (e) {
        console.warn('Could not clean up media files on delete:', e);
      }
    }
  }
  await withDbLock(async () => {
    await me.db.runAsync(
      'UPDATE message SET body = ?, reactions = NULL, replyTo = NULL, mentions = NULL WHERE id = ?',
      '__adda_deleted__',
      messageId
    );
  });
  changed();
}

export async function deleteMessageForEveryone(target: ChatTarget, messageId: string): Promise<void> {
  const me = identity();
  const live = await getRealtimeSocket(me.deviceId).catch(() => null);
  if (live?.connected) {
    live.emit('chat:delete_for_everyone', { messageId, target });
  }
  await markMessageDeletedForEveryone(messageId);
}

export async function handleRemoteMessageDeleted(messageId: string): Promise<void> {
  if (!active) return;
  await markMessageDeletedForEveryone(messageId);
}

export async function toggleMessageReaction(target: ChatTarget, messageId: string, emoji: string): Promise<void> {
  const me = identity();
  await withDbLock(async () => {
    const row = await me.db.getFirstAsync<any>('SELECT reactions FROM message WHERE id = ?', messageId);
    let reactions: Record<string, string> = {};
    if (row?.reactions) {
      try { reactions = typeof row.reactions === 'string' ? JSON.parse(row.reactions) : row.reactions; } catch {}
    }
    if (reactions[me.userId] === emoji) {
      delete reactions[me.userId];
    } else {
      reactions[me.userId] = emoji;
    }
    await me.db.runAsync('UPDATE message SET reactions = ? WHERE id = ?', JSON.stringify(reactions), messageId);
  });
  changed();

  const live = await getRealtimeSocket(me.deviceId).catch(() => null);
  if (live?.connected) {
    live.emit('chat:reaction', { messageId, target, emoji });
  }
}

export async function handleRemoteReaction(data: { messageId: string; userId: string; emoji: string }): Promise<void> {
  if (!active) return;
  const me = active;
  await withDbLock(async () => {
    const row = await me.db.getFirstAsync<any>('SELECT reactions FROM message WHERE id = ?', data.messageId);
    if (!row) return;
    let reactions: Record<string, string> = {};
    if (row.reactions) {
      try { reactions = typeof row.reactions === 'string' ? JSON.parse(row.reactions) : row.reactions; } catch {}
    }
    if (reactions[data.userId] === data.emoji) {
      delete reactions[data.userId];
    } else {
      reactions[data.userId] = data.emoji;
    }
    await me.db.runAsync('UPDATE message SET reactions = ? WHERE id = ?', JSON.stringify(reactions), data.messageId);
  });
  changed();
}

export async function chatSafetyCode(target: ChatTarget): Promise<string> {
  const keys = await socialApi<KeyList>(`/chat/keys/${target.kind}/${encodeURIComponent(target.id)}`);
  await pinKeys(keys.devices);
  const canonical = keys.devices.map(item => `${item.userId}:${item.deviceId}:${item.publicKey}`).sort().join('|');
  const chatId = target.kind === 'direct' ? [identity().userId, target.id].sort().join(':') : target.id;
  const bytes = nacl.hash(new TextEncoder().encode(`ADDA chat keys v1|${target.kind}|${chatId}|${canonical}`));
  const hex = Array.from(bytes.slice(0, 20), byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
  return hex.match(/.{1,5}/g)?.join(' ') ?? hex;
}
