import * as FileSystem from 'expo-file-system/legacy';
import type { SocialBundle, OwnProfile, PublicProfile, ChatGroup, FriendRequest } from './social-api';
import { setCachedProfile, clearCachedProfile } from './encrypted-chat';

let memoryCache: SocialBundle | null = null;
let loadPromise: Promise<SocialBundle | null> | null = null;

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function getCacheFilePath(key: string): string {
  return `${FileSystem.documentDirectory || ''}adda_social_bundle_${sanitizeId(key)}.json`;
}

const LEGACY_CACHE_FILE = `${FileSystem.documentDirectory || ''}adda_social_bundle_v1.json`;

/**
 * Strict identity check: matches ONLY against unique userId or unique username.
 * Never matches against display name to ensure 100% multi-account isolation.
 */
function userMatches(bundle: SocialBundle, expectedUser: string): boolean {
  if (!bundle?.me) return false;
  const exp = expectedUser.toLowerCase().trim();
  const id = bundle.me.id?.toLowerCase().trim();
  const username = bundle.me.username?.toLowerCase().trim();
  return Boolean((id && id === exp) || (username && username === exp));
}

export function getCachedSocialBundle(expectedUser?: string | null): SocialBundle | null {
  if (!memoryCache) return null;
  if (expectedUser && !userMatches(memoryCache, expectedUser)) {
    return null;
  }
  return memoryCache;
}

export async function initSocialCache(expectedUser?: string | null): Promise<SocialBundle | null> {
  if (memoryCache) {
    if (expectedUser) {
      if (userMatches(memoryCache, expectedUser)) {
        return memoryCache;
      }
      memoryCache = null;
    } else {
      return memoryCache;
    }
  }

  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    try {
      if (!FileSystem.documentDirectory) return null;

      // Clean up legacy single-tenant cache file if still present
      try {
        const legacyInfo = await FileSystem.getInfoAsync(LEGACY_CACHE_FILE);
        if (legacyInfo.exists) {
          await FileSystem.deleteAsync(LEGACY_CACHE_FILE, { idempotent: true });
        }
      } catch {}

      if (!expectedUser) return null;

      // Check user-scoped cache file on disk
      const cacheFile = getCacheFilePath(expectedUser);
      const info = await FileSystem.getInfoAsync(cacheFile);
      if (!info.exists) return null;

      const content = await FileSystem.readAsStringAsync(cacheFile);
      if (!content) return null;

      const parsed = JSON.parse(content) as SocialBundle;
      if (parsed && parsed.me && Array.isArray(parsed.contacts)) {
        if (userMatches(parsed, expectedUser)) {
          memoryCache = parsed;
          setCachedProfile(parsed.me);
          return parsed;
        }
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

  // Write asynchronously to user-scoped cache files on disk (both unique ID and unique username)
  if (FileSystem.documentDirectory && bundle.me?.id) {
    const userFile = getCacheFilePath(bundle.me.id);
    void FileSystem.writeAsStringAsync(userFile, JSON.stringify(bundle)).catch(() => {});
    if (bundle.me.username) {
      const usernameFile = getCacheFilePath(bundle.me.username);
      if (usernameFile !== userFile) {
        void FileSystem.writeAsStringAsync(usernameFile, JSON.stringify(bundle)).catch(() => {});
      }
    }
  }
}

export function updateCachedContacts(updater: (current: PublicProfile[]) => PublicProfile[]): void {
  if (!memoryCache) return;
  memoryCache = {
    ...memoryCache,
    contacts: updater(memoryCache.contacts),
  };
  persistCurrentMemoryCache();
}

export function updateCachedGroups(updater: (current: ChatGroup[]) => ChatGroup[]): void {
  if (!memoryCache) return;
  memoryCache = {
    ...memoryCache,
    groups: updater(memoryCache.groups),
  };
  persistCurrentMemoryCache();
}

export function updateCachedFriendRequests(updater: (current: FriendRequest[]) => FriendRequest[]): void {
  if (!memoryCache) return;
  memoryCache = {
    ...memoryCache,
    friendRequests: updater(memoryCache.friendRequests),
  };
  persistCurrentMemoryCache();
}

export function updateCachedProfile(profile: OwnProfile): void {
  setCachedProfile(profile);
  if (!memoryCache) return;
  memoryCache = {
    ...memoryCache,
    me: profile,
  };
  persistCurrentMemoryCache();
}

function persistCurrentMemoryCache(): void {
  if (!FileSystem.documentDirectory || !memoryCache?.me?.id) return;
  const userFile = getCacheFilePath(memoryCache.me.id);
  void FileSystem.writeAsStringAsync(userFile, JSON.stringify(memoryCache)).catch(() => {});
  if (memoryCache.me.username) {
    const usernameFile = getCacheFilePath(memoryCache.me.username);
    if (usernameFile !== userFile) {
      void FileSystem.writeAsStringAsync(usernameFile, JSON.stringify(memoryCache)).catch(() => {});
    }
  }
}

/**
 * Clear in-memory caches upon logout so another account on the same phone
 * cannot see the logged-out user's profile, chats, or groups.
 */
export function clearSocialCache(): void {
  memoryCache = null;
  loadPromise = null;
  clearCachedProfile();
}
