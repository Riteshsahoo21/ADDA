import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, BackHandler, DeviceEventEmitter, Image, KeyboardAvoidingView, Modal, PermissionsAndroid, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ScreenOrientation from 'expo-screen-orientation';
import { NavigationBar } from 'expo-navigation-bar';
import { router, useIsFocused, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { Check, Crown, Headphones, House, MessageCircle, Mic, MicOff, Music, Send, Trash2, UserPlus, Users, UserX, Volume1, Volume2, VolumeX, X } from 'lucide-react-native';
import { GameRoom } from '@/components/room/GameRoom';
import { ReportUser } from '@/components/safety/ReportUser';
import InCallManager from 'react-native-incall-manager';
import {
  mediaDevices,
  RTCIceCandidate,
  RTCPeerConnection,
  RTCSessionDescription,
  type MediaStream,
} from 'react-native-webrtc';
import { RoomKind } from '@/three/environment/createGameScene';
import { colors } from '@/constants/theme';
import { useSession } from '@/context/session';
import { AvatarBody } from '@/three/player/avatarStyle';
import { getRealtimeSocket } from '@/lib/realtime';
import { deleteCurrentRoom, inviteGroupToRoom, inviteToRoom, kickRoomPeer, sendRoomMessage, type PlayerSnapshot, type RoomJoin, type RoomMessage, type RoomMotionSnapshot, type RoomPeer } from '@/lib/rooms';
import { MusicHubModal } from '@/components/music/MusicHubModal';
import { MusicService } from '@/audio/MusicService';
import { SoundEffects } from '@/audio/SoundEffects';
import { getActiveUserId, sendEncryptedMessage, type RoomCardPayload } from '@/lib/encrypted-chat';
import { socialApi, type ChatGroup, type GroupDetails, type GroupMember, type PublicProfile, type SocialBundle } from '@/lib/social-api';

const avatarBodies = new Set(['man', 'uncle', 'photo_boy', 'self', 'woman', 'chinese_woman', 'nepali_woman', 'white_top_woman']);

const DEFAULT_ROOM_ICE_SERVERS = [
  { urls: ['stun:191.215.37.241:3478', 'stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

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
    roomName?: string;
    isPrivate?: string;
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
  const chatOpenRef = useRef(chatOpen);
  useEffect(() => {
    chatOpenRef.current = chatOpen;
  }, [chatOpen]);
  const [playersOpen, setPlayersOpen] = useState(false);
  const [roomMenuOpen, setRoomMenuOpen] = useState(false);
  const [musicModalOpen, setMusicModalOpen] = useState(false);
  const [musicModalTab, setMusicModalTab] = useState<'headphones' | 'radio'>('headphones');
  const [chatText, setChatText] = useState('');
  const [chatError, setChatError] = useState('');
  const [messages, setMessages] = useState<RoomMessage[]>([]);
  const [peers, setPeers] = useState<RoomPeer[]>([]);
  const [reportPeer, setReportPeer] = useState<{ userId: string; name: string; kind: 'user' | 'room'; evidenceText?: string; messageId?: string } | null>(null);
  const blockedPeersRef = useRef(new Set<string>());
  const peerSnapshots = useRef(new Map<string, PlayerSnapshot[]>());
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

  const localStreamRef = useRef<MediaStream | null>(null);
  const roomPeersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const remoteStreamsRef = useRef<Map<string, MediaStream>>(new Map());
  const pendingIceCandidatesRef = useRef<Map<string, RTCIceCandidate[]>>(new Map());
  const latestRemote = useRef(new Map<string, PlayerSnapshot>());
  const volumeSentAt = useRef(0);
  const micMutedRef = useRef(false);
  const speakerMutedRef = useRef(false);
  const isBluetoothRef = useRef(false);
  const isWiredRef = useRef(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mutedPeersRef = useRef<Set<string>>(new Set());
  const presenceRef = useRef<Awaited<ReturnType<typeof getRealtimeSocket>> | null>(null);
  const positionRef = useRef<RoomMotionSnapshot>({ x: 0, y: 0, z: 0, yaw: 0, vx: 0, vz: 0, pose: 'idle' });
  const lastMotionSentAt = useRef(0);
  const lastMotionSnapshot = useRef<{ x: number; z: number; r: number; pose: string } | null>(null);

  const roomIceServersRef = useRef<any[]>(DEFAULT_ROOM_ICE_SERVERS);
  const peersRef = useRef<RoomPeer[]>([]);

  useEffect(() => {
    void socialApi<{ iceServers: any[] }>('/calls/ice').then(res => {
      if (res?.iceServers?.length) roomIceServersRef.current = res.iceServers;
    }).catch(() => {});
  }, []);

  const getOrCreateRoomPeer = useCallback(async (peerUserId: string, isInitiator: boolean) => {
    let peer = roomPeersRef.current.get(peerUserId);
    if (peer) return peer;

    peer = new RTCPeerConnection({ iceServers: roomIceServersRef.current });
    roomPeersRef.current.set(peerUserId, peer);

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => {
        try {
          peer!.addTrack(track, localStreamRef.current!);
        } catch (e) {
          console.warn('[ADDA Room Voice] addTrack error:', e);
        }
      });
    }

    const listen = peer as unknown as { addEventListener: (type: string, listener: any) => void };
    listen.addEventListener('icecandidate', (event: any) => {
      if (event.candidate) {
        const cand = typeof event.candidate.toJSON === 'function' ? event.candidate.toJSON() : event.candidate;
        presenceRef.current?.emit('room:signal', { to: peerUserId, signal: { candidate: cand } });
      }
    });

    listen.addEventListener('track', (event: any) => {
      const stream = event.streams?.[0];
      if (stream) {
        remoteStreamsRef.current.set(peerUserId, stream);
        const other = latestRemote.current.get(peerUserId);
        const myPos = positionRef.current;
        const dist = other ? Math.hypot(other.x - myPos.x, other.z - myPos.z) : 0;
        const isMuted = speakerMutedRef.current || mutedPeersRef.current.has(peerUserId) || blockedPeersRef.current.has(peerUserId) || dist > 15;
        stream.getAudioTracks().forEach((t: any) => {
          try { t.enabled = !isMuted; } catch {}
        });
      }
    });

    listen.addEventListener('connectionstatechange', () => {
      if (peer!.connectionState === 'connected') {
        setVoiceStatus('Nearby voice on');
      }
    });

    if (isInitiator) {
      try {
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        presenceRef.current?.emit('room:signal', {
          to: peerUserId,
          signal: { type: 'offer', sdp: offer.sdp ?? '' },
        });
      } catch (err) {
        console.warn('[ADDA Room Voice] Offer failed for peer:', peerUserId, err);
      }
    }

    return peer;
  }, []);

  const closePeer = useCallback((peerUserId: string) => {
    const pc = roomPeersRef.current.get(peerUserId);
    if (pc) {
      try {
        (pc as any).onicecandidate = null;
        (pc as any).ontrack = null;
        (pc as any).onconnectionstatechange = null;
        (pc as any).onsignalingstatechange = null;
        (pc as any).oniceconnectionstatechange = null;
        pc.close();
      } catch (e) {
        console.warn('[ADDA Room Voice] error closing peer', e);
      }
      roomPeersRef.current.delete(peerUserId);
    }
    const remoteStream = remoteStreamsRef.current.get(peerUserId);
    if (remoteStream) {
      try {
        remoteStream.getTracks().forEach((t: any) => {
          try { t.stop(); } catch {}
        });
      } catch {}
      remoteStreamsRef.current.delete(peerUserId);
    }
    pendingIceCandidatesRef.current.delete(peerUserId);
  }, []);

  const onRoomSignal = useCallback(async (event: { from: string; signal: any }) => {
    try {
      const { from, signal } = event;
      if (!from || !signal || blockedPeersRef.current.has(from)) return;

      if (signal.candidate) {
        const candidate = new RTCIceCandidate(signal.candidate);
        const peer = roomPeersRef.current.get(from);
        if (peer && peer.remoteDescription) {
          await peer.addIceCandidate(candidate).catch(() => {});
        } else {
          if (!pendingIceCandidatesRef.current.has(from)) pendingIceCandidatesRef.current.set(from, []);
          pendingIceCandidatesRef.current.get(from)!.push(candidate);
        }
        return;
      }

      if (signal.type === 'offer') {
        let peer = roomPeersRef.current.get(from);
        if (!peer) {
          peer = await getOrCreateRoomPeer(from, false);
        }
        if (!peer) return;
        await peer.setRemoteDescription(new RTCSessionDescription(signal));
        const pending = pendingIceCandidatesRef.current.get(from) || [];
        pendingIceCandidatesRef.current.delete(from);
        for (const c of pending) await peer.addIceCandidate(c).catch(() => {});
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        presenceRef.current?.emit('room:signal', {
          to: from,
          signal: { type: 'answer', sdp: answer.sdp ?? '' },
        });
        return;
      }

      if (signal.type === 'answer') {
        const peer = roomPeersRef.current.get(from);
        if (peer && peer.signalingState === 'have-local-offer') {
          await peer.setRemoteDescription(new RTCSessionDescription(signal));
          const pending = pendingIceCandidatesRef.current.get(from) || [];
          pendingIceCandidatesRef.current.delete(from);
          for (const c of pending) await peer.addIceCandidate(c).catch(() => {});
        }
        return;
      }
    } catch (err) {
      console.warn('[ADDA Room Voice] onRoomSignal error:', err);
    }
  }, [getOrCreateRoomPeer]);

  const onVoiceReady = useCallback((data: { from: string }) => {
    if (!data?.from || !currentUserId || blockedPeersRef.current.has(data.from)) return;
    if (currentUserId < data.from) {
      void getOrCreateRoomPeer(data.from, true);
    } else {
      void getOrCreateRoomPeer(data.from, false);
    }
  }, [currentUserId, getOrCreateRoomPeer]);

  const onSnapshot = useCallback((snapshot: PlayerSnapshot) => {
    if (blockedPeersRef.current.has(snapshot.id)) return;
    latestRemote.current.set(snapshot.id, snapshot);
    const queues = peerSnapshots.current;
    let queue = queues.get(snapshot.id);
    if (!queue) { queue = []; queues.set(snapshot.id, queue); }
    queue.push(snapshot);
    if (queue.length > 25) queue.shift();
  }, []);

  useEffect(() => {
    void socialApi<{ id: string }[]>('/safety/blocks').then(blocks => {
      blockedPeersRef.current = new Set(blocks.map(block => block.id));
      setPeers(current => current.filter(peer => !blockedPeersRef.current.has(peer.userId)));
      setMessages(current => current.filter(message => !blockedPeersRef.current.has(message.userId)));
      for (const id of blockedPeersRef.current) {
        const stream = remoteStreamsRef.current.get(id);
        if (stream) stream.getAudioTracks().forEach((t: any) => {
          try { t.enabled = false; } catch {}
        });
      }
    }).catch(() => {});
  }, []);

  const onPosition = useCallback((snapshot: RoomMotionSnapshot) => {
    positionRef.current = snapshot;

    // Send movement at ideal 10Hz (every 100ms) with delta-thresholding directly over reliable WebSocket
    const now = Date.now();
    const last = lastMotionSnapshot.current;
    const distMoved = last ? Math.hypot(snapshot.x - last.x, snapshot.z - last.z) : 1;
    const rotChanged = last ? Math.abs(snapshot.yaw - last.r) : 1;
    const poseChanged = !last || snapshot.pose !== last.pose;
    const timeElapsed = now - lastMotionSentAt.current;

    if (poseChanged || distMoved > 0.03 || rotChanged > 0.03 || timeElapsed >= 1000) {
      if (timeElapsed >= 90 || poseChanged) {
        lastMotionSentAt.current = now;
        lastMotionSnapshot.current = { x: snapshot.x, z: snapshot.z, r: snapshot.yaw, pose: snapshot.pose };
        presenceRef.current?.emit('room:snapshot', {
          x: Number(snapshot.x.toFixed(3)),
          y: Number(snapshot.y.toFixed(3)),
          z: Number(snapshot.z.toFixed(3)),
          r: Number(snapshot.yaw.toFixed(3)),
          pose: snapshot.pose,
        });
      }
    }

    // Spatial audio proximity cutoff (checked every 200ms)
    if (Date.now() - volumeSentAt.current >= 200) {
      volumeSentAt.current = Date.now();
      let audible = 0;
      for (const [id, stream] of remoteStreamsRef.current) {
        const other = latestRemote.current.get(id);
        const distance = other ? Math.hypot(other.x - snapshot.x, other.z - snapshot.z) : 0;
        const isMuted = speakerMutedRef.current || mutedPeersRef.current.has(id) || blockedPeersRef.current.has(id) || distance > 15;
        try {
          stream.getAudioTracks().forEach((track: any) => {
            if (track.enabled !== !isMuted) {
              track.enabled = !isMuted;
            }
          });
        } catch {}
        if (!isMuted && distance <= 15) {
          audible++;
        }
      }
      setNearbySpeakers(prev => (prev !== audible ? audible : prev));
      setVoiceStatus(prev => {
        const next = audible > 0 ? 'Nearby voice on' : 'Voice ready';
        return prev !== next ? next : prev;
      });
    }
  }, []);

  // Room Audio Mesh Lifecycle
  useEffect(() => {
    if (!username || !focused || !shardId || !currentUserId) return;
    let active = true;

    void mediaDevices.getUserMedia({ audio: true, video: false })
      .then(stream => {
        if (!active) {
          stream.getTracks().forEach((t: any) => {
            try { t.stop(); } catch {}
          });
          return;
        }
        localStreamRef.current = stream;
        if (micMutedRef.current) {
          stream.getAudioTracks().forEach((t: any) => {
            try { t.enabled = false; } catch {}
          });
        }
        for (const [, p] of roomPeersRef.current) {
          stream.getTracks().forEach(track => {
            try { p.addTrack(track, stream); } catch {}
          });
        }
        setVoiceStatus('Voice ready');
        presenceRef.current?.emit('room:voice-ready');

        for (const peer of peersRef.current) {
          if (peer.userId !== currentUserId && currentUserId < peer.userId && !blockedPeersRef.current.has(peer.userId)) {
            void getOrCreateRoomPeer(peer.userId, true);
          }
        }
      })
      .catch(err => {
        console.warn('[ADDA Room Voice] Microphone error:', err);
        if (active) setVoiceStatus('Microphone unavailable');
      });

    return () => {
      active = false;
      const peerIds = Array.from(roomPeersRef.current.keys());
      for (const id of peerIds) {
        closePeer(id);
      }
      roomPeersRef.current.clear();
      remoteStreamsRef.current.clear();
      pendingIceCandidatesRef.current.clear();
      latestRemote.current.clear();

      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((t: any) => {
          try { t.stop(); } catch {}
        });
        localStreamRef.current = null;
      }
    };
  }, [username, focused, shardId, currentUserId, getOrCreateRoomPeer, closePeer]);


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

      // Post encrypted room card into DM chat with member
      const effectiveRoomId = params.roomId || (shardId.startsWith('room:') ? shardId.split(':')[1] : '');
      const cardPayload: RoomCardPayload = {
        type: 'room_card',
        roomId: effectiveRoomId,
        roomKind,
        creatorId: roomOwnerId || currentUserId || '',
        creatorName: username || 'Host',
        createdAt: new Date().toISOString(),
        roomName: params.roomName || 'Hangout',
        isPrivate: params.isPrivate === 'true',
      };
      void sendEncryptedMessage(
        { kind: 'direct', id: memberId },
        `__adda_room_card__:${JSON.stringify(cardPayload)}`,
        username || 'Host',
        undefined,
        undefined,
        undefined,
        `🌴 ${username || 'Host'} invited you: ${cardPayload.roomName}`
      ).catch(err => console.warn('[ADDA] Post DM invite card error:', err));
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

      // Post encrypted room card into group chat
      const effectiveRoomId = params.roomId || (shardId.startsWith('room:') ? shardId.split(':')[1] : '');
      const cardPayload: RoomCardPayload = {
        type: 'room_card',
        roomId: effectiveRoomId,
        groupId: targetGroupId,
        groupName,
        roomKind,
        creatorId: roomOwnerId || currentUserId || '',
        creatorName: username || 'Host',
        createdAt: new Date().toISOString(),
        roomName: params.roomName || `${groupName} Hangout`,
        isPrivate: params.isPrivate === 'true',
      };
      void sendEncryptedMessage(
        { kind: 'group', id: targetGroupId },
        `__adda_room_card__:${JSON.stringify(cardPayload)}`,
        username || 'Host',
        undefined,
        undefined,
        undefined,
        `🌴 ${username || 'Host'} invited you: ${cardPayload.roomName}`
      ).catch(err => console.warn('[ADDA] Post group invite card error:', err));
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
    const queues = peerSnapshots.current;
    const onPeer = (peer: RoomPeer) => {
      if (blockedPeersRef.current.has(peer.userId)) return;
      let q = queues.get(peer.userId);
      if (!q) { q = []; queues.set(peer.userId, q); }
      q.push({
        id: peer.userId,
        x: peer.x,
        y: peer.y ?? 0,
        z: peer.z,
        r: peer.yaw,
        pose: peer.pose ?? 'idle',
        time: Date.now(),
      });
      setPeers(current => {
        const exists = current.some(item => item.userId === peer.userId);
        const next = !exists ? [...current, peer] : current.map(item => item.userId === peer.userId ? { ...item, ...peer } : item);
        peersRef.current = next;
        return next;
      });
      latestRemote.current.set(peer.userId, {
        id: peer.userId,
        x: peer.x,
        y: peer.y ?? 0,
        z: peer.z,
        r: peer.yaw,
        pose: peer.pose ?? 'idle',
        time: Date.now(),
      });
      setInvitedIds(current => {
        if (!current.has(peer.userId)) return current;
        const next = new Set(current);
        next.delete(peer.userId);
        return next;
      });
      if (localStreamRef.current && currentUserId && currentUserId < peer.userId && !blockedPeersRef.current.has(peer.userId)) {
        void getOrCreateRoomPeer(peer.userId, true);
      }
    };
    const onLeft = ({ userId }: { userId: string }) => {
      queues.delete(userId);
      setPeers(current => current.filter(peer => peer.userId !== userId));
      setInvitedIds(current => {
        if (!current.has(userId)) return current;
        const next = new Set(current);
        next.delete(userId);
        return next;
      });
      closePeer(userId);
    };
    const onMessage = (message: RoomMessage) => {
      if (!blockedPeersRef.current.has(message.userId)) {
        setMessages(current => [...current, message].slice(-50));
        if (message.userId !== currentUserId && chatOpenRef.current) {
          SoundEffects.playReceived();
        }
      }
    };
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
      }, (error: Error | null, result?: { ok: boolean; value?: RoomJoin; error?: string }) => {
        if (!active) return;
        if (error || !result?.ok || !result.value) {
          const errMsg = result?.error || 'Could not join room chat.';
          setChatError(errMsg);
          if (errMsg.includes('Only members') || errMsg.includes('full')) {
            Alert.alert(errMsg.includes('full') ? 'Server Full' : 'Access Denied', errMsg, [
              { text: 'OK', onPress: () => router.replace('/home') }
            ]);
          }
          return;
        }
        queues.clear();
        for (const peer of result.value.peers) {
          const snap = {
            id: peer.userId,
            x: peer.x,
            y: peer.y ?? 0,
            z: peer.z,
            r: peer.yaw,
            pose: peer.pose ?? 'idle',
            time: Date.now(),
          };
          queues.set(peer.userId, [snap]);
          latestRemote.current.set(peer.userId, snap);
        }
        const validPeers = result.value.peers.filter(peer => !blockedPeersRef.current.has(peer.userId));
        peersRef.current = validPeers;
        setPeers(validPeers);
        setMessages(result.value.messages.filter(message => !blockedPeersRef.current.has(message.userId)));
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
        if (localStreamRef.current && currentUserId) {
          for (const p of result.value.peers) {
            if (p.userId !== currentUserId && currentUserId < p.userId && !blockedPeersRef.current.has(p.userId)) {
              void getOrCreateRoomPeer(p.userId, true);
            }
          }
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
      socket.on('room:peer-left', onLeft);
      socket.on('room:snapshot', onSnapshot);
      socket.on('room:signal', onRoomSignal);
      socket.on('room:voice-ready', onVoiceReady);
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
      live?.off('room:peer-left', onLeft);
      live?.off('room:snapshot', onSnapshot);
      live?.off('room:signal', onRoomSignal);
      live?.off('room:voice-ready', onVoiceReady);
      live?.off('room:message', onMessage);
      live?.off('room:radio-sync', onRadioSync);
      live?.off('room:kicked', onKicked);
      live?.off('room:deleted', onRoomDeleted);
      live?.off('connect', onReconnect);
      live?.emit('room:leave');
      queues.clear();
      setPeers([]);
      if (presenceRef.current === live) presenceRef.current = null;
    };
  }, [roomKind, username, avatar, focused, showRouteToast, onPosition, params.groupId, params.roomId, params.groupName, currentUserId, getOrCreateRoomPeer, onRoomSignal, onVoiceReady]);

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
    try {
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
    } catch (e) {
      console.warn('[ADDA Hangout] applyAudioRoute error:', e);
    }
  }, []);

  useEffect(() => {
    if (!username || !focused || !shardId) return;
    let active = true;

    // 1. Request Bluetooth permission on Android 12+ so InCallManager can start Bluetooth SCO
    if (Platform.OS === 'android' && Number(Platform.Version) >= 31) {
      void PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT).catch(() => {});
    }

    // 2. Ensure speakerphone is active for room spatial audio without stealing exclusive voice call focus
    try {
      InCallManager.setForceSpeakerphoneOn(true);
      InCallManager.setSpeakerphoneOn(true);
    } catch (e) {
      console.warn('[ADDA Hangout] speaker route error:', e);
    }

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

    return () => {
      active = false;
      audioDeviceSub.remove();
      headsetSub.remove();
      try {
        InCallManager.setForceSpeakerphoneOn(false);
        InCallManager.stop();
      } catch (e) {
        console.warn('[ADDA Hangout] InCallManager stop error:', e);
      }
      setNearbySpeakers(0);
    };
  }, [shardId, username, focused, applyAudioRoute]);

  const toggleMic = () => {
    const next = !micMutedRef.current;
    micMutedRef.current = next;
    localStreamRef.current?.getAudioTracks().forEach((t: any) => { t.enabled = !next; });
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
    setSpeakerMuted(next);
    for (const [id, stream] of remoteStreamsRef.current) {
      const other = latestRemote.current.get(id);
      const myPos = positionRef.current;
      const distance = other ? Math.hypot(other.x - myPos.x, other.z - myPos.z) : 999;
      const isMuted = next || mutedPeersRef.current.has(id) || blockedPeersRef.current.has(id) || distance > 15;
      stream.getAudioTracks().forEach((t: any) => { t.enabled = !isMuted; });
    }
  };

  const togglePeerSpeaker = (userId: string) => {
    const next = new Set(mutedPeersRef.current);
    const muted = !next.has(userId);
    if (muted) next.add(userId); else next.delete(userId);
    mutedPeersRef.current = next;
    setMutedPeers(next);

    const stream = remoteStreamsRef.current.get(userId);
    if (stream) {
      const other = latestRemote.current.get(userId);
      const myPos = positionRef.current;
      const distance = other ? Math.hypot(other.x - myPos.x, other.z - myPos.z) : 999;
      const isMuted = muted || speakerMutedRef.current || blockedPeersRef.current.has(userId) || distance > 15;
      stream.getAudioTracks().forEach((t: any) => { t.enabled = !isMuted; });
    }
  };

  const blockPeer = (peer: RoomPeer) => {
    Alert.alert(`Block ${peer.name}?`, 'Their avatar, room chat, and voice will be hidden for you. Direct contact will stop.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Block', style: 'destructive', onPress: async () => {
        try {
          await socialApi('/safety/blocks', 'POST', { userId: peer.userId });
          blockedPeersRef.current.add(peer.userId);
          const stream = remoteStreamsRef.current.get(peer.userId);
          if (stream) stream.getAudioTracks().forEach((t: any) => { t.enabled = false; });
          const pc = roomPeersRef.current.get(peer.userId);
          if (pc) {
            pc.close();
            roomPeersRef.current.delete(peer.userId);
          }
          peerSnapshots.current.delete(peer.userId);
          setPeers(current => current.filter(item => item.userId !== peer.userId));
          setMessages(current => current.filter(message => message.userId !== peer.userId));
        } catch (error) { Alert.alert('Could not block user', error instanceof Error ? error.message : 'Please try again.'); }
      } },
    ]);
  };

  const sendMessage = async () => {
    const body = chatText.trim();
    if (!body) return;
    try {
      await sendRoomMessage(body);
      SoundEffects.playSent();
      setChatText('');
      setChatError('');
    } catch (error) {
      setChatError(error instanceof Error ? error.message : 'Could not send message.');
    }
  };
  if (!username) return null;

  return <View style={styles.screen}>
    <StatusBar hidden />
    <NavigationBar hidden />
    {landscapeReady && (width >= height || orientationFailed) && (
      <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
        <GameRoom key={`${roomKind}-${roomAvatar.body}`} roomKind={roomKind} avatar={roomAvatar} peers={peers} peerSnapshotsRef={peerSnapshots} onPosition={onPosition} onPortal={() => setRoomKind(current => current === 'roof' ? 'loft' : 'roof')} onOpenRadio={() => { setMusicModalTab('radio'); setMusicModalOpen(true); }} />
      </View>
    )}
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
        <Text style={styles.roomStatus} numberOfLines={1}>{voiceStatus === 'Connecting nearby voice…' && nearbySpeakers > 0 ? 'Nearby voice on' : voiceStatus}{nearbySpeakers ? ` · ${nearbySpeakers} nearby` : ''}</Text>
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
                <Pressable accessibilityRole="button" accessibilityLabel={`Report ${peer.name}`} onPress={() => setReportPeer({ userId: peer.userId, name: peer.name, kind: 'room' })} style={styles.peerKick}>
                  <Text style={styles.reportLabel}>Report</Text>
                </Pressable>
                <Pressable accessibilityRole="button" accessibilityLabel={`Block ${peer.name}`} onPress={() => blockPeer(peer)} style={styles.peerKick}>
                  <Text style={styles.reportLabel}>Block</Text>
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
      <ScrollView style={styles.chatList}>{messages.map(message => <Pressable key={message.id} onLongPress={() => {
        if (message.userId !== currentUserId) setReportPeer({ userId: message.userId, name: message.name, kind: 'room', messageId: message.id, evidenceText: message.body });
      }}><Text style={styles.chatMessage}><Text style={styles.chatName}>{message.name}: </Text>{message.body}</Text></Pressable>)}</ScrollView>
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
    <ReportUser visible={!!reportPeer} userId={reportPeer?.userId || ''} userName={reportPeer?.name || ''}
      kind={reportPeer?.kind || 'user'} messageId={reportPeer?.messageId} roomId={params.roomId || activeRoomId}
      evidenceText={reportPeer?.evidenceText} onClose={() => setReportPeer(null)} />
  </View>;
}

const styles = StyleSheet.create({
  reportLabel: { color: '#F7FAF8', fontSize: 11, fontWeight: '700' },
  screen: { flex: 1, backgroundColor: '#0A0E14' },
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
