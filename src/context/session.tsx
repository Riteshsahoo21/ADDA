import { createContext, PropsWithChildren, useContext, useEffect, useRef, useState } from 'react';
import { AvatarStyle, DEFAULT_AVATAR_STYLE } from '@/three/player/avatarStyle';
import { authClient, authStorage } from '@/lib/auth-client';
import { GoogleSignin } from '@react-native-google-signin/google-signin';
import { configureGoogleSignIn } from '@/lib/google-sign-in';
import * as SecureStore from 'expo-secure-store';
import { disconnectRealtime, getRealtimeSocket } from '@/lib/realtime';
import { type CallInfo } from '@/lib/calls';
import { router, type Href } from 'expo-router';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors } from '@/constants/theme';
import * as Notifications from 'expo-notifications';
import { registerCallNotifications, showSocketCallNotification, unregisterCallNotifications } from '@/lib/push-notifications';

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
  const [incomingCall, setIncomingCall] = useState<CallInfo | null>(null);
  const openedNotificationCall = useRef<string | null>(null);

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

  useEffect(() => {
    if (username) void getRealtimeSocket().catch(error => console.warn('Live chat unavailable:', error));
    else disconnectRealtime();
    return () => disconnectRealtime();
  }, [username]);
  useEffect(() => {
    if (!username) return;
    let active = true;
    let live: Awaited<ReturnType<typeof getRealtimeSocket>> | null = null;
    const onInvite = (call: CallInfo) => {
      setIncomingCall(call);
      void showSocketCallNotification(call).catch(error => console.warn('Call alert unavailable:', error));
    };
    const onEnded = ({ callId }: { callId: string }) => setIncomingCall(current => current?.id === callId ? null : current);
    const checkPending = () => {
      live?.timeout(5000).emit('call:pending', (error: Error | null, result?: { ok: boolean; value?: CallInfo[] }) => {
        if (!error && result?.ok && result.value?.length) setIncomingCall(result.value[result.value.length - 1]);
      });
    };
    void getRealtimeSocket().then(value => {
      if (!active) return;
      live = value;
      value.on('call:invite', onInvite);
      value.on('call:ended', onEnded);
      value.on('connect', checkPending);
      checkPending();
    }).catch(() => {});
    return () => { active = false; live?.off('call:invite', onInvite); live?.off('call:ended', onEnded); live?.off('connect', checkPending); };
  }, [username]);

  useEffect(() => {
    if (!username) return;
    void registerCallNotifications().catch(error => console.warn('Call notifications unavailable:', error));
    const openCall = (response: Notifications.NotificationResponse) => {
      const data = response.notification.request.content.data;
      if (data?.kind !== 'call' || typeof data.callId !== 'string') return;
      if (openedNotificationCall.current === data.callId) return;
      openedNotificationCall.current = data.callId;
      setIncomingCall(current => current?.id === data.callId ? null : current);
      void Notifications.clearLastNotificationResponseAsync();
      router.push({ pathname: '/call', params: { callId: data.callId, role: 'callee', name: typeof data.callerName === 'string' ? data.callerName : 'ADDA call' } } as unknown as Href);
    };
    void Notifications.getLastNotificationResponseAsync().then(response => { if (response) openCall(response); });
    const subscription = Notifications.addNotificationResponseReceivedListener(openCall);
    return () => subscription.remove();
  }, [username]);

  const answerCall = () => {
    const call = incomingCall;
    if (!call) return;
    setIncomingCall(null);
    router.push({ pathname: '/call', params: { callId: call.id, role: 'callee', name: call.callerName } } as unknown as Href);
  };
  const declineCall = () => {
    if (incomingCall) void getRealtimeSocket().then(live => live.emit('call:decline', incomingCall.id));
    setIncomingCall(null);
  };

  const login = (name: string) => {
    setUsername(name);
    void SecureStore.setItemAsync(SAVED_USER_KEY, name);
  };

  const logout = async () => {
    await unregisterCallNotifications();
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
      <Modal visible={incomingCall !== null} transparent animationType="fade" onRequestClose={declineCall}>
        <View style={callStyles.overlay}><View style={callStyles.card}>
          <Text style={callStyles.label}>INCOMING {incomingCall?.media === 'video' ? 'VIDEO' : 'VOICE'} CALL</Text>
          <Text style={callStyles.name}>{incomingCall?.callerName}</Text>
          <View style={callStyles.actions}>
            <Pressable accessibilityLabel="Decline call" onPress={declineCall} style={[callStyles.button, callStyles.decline]}><Text style={callStyles.buttonText}>Decline</Text></Pressable>
            <Pressable accessibilityLabel="Answer call" onPress={answerCall} style={[callStyles.button, callStyles.answer]}><Text style={callStyles.buttonText}>Answer</Text></Pressable>
          </View>
        </View></View>
      </Modal>
    </SessionContext.Provider>
  );
}

const callStyles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'center', padding: 28, backgroundColor: '#0A2317B0' },
  card: { padding: 26, borderRadius: 24, backgroundColor: colors.surface, alignItems: 'center' },
  label: { color: colors.primary, fontSize: 11, fontWeight: '800', letterSpacing: 1.5 },
  name: { color: colors.text, fontSize: 26, fontWeight: '800', marginTop: 9, marginBottom: 28 },
  actions: { flexDirection: 'row', gap: 15 },
  button: { minWidth: 105, alignItems: 'center', borderRadius: 30, padding: 14 },
  decline: { backgroundColor: '#D94747' }, answer: { backgroundColor: colors.primary },
  buttonText: { color: '#FFFFFF', fontWeight: '800' },
});

export function useSession() {
  const session = useContext(SessionContext);
  if (!session) throw new Error('SessionProvider is missing');
  return session;
}
