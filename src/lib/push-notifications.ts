import * as Notifications from 'expo-notifications';
import { AppState, Platform } from 'react-native';
import { getRealtimeSocket } from './realtime';

let currentToken: string | null = null;

Notifications.setNotificationHandler({
  handleNotification: async notification => {
    const data = notification.request.content.data;
    const show = (data?.kind === 'call' || data?.kind === 'chat') && (data.source !== 'socket' || AppState.currentState !== 'active') &&
      (data.kind !== 'chat' || AppState.currentState !== 'active');
    return { shouldShowBanner: show, shouldShowList: show, shouldPlaySound: show, shouldSetBadge: false };
  },
});

export function hasCallPushToken() { return !!currentToken; }

export async function showSocketCallNotification(call: { id: string; callerName: string; media: string; target: { kind: string } }) {
  if (AppState.currentState === 'active' || hasCallPushToken()) return;
  await Notifications.scheduleNotificationAsync({
    content: {
      title: `${call.callerName} is calling`,
      body: `Incoming ${call.target.kind === 'group' ? 'group ' : ''}${call.media} call`,
      data: { kind: 'call', callId: call.id, callerName: call.callerName, source: 'socket' },
    },
    trigger: null,
  });
}

async function submitToken(token: string) {
  const socket = await getRealtimeSocket();
  await new Promise<void>((resolve, reject) => socket.timeout(8000).emit('push:register', token,
    (error: Error | null, reply?: { ok: boolean; error?: string }) => error || !reply?.ok ? reject(error || new Error(reply?.error || 'Push registration failed.')) : resolve()));
  currentToken = token;
}

export async function registerCallNotifications() {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync('adda_messages', {
    name: 'Messages', importance: Notifications.AndroidImportance.HIGH, sound: 'default',
  });
  await Notifications.setNotificationChannelAsync('adda_mentions', {
    name: 'Mentions & Replies',
    importance: Notifications.AndroidImportance.MAX,
    sound: 'default',
    vibrationPattern: [0, 250, 100, 250],
  });
  await Notifications.setNotificationChannelAsync('adda_calls', {
    name: 'Incoming calls',
    importance: Notifications.AndroidImportance.MAX,
    vibrationPattern: [0, 300, 150, 300],
    sound: 'default',
  });
  const permission = await Notifications.getPermissionsAsync();
  const status = permission.granted ? permission : await Notifications.requestPermissionsAsync();
  if (!status.granted) {
    console.warn('[Push] Notification permission not granted.');
    return;
  }

  let tokenData: string | null = null;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const token = await Notifications.getDevicePushTokenAsync();
      if (typeof token.data === 'string' && token.data.length > 20) {
        tokenData = token.data;
        break;
      }
    } catch (error) {
      console.warn(`[Push] Token retrieval attempt ${attempt}/6 failed:`, error);
      if (attempt < 6) await new Promise(r => setTimeout(r, attempt * 1500));
    }
  }

  if (tokenData) {
    await submitToken(tokenData);
    console.log('[Push] Successfully registered FCM push token with backend!');
  } else {
    console.warn('[Push] Could not obtain device push token after 6 attempts.');
  }
}

export async function unregisterCallNotifications() {
  if (!currentToken) return;
  const token = currentToken;
  currentToken = null;
  try { (await getRealtimeSocket()).emit('push:unregister', token); } catch { /* The session may already be offline. */ }
}
