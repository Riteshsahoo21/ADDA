import { useEffect, useState } from 'react';
import { BackHandler, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ScreenOrientation from 'expo-screen-orientation';
import { NavigationBar } from 'expo-navigation-bar';
import { router, useLocalSearchParams } from 'expo-router';
import { GameRoom } from '@/components/room/GameRoom';
import { RoomKind } from '@/three/environment/createGameScene';
import { colors } from '@/constants/theme';
import { useSession } from '@/context/session';
import { StatusBar } from 'expo-status-bar';

export default function HangoutScreen() {
  const { username } = useSession();
  const params = useLocalSearchParams<{ room?: string; avatar?: string }>();
  const [roomKind, setRoomKind] = useState<RoomKind>(params.room === 'tea' ? 'tea' : params.room === 'roof' ? 'roof' : 'loft');
  const avatar = params.avatar === 'girl' ? 'girl' : 'boy';
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [landscapeReady, setLandscapeReady] = useState(false);
  const [orientationFailed, setOrientationFailed] = useState(false);
  useEffect(() => {
    if (!username) { router.replace('/login'); return; }
    let active = true;
    void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE).then(() => {
      if (active) setLandscapeReady(true);
    }).catch((error) => {
      console.warn('[ADDA] Landscape lock failed; rendering in current orientation', error);
      if (active) { setOrientationFailed(true); setLandscapeReady(true); }
    });
    return () => { active = false; void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP); };
  }, [username]);
  useEffect(() => {
    const back = BackHandler.addEventListener('hardwareBackPress', () => {
      if (roomKind === 'roof') setRoomKind('loft');
      else router.replace('/home');
      return true;
    });
    return () => back.remove();
  }, [roomKind]);
  if (!username) return null;
  return <View style={styles.screen}>
    <StatusBar hidden />
    <NavigationBar hidden />
    {landscapeReady && (width >= height || orientationFailed) && <GameRoom key={`${roomKind}-${avatar}`} roomKind={roomKind} avatar={avatar} onPortal={() => setRoomKind(current => current === 'roof' ? 'loft' : 'roof')} />}
    <View style={[styles.topBar, { left: Math.max(16, insets.left + 8), right: Math.max(16, insets.right + 8), top: Math.max(8, insets.top + 4) }]}>
      <View><Text style={styles.kicker}>THE ADDA GANG</Text><Text style={styles.title}>{roomKind === 'tea' ? 'Tea Party' : roomKind === 'roof' ? 'School Rooftop' : 'Loft 16'}</Text></View>
      <Pressable accessibilityRole="button" onPress={() => roomKind === 'roof' ? setRoomKind('loft') : router.replace('/home')} style={styles.exit}><Text style={styles.exitText}>{roomKind === 'roof' ? 'Back to Loft' : 'Exit room'}</Text></Pressable>
    </View>
  </View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#151228' },
  topBar: { position: 'absolute', top: 8, left: 16, right: 16, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  kicker: { color: colors.purple, fontSize: 10, fontWeight: '800', letterSpacing: 1.5 }, title: { color: colors.text, fontSize: 20, fontWeight: '800', marginTop: 2 },
  exit: { backgroundColor: '#1E1A2BE8', borderRadius: 13, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 18, paddingVertical: 11 }, exitText: { color: colors.text, fontWeight: '800', fontSize: 13 },
});
