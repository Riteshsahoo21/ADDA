import { useEffect, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as ScreenOrientation from 'expo-screen-orientation';
import { router } from 'expo-router';
import * as Notifications from 'expo-notifications';
import { AddaLogo } from '@/components/ui/AddaLogo';
import { colors } from '@/constants/theme';
import { useSession, notificationNavigationOccurred } from '@/context/session';

export default function WelcomeScreen() {
  const { username, isRestoring } = useSession();
  const [progress] = useState(() => new Animated.Value(0));
  const [percent, setPercent] = useState(0);
  const [handledNotification, setHandledNotification] = useState(false);

  useEffect(() => {
    void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
    void Notifications.getLastNotificationResponseAsync().then(last => {
      const data = last?.notification?.request?.content?.data;
      if (data?.kind === 'chat' || data?.kind === 'call' || data?.kind === 'room_invite') {
        setHandledNotification(true);
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const listener = progress.addListener(({ value }) => {
      setPercent(Math.min(100, Math.round(value)));
    });
    return () => progress.removeListener(listener);
  }, [progress]);

  useEffect(() => {
    if (isRestoring || handledNotification || notificationNavigationOccurred) return;

    let navigationTimer: ReturnType<typeof setTimeout> | undefined;
    const animation = Animated.timing(progress, {
      toValue: 100,
      duration: 2200,
      easing: Easing.linear,
      useNativeDriver: false,
    });

    animation.start(({ finished }) => {
      if (finished) {
        setPercent(100);
        navigationTimer = setTimeout(async () => {
          if (notificationNavigationOccurred) return;
          const last = await Notifications.getLastNotificationResponseAsync().catch(() => null);
          const data = last?.notification?.request?.content?.data;
          if (data?.kind === 'chat' || data?.kind === 'call' || data?.kind === 'room_invite') {
            return;
          }
          router.replace(username ? '/home' : '/login');
        }, 180);
      }
    });

    return () => {
      animation.stop();
      if (navigationTimer) clearTimeout(navigationTimer);
    };
  }, [isRestoring, progress, username, handledNotification]);

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.content}>
        <AddaLogo centered />
        <View style={styles.progressArea}>
          <Text style={styles.percent}>{percent}%</Text>
          <View style={styles.track}>
            <Animated.View
              style={[
                styles.fill,
                { width: progress.interpolate({ inputRange: [0, 100], outputRange: ['0%', '100%'] }) },
              ]}
            />
          </View>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 30,
    paddingBottom: 20,
  },
  progressArea: {
    width: '100%',
    maxWidth: 300,
    marginTop: 28,
  },
  percent: {
    color: colors.text,
    fontSize: 18,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
    textAlign: 'right',
    marginBottom: 14,
  },
  track: {
    height: 14,
    backgroundColor: colors.surfaceRaised,
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    backgroundColor: colors.primary,
  },
});
