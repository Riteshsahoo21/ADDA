import * as FileSystem from 'expo-file-system/legacy';
import type { SocialBundle, OwnProfile, PublicProfile, ChatGroup, FriendRequest } from './social-api';
import { setCachedProfile } from './encrypted-chat';

const CACHE_FILE = `${FileSystem.documentDirectory || ''}adda_social_bundle_v1.json`;

let memoryCache: SocialBundle | null = null;
let loadPromise: Promise<SocialBundle | null> | null = null;

export function getCachedSocialBundle(): SocialBundle | null {
  return memoryCache;
}

export async function initSocialCache(): Promise<SocialBundle | null> {
  if (memoryCache) return memoryCache;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    try {
      if (!FileSystem.documentDirectory) return null;
      const info = await FileSystem.getInfoAsync(CACHE_FILE);
      if (!info.exists) return null;

      const content = await FileSystem.readAsStringAsync(CACHE_FILE);
      if (!content) return null;

      const parsed = JSON.parse(content) as SocialBundle;
      if (parsed && parsed.me && Array.isArray(parsed.contacts)) {
        memoryCache = parsed;
        setCachedProfile(parsed.me);
        return parsed;
      }
    } catch {
      // Ignore corrupted or unreadable cache
    } finally {
      loadPromise = null;
    }
    return null;
  })();

  return loadPromise;
}

export function setCachedSocialBundle(bundle: SocialBundle): void {
  memoryCache = bundle;
  setCachedProfile(bundle.me);

  // Write asynchronously to disk in background without blocking UI
  if (FileSystem.documentDirectory) {
    void FileSystem.writeAsStringAsync(CACHE_FILE, JSON.stringify(bundle)).catch(() => {});
  }
}

export function updateCachedContacts(updater: (current: PublicProfile[]) => PublicProfile[]): void {
  if (!memoryCache) return;
  memoryCache = {
    ...memoryCache,
    contacts: updater(memoryCache.contacts),
  };
  if (FileSystem.documentDirectory) {
    void FileSystem.writeAsStringAsync(CACHE_FILE, JSON.stringify(memoryCache)).catch(() => {});
  }
}

export function updateCachedGroups(updater: (current: ChatGroup[]) => ChatGroup[]): void {
  if (!memoryCache) return;
  memoryCache = {
    ...memoryCache,
    groups: updater(memoryCache.groups),
  };
  if (FileSystem.documentDirectory) {
    void FileSystem.writeAsStringAsync(CACHE_FILE, JSON.stringify(memoryCache)).catch(() => {});
  }
}

export function updateCachedFriendRequests(updater: (current: FriendRequest[]) => FriendRequest[]): void {
  if (!memoryCache) return;
  memoryCache = {
    ...memoryCache,
    friendRequests: updater(memoryCache.friendRequests),
  };
  if (FileSystem.documentDirectory) {
    void FileSystem.writeAsStringAsync(CACHE_FILE, JSON.stringify(memoryCache)).catch(() => {});
  }
}

export function updateCachedProfile(profile: OwnProfile): void {
  setCachedProfile(profile);
  if (!memoryCache) return;
  memoryCache = {
    ...memoryCache,
    me: profile,
  };
  if (FileSystem.documentDirectory) {
    void FileSystem.writeAsStringAsync(CACHE_FILE, JSON.stringify(memoryCache)).catch(() => {});
  }
}

export async function clearSocialCache(): Promise<void> {
  memoryCache = null;
  try {
    if (FileSystem.documentDirectory) {
      await FileSystem.deleteAsync(CACHE_FILE, { idempotent: true });
    }
  } catch {}
}
