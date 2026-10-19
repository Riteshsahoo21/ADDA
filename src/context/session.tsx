import { createContext, PropsWithChildren, useContext, useEffect, useRef, useState } from 'react';
import { AvatarStyle, DEFAULT_AVATAR_STYLE } from '@/three/player/avatarStyle';
import { authClient, authStorage } from '@/lib/auth-client';
import { GoogleSignin } from '@react-native-google-signin/google-signin';
import { configureGoogleSignIn } from '@/lib/google-sign-in';
import * as SecureStore from 'expo-secure-store';
import { disconnectRealtime, getRealtimeSocket } from '@/lib/realtime';
import { type CallInfo } from '@/lib/calls';
import { router, type Href } from 'expo-router';
import { AppState, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors } from '@/constants/theme';
import * as Notifications from 'expo-notifications';
import { hasCallPushToken, registerCallNotifications, showSocketCallNotification, unregisterCallNotifications } from '@/lib/push-notifications';
import { closeEncryptedChat, initEncryptedChat, receiveDirectEnvelope, handleMessageStatusUpdate, setCachedProfile, syncEncryptedChat, clearKeyCache, type Envelope } from '@/lib/encrypted-chat';
import { clearSocialCache } from '@/lib/social-cache';
import { socialApi, type OwnProfile } from '@/lib/social-api';

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
export let notificationNavigationOccurred = false;

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
    if (!username) { void closeEncryptedChat(); return; }
    let active = true;
    let live: Awaited<ReturnType<typeof getRealtimeSocket>> | null = null;
    let onEnvelope: ((envelope: Envelope) => void) | null = null;
    let onStatus: ((update: any) => void) | null = null;
    let onGroupUpdate: ((data: any) => void) | null = null;
    let onConnect: (() => void) | null = null;
    const sync = () => { void syncEncryptedChat().catch(error => console.warn('Encrypted chat sync unavailable:', error)); };
    void socialApi<OwnProfile>('/me').then(async me => {
      if (!active) return;
      setCachedProfile(me);
      await initEncryptedChat(me.id);
      if (!active) return;
      sync();
      live = await getRealtimeSocket();
      if (!active) return;
      onEnvelope = (envelope: Envelope) => { void receiveDirectEnvelope(envelope).catch(() => {}); };
      onStatus = (update: any) => { void handleMessageStatusUpdate(update).catch(() => {}); };
      onGroupUpdate = (data: any) => {
        if (data?.groupId) clearKeyCache({ kind: 'group', id: data.groupId });
        else clearKeyCache();
      };
      onConnect = () => {
        sync();
        if (!hasCallPushToken()) void registerCallNotifications().catch(() => {});
      };
      live.on('chat:envelope', onEnvelope);
      live.on('chat:msg_status', onStatus);
      live.on('group:updated', onGroupUpdate);
      live.on('connect', onConnect);
    }).catch(error => console.warn('Encrypted chat unavailable:', error));
    const appState = AppState.addEventListener('change', state => {
      if (state === 'active') {
        sync();
        if (!hasCallPushToken()) void registerCallNotifications().catch(() => {});
      }
    });
    return () => {
      active = false;
      appState.remove();
      if (onEnvelope) live?.off('chat:envelope', onEnvelope);
      if (onStatus) live?.off('chat:msg_status', onStatus);
      if (onGroupUpdate) live?.off('group:updated', onGroupUpdate);
      if (onConnect) live?.off('connect', onConnect);
    };
  }, [username]);
  useEffect(() => {
    if (!username) return;
    let active = true;
    let live: Awaited<ReturnType<typeof getRealtimeSocket>> | null = null;
    const onInvite = (call: CallInfo) => {
      if (openedNotificationCall.current === call.id) return;
      setIncomingCall(call);
      void showSocketCallNotification(call).catch(error => console.warn('Call alert unavailable:', error));
    };
    const onEnded = ({ callId }: { callId: string }) => setIncomingCall(current => current?.id === callId ? null : current);
    const checkPending = () => {
      live?.timeout(5000).emit('call:pending', (error: Error | null, result?: { ok: boolean; value?: CallInfo[] }) => {
        if (!error && result?.ok && result.value?.length) {
          const latest = result.value[result.value.length - 1];
          if (openedNotificationCall.current === latest.id) return;
          setIncomingCall(latest);
        }
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
      if (data?.kind === 'chat' && (data.chatKind === 'direct' || data.chatKind === 'group') && typeof data.chatId === 'string') {
        if (typeof data.envelope === 'string' && data.envelope.length > 0) {
          try {
            const envelope = JSON.parse(data.envelope) as Envelope;
            void receiveDirectEnvelope(envelope).catch(() => {});
          } catch {}
        }
        const chatName = (typeof data.chatName === 'string' && data.chatName) ||
                         (typeof data.name === 'string' && data.name) ||
                         (typeof response.notification.request.content.title === 'string' && response.notification.request.content.title !== 'ADDA' ? response.notification.request.content.title : '');
        void Notifications.clearLastNotificationResponseAsync();
        router.push({
          pathname: '/conversation',
          params: {
            kind: data.chatKind,
            id: data.chatId,
            ...(chatName ? { name: chatName } : {}),
          },
        } as unknown as Href);
        return;
      }
      if (data?.kind === 'room_invite' && (typeof data.roomId === 'string' || typeof data.groupId === 'string')) {
        void Notifications.clearLastNotificationResponseAsync();
        router.push({
          pathname: '/lobby',
          params: {
            room: data.roomKind || 'loft',
            groupId: data.groupId || '',
            roomId: data.roomId || '',
            roomOwnerId: data.ownerId || '',
            roomName: data.roomName || '',
            inviterName: data.inviterName || '',
            isPrivate: data.isPrivate || 'false',
          },
        } as unknown as Href);
        return;
      }
      if (data?.kind !== 'call' || typeof data.callId !== 'string') return;
      if (data?.isOngoing) {
        void Notifications.clearLastNotificationResponseAsync();
        void Notifications.dismissNotificationAsync('adda_active_call_notification').catch(() => {});
        router.push({ pathname: '/call', params: { callId: data.callId, role: data.role || 'callee', name: data.name || 'ADDA call', media: (data as any)?.media || 'audio' } } as unknown as Href);
        return;
      }
      if (openedNotificationCall.current === data.callId) return;
      openedNotificationCall.current = data.callId;
      notificationNavigationOccurred = true;
      setIncomingCall(null);
      void Notifications.clearLastNotificationResponseAsync();
      router.replace({
        pathname: '/call',
        params: {
          callId: data.callId,
          role: 'callee',
          name: typeof data.callerName === 'string' ? data.callerName : 'ADDA call',
          media: (data as any)?.media || 'video',
        },
      } as unknown as Href);
    };
    void Notifications.getLastNotificationResponseAsync().then(response => { if (response) openCall(response); });
    const subscription = Notifications.addNotificationResponseReceivedListener(openCall);
    const receiveSubscription = Notifications.addNotificationReceivedListener(notification => {
      const data = notification.request.content.data;
      if (data?.kind === 'chat') {
        if (typeof data.envelope === 'string' && data.envelope.length > 0) {
          try {
            const envelope = JSON.parse(data.envelope) as Envelope;
            void receiveDirectEnvelope(envelope).catch(() => {
              void syncEncryptedChat().catch(() => {});
            });
            return;
          } catch {}
        }
        void syncEncryptedChat().catch(() => {});
      }
    });
    return () => {
      subscription.remove();
      receiveSubscription.remove();
    };
  }, [username]);

  const answerCall = () => {
    const call = incomingCall;
    if (!call) return;
    openedNotificationCall.current = call.id;
    setIncomingCall(null);
    router.push({ pathname: '/call', params: { callId: call.id, role: 'callee', name: call.callerName, media: call.media } } as unknown as Href);
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
      await clearSocialCache();
      await closeEncryptedChat();
      disconnectRealtime();
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
