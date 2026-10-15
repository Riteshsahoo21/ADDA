import { createAuthClient } from 'better-auth/react';
import * as SecureStore from 'expo-secure-store';

// On Android connected over USB or emulator, localhost:3000 connects via adb reverse
export const API_BASE_URL =
  process.env.EXPO_PUBLIC_API_URL || 'http://localhost:3000';

const ACCESS_TOKEN_KEY = 'adda_bearer_session_v2';
const LEGACY_TOKEN_KEY = 'adda_jwt_access_token';
const REFRESH_TOKEN_KEY = 'adda_jwt_refresh_token';

export const authStorage = {
  getAccessToken: async (): Promise<string | null> => {
    try {
      return await SecureStore.getItemAsync(ACCESS_TOKEN_KEY);
    } catch {
      return null;
    }
  },
  setAccessToken: async (token: string): Promise<void> => {
    try {
      await SecureStore.setItemAsync(ACCESS_TOKEN_KEY, token);
    } catch (e) {
      console.warn('Could not store access token in SecureStore:', e);
    }
  },
  getRefreshToken: async (): Promise<string | null> => {
    try {
      return await SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
    } catch {
      return null;
    }
  },
  setRefreshToken: async (token: string): Promise<void> => {
    try {
      await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, token);
    } catch (e) {
      console.warn('Could not store refresh token in SecureStore:', e);
    }
  },
  clearTokens: async (): Promise<void> => {
    try {
      await SecureStore.deleteItemAsync(ACCESS_TOKEN_KEY);
      await SecureStore.deleteItemAsync(LEGACY_TOKEN_KEY);
      await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
    } catch (e) {
      console.warn('Could not clear tokens from SecureStore:', e);
    }
  },
};

export const authClient = createAuthClient({
  baseURL: API_BASE_URL,
  fetchOptions: {
    onSuccess: async (context) => {
      const token = context.response.headers.get('set-auth-token');
      if (token) await authStorage.setAccessToken(token);
    },
  },
});
