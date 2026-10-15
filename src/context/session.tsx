import { createContext, PropsWithChildren, useContext, useEffect, useState } from 'react';
import { AvatarStyle, DEFAULT_AVATAR_STYLE } from '@/three/player/avatarStyle';
import { authClient, authStorage } from '@/lib/auth-client';
import { GoogleSignin } from '@react-native-google-signin/google-signin';
import { configureGoogleSignIn } from '@/lib/google-sign-in';
import * as SecureStore from 'expo-secure-store';

type Session = {
  username: string | null;
  isRestoring: boolean;
  avatarStyle: AvatarStyle;
  setAvatarStyle: (style: AvatarStyle) => void;
  login: (username: string) => void;
  logout: () => Promise<void>;
};
const SessionContext = createContext<Session | null>(null);

const SAVED_USER_KEY = 'adda_current_username';

export function SessionProvider({ children }: PropsWithChildren) {
  const [username, setUsername] = useState<string | null>(null);
  const [isRestoring, setIsRestoring] = useState(true);
  const [avatarStyle, setAvatarStyle] = useState<AvatarStyle>(DEFAULT_AVATAR_STYLE);

  useEffect(() => {
    // Restore session on app boot from SecureStore
    void (async () => {
      try {
        const savedName = await SecureStore.getItemAsync(SAVED_USER_KEY);
        const token = await authStorage.getAccessToken();
        if (savedName && token) {
          setUsername(savedName);
        }
      } catch (e) {
        console.warn('Could not restore user from SecureStore:', e);
      } finally {
        setIsRestoring(false);
      }
    })();
  }, []);

  const login = (name: string) => {
    setUsername(name);
    void SecureStore.setItemAsync(SAVED_USER_KEY, name);
  };

  const logout = async () => {
    try {
      const token = await authStorage.getAccessToken();
      if (token) await authClient.signOut({ fetchOptions: { headers: { Authorization: `Bearer ${token}` } } });
    } catch (error) {
      console.warn('Could not revoke ADDA session:', error);
    }
    try {
      configureGoogleSignIn();
      await GoogleSignin.signOut();
    } catch (error) {
      console.warn('Could not clear Google sign-in session:', error);
    } finally {
      await authStorage.clearTokens();
      await SecureStore.deleteItemAsync(SAVED_USER_KEY);
      setUsername(null);
    }
  };

  return (
    <SessionContext.Provider
      value={{
        username,
        isRestoring,
        avatarStyle,
        setAvatarStyle,
        login,
        logout,
      }}
    >
      {children}
    </SessionContext.Provider>
  );
}

export function useSession() {
  const session = useContext(SessionContext);
  if (!session) throw new Error('SessionProvider is missing');
  return session;
}
