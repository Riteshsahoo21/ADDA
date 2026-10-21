import * as Crypto from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import { gunzipSync } from 'fflate';
import { API_BASE_URL } from '@/lib/auth-client';
import { roomAssetManifest } from './roomAssetManifest';

export type DownloadableRoom = keyof typeof roomAssetManifest.packs;
const root = () => new Directory(Paths.document, 'adda-room-assets');
const versionRoot = () => new Directory(root(), roomAssetManifest.version);
const packDirectory = (room: DownloadableRoom) => new Directory(versionRoot(), room);
const assetBaseUrl = (process.env.EXPO_PUBLIC_ROOM_ASSET_URL || `${API_BASE_URL}/room-assets`).replace(/\/$/, '');

function packFile(room: DownloadableRoom, name: string): File {
  const [kind, filename] = name.split('/');
  if (!['models', 'textures'].includes(kind) || !filename || filename.includes('..')) throw new Error('Invalid room asset name.');
  return new File(packDirectory(room), kind, filename);
}

async function verified(file: File, name: string): Promise<boolean> {
  const expected = roomAssetManifest.files[name as keyof typeof roomAssetManifest.files];
  if (!expected || !file.exists || file.size !== expected.size) return false;
  const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, await file.arrayBuffer());
  const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return hex === expected.sha256;
}

export function roomDownloadSize(room: DownloadableRoom): number {
  return roomAssetManifest.packs[room].reduce((total, name) =>
    total + roomAssetManifest.files[name].size, 0);
}

export function roomIsDownloaded(_room: DownloadableRoom): boolean {
  return true;
}

/** All rooms are bundled directly into the app (0 download latency, 0 VPS bandwidth). */
export async function ensureRoomAssets(_room: DownloadableRoom, progress?: (done: number, total: number) => void): Promise<void> {
  progress?.(1, 1);
  return;
}

async function pruneRoomPacks(room: DownloadableRoom) {
  const index = new File(root(), 'room-use.json');
  let usage: Record<string, number> = {};
  try { if (index.exists) usage = JSON.parse(await index.text()); } catch {}
  usage[room] = Date.now();
  const keep = new Set(Object.keys(usage).sort((a, b) => usage[b] - usage[a]).slice(0, 2));
  for (const item of versionRoot().list()) {
    if (item instanceof Directory && !keep.has(item.name)) item.delete();
  }
  for (const item of root().list()) {
    if (item instanceof Directory && item.name !== roomAssetManifest.version) item.delete();
  }
  usage = Object.fromEntries(Object.entries(usage).filter(([name]) => keep.has(name)));
  index.write(JSON.stringify(usage));
}

export function roomAssetUri(room: DownloadableRoom, name: string): string {
  const file = packFile(room, `${name}.gz`);
  if (!file.exists) throw new Error('Room download is missing. Return to the lobby to download it.');
  return file.uri;
}

export async function readRoomAssetBytes(uri: string): Promise<Uint8Array> {
  return gunzipSync(await new File(uri).bytes());
}

export function roomStorageBytes(): number {
  return root().exists ? root().size ?? 0 : 0;
}

export function clearDownloadedRooms(): void {
  if (root().exists) root().delete();
}
