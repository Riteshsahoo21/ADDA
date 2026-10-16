import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BackHandler, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ScreenOrientation from 'expo-screen-orientation';
import { NavigationBar } from 'expo-navigation-bar';
import { router, useIsFocused, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { MessageCircle, Mic, MicOff, Send } from 'lucide-react-native';
import { GameRoom } from '@/components/room/GameRoom';
import InCallManager from 'react-native-incall-manager';
import { RoomKind } from '@/three/environment/createGameScene';
import { colors } from '@/constants/theme';
import { useSession } from '@/context/session';
import { AvatarBody } from '@/three/player/avatarStyle';
import { GroupMedia } from '@/lib/group-media';
import { getRealtimeSocket } from '@/lib/realtime';
import { sendRoomMessage, type RoomJoin, type RoomMessage, type RoomPeer } from '@/lib/rooms';

const avatarBodies = new Set(['man', 'uncle', 'photo_boy', 'self', 'woman', 'chinese_woman', 'nepali_woman', 'white_top_woman']);

export default function HangoutScreen() {
  const { username, avatarStyle } = useSession();
  const focused = useIsFocused();
  const params = useLocalSearchParams<{ room?: string; avatar?: string }>();
  const [roomKind, setRoomKind] = useState<RoomKind>(params.room === 'tea' ? 'tea' : params.room === 'roof' ? 'roof' : 'loft');
  const avatar: AvatarBody = avatarBodies.has(params.avatar ?? '') ? params.avatar as AvatarBody : avatarStyle.body;
  const roomAvatar = useMemo(() => ({ ...avatarStyle, body: avatar }), [avatarStyle, avatar]);
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [landscapeReady, setLandscapeReady] = useState(false);
  const [orientationFailed, setOrientationFailed] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState('Connecting voice…');
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [voiceEpoch, setVoiceEpoch] = useState(0);
  const [nearbySpeakers, setNearbySpeakers] = useState(0);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatText, setChatText] = useState('');
  const [chatError, setChatError] = useState('');
  const [messages, setMessages] = useState<RoomMessage[]>([]);
  const [peers, setPeers] = useState<RoomPeer[]>([]);
  const mediaRef = useRef<GroupMedia | null>(null);
  const presenceRef = useRef<Awaited<ReturnType<typeof getRealtimeSocket>> | null>(null);
  const positionRef = useRef({ x: 0, z: 0, yaw: 0 });
  const lastVoicePosition = useRef({ x: Number.POSITIVE_INFINITY, z: Number.POSITIVE_INFINITY, at: 0 });
  const onPosition = useCallback((x: number, z: number, yaw: number) => {
    positionRef.current = { x, z, yaw };
    presenceRef.current?.volatile.emit('room:position', positionRef.current);
    if (Math.hypot(x - lastVoicePosition.current.x, z - lastVoicePosition.current.z) > 0.2 || Date.now() - lastVoicePosition.current.at > 2000) {
      lastVoicePosition.current = { x, z, at: Date.now() };
      mediaRef.current?.setPosition(x, z);
    }
  }, []);

  useEffect(() => {
    if (!username) { router.replace('/login'); return; }
    let active = true;
    void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE).then(() => {
      if (active) setLandscapeReady(true);
    }).catch(error => {
      console.warn('[ADDA] Landscape lock failed', error);
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

  useEffect(() => {
    if (!username || !focused) return;
    let active = true;
    let live: Awaited<ReturnType<typeof getRealtimeSocket>> | null = null;
    const onPeer = (peer: RoomPeer) => setPeers(current => [...current.filter(item => item.userId !== peer.userId), peer]);
    const onLeft = ({ userId }: { userId: string }) => setPeers(current => current.filter(peer => peer.userId !== userId));
    const onMessage = (message: RoomMessage) => setMessages(current => [...current, message].slice(-50));
    const onReconnect = () => { joinPresence(); setVoiceEpoch(current => current + 1); };
    const joinPresence = () => {
      if (!live || !active) return;
      live.timeout(8000).emit('room:join', { room: roomKind, avatar }, (error: Error | null, result?: { ok: boolean; value?: RoomJoin; error?: string }) => {
        if (!active) return;
        if (error || !result?.ok || !result.value) { setChatError(result?.error || 'Could not join room chat.'); return; }
        setPeers(result.value.peers);
        setMessages(result.value.messages);
        setChatError('');
        live?.volatile.emit('room:position', positionRef.current);
      });
    };
    void getRealtimeSocket().then(socket => {
      if (!active) return;
      live = socket;
      presenceRef.current = socket;
      socket.on('room:peer', onPeer);
      socket.on('room:peer-left', onLeft);
      socket.on('room:message', onMessage);
      socket.on('connect', onReconnect);
      joinPresence();
    }).catch(error => { if (active) setChatError(error instanceof Error ? error.message : 'Room chat offline.'); });
    return () => {
      active = false;
      live?.off('room:peer', onPeer); live?.off('room:peer-left', onLeft); live?.off('room:message', onMessage);
      live?.off('connect', onReconnect);
      live?.emit('room:leave');
      if (presenceRef.current === live) presenceRef.current = null;
    };
  }, [roomKind, username, avatar, focused]);

  useEffect(() => {
    if (!username || !focused || !voiceEnabled) return;
    let active = true;
    InCallManager.start({ media: 'video', auto: false });
    InCallManager.setForceSpeakerphoneOn(true);
    const media = new GroupMedia(tracks => {
      if (active) setNearbySpeakers(new Set(tracks.filter(track => track.kind === 'audio').map(track => track.userId)).size);
    }, error => { if (active) setVoiceStatus(error); });
    mediaRef.current = media;
    void media.join({ kind: 'room', id: roomKind }, false, positionRef.current).then(() => {
      if (!active) return;
      media.setPosition(positionRef.current.x, positionRef.current.z);
      setVoiceStatus('Nearby voice on');
    }).catch(error => { if (active) setVoiceStatus(error instanceof Error ? error.message : 'Voice unavailable.'); });
    return () => { active = false; media.close(); InCallManager.setForceSpeakerphoneOn(false); InCallManager.stop(); setNearbySpeakers(0); if (mediaRef.current === media) mediaRef.current = null; };
  }, [roomKind, username, voiceEnabled, voiceEpoch, focused]);

  const sendMessage = async () => {
    const body = chatText.trim();
    if (!body) return;
    try { await sendRoomMessage(body); setChatText(''); setChatError(''); }
    catch (error) { setChatError(error instanceof Error ? error.message : 'Could not send message.'); }
  };
  if (!username) return null;

  return <View style={styles.screen}>
    <StatusBar hidden />
    <NavigationBar hidden />
    {landscapeReady && (width >= height || orientationFailed) && <GameRoom key={`${roomKind}-${roomAvatar.body}`} roomKind={roomKind} avatar={roomAvatar} peers={peers} onPosition={onPosition} onPortal={() => setRoomKind(current => current === 'roof' ? 'loft' : 'roof')} />}
    <View style={[styles.topBar, { left: Math.max(16, insets.left + 8), right: Math.max(16, insets.right + 8), top: Math.max(8, insets.top + 4) }]}>
      <View style={styles.roomIdentity}><Text style={styles.kicker}>THE ADDA GANG</Text><Text style={styles.title}>{roomKind === 'tea' ? 'Tea Party' : roomKind === 'roof' ? 'School Rooftop' : 'Loft 16'}</Text></View>
      <Pressable accessibilityRole="button" onPress={() => roomKind === 'roof' ? setRoomKind('loft') : router.replace('/home')} style={styles.exit}><Text style={styles.exitText}>{roomKind === 'roof' ? 'Back to Loft' : 'Exit room'}</Text></Pressable>
    </View>
    <View style={[styles.actions, { top: Math.max(67, insets.top + 64), right: Math.max(16, insets.right + 8) }]}>
      <Pressable accessibilityRole="button" accessibilityLabel={voiceEnabled ? 'Turn off nearby voice' : 'Turn on nearby voice'} onPress={() => { setVoiceStatus(voiceEnabled ? 'Voice off' : 'Connecting voice…'); setVoiceEnabled(current => !current); }} style={styles.voice}>
        {voiceEnabled ? <Mic size={17} color={colors.primaryDark} /> : <MicOff size={17} color={colors.primaryDark} />}
        <Text style={styles.voiceText} numberOfLines={1}>{voiceStatus}{voiceEnabled && nearbySpeakers ? ` · ${nearbySpeakers}` : ''}</Text>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Room chat" onPress={() => setChatOpen(current => !current)} style={styles.voice}><MessageCircle size={17} color={colors.primaryDark} /><Text style={styles.voiceText}>Chat</Text></Pressable>
    </View>
    {chatOpen && <KeyboardAvoidingView style={[styles.chatPanel, { right: Math.max(16, insets.right + 8), bottom: Math.max(14, insets.bottom + 8) }]} behavior="padding">
      <Text style={styles.chatTitle}>Room chat</Text>
      <ScrollView style={styles.chatList}>{messages.map(message => <Text key={message.id} style={styles.chatMessage}><Text style={styles.chatName}>{message.name}: </Text>{message.body}</Text>)}</ScrollView>
      {!!chatError && <Text style={styles.chatError}>{chatError}</Text>}
      <View style={styles.chatInputRow}><TextInput style={styles.chatInput} placeholder="Message the room" value={chatText} onChangeText={setChatText} maxLength={500} onSubmitEditing={() => void sendMessage()} /><Pressable accessibilityLabel="Send room message" onPress={() => void sendMessage()}><Send size={21} color={colors.primary} /></Pressable></View>
    </KeyboardAvoidingView>}
  </View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  topBar: { position: 'absolute', top: 8, left: 16, right: 16, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  roomIdentity: { backgroundColor: '#FFFFFFE8', borderRadius: 14, paddingHorizontal: 14, paddingVertical: 8, borderWidth: 1, borderColor: '#FFFFFF' },
  kicker: { color: colors.primary, fontSize: 10, fontWeight: '800', letterSpacing: 1.5 }, title: { color: colors.text, fontSize: 20, fontWeight: '800', marginTop: 2 },
  exit: { backgroundColor: '#FFFFFFE8', borderRadius: 13, borderWidth: 1, borderColor: '#FFFFFF', paddingHorizontal: 18, paddingVertical: 11 }, exitText: { color: colors.primaryDark, fontWeight: '800', fontSize: 13 },
  actions: { position: 'absolute', flexDirection: 'row', gap: 8 },
  voice: { flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: 190, backgroundColor: '#FFFFFFE8', borderRadius: 14, paddingHorizontal: 12, paddingVertical: 9 },
  voiceText: { color: colors.primaryDark, fontWeight: '700', fontSize: 11, maxWidth: 155 },
  chatPanel: { position: 'absolute', width: 300, height: 220, backgroundColor: '#FFFFFFF5', borderRadius: 16, padding: 12 },
  chatTitle: { color: colors.text, fontWeight: '800', marginBottom: 6 }, chatList: { flex: 1 },
  chatMessage: { color: colors.text, fontSize: 12, marginVertical: 3 }, chatName: { fontWeight: '800', color: colors.primaryDark },
  chatError: { color: colors.error, fontSize: 11 }, chatInputRow: { flexDirection: 'row', alignItems: 'center', gap: 8, borderTopWidth: 1, borderColor: colors.border },
  chatInput: { flex: 1, height: 38, color: colors.text, fontSize: 12 },
});
