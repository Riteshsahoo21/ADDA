import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BackHandler, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ScreenOrientation from 'expo-screen-orientation';
import { NavigationBar } from 'expo-navigation-bar';
import { router, useIsFocused, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { House, MessageCircle, Mic, MicOff, Send, Users, Volume2, VolumeX, X } from 'lucide-react-native';
import { GameRoom } from '@/components/room/GameRoom';
import InCallManager from 'react-native-incall-manager';
import { RoomKind } from '@/three/environment/createGameScene';
import { colors } from '@/constants/theme';
import { useSession } from '@/context/session';
import { AvatarBody } from '@/three/player/avatarStyle';
import { GroupMedia } from '@/lib/group-media';
import { getRealtimeSocket } from '@/lib/realtime';
import { sendRoomMessage, type RoomJoin, type RoomMessage, type RoomMotionSnapshot, type RoomPeer } from '@/lib/rooms';

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
  const [micMuted, setMicMuted] = useState(false);
  const [speakerMuted, setSpeakerMuted] = useState(false);
  const [mutedPeers, setMutedPeers] = useState<Set<string>>(() => new Set());
  const [voiceEpoch, setVoiceEpoch] = useState(0);
  const [nearbySpeakers, setNearbySpeakers] = useState(0);
  const [chatOpen, setChatOpen] = useState(false);
  const [playersOpen, setPlayersOpen] = useState(false);
  const [roomMenuOpen, setRoomMenuOpen] = useState(false);
  const [chatText, setChatText] = useState('');
  const [chatError, setChatError] = useState('');
  const [messages, setMessages] = useState<RoomMessage[]>([]);
  const [peers, setPeers] = useState<RoomPeer[]>([]);
  const mediaRef = useRef<GroupMedia | null>(null);
  const micMutedRef = useRef(false);
  const speakerMutedRef = useRef(false);
  const mutedPeersRef = useRef<Set<string>>(new Set());
  const presenceRef = useRef<Awaited<ReturnType<typeof getRealtimeSocket>> | null>(null);
  const positionRef = useRef<RoomMotionSnapshot>({ x: 0, y: 0, z: 0, yaw: 0, pose: 'idle' });
  const lastVoicePosition = useRef({ x: Number.POSITIVE_INFINITY, z: Number.POSITIVE_INFINITY, at: 0 });
  const onPosition = useCallback((snapshot: RoomMotionSnapshot) => {
    positionRef.current = snapshot;
    presenceRef.current?.volatile.emit('room:position', snapshot);
    if (Math.hypot(snapshot.x - lastVoicePosition.current.x, snapshot.z - lastVoicePosition.current.z) > 0.2 || Date.now() - lastVoicePosition.current.at > 2000) {
      lastVoicePosition.current = { x: snapshot.x, z: snapshot.z, at: Date.now() };
      mediaRef.current?.setPosition(snapshot.x, snapshot.z);
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
    if (!username || !focused) return;
    let active = true;
    InCallManager.start({ media: 'video', auto: false });
    InCallManager.setForceSpeakerphoneOn(true);
    const media = new GroupMedia(tracks => {
      if (active) setNearbySpeakers(new Set(tracks.filter(track => track.kind === 'audio').map(track => track.userId)).size);
    }, error => { if (active) setVoiceStatus(error); });
    media.setMuted(micMutedRef.current);
    media.setPlaybackMuted(speakerMutedRef.current);
    for (const userId of mutedPeersRef.current) media.setUserMuted(userId, true);
    mediaRef.current = media;
    void media.join({ kind: 'room', id: roomKind }, false, positionRef.current).then(() => {
      if (!active) return;
      media.setPosition(positionRef.current.x, positionRef.current.z);
      setVoiceStatus('Nearby voice on');
    }).catch(error => { if (active) setVoiceStatus(error instanceof Error ? error.message : 'Voice unavailable.'); });
    return () => { active = false; media.close(); InCallManager.setForceSpeakerphoneOn(false); InCallManager.stop(); setNearbySpeakers(0); if (mediaRef.current === media) mediaRef.current = null; };
  }, [roomKind, username, voiceEpoch, focused]);

  const toggleMic = () => {
    const next = !micMutedRef.current;
    micMutedRef.current = next;
    mediaRef.current?.setMuted(next);
    setMicMuted(next);
  };
  const toggleSpeaker = () => {
    const next = !speakerMutedRef.current;
    speakerMutedRef.current = next;
    mediaRef.current?.setPlaybackMuted(next);
    setSpeakerMuted(next);
  };
  const togglePeerSpeaker = (userId: string) => {
    const next = new Set(mutedPeersRef.current);
    const muted = !next.has(userId);
    if (muted) next.add(userId); else next.delete(userId);
    mutedPeersRef.current = next;
    mediaRef.current?.setUserMuted(userId, muted);
    setMutedPeers(next);
  };

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
      <View style={styles.toolbar}>
        <Pressable accessibilityRole="button" accessibilityLabel="Room menu" accessibilityState={{ expanded: roomMenuOpen }} onPress={() => { setRoomMenuOpen(current => !current); setPlayersOpen(false); setChatOpen(false); }} style={[styles.toolButton, roomMenuOpen && styles.toolButtonActive]}><House size={22} color="#F7FAF8" /></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Room chat" accessibilityState={{ expanded: chatOpen }} onPress={() => { setChatOpen(current => !current); setPlayersOpen(false); setRoomMenuOpen(false); }} style={[styles.toolButton, chatOpen && styles.toolButtonActive]}><MessageCircle size={22} color="#F7FAF8" /></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={micMuted ? 'Unmute my microphone' : 'Mute my microphone'} accessibilityState={{ selected: micMuted }} onPress={toggleMic} style={[styles.toolButton, micMuted && styles.toolButtonOff]}>{micMuted ? <MicOff size={22} color="#F7FAF8" /> : <Mic size={22} color="#F7FAF8" />}</Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={speakerMuted ? 'Turn my speaker on' : 'Mute my speaker'} accessibilityState={{ selected: speakerMuted }} onPress={toggleSpeaker} style={[styles.toolButton, speakerMuted && styles.toolButtonOff]}>{speakerMuted ? <VolumeX size={22} color="#F7FAF8" /> : <Volume2 size={22} color="#F7FAF8" />}</Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Players in room" accessibilityState={{ expanded: playersOpen }} onPress={() => { setPlayersOpen(current => !current); setChatOpen(false); setRoomMenuOpen(false); }} style={[styles.toolButton, playersOpen && styles.toolButtonActive]}><Users size={22} color="#F7FAF8" /><Text style={styles.playerCount}>{peers.length + 1}</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={roomKind === 'roof' ? 'Back to Loft' : 'Exit room'} onPress={() => roomKind === 'roof' ? setRoomKind('loft') : router.replace('/home')} style={styles.toolButton}><X size={22} color="#F7FAF8" /></Pressable>
      </View>
      <View style={styles.roomIdentity}><Text style={styles.title}>{roomKind === 'tea' ? 'Tea Party' : roomKind === 'roof' ? 'School Rooftop' : 'Loft 16'}</Text><Text style={styles.roomStatus} numberOfLines={1}>{voiceStatus}{nearbySpeakers ? ` · ${nearbySpeakers} nearby` : ''}</Text></View>
    </View>
    {roomMenuOpen && <View style={[styles.playersPanel, { left: Math.max(16, insets.left + 8), top: Math.max(66, insets.top + 62) }]}>
      <Text style={styles.panelTitle}>{roomKind === 'tea' ? 'Tea Party' : roomKind === 'roof' ? 'School Rooftop' : 'Loft 16'}</Text>
      <Text style={styles.roomMenuStatus}>{voiceStatus}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={roomKind === 'roof' ? 'Back to Loft' : 'Exit room'} onPress={() => roomKind === 'roof' ? setRoomKind('loft') : router.replace('/home')} style={styles.roomMenuExit}><Text style={styles.roomMenuExitText}>{roomKind === 'roof' ? 'Back to Loft' : 'Exit room'}</Text></Pressable>
    </View>}
    {playersOpen && <View style={[styles.playersPanel, { left: Math.max(16, insets.left + 8), top: Math.max(66, insets.top + 62) }]}>
      <Text style={styles.panelTitle}>Players in room</Text>
      <ScrollView style={styles.playersList}>
        <View style={styles.playerRow}><Text style={styles.playerName}>You</Text><Text style={styles.playerMeta}>{micMuted ? 'Mic muted' : 'Mic on'}</Text></View>
        {peers.map(peer => <View key={peer.userId} style={styles.playerRow}>
          <Text style={styles.playerName} numberOfLines={1}>{peer.name}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel={`${mutedPeers.has(peer.userId) ? 'Unmute' : 'Mute'} ${peer.name} for me`} onPress={() => togglePeerSpeaker(peer.userId)} style={styles.peerMute}>{mutedPeers.has(peer.userId) ? <VolumeX size={18} color={colors.amber} /> : <Volume2 size={18} color="#F7FAF8" />}</Pressable>
        </View>)}
        {!peers.length && <Text style={styles.emptyPlayers}>No one else is here yet.</Text>}
      </ScrollView>
    </View>}
    {chatOpen && <KeyboardAvoidingView style={[styles.chatPanel, { right: Math.max(16, insets.right + 8), bottom: Math.max(14, insets.bottom + 8) }]} behavior="padding">
      <Text style={styles.chatTitle}>Room chat</Text>
      <ScrollView style={styles.chatList}>{messages.map(message => <Text key={message.id} style={styles.chatMessage}><Text style={styles.chatName}>{message.name}: </Text>{message.body}</Text>)}</ScrollView>
      {!!chatError && <Text style={styles.chatError}>{chatError}</Text>}
      <View style={styles.chatInputRow}><TextInput style={styles.chatInput} placeholder="Message the room" placeholderTextColor="#A7B6AC" value={chatText} onChangeText={setChatText} maxLength={500} onSubmitEditing={() => void sendMessage()} /><Pressable accessibilityRole="button" accessibilityLabel="Send room message" onPress={() => void sendMessage()}><Send size={21} color="#F7FAF8" /></Pressable></View>
    </KeyboardAvoidingView>}
  </View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  topBar: { position: 'absolute', top: 8, left: 16, right: 16, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 },
  roomIdentity: { maxWidth: 190, backgroundColor: '#10221DCF', borderRadius: 14, paddingHorizontal: 12, paddingVertical: 8 },
  title: { color: '#F7FAF8', fontSize: 16, fontWeight: '800' },
  roomStatus: { color: '#C9DED2', fontSize: 10, marginTop: 2 },
  toolbar: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#10221DE8', borderRadius: 18, padding: 4, gap: 2 },
  toolButton: { width: 42, height: 42, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  toolButtonOff: { backgroundColor: '#A74141' },
  toolButtonActive: { backgroundColor: '#277A55' },
  playerCount: { position: 'absolute', right: 2, top: 1, color: '#F7FAF8', fontSize: 9, fontWeight: '800' },
  playersPanel: { position: 'absolute', width: 240, maxHeight: 230, backgroundColor: '#10221DF2', borderRadius: 16, padding: 13, gap: 5 },
  playersList: { maxHeight: 178 },
  panelTitle: { color: '#F7FAF8', fontSize: 13, fontWeight: '800', marginBottom: 4 },
  roomMenuStatus: { color: '#A7B6AC', fontSize: 11, marginBottom: 8 },
  roomMenuExit: { alignSelf: 'flex-start', backgroundColor: '#FFFFFF1A', borderRadius: 9, paddingHorizontal: 12, paddingVertical: 8 },
  roomMenuExitText: { color: '#F7FAF8', fontSize: 12, fontWeight: '700' },
  playerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 34, gap: 8 },
  playerName: { color: '#F7FAF8', fontSize: 12, fontWeight: '700', flexShrink: 1 },
  playerMeta: { color: '#A7B6AC', fontSize: 10 },
  peerMute: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center', borderRadius: 8, backgroundColor: '#FFFFFF1A' },
  emptyPlayers: { color: '#A7B6AC', fontSize: 11 },
  chatPanel: { position: 'absolute', width: 300, height: 220, backgroundColor: '#10221DF2', borderRadius: 16, padding: 12 },
  chatTitle: { color: '#F7FAF8', fontWeight: '800', marginBottom: 6 }, chatList: { flex: 1 },
  chatMessage: { color: '#F7FAF8', fontSize: 12, marginVertical: 3 }, chatName: { fontWeight: '800', color: '#EFC37C' },
  chatError: { color: '#FFAAA8', fontSize: 11 }, chatInputRow: { flexDirection: 'row', alignItems: 'center', gap: 8, borderTopWidth: 1, borderColor: '#FFFFFF33' },
  chatInput: { flex: 1, height: 38, color: '#F7FAF8', fontSize: 12 },
});
