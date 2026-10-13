import { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as ScreenOrientation from 'expo-screen-orientation';
import { router } from 'expo-router';
import { ActionButton } from '@/components/ui/ActionButton';
import { colors } from '@/constants/theme';
import { useSession } from '@/context/session';

const friends = [
  { name: 'Aarav', online: true, color: '#E9A97A' },
  { name: 'Meera', online: true, color: '#E78FB8' },
  { name: 'Kabir', online: true, color: '#92B8ED' },
  { name: 'Diya', online: false, color: '#A8D7B0' },
  { name: 'Rohan', online: false, color: '#D4A7D9' },
  { name: 'Isha', online: false, color: '#E9CD81' },
];

export default function HomeScreen() {
  const { username, logout } = useSession();
  const [selectedRoom, setSelectedRoom] = useState<'loft' | 'tea' | null>(null);
  const joinAs = (avatar: 'boy' | 'girl') => {
    if (!selectedRoom) return;
    const room = selectedRoom;
    setSelectedRoom(null);
    router.push({ pathname: '/hangout', params: { room, avatar } });
  };
  useEffect(() => { void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP); }, []);
  useEffect(() => { if (!username) router.replace('/login'); }, [username]);
  if (!username) return null;

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.top}><Text style={styles.brand}>ADDA<Text style={styles.dot}>.</Text></Text><View style={styles.avatar}><Text style={styles.avatarText}>{username[0].toUpperCase()}</Text></View></View>
        <Text style={styles.eyebrow}>YOUR CORNER OF THE INTERNET</Text>
        <Text style={styles.heading}>Good to see you,{"\n"}<Text style={styles.name}>{username}.</Text></Text>
        <View style={styles.hero}>
          <View style={styles.heroGlow} />
          <Text style={styles.heroKicker}>YOUR SPACE IS READY</Text>
          <Text style={styles.heroTitle}>The Adda Gang</Text>
          <Text style={styles.heroSub}>Six friends. One place to meet.</Text>
          <View style={styles.onlinePill}><View style={styles.onlineDot} /><Text style={styles.onlineText}>3 friends online now</Text></View>
        </View>
        <View style={styles.sectionHeading}><Text style={styles.sectionTitle}>The crew</Text><Text style={styles.count}>06 MEMBERS</Text></View>
        <View style={styles.friendList}>
          {friends.map((friend) => <View key={friend.name} style={styles.friend}>
            <View style={[styles.friendAvatar, { backgroundColor: friend.color }]}><Text style={styles.initial}>{friend.name[0]}</Text></View>
            <View style={styles.friendInfo}><Text style={styles.friendName}>{friend.name}</Text><Text style={styles.friendStatus}>{friend.online ? 'Online' : 'Away'}</Text></View>
            <View style={[styles.statusDot, !friend.online && styles.offlineDot]} />
          </View>)}
        </View>
        <Text style={styles.roomsTitle}>Choose a hangout</Text>
        <Pressable accessibilityRole="button" onPress={() => setSelectedRoom('loft')} style={styles.roomCard}>
          <View style={styles.roomIcon}><Text style={styles.roomIconText}>⌂</Text></View>
          <View style={styles.roomInfo}><Text style={styles.roomName}>Loft 16</Text><Text style={styles.roomDescription}>Explore the furnished interior</Text></View>
          <Text style={styles.roomArrow}>›</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={() => setSelectedRoom('tea')} style={styles.roomCard}>
          <View style={[styles.roomIcon, styles.teaIcon]}><Text style={styles.roomIconText}>☕</Text></View>
          <View style={styles.roomInfo}><Text style={styles.roomName}>Tea Party</Text><Text style={styles.roomDescription}>A roadside adda at evening</Text></View>
          <Text style={styles.roomArrow}>›</Text>
        </Pressable>
        <ActionButton label="Log out" secondary onPress={() => { logout(); router.replace('/login'); }} style={styles.logout} />
      </ScrollView>
      <Modal visible={selectedRoom !== null} transparent animationType="fade" onRequestClose={() => setSelectedRoom(null)}>
        <View style={styles.modalShade}>
          <View style={styles.modalCard}>
            <Text style={styles.modalKicker}>ENTER {selectedRoom === 'loft' ? 'LOFT 16' : 'TEA PARTY'}</Text>
            <Text style={styles.modalTitle}>Join as who?</Text>
            <Text style={styles.modalSub}>Choose the character you will control.</Text>
            <View style={styles.choices}>
              <Pressable accessibilityRole="button" onPress={() => joinAs('boy')} style={styles.choice}><Text style={styles.choiceEmoji}>👨</Text><Text style={styles.choiceText}>Boy</Text></Pressable>
              <Pressable accessibilityRole="button" onPress={() => joinAs('girl')} style={styles.choice}><Text style={styles.choiceEmoji}>👩</Text><Text style={styles.choiceText}>Girl</Text></Pressable>
            </View>
            <Pressable accessibilityRole="button" onPress={() => setSelectedRoom(null)} style={styles.cancel}><Text style={styles.cancelText}>Cancel</Text></Pressable>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background }, content: { paddingHorizontal: 24, paddingTop: 22, paddingBottom: 34 },
  top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, brand: { color: colors.text, fontSize: 24, fontWeight: '900', letterSpacing: -1.4 }, dot: { color: colors.purple },
  avatar: { width: 40, height: 40, borderRadius: 14, backgroundColor: colors.surfaceRaised, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' }, avatarText: { color: colors.purple, fontSize: 17, fontWeight: '800' },
  eyebrow: { color: colors.purple, fontSize: 10, fontWeight: '800', letterSpacing: 1.8, marginTop: 42 },
  heading: { color: colors.text, fontSize: 32, fontWeight: '800', lineHeight: 39, marginTop: 10 }, name: { color: colors.purple },
  hero: { backgroundColor: '#28203D', borderRadius: 25, minHeight: 178, padding: 22, marginTop: 28, overflow: 'hidden', borderWidth: 1, borderColor: '#55447E' },
  heroGlow: { position: 'absolute', right: -50, top: -70, width: 200, height: 200, borderRadius: 100, backgroundColor: '#51358D', opacity: 0.65 },
  heroKicker: { color: '#C8AEFF', fontSize: 10, fontWeight: '800', letterSpacing: 1.7 }, heroTitle: { color: colors.text, fontSize: 25, fontWeight: '800', marginTop: 14 }, heroSub: { color: '#D2C9E0', fontSize: 14, marginTop: 6 },
  onlinePill: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 8, backgroundColor: '#352E4A', paddingHorizontal: 11, paddingVertical: 7, borderRadius: 20, marginTop: 17 }, onlineDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.green }, onlineText: { color: colors.text, fontSize: 11, fontWeight: '700' },
  sectionHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 33, marginBottom: 13 }, sectionTitle: { color: colors.text, fontSize: 20, fontWeight: '800' }, count: { color: colors.muted, fontSize: 10, fontWeight: '800', letterSpacing: 1.2 },
  friendList: { backgroundColor: colors.surface, borderRadius: 21, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' }, friend: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, minHeight: 64, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }, friendAvatar: { width: 39, height: 39, borderRadius: 14, alignItems: 'center', justifyContent: 'center' }, initial: { color: '#261C31', fontSize: 16, fontWeight: '900' }, friendInfo: { flex: 1, marginLeft: 12 }, friendName: { color: colors.text, fontSize: 14, fontWeight: '700' }, friendStatus: { color: colors.muted, fontSize: 11, marginTop: 2 }, statusDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.green }, offlineDot: { backgroundColor: '#5D576A' },
  roomsTitle: { color: colors.text, fontSize: 20, fontWeight: '800', marginTop: 28, marginBottom: 12 },
  roomCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 19, padding: 14, marginBottom: 10 },
  roomIcon: { width: 48, height: 48, borderRadius: 15, backgroundColor: '#493865', alignItems: 'center', justifyContent: 'center' },
  teaIcon: { backgroundColor: '#654133' }, roomIconText: { color: colors.text, fontSize: 24, fontWeight: '800' },
  roomInfo: { flex: 1, marginLeft: 13 }, roomName: { color: colors.text, fontSize: 16, fontWeight: '800' }, roomDescription: { color: colors.muted, fontSize: 11, marginTop: 3 },
  roomArrow: { color: colors.purple, fontSize: 28, marginRight: 4 }, logout: { marginTop: 12 },
  modalShade: { flex: 1, backgroundColor: '#090812C8', justifyContent: 'center', paddingHorizontal: 24 },
  modalCard: { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 24, padding: 24 },
  modalKicker: { color: colors.purple, fontSize: 10, fontWeight: '800', letterSpacing: 1.5 }, modalTitle: { color: colors.text, fontSize: 27, fontWeight: '800', marginTop: 10 },
  modalSub: { color: colors.muted, fontSize: 13, marginTop: 5 }, choices: { flexDirection: 'row', gap: 12, marginTop: 25 },
  choice: { flex: 1, alignItems: 'center', backgroundColor: colors.surfaceRaised, borderColor: colors.purple, borderWidth: 1, borderRadius: 17, paddingVertical: 18 },
  choiceEmoji: { fontSize: 33 }, choiceText: { color: colors.text, fontSize: 15, fontWeight: '800', marginTop: 7 },
  cancel: { alignSelf: 'center', padding: 12, marginTop: 8 }, cancelText: { color: colors.muted, fontSize: 13, fontWeight: '700' },
});
