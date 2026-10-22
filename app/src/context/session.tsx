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
import InCallManager from 'react-native-incall-manager';
import { dismissCallNotification, hasCallPushToken, registerCallNotifications, showSocketCallNotification, unregisterCallNotifications } from '@/lib/push-notifications';
import { closeEncryptedChat, initEncryptedChat, receiveDirectEnvelope, handleMessageStatusUpdate, setCachedProfile, getCachedProfile, syncEncryptedChat, clearKeyCache, type Envelope } from '@/lib/encrypted-chat';
import { clearSocialCache, initSocialCache } from '@/lib/social-cache';
import { socialApi, type OwnProfile } from '@/lib/social-api';

type Session = {
  username: string | null;
  isRestoring: boolean;
  avatarStyle: AvatarStyle;
  setAvatarStyle: (style: AvatarStyle) => void;
  login: (username: string, userId?: string) => void;
  logout: () => Promise<void>;
};
const SessionContext = createContext<Session | null>(null);

const SAVED_USER_KEY = 'adda_current_username';
const SAVED_USER_ID_KEY = 'adda_current_user_id';
export let notificationNavigationOccurred = false;
export function hasNotificationNavigationOccurred(): boolean {
  return notificationNavigationOccurred;
}
export function setNotificationNavigationOccurred(value: boolean) {
  notificationNavigationOccurred = value;
}

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
        const savedId = await SecureStore.getItemAsync(SAVED_USER_ID_KEY);
        const token = await authStorage.getAccessToken();
        if (savedName && token) {
          // Immediately load user's disk cache into memory during boot!
          const preloaded = await initSocialCache(savedId || savedName);
          if (preloaded?.me) {
            setCachedProfile(preloaded.me);
          }
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
    if (!username) { void closeEncryptedChat(); disconnectRealtime(); return; }
    let active = true;
    let live: Awaited<ReturnType<typeof getRealtimeSocket>> | null = null;
    const sync = () => { void syncEncryptedChat().catch(error => console.warn('Encrypted chat sync unavailable:', error)); };

    const onEnvelope = (envelope: Envelope) => { void receiveDirectEnvelope(envelope).catch(() => {}); };
    const onStatus = (update: any) => { void handleMessageStatusUpdate(update).catch(() => {}); };
    const onGroupUpdate = (data: any) => {
      if (data?.groupId) clearKeyCache({ kind: 'group', id: data.groupId });
      else clearKeyCache();
    };
    const onConnect = () => {
      sync();
      if (!hasCallPushToken()) void registerCallNotifications().catch(() => {});
    };

    void (async () => {
      try {
        live = await getRealtimeSocket();
        if (!active) return;
        live.on('chat:envelope', onEnvelope);
        live.on('chat:msg_status', onStatus);
        live.on('group:updated', onGroupUpdate);
        live.on('connect', onConnect);

        const cachedMe = getCachedProfile();
        if (cachedMe?.id) {
          await initEncryptedChat(cachedMe.id).catch(() => {});
        }

        const me = await socialApi<OwnProfile>('/me');
        if (!active) return;
        setCachedProfile(me);
        void SecureStore.setItemAsync(SAVED_USER_ID_KEY, me.id);
        await initEncryptedChat(me.id);
        if (!active) return;
        sync();
      } catch (error) {
        console.warn('Encrypted chat setup error:', error);
      }
    })();

    const appState = AppState.addEventListener('change', state => {
      if (state === 'active') {
        sync();
        if (!hasCallPushToken()) void registerCallNotifications().catch(() => {});
      }
    });
    return () => {
      active = false;
      appState.remove();
      if (live) {
        live.off('chat:envelope', onEnvelope);
        live.off('chat:msg_status', onStatus);
        live.off('group:updated', onGroupUpdate);
        live.off('connect', onConnect);
      }
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
    const onEnded = ({ callId }: { callId: string }) => {
      void dismissCallNotification(callId);
      setIncomingCall(current => {
        if (current?.id === callId) {
          try { InCallManager.stopRingtone(); } catch {}
          return null;
        }
        return current;
      });
    };
    const onJoined = ({ callId, userId }: { callId: string; userId: string }) => {
      if (userId !== getCachedProfile()?.id) return;
      void dismissCallNotification(callId);
      setIncomingCall(current => current?.id === callId ? null : current);
    };
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
      value.on('call:participant-joined', onJoined);
      value.on('connect', checkPending);
      checkPending();
    }).catch(() => {});
    return () => { active = false; live?.off('call:invite', onInvite); live?.off('call:ended', onEnded); live?.off('call:participant-joined', onJoined); live?.off('connect', checkPending); };
  }, [username]);

  useEffect(() => {
    if (incomingCall) {
      try {
        InCallManager.startRingtone('_DEFAULT_', [0, 500, 200, 500], 'default', 45);
      } catch (err) {
        console.warn('Could not start ringtone:', err);
      }
    } else {
      try {
        InCallManager.stopRingtone();
      } catch {}
    }
    return () => {
      try {
        InCallManager.stopRingtone();
      } catch {}
    };
  }, [incomingCall]);

  useEffect(() => {
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
      try { InCallManager.stopRingtone(); } catch {}
      void dismissCallNotification(data.callId);
      const actionIdentifier = response.actionIdentifier;
      if (actionIdentifier === 'decline') {
        void getRealtimeSocket().then(live => live.emit('call:decline', data.callId));
        setIncomingCall(null);
        void Notifications.clearLastNotificationResponseAsync();
        return;
      }
      if (data?.isOngoing) {
        void Notifications.clearLastNotificationResponseAsync();
        void Notifications.dismissNotificationAsync('adda_active_call_notification').catch(() => {});
        if (openedNotificationCall.current === data.callId) return;
        openedNotificationCall.current = data.callId;
        router.push({ pathname: '/call', params: { callId: data.callId, role: data.role || 'callee', name: data.name || 'ADDA call', media: (data as any)?.media || 'video' } } as unknown as Href);
        return;
      }
      if (openedNotificationCall.current === data.callId) return;
      openedNotificationCall.current = data.callId;
      notificationNavigationOccurred = true;
      setNotificationNavigationOccurred(true);
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
      if (data?.kind === 'call' && typeof data.callId === 'string' && !data.isOngoing) {
        try {
          InCallManager.startRingtone('_DEFAULT_', [0, 500, 200, 500], 'default', 45);
        } catch {}
      }
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
  }, []);

  const answerCall = () => {
    const call = incomingCall;
    if (!call) return;
    try { InCallManager.stopRingtone(); } catch {}
    openedNotificationCall.current = call.id;
    setIncomingCall(null);
    void dismissCallNotification(call.id);
    router.push({ pathname: '/call', params: { callId: call.id, role: 'callee', name: call.callerName, media: call.media } } as unknown as Href);
  };
  const declineCall = () => {
    try { InCallManager.stopRingtone(); } catch {}
    if (incomingCall) {
      void dismissCallNotification(incomingCall.id);
      void getRealtimeSocket().then(live => live.emit('call:decline', incomingCall.id));
    }
    setIncomingCall(null);
  };

  const login = (name: string, userId?: string) => {
    setUsername(name);
    void SecureStore.setItemAsync(SAVED_USER_KEY, name);
    if (userId) {
      void SecureStore.setItemAsync(SAVED_USER_ID_KEY, userId);
      void initSocialCache(userId);
    }
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
      await SecureStore.deleteItemAsync(SAVED_USER_ID_KEY);
      clearSocialCache();
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
