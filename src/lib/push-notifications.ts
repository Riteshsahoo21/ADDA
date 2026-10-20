import * as Notifications from 'expo-notifications';
import { AppState, Platform } from 'react-native';
import { getRealtimeSocket } from './realtime';

let currentToken: string | null = null;

Notifications.setNotificationHandler({
  handleNotification: async notification => {
    const data = notification.request.content.data;
    const isBackground = AppState.currentState !== 'active';
    const show = (data?.kind === 'call' || data?.kind === 'chat' || data?.kind === 'room_invite') &&
      (data.source !== 'socket' || isBackground) &&
      (data.kind !== 'chat' || isBackground) &&
      (data.kind !== 'room_invite' || isBackground);
    return { shouldShowBanner: show, shouldShowList: show, shouldPlaySound: show, shouldSetBadge: false };
  },
});

export function hasCallPushToken() { return !!currentToken; }

export async function showSocketCallNotification(call: { id: string; callerName: string; media: string; target: { kind: string; id?: string } }) {
  if (AppState.currentState === 'active' || hasCallPushToken()) return;
  const isGroup = call.target.kind === 'group';
  await Notifications.scheduleNotificationAsync({
    content: {
      title: isGroup ? `Group ${call.media} call` : `${call.callerName} is calling`,
      body: isGroup ? `${call.callerName} started a group ${call.media} call` : `Incoming ${call.media} call`,
      categoryIdentifier: 'incoming_call',
      sound: 'default',
      data: {
        kind: 'call',
        callId: call.id,
        callerName: call.callerName,
        media: call.media,
        chatKind: call.target.kind,
        chatId: call.target.id,
        source: 'socket',
        categoryId: 'incoming_call',
      },
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

export async function setupCallNotificationCategories() {
  try {
    await Notifications.setNotificationCategoryAsync('incoming_call', [
      {
        identifier: 'answer',
        buttonTitle: 'Answer',
        options: {
          opensAppToForeground: true,
        },
      },
      {
        identifier: 'decline',
        buttonTitle: 'Decline',
        options: {
          isDestructive: true,
          opensAppToForeground: false,
        },
      },
    ]);
  } catch (err) {
    console.warn('[Push] Could not register call notification category:', err);
  }
}

export async function registerCallNotifications() {
  await setupCallNotificationCategories();
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
    vibrationPattern: [0, 500, 200, 500, 200, 500],
    sound: 'default',
    enableVibrate: true,
    enableLights: true,
    lightColor: '#25D366',
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    bypassDnd: true,
    audioAttributes: {
      usage: Notifications.AndroidAudioUsage.NOTIFICATION_RINGTONE,
      contentType: Notifications.AndroidAudioContentType.SONIFICATION,
      flags: { enforceAudibility: true, requestHardwareAudioVideoSynchronization: false },
    },
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
