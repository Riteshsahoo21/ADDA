import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';
import { File, Paths } from 'expo-file-system';
import nacl from 'tweetnacl';
import { socialApi } from './social-api';
import type { ChatTarget } from './realtime';

export type LocalMessage = {
  id: string; kind: ChatTarget['kind']; targetId: string; senderId: string; senderName: string;
  body: string; createdAt: string; status: 'queued' | 'sent' | 'delivered' | 'read' | 'received';
};
type DeviceKey = { deviceId: string; userId: string; publicKey: string };
type KeyList = { members: string[]; devices: DeviceKey[] };
type Envelope = {
  deliveryId: string; messageId: string; senderId: string; senderDeviceId: string; senderPublicKey: string;
  senderName: string; kind: ChatTarget['kind']; targetId: string; ciphertext: string; nonce: string;
  wrappedKey: string; wrapNonce: string; createdAt: string;
};
type Receipt = { id: string; messageId: string; actorId: string; kind: 'delivered' | 'read' };
type Pending = { messages: Envelope[]; receipts: Receipt[]; hasMore: boolean };
type Identity = { userId: string; deviceId: string; secretKey: Uint8Array; publicKey: string; db: SQLite.SQLiteDatabase };
export type EncryptedMedia = { type: 'media'; mediaId: string; mediaKind: 'image' | 'video'; key: string; nonce: string; mimeType: string; createdAt: string; senderName: string };
const mediaPrefix = '\u0000adda-media:';
export function mediaFromBody(body: string): EncryptedMedia | null {
  if (!body.startsWith(mediaPrefix)) return null;
  try {
    const data: EncryptedMedia = JSON.parse(body.slice(mediaPrefix.length));
    return data.type === 'media' && typeof data.mediaId === 'string' && (data.mediaKind === 'image' || data.mediaKind === 'video') ? data : null;
  } catch { return null; }
}
export function previewBody(body: string) { const media = mediaFromBody(body); return media ? (media.mediaKind === 'image' ? 'Photo' : 'Video') : body; }

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

// TweetNaCl needs a platform CSPRNG on React Native. Expo Crypto supplies native random bytes.
nacl.setPRNG((buffer, size) => {
  for (let offset = 0; offset < size; offset += 1024) buffer.set(Crypto.getRandomBytes(Math.min(1024, size - offset)), offset);
});

let active: Identity | null = null;
let initializing: Promise<void> | null = null;
let syncing: Promise<void> | null = null;
const listeners = new Set<() => void>();
export function onChatChanged(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
function changed() { listeners.forEach(listener => listener()); }

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
  const dbKeyName = `adda_chat_db_key_${userId}`;
  const deviceName = `adda_chat_device_${userId}`;
  let secret = await SecureStore.getItemAsync(secretName);
  let dbKey = await SecureStore.getItemAsync(dbKeyName);
  let deviceId = await SecureStore.getItemAsync(deviceName);
  if (!secret) { secret = bytesToBase64(nacl.box.keyPair().secretKey); await SecureStore.setItemAsync(secretName, secret); }
  if (!dbKey) { dbKey = bytesToBase64(Crypto.getRandomBytes(32)); await SecureStore.setItemAsync(dbKeyName, dbKey); }
  if (!deviceId) { deviceId = Crypto.randomUUID(); await SecureStore.setItemAsync(deviceName, deviceId); }
  const pair = nacl.box.keyPair.fromSecretKey(base64ToBytes(secret));
  const db = await SQLite.openDatabaseAsync(`adda-chat-${userId}.db`);
  try {
    await db.execAsync(`PRAGMA key = '${dbKey}';`);
    const cipher = await db.getFirstAsync<{ cipher_version: string }>('PRAGMA cipher_version;');
    if (!cipher?.cipher_version) throw new Error('Encrypted local database is unavailable. Rebuild ADDA with SQLCipher.');
    await db.execAsync(`PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS message (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, targetId TEXT NOT NULL, senderId TEXT NOT NULL,
        senderName TEXT NOT NULL, body TEXT NOT NULL, createdAt TEXT NOT NULL, status TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS message_chat_idx ON message(kind, targetId, createdAt);
      CREATE TABLE IF NOT EXISTS known_key (deviceId TEXT PRIMARY KEY, userId TEXT NOT NULL, publicKey TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS message_receipt (messageId TEXT NOT NULL, actorId TEXT NOT NULL, kind TEXT NOT NULL,
        PRIMARY KEY (messageId, actorId, kind));
      CREATE TABLE IF NOT EXISTS message_recipient (messageId TEXT NOT NULL, userId TEXT NOT NULL, PRIMARY KEY (messageId, userId));`);
    await socialApi('/chat/devices', 'POST', { deviceId, publicKey: bytesToBase64(pair.publicKey) });
    active = { userId, deviceId, secretKey: pair.secretKey, publicKey: bytesToBase64(pair.publicKey), db };
  } catch (error) { await db.closeAsync(); throw error; }
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
export function currentChatDeviceId() { return active?.deviceId ?? null; }

export async function chatSafetyCode(target: ChatTarget): Promise<string> {
  const keys = await socialApi<KeyList>(`/chat/keys/${target.kind}/${encodeURIComponent(target.id)}`);
  await pinKeys(keys.devices);
  const canonical = keys.devices.map(item => `${item.userId}:${item.deviceId}:${item.publicKey}`).sort().join('|');
  const chatId = target.kind === 'direct' ? [identity().userId, target.id].sort().join(':') : target.id;
  const bytes = nacl.hash(new TextEncoder().encode(`ADDA chat keys v1|${target.kind}|${chatId}|${canonical}`));
  const hex = Array.from(bytes.slice(0, 20), byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
  return hex.match(/.{1,5}/g)?.join(' ') ?? hex;
}

export async function localMessages(target: ChatTarget): Promise<LocalMessage[]> {
  return identity().db.getAllAsync<LocalMessage>('SELECT * FROM message WHERE kind = ? AND targetId = ? ORDER BY createdAt, id LIMIT 300', target.kind, target.id);
}

export async function localPreviews(): Promise<{ kind: string; targetId: string; body: string; createdAt: string }[]> {
  return identity().db.getAllAsync('SELECT m.kind, m.targetId, m.body, m.createdAt FROM message m WHERE m.id = (SELECT m2.id FROM message m2 WHERE m2.kind = m.kind AND m2.targetId = m.targetId ORDER BY m2.createdAt DESC, m2.id DESC LIMIT 1)');
}

async function pinKeys(devices: DeviceKey[]) {
  const { db } = identity();
  await db.withExclusiveTransactionAsync(async tx => {
    for (const device of devices) {
      const known = await tx.getFirstAsync<{ userId: string; publicKey: string }>('SELECT userId, publicKey FROM known_key WHERE deviceId = ?', device.deviceId);
      if (known && (known.userId !== device.userId || known.publicKey !== device.publicKey)) throw new Error('A chat device key changed. Stop and verify this contact before continuing.');
      if (!known) await tx.runAsync('INSERT INTO known_key VALUES (?, ?, ?)', device.deviceId, device.userId, device.publicKey);
    }
  });
}

export async function sendEncryptedMessage(target: ChatTarget, body: string, senderName: string, existingId?: string): Promise<LocalMessage> {
  return sendEncryptedContent(target, body, senderName, existingId);
}

async function sendEncryptedContent(target: ChatTarget, body: string, senderName: string, existingId?: string): Promise<LocalMessage> {
  const me = identity();
  const messageId = existingId ?? Crypto.randomUUID();
  const existing = existingId ? await me.db.getFirstAsync<LocalMessage>('SELECT * FROM message WHERE id = ?', existingId) : null;
  const createdAt = existing?.createdAt ?? new Date().toISOString();
  const message: LocalMessage = { id: messageId, kind: target.kind, targetId: target.id, senderId: me.userId, senderName, body, createdAt, status: 'queued' };
  await me.db.runAsync('INSERT OR IGNORE INTO message VALUES (?, ?, ?, ?, ?, ?, ?, ?)', message.id, message.kind, message.targetId, message.senderId, message.senderName, message.body, message.createdAt, message.status);
  changed();
  const keyList = await socialApi<KeyList>(`/chat/keys/${target.kind}/${encodeURIComponent(target.id)}`);
  await pinKeys(keyList.devices);
  const contentKey = nacl.randomBytes(nacl.secretbox.keyLength);
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const payloadObject = { ...(mediaFromBody(body) ?? { type: 'text', body, createdAt: message.createdAt, senderName }),
    version: 1, messageId, senderId: me.userId, kind: target.kind, targetId: target.id,
    recipients: keyList.members.filter(id => id !== me.userId) };
  const payload = new TextEncoder().encode(JSON.stringify(payloadObject));
  const ciphertext = bytesToBase64(nacl.secretbox(payload, nonce, contentKey));
  const keys = keyList.devices.filter(device => device.deviceId !== me.deviceId).map(device => {
    const wrapNonce = nacl.randomBytes(nacl.box.nonceLength);
    return { deviceId: device.deviceId, wrappedKey: bytesToBase64(nacl.box(contentKey, wrapNonce, base64ToBytes(device.publicKey), me.secretKey)), wrapNonce: bytesToBase64(wrapNonce) };
  });
  const media = mediaFromBody(body);
  const sent = await socialApi<{ recipients: string[] }>('/chat/send', 'POST', { messageId, senderDeviceId: me.deviceId, target, ciphertext, nonce: bytesToBase64(nonce), keys,
    mediaIds: media ? [media.mediaId] : [] });
  await me.db.withExclusiveTransactionAsync(async tx => {
    for (const recipient of sent.recipients) await tx.runAsync('INSERT OR IGNORE INTO message_recipient VALUES (?, ?)', messageId, recipient);
    await tx.runAsync("UPDATE message SET status = 'sent' WHERE id = ? AND status = 'queued'", messageId);
  });
  changed();
  return { ...message, status: 'sent' };
}

export async function sendEncryptedMedia(target: ChatTarget, uri: string, mediaKind: 'image' | 'video', mimeType: string, senderName: string): Promise<LocalMessage> {
  const source = new File(uri);
  if (source.size < 1 || source.size > 25 * 1024 * 1024 - 16) throw new Error('Choose an image or video under 25 MB.');
  const key = nacl.randomBytes(nacl.secretbox.keyLength);
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const encrypted = nacl.secretbox(await source.bytes(), nonce, key);
  const upload = await socialApi<{ mediaId: string; url: string; contentType: string }>('/chat/media/upload', 'POST',
    { target, mediaKind, contentLength: encrypted.byteLength });
  encryptedMediaFile(upload.mediaId).write(encrypted);
  const encryptedFile = new File(Paths.cache, `adda-encrypted-upload-${upload.mediaId}`);
  encryptedFile.write(encrypted);
  try {
    const result = await encryptedFile.upload(upload.url, { httpMethod: 'PUT', headers: { 'Content-Type': upload.contentType } });
    if (result.status < 200 || result.status >= 300) throw new Error('Encrypted upload failed.');
    await socialApi(`/chat/media/${upload.mediaId}/confirm`, 'POST', {});
  } finally { encryptedFile.delete(); }
  const media: EncryptedMedia = { type: 'media', mediaId: upload.mediaId, mediaKind, key: bytesToBase64(key), nonce: bytesToBase64(nonce), mimeType,
    createdAt: new Date().toISOString(), senderName };
  return sendEncryptedContent(target, mediaPrefix + JSON.stringify(media), senderName);
}

export async function openEncryptedMedia(media: EncryptedMedia): Promise<string> {
  const destination = new File(Paths.cache, `adda-media-${media.mediaId}.${media.mediaKind === 'image' ? 'jpg' : 'mp4'}`);
  if (destination.exists) return destination.uri;
  const encryptedFile = encryptedMediaFile(media.mediaId);
  if (!encryptedFile.exists) await saveEncryptedMedia(media);
  const plain = nacl.secretbox.open(await encryptedFile.bytes(), base64ToBytes(media.nonce), base64ToBytes(media.key));
  if (!plain) throw new Error('Could not verify encrypted media.');
  destination.write(plain);
  return destination.uri;
}

function encryptedMediaFile(mediaId: string) { return new File(Paths.document, `adda-media-${mediaId}.enc`); }
export function releaseDecryptedMedia(uri: string) {
  const file = new File(uri);
  if (file.name.startsWith('adda-media-') && file.exists) file.delete();
}

function clearDecryptedMediaCache() {
  for (const item of Paths.cache.list()) {
    if (item instanceof File && item.name.startsWith('adda-media-') && item.exists) item.delete();
  }
}

async function saveEncryptedMedia(media: EncryptedMedia) {
  const destination = encryptedMediaFile(media.mediaId);
  if (destination.exists) {
    const existing = nacl.secretbox.open(await destination.bytes(), base64ToBytes(media.nonce), base64ToBytes(media.key));
    if (existing) return;
    destination.delete();
  }
  const { url } = await socialApi<{ url: string }>(`/chat/media/${encodeURIComponent(media.mediaId)}/download`);
  await File.downloadFileAsync(url, destination, { idempotent: true });
  const verified = nacl.secretbox.open(await destination.bytes(), base64ToBytes(media.nonce), base64ToBytes(media.key));
  if (!verified) { destination.delete(); throw new Error('Could not verify encrypted media.'); }
}

export async function syncEncryptedChat(): Promise<void> {
  if (syncing) return syncing;
  syncing = doSync().finally(() => { syncing = null; });
  return syncing;
}

async function doSync() {
  const me = identity();
  for (let page = 0; page < 20; page++) {
    const pending = await socialApi<Pending>(`/chat/pending?deviceId=${encodeURIComponent(me.deviceId)}`);
    for (const envelope of pending.messages) {
      await pinKeys([{ deviceId: envelope.senderDeviceId, userId: envelope.senderId, publicKey: envelope.senderPublicKey }]);
      const contentKey = nacl.box.open(base64ToBytes(envelope.wrappedKey), base64ToBytes(envelope.wrapNonce), base64ToBytes(envelope.senderPublicKey), me.secretKey);
      if (!contentKey) throw new Error('Could not unlock a message key.');
      const plaintext = nacl.secretbox.open(base64ToBytes(envelope.ciphertext), base64ToBytes(envelope.nonce), contentKey);
      if (!plaintext) throw new Error('Could not verify an encrypted message.');
      const content: unknown = JSON.parse(new TextDecoder().decode(plaintext));
      if (!content || typeof content !== 'object' || !('type' in content) ||
          (content.type !== 'text' && content.type !== 'media') || !('createdAt' in content) || typeof content.createdAt !== 'string') {
        throw new Error('Unsupported encrypted message.');
      }
      if (!('version' in content) || content.version !== 1 || !('messageId' in content) || content.messageId !== envelope.messageId ||
          !('senderId' in content) || content.senderId !== envelope.senderId || !('kind' in content) || content.kind !== envelope.kind ||
          !('targetId' in content) || content.targetId !== envelope.targetId) throw new Error('Encrypted message routing did not match its contents.');
      const body = content.type === 'media' ? mediaPrefix + JSON.stringify(content) : ('body' in content && typeof content.body === 'string' ? content.body : null);
      if (body === null) throw new Error('Invalid encrypted message.');
      const savedCreatedAt = content.createdAt as string;
      if (content.type === 'media') {
        const media = mediaFromBody(body);
        if (!media) throw new Error('Invalid encrypted media.');
        // Keep a verified encrypted copy on the device before acknowledging server deletion.
        await saveEncryptedMedia(media);
      }
      const targetId = envelope.kind === 'direct' ? (envelope.senderId === me.userId ? envelope.targetId : envelope.senderId) : envelope.targetId;
      await me.db.withExclusiveTransactionAsync(async tx => {
        await tx.runAsync('INSERT OR IGNORE INTO message VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          envelope.messageId, envelope.kind, targetId, envelope.senderId,
          'senderName' in content && typeof content.senderName === 'string' ? content.senderName : envelope.senderName,
          body, savedCreatedAt, envelope.senderId === me.userId ? 'sent' : 'received');
        if (envelope.senderId === me.userId && 'recipients' in content && Array.isArray(content.recipients)) {
          for (const recipient of content.recipients) if (typeof recipient === 'string') await tx.runAsync('INSERT OR IGNORE INTO message_recipient VALUES (?, ?)', envelope.messageId, recipient);
        }
      });
      // Delete the server copy only after SQLite confirms it has saved the plaintext.
      await socialApi('/chat/ack', 'POST', { deviceId: me.deviceId, deliveryId: envelope.deliveryId });
      changed();
    }
    const receiptIds: string[] = [];
    for (const receipt of pending.receipts) {
      await me.db.withExclusiveTransactionAsync(async tx => {
        await tx.runAsync('INSERT OR IGNORE INTO message_receipt VALUES (?, ?, ?)', receipt.messageId, receipt.actorId, receipt.kind);
        const counts = await tx.getFirstAsync<{ total: number; delivered: number; read: number }>(
          `SELECT COUNT(*) AS total,
           SUM(CASE WHEN EXISTS (SELECT 1 FROM message_receipt r WHERE r.messageId = m.messageId AND r.actorId = m.userId AND r.kind IN ('delivered', 'read')) THEN 1 ELSE 0 END) AS delivered,
           SUM(CASE WHEN EXISTS (SELECT 1 FROM message_receipt r WHERE r.messageId = m.messageId AND r.actorId = m.userId AND r.kind = 'read') THEN 1 ELSE 0 END) AS read
           FROM message_recipient m WHERE m.messageId = ?`, receipt.messageId);
        if (counts && counts.total > 0 && counts.read === counts.total) await tx.runAsync("UPDATE message SET status = 'read' WHERE id = ? AND senderId = ?", receipt.messageId, me.userId);
        else if (counts && counts.total > 0 && counts.delivered === counts.total) await tx.runAsync("UPDATE message SET status = 'delivered' WHERE id = ? AND senderId = ? AND status <> 'read'", receipt.messageId, me.userId);
      });
      receiptIds.push(receipt.id);
      changed();
    }
    if (receiptIds.length) await socialApi('/chat/receipt-ack', 'POST', { deviceId: me.deviceId, receiptIds });
    if (!pending.hasMore) break;
  }
  const queued = await me.db.getAllAsync<LocalMessage>("SELECT * FROM message WHERE senderId = ? AND status = 'queued' ORDER BY createdAt LIMIT 20", me.userId);
  for (const item of queued) {
    try { await sendEncryptedContent({ kind: item.kind, id: item.targetId }, item.body, item.senderName, item.id); }
    catch { /* Keep this message in the encrypted outbox for the next reconnect. */ }
  }
}

export async function markChatRead(target: ChatTarget) {
  const me = identity();
  const rows = await me.db.getAllAsync<{ id: string }>('SELECT id FROM message WHERE kind = ? AND targetId = ? AND senderId <> ? ORDER BY createdAt DESC LIMIT 100', target.kind, target.id, me.userId);
  if (rows.length) await socialApi('/chat/read', 'POST', { deviceId: me.deviceId, messageIds: rows.map(row => row.id) });
}
