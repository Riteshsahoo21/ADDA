import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, BackHandler, DeviceEventEmitter, Image, KeyboardAvoidingView, Modal, PermissionsAndroid, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ScreenOrientation from 'expo-screen-orientation';
import { NavigationBar } from 'expo-navigation-bar';
import { router, useIsFocused, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { Check, Crown, Headphones, House, MessageCircle, Mic, MicOff, Music, Send, Trash2, UserPlus, Users, UserX, Volume1, Volume2, VolumeX, X } from 'lucide-react-native';
import { GameRoom } from '@/components/room/GameRoom';
import InCallManager from 'react-native-incall-manager';
import { RoomKind } from '@/three/environment/createGameScene';
import { colors } from '@/constants/theme';
import { useSession } from '@/context/session';
import { AvatarBody } from '@/three/player/avatarStyle';
import { GroupMedia } from '@/lib/group-media';
import { getRealtimeSocket } from '@/lib/realtime';
import { deleteCurrentRoom, inviteGroupToRoom, inviteToRoom, kickRoomPeer, sendRoomMessage, type RoomJoin, type RoomMessage, type RoomMotionSnapshot, type RoomPeer, type RoomPeerMotion } from '@/lib/rooms';
import { decodeMotionBatch, encodeMotion, isNewerSequence } from '@/lib/room-motion-codec';
import { MusicHubModal } from '@/components/music/MusicHubModal';
import { MusicService } from '@/audio/MusicService';
import { getActiveUserId } from '@/lib/encrypted-chat';
import { socialApi, type ChatGroup, type GroupDetails, type GroupMember, type PublicProfile, type SocialBundle } from '@/lib/social-api';

const avatarBodies = new Set(['man', 'uncle', 'photo_boy', 'self', 'woman', 'chinese_woman', 'nepali_woman', 'white_top_woman']);

export default function HangoutScreen() {
  const { username, avatarStyle } = useSession();
  const focused = useIsFocused();
  const params = useLocalSearchParams<{
    room?: string;
    avatar?: string;
    groupId?: string;
    roomId?: string;
    roomOwnerId?: string;
    groupName?: string;
  }>();
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
  const [motionV2, setMotionV2] = useState(false);
  const peerMotions = useRef(new Map<string, RoomPeerMotion>());
  const motionUsers = useRef(new Map<number, string>());
  const motionSequences = useRef(new Map<number, number>());
  const outboundSequence = useRef(0);
  const motionProtocol = useRef(false);
  const lastOutboundPose = useRef<RoomMotionSnapshot['pose']>('idle');
  const [shardId, setShardId] = useState<string>('');
  const [shardIndex, setShardIndex] = useState<number>(1);

  // Group Rooms & Moderation State
  const currentUserId = getActiveUserId();
  const [roomOwnerId, setRoomOwnerId] = useState<string>(params.roomOwnerId ?? '');
  const isOwner = Boolean(currentUserId && roomOwnerId && currentUserId === roomOwnerId);

  const [inviteModalOpen, setInviteModalOpen] = useState(false);
  const [inviteTab, setInviteTab] = useState<'members' | 'friends' | 'groups'>(params.groupId ? 'members' : 'friends');
  const [groupMembers, setGroupMembers] = useState<GroupMember[]>([]);
  const [contacts, setContacts] = useState<PublicProfile[]>([]);
  const [myGroups, setMyGroups] = useState<ChatGroup[]>([]);
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [invitedIds, setInvitedIds] = useState<Set<string>>(() => new Set());
  const [invitingId, setInvitingId] = useState<string | null>(null);
  const [invitedGroupIds, setInvitedGroupIds] = useState<Set<string>>(() => new Set());
  const [invitingGroupId, setInvitingGroupId] = useState<string | null>(null);

  const activeRoomId = shardId || (params.roomId ? `room:${params.roomId}` : (params.groupId ? `group:${params.groupId}:${roomKind}` : roomKind));

  const mediaRef = useRef<GroupMedia | null>(null);
  const micMutedRef = useRef(false);
  const speakerMutedRef = useRef(false);
  const isBluetoothRef = useRef(false);
  const isWiredRef = useRef(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mutedPeersRef = useRef<Set<string>>(new Set());
  const presenceRef = useRef<Awaited<ReturnType<typeof getRealtimeSocket>> | null>(null);
  const positionRef = useRef<RoomMotionSnapshot>({ x: 0, y: 0, z: 0, yaw: 0, vx: 0, vz: 0, pose: 'idle' });
  const lastVoicePosition = useRef({ x: Number.POSITIVE_INFINITY, z: Number.POSITIVE_INFINITY, at: 0 });
  const onPosition = useCallback((snapshot: RoomMotionSnapshot) => {
    positionRef.current = snapshot;
    const socket = presenceRef.current;
    if (socket && motionProtocol.current) {
      const packet = encodeMotion({ ...snapshot, motionId: 0, seq: ++outboundSequence.current });
      if (snapshot.pose !== lastOutboundPose.current) socket.emit('room:motion', packet);
      else socket.volatile.emit('room:motion', packet);
    } else socket?.volatile.emit('room:position', snapshot);
    lastOutboundPose.current = snapshot.pose;
    if (Math.hypot(snapshot.x - lastVoicePosition.current.x, snapshot.z - lastVoicePosition.current.z) > 0.2 || Date.now() - lastVoicePosition.current.at > 2000) {
      lastVoicePosition.current = { x: snapshot.x, z: snapshot.z, at: Date.now() };
      mediaRef.current?.setPosition(snapshot.x, snapshot.z);
    }
  }, []);

  const showRouteToast = useCallback((msg: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setRouteToast(msg);
    toastTimer.current = setTimeout(() => setRouteToast(null), 2500);
  }, []);

  const openInviteModal = async () => {
    setInviteModalOpen(true);
    setInviteTab(params.groupId ? 'members' : 'friends');
    setLoadingMembers(true);
    try {
      const bundlePromise = socialApi<SocialBundle>('/social/bundle').catch(err => {
        console.warn('[ADDA] Failed to fetch social bundle for invite:', err);
        return null;
      });
      const groupPromise = params.groupId
        ? socialApi<GroupDetails>(`/groups/${params.groupId}`).catch(err => {
            console.warn('[ADDA] Failed to fetch group members for invite:', err);
            return null;
          })
        : Promise.resolve(null);

      const [bundle, details] = await Promise.all([bundlePromise, groupPromise]);

      if (details?.members) {
        setGroupMembers(details.members);
      }
      if (bundle) {
        setContacts(bundle.contacts || []);
        setMyGroups(bundle.groups || []);
      }
    } catch (err) {
      console.warn('[ADDA] Failed to load invite data:', err);
    } finally {
      setLoadingMembers(false);
    }
  };

  const handleInviteMember = async (memberId: string, memberName: string) => {
    if (invitingId || invitedIds.has(memberId)) return;
    setInvitingId(memberId);
    try {
      await inviteToRoom([memberId]);
      setInvitedIds(prev => new Set([...prev, memberId]));
      showRouteToast(`Invited ${memberName}!`);
    } catch (err: any) {
      Alert.alert('Invite Failed', err.message || 'Could not send invitation.');
    } finally {
      setInvitingId(null);
    }
  };

  const handleInviteGroup = async (targetGroupId: string, groupName: string) => {
    if (invitingGroupId || invitedGroupIds.has(targetGroupId)) return;
    setInvitingGroupId(targetGroupId);
    try {
      const count = await inviteGroupToRoom(targetGroupId);
      setInvitedGroupIds(prev => new Set([...prev, targetGroupId]));
      showRouteToast(`Invited ${count} member${count === 1 ? '' : 's'} from ${groupName}!`);
    } catch (err: any) {
      Alert.alert('Invite Failed', err.message || 'Could not send group invitation.');
    } finally {
      setInvitingGroupId(null);
    }
  };

  const handleDeleteRoom = () => {
    Alert.alert(
      'Delete Room',
      'Are you sure you want to delete and end this room? All players will be disconnected and resources freed.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete Room',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteCurrentRoom();
              showRouteToast('Room ended and deleted.');
              router.replace('/home');
            } catch (err: any) {
              Alert.alert('Action Failed', err.message || 'Could not delete room.');
            }
          },
        },
      ]
    );
  };

  const handleKickPeer = (peer: RoomPeer) => {
    Alert.alert(
      'Kick Player',
      `Are you sure you want to kick ${peer.name} from this room?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Kick',
          style: 'destructive',
          onPress: async () => {
            try {
              await kickRoomPeer(peer.userId);
              showRouteToast(`Kicked ${peer.name}`);
            } catch (err: any) {
              Alert.alert('Action Failed', err.message || 'Could not kick player.');
            }
          },
        },
      ]
    );
  };

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
    const motions = peerMotions.current;
    const usersByMotionId = motionUsers.current;
    const sequencesByMotionId = motionSequences.current;
    const onPeer = (peer: RoomPeer) => {
      for (const [id, name] of usersByMotionId) if (name === peer.userId && id !== peer.motionId) {
        usersByMotionId.delete(id);
        sequencesByMotionId.delete(id);
      }
      if (peer.motionId !== undefined) usersByMotionId.set(peer.motionId, peer.userId);
      const previous = motions.get(peer.userId)?.peer;
      motions.set(peer.userId, { peer, receivedAt: Date.now() });
      if (!previous || previous.avatar !== peer.avatar || previous.name !== peer.name) {
        setPeers(current => [...current.filter(item => item.userId !== peer.userId), peer]);
      }
    };
    const onLeft = ({ userId }: { userId: string }) => {
      motions.delete(userId);
      for (const [id, name] of usersByMotionId) if (name === userId) {
        usersByMotionId.delete(id);
        sequencesByMotionId.delete(id);
      }
      setPeers(current => current.filter(peer => peer.userId !== userId));
    };
    const onMotionBatch = (packet: unknown) => {
      const states = decodeMotionBatch(packet);
      if (!states) return;
      const receivedAt = Date.now();
      for (const state of states) {
        const userId = usersByMotionId.get(state.motionId);
        if (!userId) continue;
        const last = sequencesByMotionId.get(state.motionId);
        if (last !== undefined && !isNewerSequence(state.seq, last)) continue;
        const previous = motions.get(userId);
        if (!previous) continue;
        sequencesByMotionId.set(state.motionId, state.seq);
        motions.set(userId, { peer: { ...previous.peer, ...state }, receivedAt });
      }
    };
    const onMessage = (message: RoomMessage) => setMessages(current => [...current, message].slice(-50));
    const onRadioSync = (radio: { enabled?: boolean; trackIndex?: number }) => {
      if (typeof radio?.enabled === 'boolean' && radio.enabled !== MusicService.state.radioEnabled) {
        MusicService.setRadioEnabled(radio.enabled);
      }
      if (typeof radio?.trackIndex === 'number' && radio.trackIndex !== MusicService.state.radioTrackIndex) {
        MusicService.playRadioTrack(radio.trackIndex);
      }
    };
    const onKicked = (data: { roomId?: string; reason?: string }) => {
      Alert.alert(
        'Removed from Room',
        data?.reason || 'You have been removed from this room by the host.',
        [{ text: 'Exit', onPress: () => router.replace('/home') }]
      );
    };
    const onRoomDeleted = (data: { roomId?: string; reason?: string }) => {
      Alert.alert(
        'Room Ended',
        data?.reason || 'The host has ended and deleted this room.',
        [{ text: 'OK', onPress: () => router.replace('/home') }]
      );
    };
    const onReconnect = () => { joinPresence(); setVoiceEpoch(current => current + 1); };
    const joinPresence = () => {
      if (!live || !active) return;
      live.timeout(8000).emit('room:join', {
        room: roomKind,
        avatar,
        groupId: params.groupId,
        roomId: params.roomId,
        motionProtocol: 2,
      }, (error: Error | null, result?: { ok: boolean; value?: RoomJoin; error?: string }) => {
        if (!active) return;
        if (error || !result?.ok || !result.value) {
          const errMsg = result?.error || 'Could not join room chat.';
          setChatError(errMsg);
          if (errMsg.includes('Only members')) {
            Alert.alert('Access Denied', errMsg, [
              { text: 'OK', onPress: () => router.replace('/home') }
            ]);
          }
          return;
        }
        motions.clear();
        usersByMotionId.clear();
        sequencesByMotionId.clear();
        motionProtocol.current = result.value.motionProtocol === 2;
        setMotionV2(motionProtocol.current);
        for (const peer of result.value.peers) {
          motions.set(peer.userId, { peer, receivedAt: Date.now() });
          if (peer.motionId !== undefined) usersByMotionId.set(peer.motionId, peer.userId);
        }
        setPeers(result.value.peers);
        setMessages(result.value.messages);
        if (result.value.shardId) setShardId(result.value.shardId);
        if (result.value.ownerId) setRoomOwnerId(result.value.ownerId);
        if (result.value.shardIndex) {
          setShardIndex(result.value.shardIndex);
          const baseLabel = roomKind === 'beach' ? 'Goa Beach' : roomKind === 'tea' ? 'Tea Party' : roomKind === 'roof' ? 'Rooftop' : 'Loft 16';
          const label = params.groupId ? (params.groupName ? `${params.groupName} Hangout` : 'Group Hangout') : `${baseLabel} #${result.value.shardIndex}`;
          const count = result.value.totalInShard ?? (result.value.peers.length + 1);
          showRouteToast(`🌴 ${label} • ${count} online`);
        }
        if (result.value.radio) {
          MusicService.setRadioEnabled(result.value.radio.enabled, true);
          MusicService.playRadioTrack(result.value.radio.trackIndex);
        }
        setChatError('');
        onPosition(positionRef.current);
      });
    };
    void getRealtimeSocket().then(socket => {
      if (!active) return;
      live = socket;
      presenceRef.current = socket;
      socket.on('room:peer', onPeer);
      socket.on('room:motion-batch', onMotionBatch);
      socket.on('room:peer-left', onLeft);
      socket.on('room:message', onMessage);
      socket.on('room:radio-sync', onRadioSync);
      socket.on('room:kicked', onKicked);
      socket.on('room:deleted', onRoomDeleted);
      socket.on('connect', onReconnect);
      joinPresence();
    }).catch(error => { if (active) setChatError(error instanceof Error ? error.message : 'Room chat offline.'); });
    return () => {
      active = false;
      MusicService.stopAll();
      live?.off('room:peer', onPeer);
      live?.off('room:motion-batch', onMotionBatch);
      live?.off('room:peer-left', onLeft);
      live?.off('room:message', onMessage);
      live?.off('room:radio-sync', onRadioSync);
      live?.off('room:kicked', onKicked);
      live?.off('room:deleted', onRoomDeleted);
      live?.off('connect', onReconnect);
      live?.emit('room:leave');
      motions.clear();
      usersByMotionId.clear();
      sequencesByMotionId.clear();
      motionProtocol.current = false;
      setMotionV2(false);
      setPeers([]);
      if (presenceRef.current === live) presenceRef.current = null;
    };
  }, [roomKind, username, avatar, focused, showRouteToast, onPosition, params.groupId, params.roomId, params.groupName]);

  // Pause background music when the app is minimized to prevent audio stream conflicts
  useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      if (state === 'background' || state === 'inactive') {
        MusicService.pauseAll();
      }
    });
    return () => sub.remove();
  }, []);

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
    void media.join({ kind: 'room', id: activeRoomId }, false, positionRef.current).then(() => {
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
  }, [activeRoomId, username, voiceEpoch, focused, applyAudioRoute]);

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
    {landscapeReady && (width >= height || orientationFailed) && <GameRoom key={`${roomKind}-${roomAvatar.body}`} roomKind={roomKind} avatar={roomAvatar} peers={peers} peerMotionsRef={peerMotions} motionV2={motionV2} onPosition={onPosition} onPortal={() => setRoomKind(current => current === 'roof' ? 'loft' : 'roof')} onOpenRadio={() => { setMusicModalTab('radio'); setMusicModalOpen(true); }} />}
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
      <View style={styles.roomIdentity}>
        <View style={styles.roomIdentityHeader}>
          <Text style={styles.title} numberOfLines={1}>
            {params.groupId
              ? (params.groupName ? `${params.groupName} Hangout` : 'Group Hangout')
              : (roomKind === 'beach' ? 'Goa Beach' : roomKind === 'tea' ? 'Tea Party' : roomKind === 'roof' ? 'School Rooftop' : 'Loft 16')}
          </Text>
          {isOwner && (
            <View style={styles.hostBadgeSmall}>
              <Crown size={11} color="#F59E0B" />
              <Text style={styles.hostBadgeSmallText}>Host</Text>
            </View>
          )}
        </View>
        <Text style={styles.roomStatus} numberOfLines={1}>{voiceStatus}{nearbySpeakers ? ` · ${nearbySpeakers} nearby` : ''}</Text>
      </View>
    </View>
    {!!routeToast && (
      <View style={[styles.routeToastPill, { top: Math.max(56, insets.top + 52) }]} pointerEvents="none">
        <Text style={styles.routeToastText}>{routeToast}</Text>
      </View>
    )}
    {roomMenuOpen && <View style={[styles.playersPanel, { left: Math.max(16, insets.left + 8), top: Math.max(66, insets.top + 62) }]}>
      <Text style={styles.panelTitle}>
        {params.groupId
          ? (params.groupName ? `${params.groupName} Hangout` : 'Group Hangout')
          : (roomKind === 'beach' ? 'Goa Beach' : roomKind === 'tea' ? 'Tea Party' : roomKind === 'roof' ? 'School Rooftop' : 'Loft 16')}
      </Text>
      <Text style={styles.roomMenuStatus}>{voiceStatus}</Text>
      <View style={styles.roomMenuButtonsRow}>
        <Pressable accessibilityRole="button" accessibilityLabel={roomKind === 'roof' ? 'Back to Loft' : 'Exit room'} onPress={() => roomKind === 'roof' ? setRoomKind('loft') : router.replace('/home')} style={styles.roomMenuExit}>
          <Text style={styles.roomMenuExitText}>{roomKind === 'roof' ? 'Back to Loft' : 'Exit room'}</Text>
        </Pressable>
        {isOwner && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Delete and end room"
            onPress={handleDeleteRoom}
            style={styles.roomMenuDelete}
          >
            <Trash2 size={13} color="#FF6B6B" />
            <Text style={styles.roomMenuDeleteText}>Delete Room</Text>
          </Pressable>
        )}
      </View>
    </View>}
    {playersOpen && <View style={[styles.playersPanel, { left: Math.max(16, insets.left + 8), top: Math.max(66, insets.top + 62) }]}>
      <View style={styles.playersPanelHeader}>
        <Text style={styles.panelTitle}>Players ({peers.length + 1})</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Invite members or friends"
          onPress={() => { setPlayersOpen(false); void openInviteModal(); }}
          style={styles.inviteButtonSmall}
        >
          <UserPlus size={13} color="#00E5FF" />
          <Text style={styles.inviteButtonSmallText}>Invite</Text>
        </Pressable>
      </View>
      <ScrollView style={styles.playersList}>
        <View style={styles.playerRow}>
          <View style={styles.playerNameCol}>
            <Text style={styles.playerName}>You</Text>
            {isOwner && (
              <View style={styles.ownerBadge}>
                <Crown size={10} color="#F59E0B" />
                <Text style={styles.ownerBadgeText}>Host</Text>
              </View>
            )}
          </View>
          <Text style={styles.playerMeta}>{micMuted ? 'Mic muted' : 'Mic on'}</Text>
        </View>
        {peers.map(peer => {
          const isPeerOwner = peer.userId === roomOwnerId;
          return (
            <View key={peer.userId} style={styles.playerRow}>
              <View style={styles.playerNameCol}>
                <Text style={styles.playerName} numberOfLines={1}>{peer.name}</Text>
                {isPeerOwner && (
                  <View style={styles.ownerBadge}>
                    <Crown size={10} color="#F59E0B" />
                    <Text style={styles.ownerBadgeText}>Host</Text>
                  </View>
                )}
              </View>
              <View style={styles.peerActions}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${mutedPeers.has(peer.userId) ? 'Unmute' : 'Mute'} ${peer.name} for me`}
                  onPress={() => togglePeerSpeaker(peer.userId)}
                  style={styles.peerMute}
                >
                  {mutedPeers.has(peer.userId) ? <VolumeX size={17} color={colors.amber} /> : <Volume2 size={17} color="#F7FAF8" />}
                </Pressable>
                {isOwner && (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Kick ${peer.name}`}
                    onPress={() => handleKickPeer(peer)}
                    style={styles.peerKick}
                  >
                    <UserX size={15} color="#FF6B6B" />
                  </Pressable>
                )}
              </View>
            </View>
          );
        })}
        {!peers.length && <Text style={styles.emptyPlayers}>No one else is here yet.</Text>}
      </ScrollView>
      {isOwner && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="End and delete room"
          onPress={handleDeleteRoom}
          style={styles.playersDeleteRoomBtn}
        >
          <Trash2 size={12} color="#FF6B6B" />
          <Text style={styles.playersDeleteRoomBtnText}>End & Delete Room</Text>
        </Pressable>
      )}
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
    <Modal
      visible={inviteModalOpen}
      animationType="fade"
      transparent
      onRequestClose={() => setInviteModalOpen(false)}
    >
      <View style={styles.inviteModalOverlay}>
        <View style={styles.inviteModalCard}>
          <View style={styles.inviteModalHeader}>
            <View>
              <Text style={styles.inviteModalTitle}>Invite to Hangout</Text>
              <Text style={styles.inviteModalSubtitle}>
                {params.groupName ? `Room: ${params.groupName}` : 'Invite friends or groups'}
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close invite modal"
              onPress={() => setInviteModalOpen(false)}
              style={styles.modalCloseButton}
            >
              <X size={18} color="#F7FAF8" />
            </Pressable>
          </View>

          <View style={styles.inviteTabsRow}>
            {Boolean(params.groupId) && (
              <Pressable
                onPress={() => setInviteTab('members')}
                style={[styles.inviteTabBtn, inviteTab === 'members' && styles.inviteTabBtnActive]}
              >
                <Text style={[styles.inviteTabBtnText, inviteTab === 'members' && styles.inviteTabBtnTextActive]}>
                  Group Members
                </Text>
              </Pressable>
            )}
            <Pressable
              onPress={() => setInviteTab('friends')}
              style={[styles.inviteTabBtn, inviteTab === 'friends' && styles.inviteTabBtnActive]}
            >
              <Text style={[styles.inviteTabBtnText, inviteTab === 'friends' && styles.inviteTabBtnTextActive]}>
                Friends ({contacts.length})
              </Text>
            </Pressable>
            <Pressable
              onPress={() => setInviteTab('groups')}
              style={[styles.inviteTabBtn, inviteTab === 'groups' && styles.inviteTabBtnActive]}
            >
              <Text style={[styles.inviteTabBtnText, inviteTab === 'groups' && styles.inviteTabBtnTextActive]}>
                Other Groups
              </Text>
            </Pressable>
          </View>

          {loadingMembers ? (
            <View style={styles.inviteLoadingState}>
              <ActivityIndicator size="small" color="#00E5FF" />
              <Text style={styles.inviteLoadingText}>Loading…</Text>
            </View>
          ) : (
            <ScrollView style={styles.inviteMemberList}>
              {inviteTab === 'members' && (() => {
                const inRoomIds = new Set([currentUserId, ...peers.map(p => p.userId)]);
                const eligible = groupMembers.filter(m => !inRoomIds.has(m.id));

                if (!eligible.length) {
                  return (
                    <Text style={styles.inviteEmptyText}>
                      Everyone in this group is already in the room!
                    </Text>
                  );
                }

                return eligible.map(member => {
                  const isInvited = invitedIds.has(member.id);
                  const isPending = invitingId === member.id;

                  return (
                    <View key={member.id} style={styles.inviteMemberRow}>
                      <View style={styles.inviteMemberAvatarWrap}>
                        {member.avatarUrl ? (
                          <Image source={{ uri: member.avatarUrl }} style={styles.inviteMemberAvatar} />
                        ) : (
                          <View style={styles.inviteMemberAvatarFallback}>
                            <Text style={styles.inviteMemberAvatarFallbackText}>
                              {member.name.slice(0, 1).toUpperCase()}
                            </Text>
                          </View>
                        )}
                      </View>
                      <View style={styles.inviteMemberInfo}>
                        <Text style={styles.inviteMemberName} numberOfLines={1}>{member.name}</Text>
                        <Text style={styles.inviteMemberUsername} numberOfLines={1}>@{member.username}</Text>
                      </View>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={isInvited ? `Invited ${member.name}` : `Invite ${member.name}`}
                        disabled={isInvited || isPending}
                        onPress={() => void handleInviteMember(member.id, member.name)}
                        style={[
                          styles.inviteActionButton,
                          isInvited && styles.inviteActionButtonSent,
                        ]}
                      >
                        {isPending ? (
                          <ActivityIndicator size="small" color="#00E5FF" />
                        ) : isInvited ? (
                          <>
                            <Check size={13} color="#34D399" />
                            <Text style={styles.inviteActionButtonSentText}>Invited</Text>
                          </>
                        ) : (
                          <>
                            <UserPlus size={13} color="#F7FAF8" />
                            <Text style={styles.inviteActionButtonText}>Invite</Text>
                          </>
                        )}
                      </Pressable>
                    </View>
                  );
                });
              })()}

              {inviteTab === 'friends' && (() => {
                const inRoomIds = new Set([currentUserId, ...peers.map(p => p.userId)]);
                const eligible = contacts.filter(c => !inRoomIds.has(c.id));

                if (!eligible.length) {
                  return (
                    <Text style={styles.inviteEmptyText}>
                      {contacts.length === 0 ? 'No friends on your friend list yet.' : 'All your friends are already in this room!'}
                    </Text>
                  );
                }

                return eligible.map(friend => {
                  const isInvited = invitedIds.has(friend.id);
                  const isPending = invitingId === friend.id;

                  return (
                    <View key={friend.id} style={styles.inviteMemberRow}>
                      <View style={styles.inviteMemberAvatarWrap}>
                        {friend.avatarUrl ? (
                          <Image source={{ uri: friend.avatarUrl }} style={styles.inviteMemberAvatar} />
                        ) : (
                          <View style={styles.inviteMemberAvatarFallback}>
                            <Text style={styles.inviteMemberAvatarFallbackText}>
                              {friend.name.slice(0, 1).toUpperCase()}
                            </Text>
                          </View>
                        )}
                      </View>
                      <View style={styles.inviteMemberInfo}>
                        <Text style={styles.inviteMemberName} numberOfLines={1}>{friend.name}</Text>
                        <Text style={styles.inviteMemberUsername} numberOfLines={1}>@{friend.username}</Text>
                      </View>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={isInvited ? `Invited ${friend.name}` : `Invite ${friend.name}`}
                        disabled={isInvited || isPending}
                        onPress={() => void handleInviteMember(friend.id, friend.name)}
                        style={[
                          styles.inviteActionButton,
                          isInvited && styles.inviteActionButtonSent,
                        ]}
                      >
                        {isPending ? (
                          <ActivityIndicator size="small" color="#00E5FF" />
                        ) : isInvited ? (
                          <>
                            <Check size={13} color="#34D399" />
                            <Text style={styles.inviteActionButtonSentText}>Invited</Text>
                          </>
                        ) : (
                          <>
                            <UserPlus size={13} color="#F7FAF8" />
                            <Text style={styles.inviteActionButtonText}>Invite</Text>
                          </>
                        )}
                      </Pressable>
                    </View>
                  );
                });
              })()}

              {inviteTab === 'groups' && (() => {
                const eligible = myGroups.filter(g => g.id !== params.groupId);

                if (!eligible.length) {
                  return (
                    <Text style={styles.inviteEmptyText}>
                      No other groups available to invite.
                    </Text>
                  );
                }

                return eligible.map(group => {
                  const isInvited = invitedGroupIds.has(group.id);
                  const isPending = invitingGroupId === group.id;

                  return (
                    <View key={group.id} style={styles.inviteMemberRow}>
                      <View style={styles.inviteMemberAvatarWrap}>
                        {group.avatarUrl ? (
                          <Image source={{ uri: group.avatarUrl }} style={styles.inviteMemberAvatar} />
                        ) : (
                          <View style={[styles.inviteMemberAvatarFallback, { backgroundColor: '#18384C' }]}>
                            <Users size={15} color="#00E5FF" />
                          </View>
                        )}
                      </View>
                      <View style={styles.inviteMemberInfo}>
                        <Text style={styles.inviteMemberName} numberOfLines={1}>{group.name}</Text>
                        <Text style={styles.inviteMemberUsername} numberOfLines={1}>
                          {group.memberCount} member{group.memberCount === 1 ? '' : 's'}
                        </Text>
                      </View>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={isInvited ? `Invited ${group.name}` : `Invite ${group.name}`}
                        disabled={isInvited || isPending}
                        onPress={() => void handleInviteGroup(group.id, group.name)}
                        style={[
                          styles.inviteActionButton,
                          isInvited && styles.inviteActionButtonSent,
                        ]}
                      >
                        {isPending ? (
                          <ActivityIndicator size="small" color="#00E5FF" />
                        ) : isInvited ? (
                          <>
                            <Check size={13} color="#34D399" />
                            <Text style={styles.inviteActionButtonSentText}>Invited</Text>
                          </>
                        ) : (
                          <>
                            <Users size={13} color="#F7FAF8" />
                            <Text style={styles.inviteActionButtonText}>Invite Group</Text>
                          </>
                        )}
                      </Pressable>
                    </View>
                  );
                });
              })()}
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  </View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  topBar: { position: 'absolute', top: 8, left: 16, right: 16, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 },
  roomIdentity: { maxWidth: 220, backgroundColor: '#10221DCF', borderRadius: 14, paddingHorizontal: 12, paddingVertical: 8 },
  roomIdentityHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  hostBadgeSmall: { flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: '#F59E0B26', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8 },
  hostBadgeSmallText: { color: '#F59E0B', fontSize: 9, fontWeight: '800' },
  title: { color: '#F7FAF8', fontSize: 15, fontWeight: '800', flexShrink: 1 },
  roomStatus: { color: '#C9DED2', fontSize: 10, marginTop: 2 },
  toolbar: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#10221DE8', borderRadius: 18, padding: 4, gap: 2 },
  toolButton: { width: 42, height: 42, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  toolButtonOff: { backgroundColor: '#A74141' },
  toolButtonActive: { backgroundColor: '#277A55' },
  toolButtonNormalSpeaker: { backgroundColor: '#1B4D68' },
  routeToastPill: { position: 'absolute', alignSelf: 'center', backgroundColor: '#10221DF2', borderWidth: 1, borderColor: '#FFFFFF33', borderRadius: 20, paddingHorizontal: 16, paddingVertical: 7, zIndex: 999 },
  routeToastText: { color: '#F7FAF8', fontSize: 12, fontWeight: '700' },
  playerCount: { position: 'absolute', right: 2, top: 1, color: '#F7FAF8', fontSize: 9, fontWeight: '800' },
  playersPanel: { position: 'absolute', width: 260, maxHeight: 240, backgroundColor: '#10221DF2', borderRadius: 16, padding: 13, gap: 5 },
  playersPanelHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  inviteButtonSmall: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#00E5FF1F', borderWidth: 1, borderColor: '#00E5FF44', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 },
  inviteButtonSmallText: { color: '#00E5FF', fontSize: 11, fontWeight: '700' },
  playersList: { maxHeight: 185 },
  panelTitle: { color: '#F7FAF8', fontSize: 13, fontWeight: '800' },
  roomMenuStatus: { color: '#A7B6AC', fontSize: 11, marginBottom: 8 },
  roomMenuButtonsRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  roomMenuExit: { alignSelf: 'flex-start', backgroundColor: '#FFFFFF1A', borderRadius: 9, paddingHorizontal: 12, paddingVertical: 8 },
  roomMenuExitText: { color: '#F7FAF8', fontSize: 12, fontWeight: '700' },
  roomMenuDelete: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: '#FF6B6B22', borderWidth: 1, borderColor: '#FF6B6B44', borderRadius: 9, paddingHorizontal: 10, paddingVertical: 8 },
  roomMenuDeleteText: { color: '#FF6B6B', fontSize: 11, fontWeight: '800' },
  playersDeleteRoomBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: '#FF6B6B22', borderWidth: 1, borderColor: '#FF6B6B44', borderRadius: 9, paddingVertical: 7, marginTop: 8 },
  playersDeleteRoomBtnText: { color: '#FF6B6B', fontSize: 11, fontWeight: '800' },
  playerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 34, gap: 8 },
  playerNameCol: { flexDirection: 'row', alignItems: 'center', gap: 5, flex: 1 },
  ownerBadge: { flexDirection: 'row', alignItems: 'center', gap: 2, backgroundColor: '#F59E0B22', paddingHorizontal: 5, paddingVertical: 1, borderRadius: 6 },
  ownerBadgeText: { color: '#F59E0B', fontSize: 9, fontWeight: '800' },
  playerName: { color: '#F7FAF8', fontSize: 12, fontWeight: '700', flexShrink: 1 },
  playerMeta: { color: '#A7B6AC', fontSize: 10 },
  peerActions: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  peerMute: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center', borderRadius: 8, backgroundColor: '#FFFFFF1A' },
  peerKick: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center', borderRadius: 8, backgroundColor: '#FF6B6B22' },
  emptyPlayers: { color: '#A7B6AC', fontSize: 11 },
  chatPanel: { position: 'absolute', width: 300, height: 220, backgroundColor: '#10221DF2', borderRadius: 16, padding: 12 },
  chatTitle: { color: '#F7FAF8', fontWeight: '800', marginBottom: 6 }, chatList: { flex: 1 },
  chatMessage: { color: '#F7FAF8', fontSize: 12, marginVertical: 3 }, chatName: { fontWeight: '800', color: '#EFC37C' },
  chatError: { color: '#FFAAA8', fontSize: 11 }, chatInputRow: { flexDirection: 'row', alignItems: 'center', gap: 8, borderTopWidth: 1, borderColor: '#FFFFFF33' },
  chatInput: { flex: 1, height: 38, color: '#F7FAF8', fontSize: 12 },
  inviteModalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', alignItems: 'center', padding: 16 },
  inviteModalCard: { width: '85%', maxWidth: 440, maxHeight: 290, backgroundColor: '#10221DF8', borderRadius: 20, borderWidth: 1, borderColor: '#FFFFFF22', padding: 16 },
  inviteModalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10, borderBottomWidth: 1, borderColor: '#FFFFFF1A', paddingBottom: 8 },
  inviteModalTitle: { color: '#F7FAF8', fontSize: 15, fontWeight: '800' },
  inviteModalSubtitle: { color: '#A7B6AC', fontSize: 11, marginTop: 2 },
  modalCloseButton: { width: 30, height: 30, borderRadius: 15, backgroundColor: '#FFFFFF1A', alignItems: 'center', justifyContent: 'center' },
  inviteTabsRow: { flexDirection: 'row', gap: 6, marginBottom: 10 },
  inviteTabBtn: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, backgroundColor: '#FFFFFF14' },
  inviteTabBtnActive: { backgroundColor: '#00E5FF26', borderWidth: 1, borderColor: '#00E5FF66' },
  inviteTabBtnText: { color: '#A7B6AC', fontSize: 11, fontWeight: '700' },
  inviteTabBtnTextActive: { color: '#00E5FF', fontSize: 11, fontWeight: '800' },
  inviteLoadingState: { paddingVertical: 28, alignItems: 'center', justifyContent: 'center', gap: 8 },
  inviteLoadingText: { color: '#A7B6AC', fontSize: 12 },
  inviteMemberList: { maxHeight: 180 },
  inviteMemberRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, gap: 10, borderBottomWidth: 1, borderColor: '#FFFFFF0F' },
  inviteMemberAvatarWrap: { width: 32, height: 32, borderRadius: 16, overflow: 'hidden' },
  inviteMemberAvatar: { width: '100%', height: '100%' },
  inviteMemberAvatarFallback: { width: '100%', height: '100%', backgroundColor: '#204035', alignItems: 'center', justifyContent: 'center' },
  inviteMemberAvatarFallbackText: { color: '#F7FAF8', fontSize: 12, fontWeight: '800' },
  inviteMemberInfo: { flex: 1 },
  inviteMemberName: { color: '#F7FAF8', fontSize: 12, fontWeight: '700' },
  inviteMemberUsername: { color: '#A7B6AC', fontSize: 10 },
  inviteActionButton: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#00E5FF26', borderWidth: 1, borderColor: '#00E5FF66', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 },
  inviteActionButtonSent: { backgroundColor: '#34D3991A', borderColor: '#34D39944' },
  inviteActionButtonText: { color: '#F7FAF8', fontSize: 11, fontWeight: '700' },
  inviteActionButtonSentText: { color: '#34D399', fontSize: 11, fontWeight: '700' },
  inviteEmptyText: { color: '#A7B6AC', fontSize: 12, textAlign: 'center', paddingVertical: 24 },
});
