import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SessionProvider } from '@/context/session';
import { colors } from '@/constants/theme';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { LogBox } from 'react-native';

if (__DEV__) {
  // Three r162 reports this known Expo GL WebGL 1 deprecation on every room entry.
  // Keep all other warnings and errors visible on the phone.
  LogBox.ignoreLogs(['THREE.WebGLRenderer: WebGL 1 support was deprecated']);
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}><SessionProvider>
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background }, animation: 'fade' }} />
    </SessionProvider></GestureHandlerRootView>
  );
}
