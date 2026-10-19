import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, BackHandler, DeviceEventEmitter, KeyboardAvoidingView, PermissionsAndroid, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ScreenOrientation from 'expo-screen-orientation';
import { NavigationBar } from 'expo-navigation-bar';
import { router, useIsFocused, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { Headphones, House, MessageCircle, Mic, MicOff, Music, Send, Users, Volume1, Volume2, VolumeX, X } from 'lucide-react-native';
import { GameRoom } from '@/components/room/GameRoom';
import InCallManager from 'react-native-incall-manager';
import { RoomKind } from '@/three/environment/createGameScene';
import { colors } from '@/constants/theme';
import { useSession } from '@/context/session';
import { AvatarBody } from '@/three/player/avatarStyle';
import { GroupMedia } from '@/lib/group-media';
import { getRealtimeSocket } from '@/lib/realtime';
import { sendRoomMessage, type RoomJoin, type RoomMessage, type RoomMotionSnapshot, type RoomPeer } from '@/lib/rooms';
import { MusicHubModal } from '@/components/music/MusicHubModal';
import { MusicService } from '@/audio/MusicService';

const avatarBodies = new Set(['man', 'uncle', 'photo_boy', 'self', 'woman', 'chinese_woman', 'nepali_woman', 'white_top_woman']);

export default function HangoutScreen() {
  const { username, avatarStyle } = useSession();
  const focused = useIsFocused();
  const params = useLocalSearchParams<{ room?: string; avatar?: string }>();
  const [roomKind, setRoomKind] = useState<RoomKind>(params.room === 'beach' ? 'beach' : params.room === 'tea' ? 'tea' : params.room === 'roof' ? 'roof' : 'loft');
  const avatar: AvatarBody = avatarBodies.has(params.avatar ?? '') ? params.avatar as AvatarBody : avatarStyle.body;
  const roomAvatar = useMemo(() => ({ ...avatarStyle, body: avatar }), [avatarStyle, avatar]);
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [landscapeReady, setLandscapeReady] = useState(false);
  const [orientationFailed, setOrientationFailed] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState('Connecting voice…');
  const [micMuted, setMicMuted] = useState(false);
  const [speakerMuted, setSpeakerMuted] = useState(false);
  const [routeToast, setRouteToast] = useState<string | null>(null);
  const [mutedPeers, setMutedPeers] = useState<Set<string>>(() => new Set());
  const [voiceEpoch, setVoiceEpoch] = useState(0);
  const [nearbySpeakers, setNearbySpeakers] = useState(0);
  const [chatOpen, setChatOpen] = useState(false);
  const [playersOpen, setPlayersOpen] = useState(false);
  const [roomMenuOpen, setRoomMenuOpen] = useState(false);
  const [musicModalOpen, setMusicModalOpen] = useState(false);
  const [musicModalTab, setMusicModalTab] = useState<'headphones' | 'radio'>('headphones');
  const [chatText, setChatText] = useState('');
  const [chatError, setChatError] = useState('');
  const [messages, setMessages] = useState<RoomMessage[]>([]);
  const [peers, setPeers] = useState<RoomPeer[]>([]);
  const mediaRef = useRef<GroupMedia | null>(null);
  const micMutedRef = useRef(false);
  const speakerMutedRef = useRef(false);
  const isBluetoothRef = useRef(false);
  const isWiredRef = useRef(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
    MusicService.init();
    let active = true;
    let live: Awaited<ReturnType<typeof getRealtimeSocket>> | null = null;
    const onPeer = (peer: RoomPeer) => setPeers(current => [...current.filter(item => item.userId !== peer.userId), peer]);
    const onLeft = ({ userId }: { userId: string }) => setPeers(current => current.filter(peer => peer.userId !== userId));
    const onMessage = (message: RoomMessage) => setMessages(current => [...current, message].slice(-50));
    const onRadioSync = (radio: { enabled?: boolean; trackIndex?: number }) => {
      if (typeof radio?.enabled === 'boolean' && radio.enabled !== MusicService.state.radioEnabled) {
        MusicService.setRadioEnabled(radio.enabled);
      }
      if (typeof radio?.trackIndex === 'number' && radio.trackIndex !== MusicService.state.radioTrackIndex) {
        MusicService.playRadioTrack(radio.trackIndex);
      }
    };
    const onReconnect = () => { joinPresence(); setVoiceEpoch(current => current + 1); };
    const joinPresence = () => {
      if (!live || !active) return;
      live.timeout(8000).emit('room:join', { room: roomKind, avatar }, (error: Error | null, result?: { ok: boolean; value?: RoomJoin; error?: string }) => {
        if (!active) return;
        if (error || !result?.ok || !result.value) { setChatError(result?.error || 'Could not join room chat.'); return; }
        setPeers(result.value.peers);
        setMessages(result.value.messages);
        if (result.value.radio) {
          MusicService.setRadioEnabled(result.value.radio.enabled, true);
          MusicService.playRadioTrack(result.value.radio.trackIndex);
        }
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
      socket.on('room:radio-sync', onRadioSync);
      socket.on('connect', onReconnect);
      joinPresence();
    }).catch(error => { if (active) setChatError(error instanceof Error ? error.message : 'Room chat offline.'); });
    return () => {
      active = false;
      MusicService.stopAll();
      live?.off('room:peer', onPeer); live?.off('room:peer-left', onLeft); live?.off('room:message', onMessage);
      live?.off('room:radio-sync', onRadioSync);
      live?.off('connect', onReconnect);
      live?.emit('room:leave');
      if (presenceRef.current === live) presenceRef.current = null;
    };
  }, [roomKind, username, avatar, focused]);

  // Pause background music when the app is minimized to prevent audio stream conflicts
  useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      if (state === 'background' || state === 'inactive') {
        MusicService.pauseAll();
      }
    });
    return () => sub.remove();
  }, []);

  const showRouteToast = (msg: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setRouteToast(msg);
    toastTimer.current = setTimeout(() => setRouteToast(null), 2500);
  };

  const applyAudioRoute = useCallback(() => {
    if (isBluetoothRef.current) {
      InCallManager.setForceSpeakerphoneOn(null as any);
      InCallManager.setSpeakerphoneOn(false);
      void InCallManager.chooseAudioRoute('BLUETOOTH');
    } else if (isWiredRef.current) {
      InCallManager.setForceSpeakerphoneOn(null as any);
      InCallManager.setSpeakerphoneOn(false);
      void InCallManager.chooseAudioRoute('WIRED_HEADSET');
    } else {
      InCallManager.setForceSpeakerphoneOn(true);
      InCallManager.setSpeakerphoneOn(true);
      void InCallManager.chooseAudioRoute('SPEAKER_PHONE');
    }
  }, []);

  useEffect(() => {
    if (!username || !focused) return;
    let active = true;

    // 1. Request Bluetooth permission on Android 12+ so InCallManager can start Bluetooth SCO
    if (Platform.OS === 'android' && Number(Platform.Version) >= 31) {
      void PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT).catch(() => {});
    }

    // 2. Start InCallManager with audio media (room is proximity voice chat, auto starts Bluetooth SCO manager)
    InCallManager.start({ media: 'audio', auto: true });

    // Initial check for wired earphones
    void InCallManager.getIsWiredHeadsetPluggedIn().then(({ isWiredHeadsetPluggedIn }) => {
      if (!active) return;
      isWiredRef.current = Boolean(isWiredHeadsetPluggedIn);
      applyAudioRoute();
    }).catch(() => {});

    // Listen for audio device changes (Bluetooth wireless, wired headset, or speaker)
    const audioDeviceSub = DeviceEventEmitter.addListener('onAudioDeviceChanged', (data: { selectedAudioDevice?: string; availableAudioDeviceList?: string }) => {
      if (!active) return;
      console.log('[ADDA Hangout Audio Device]', data);
      let hasBt = false;
      let hasWired = false;
      if (data?.availableAudioDeviceList) {
        try {
          const list = JSON.parse(data.availableAudioDeviceList) as string[];
          hasBt = list.includes('BLUETOOTH');
          hasWired = list.includes('WIRED_HEADSET');
        } catch {}
      }
      const prevBt = isBluetoothRef.current;
      const prevWired = isWiredRef.current;
      isBluetoothRef.current = hasBt;
      isWiredRef.current = hasWired;
      applyAudioRoute();

      if (hasBt && !prevBt) {
        showRouteToast('🎧 Wireless Earphones Connected (Bluetooth SCO)');
      } else if (hasWired && !prevWired) {
        showRouteToast('🎧 Wired Earphones Connected');
      }
    });

    const headsetSub = DeviceEventEmitter.addListener('WiredHeadset', (data: { isPlugged?: boolean }) => {
      if (!active) return;
      const plugged = Boolean(data?.isPlugged);
      isWiredRef.current = plugged;
      applyAudioRoute();
      if (plugged) showRouteToast('🎧 Wired Earphones Connected');
    });

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
    return () => {
      active = false;
      audioDeviceSub.remove();
      headsetSub.remove();
      media.close();
      InCallManager.setForceSpeakerphoneOn(false);
      InCallManager.stop();
      setNearbySpeakers(0);
      if (mediaRef.current === media) mediaRef.current = null;
    };
  }, [roomKind, username, voiceEpoch, focused, applyAudioRoute]);

  const toggleMic = () => {
    const next = !micMutedRef.current;
    micMutedRef.current = next;
    mediaRef.current?.setMuted(next);
    setMicMuted(next);

    // Root fix: when unmuting, WebRTC ADM restarts AudioRecord.
    // Re-assert route after 100ms so WebRTC does NOT kick audio to loudspeaker!
    if (!next) {
      setTimeout(() => {
        applyAudioRoute();
      }, 100);
    }
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
    {landscapeReady && (width >= height || orientationFailed) && <GameRoom key={`${roomKind}-${roomAvatar.body}`} roomKind={roomKind} avatar={roomAvatar} peers={peers} onPosition={onPosition} onPortal={() => setRoomKind(current => current === 'roof' ? 'loft' : 'roof')} onOpenRadio={() => { setMusicModalTab('radio'); setMusicModalOpen(true); }} />}
    <View style={[styles.topBar, { left: Math.max(16, insets.left + 8), right: Math.max(16, insets.right + 8), top: Math.max(8, insets.top + 4) }]}>
      <View style={styles.toolbar}>
        <Pressable accessibilityRole="button" accessibilityLabel="Room menu" accessibilityState={{ expanded: roomMenuOpen }} onPress={() => { setRoomMenuOpen(current => !current); setPlayersOpen(false); setChatOpen(false); }} style={[styles.toolButton, roomMenuOpen && styles.toolButtonActive]}><House size={22} color="#F7FAF8" /></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Room chat" accessibilityState={{ expanded: chatOpen }} onPress={() => { setChatOpen(current => !current); setPlayersOpen(false); setRoomMenuOpen(false); }} style={[styles.toolButton, chatOpen && styles.toolButtonActive]}><MessageCircle size={22} color="#F7FAF8" /></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={micMuted ? 'Unmute my microphone' : 'Mute my microphone'} accessibilityState={{ selected: micMuted }} onPress={toggleMic} style={[styles.toolButton, micMuted && styles.toolButtonOff]}>{micMuted ? <MicOff size={22} color="#F7FAF8" /> : <Mic size={22} color="#F7FAF8" />}</Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={speakerMuted ? 'Turn my speaker on' : 'Mute my speaker'} accessibilityState={{ selected: speakerMuted }} onPress={toggleSpeaker} style={[styles.toolButton, speakerMuted && styles.toolButtonOff]}>{speakerMuted ? <VolumeX size={22} color="#F7FAF8" /> : <Volume2 size={22} color="#F7FAF8" />}</Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Open Music Studio & Radio" accessibilityState={{ expanded: musicModalOpen }} onPress={() => { setMusicModalTab('headphones'); setMusicModalOpen(true); setPlayersOpen(false); setChatOpen(false); setRoomMenuOpen(false); }} style={[styles.toolButton, musicModalOpen && styles.toolButtonActive]}><Music size={21} color="#00E5FF" /></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Players in room" accessibilityState={{ expanded: playersOpen }} onPress={() => { setPlayersOpen(current => !current); setChatOpen(false); setRoomMenuOpen(false); }} style={[styles.toolButton, playersOpen && styles.toolButtonActive]}><Users size={22} color="#F7FAF8" /><Text style={styles.playerCount}>{peers.length + 1}</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={roomKind === 'roof' ? 'Back to Loft' : 'Exit room'} onPress={() => roomKind === 'roof' ? setRoomKind('loft') : router.replace('/home')} style={styles.toolButton}><X size={22} color="#F7FAF8" /></Pressable>
      </View>
      <View style={styles.roomIdentity}><Text style={styles.title}>{roomKind === 'beach' ? 'Goa Beach' : roomKind === 'tea' ? 'Tea Party' : roomKind === 'roof' ? 'School Rooftop' : 'Loft 16'}</Text><Text style={styles.roomStatus} numberOfLines={1}>{voiceStatus}{nearbySpeakers ? ` · ${nearbySpeakers} nearby` : ''}</Text></View>
    </View>
    {!!routeToast && (
      <View style={[styles.routeToastPill, { top: Math.max(56, insets.top + 52) }]} pointerEvents="none">
        <Text style={styles.routeToastText}>{routeToast}</Text>
      </View>
    )}
    {roomMenuOpen && <View style={[styles.playersPanel, { left: Math.max(16, insets.left + 8), top: Math.max(66, insets.top + 62) }]}>
      <Text style={styles.panelTitle}>{roomKind === 'beach' ? 'Goa Beach' : roomKind === 'tea' ? 'Tea Party' : roomKind === 'roof' ? 'School Rooftop' : 'Loft 16'}</Text>
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
    <MusicHubModal
      visible={musicModalOpen}
      onClose={() => setMusicModalOpen(false)}
      initialTab={musicModalTab}
      onSyncRadioToServer={(sync) => presenceRef.current?.emit('room:radio-sync', sync)}
    />
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
  toolButtonNormalSpeaker: { backgroundColor: '#1B4D68' },
  routeToastPill: { position: 'absolute', alignSelf: 'center', backgroundColor: '#10221DF2', borderWidth: 1, borderColor: '#FFFFFF33', borderRadius: 20, paddingHorizontal: 16, paddingVertical: 7, zIndex: 999 },
  routeToastText: { color: '#F7FAF8', fontSize: 12, fontWeight: '700' },
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
