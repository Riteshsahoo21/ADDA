import { useEffect, useRef, useState } from 'react';
import {
  DeviceEventEmitter,
  PermissionsAndroid,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Headphones,
  Lock,
  Mic,
  MicOff,
  PhoneOff,
  SwitchCamera,
  User,
  Video,
  VideoOff,
  Volume1,
  Volume2,
} from 'lucide-react-native';
import {
  mediaDevices,
  RTCIceCandidate,
  RTCPeerConnection,
  RTCSessionDescription,
  RTCView,
  MediaStream,
} from 'react-native-webrtc';
import InCallManager from 'react-native-incall-manager';
import { useKeepAwake } from 'expo-keep-awake';
import * as Notifications from 'expo-notifications';
import { callRequest, type CallInfo } from '@/lib/calls';
import { getActiveSocket, getRealtimeSocket } from '@/lib/realtime';
import { socialApi, type OwnProfile } from '@/lib/social-api';
import { dismissCallNotification } from '@/lib/push-notifications';
import { MusicService } from '@/audio/MusicService';

type Signal = { type: 'offer' | 'answer'; sdp: string } | { candidate: any };
const ONGOING_CALL_NOTIF_ID = 'adda_active_call_notification';

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

export default function CallScreen() {
  useKeepAwake();

  const insets = useSafeAreaInsets();
  const { callId, role: paramRole, name, media: paramMedia } = useLocalSearchParams<{
    callId?: string;
    role?: string;
    name?: string;
    media?: string;
  }>();

  const initialCameraOff = paramMedia === 'audio';
  const [call, setCall] = useState<CallInfo | null>(null);
  const [status, setStatus] = useState(callId ? 'Connecting…' : 'Call unavailable.');
  const [callDuration, setCallDuration] = useState(0);
  const [local, setLocal] = useState<MediaStream | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<Map<string, MediaStream>>(new Map());
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(initialCameraOff);
  const [speakerOn, setSpeakerOn] = useState(true);
  const [isHeadsetConnected, setIsHeadsetConnected] = useState(false);
  const [routeToast, setRouteToast] = useState<string | null>(null);
  const [userNames, setUserNames] = useState<Record<string, string>>({});
  const [selfUserId, setSelfUserId] = useState('');

  const activeRef = useRef(true);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mutedRef = useRef(false);
  const cameraOffRef = useRef(initialCameraOff);
  const speakerOnRef = useRef(true);
  const isHeadsetConnectedRef = useRef(false);

  // WebRTC references
  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const pendingCandidatesRef = useRef<Map<string, RTCIceCandidate[]>>(new Map());
  const localRef = useRef<MediaStream | null>(null);
  const endingRef = useRef(false);
  const closeRef = useRef<((leave: boolean) => void) | null>(null);
  const iceServersRef = useRef<any[]>([
    { urls: ['stun:stun.l.google.com:19302', 'stun:191.215.37.241:3478'] },
  ]);

  const safeExit = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/home');
  };

  const showRouteToast = (msg: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setRouteToast(msg);
    toastTimer.current = setTimeout(() => setRouteToast(null), 2500);
  };

  const applyAudioRoute = (forceSpeaker: boolean) => {
    speakerOnRef.current = forceSpeaker;
    setSpeakerOn(forceSpeaker);
    if (forceSpeaker) {
      InCallManager.setForceSpeakerphoneOn(true);
      InCallManager.setSpeakerphoneOn(true);
      void InCallManager.chooseAudioRoute('SPEAKER_PHONE');
    } else {
      InCallManager.setSpeakerphoneOn(false);
      if (isHeadsetConnectedRef.current) {
        InCallManager.setForceSpeakerphoneOn(null as any);
        void InCallManager.chooseAudioRoute('WIRED_HEADSET');
      } else {
        InCallManager.setForceSpeakerphoneOn(false);
        void InCallManager.chooseAudioRoute('EARPIECE');
      }
    }
  };

  // InCallManager audio management
  useEffect(() => {
    activeRef.current = true;
    MusicService.stopAll();
    try { InCallManager.stopRingtone(); } catch {}

    const isVideo = (call?.media ?? paramMedia) === 'video';
    InCallManager.start({ media: isVideo ? 'video' : 'audio', auto: true });
    InCallManager.setKeepScreenOn(true);

    void InCallManager.getIsWiredHeadsetPluggedIn().then(({ isWiredHeadsetPluggedIn }) => {
      const plugged = Boolean(isWiredHeadsetPluggedIn);
      setIsHeadsetConnected(plugged);
      isHeadsetConnectedRef.current = plugged;
      applyAudioRoute(!plugged && isVideo);
    }).catch(() => {});

    const audioSub = DeviceEventEmitter.addListener('onAudioDeviceChanged', (data: any) => {
      const list = data?.availableAudioDeviceList ? String(data.availableAudioDeviceList) : '';
      const hasHeadset = list.includes('WIRED_HEADSET') || list.includes('BLUETOOTH');
      setIsHeadsetConnected(hasHeadset);
      isHeadsetConnectedRef.current = hasHeadset;
    });

    return () => {
      activeRef.current = false;
      audioSub.remove();
      InCallManager.setForceSpeakerphoneOn(false);
      InCallManager.stop();
      MusicService.stopAll();
    };
  }, []);

  // Duration timer
  useEffect(() => {
    if (status !== 'Connected') return;
    const interval = setInterval(() => setCallDuration(prev => prev + 1), 1000);
    return () => clearInterval(interval);
  }, [status]);

  // Load participant names
  useEffect(() => {
    if (!callId) return;
    void socialApi<OwnProfile>('/me').then(me => {
      if (me?.id && me?.name) setUserNames(prev => ({ ...prev, [me.id]: me.name }));
    }).catch(() => {});

    if (call?.target.kind === 'group') {
      void socialApi<{ members: Array<{ id: string; name: string }> }>(`/groups/${call.target.id}`).then(group => {
        if (group?.members) {
          const map: Record<string, string> = {};
          group.members.forEach(m => { map[m.id] = m.name; });
          setUserNames(prev => ({ ...prev, ...map }));
        }
      }).catch(() => {});
    } else {
      void socialApi<Array<{ id: string; name: string }>>('/contacts').then(contacts => {
        if (Array.isArray(contacts)) {
          const map: Record<string, string> = {};
          contacts.forEach(c => { map[c.id] = c.name; });
          setUserNames(prev => ({ ...prev, ...map }));
        }
      }).catch(() => {});
    }
  }, [callId, call?.target.id, call?.target.kind]);

  // Main WebRTC Lifecycle
  useEffect(() => {
    if (!callId) return;
    let socket: Awaited<ReturnType<typeof getRealtimeSocket>> | null = null;
    let myUserId = '';
    const earlySignals: Array<{ from: string; signal: Signal }> = [];

    const closeCall = (leave: boolean) => {
      if (endingRef.current) return;
      endingRef.current = true;
      activeRef.current = false;
      void Notifications.dismissNotificationAsync(ONGOING_CALL_NOTIF_ID).catch(() => {});
      if (leave) {
        (socket ?? getActiveSocket())?.emit('call:leave', callId);
      }
      peersRef.current.forEach(p => p.close());
      peersRef.current.clear();
      pendingCandidatesRef.current.clear();
      localRef.current?.getTracks().forEach(t => t.stop());
      localRef.current = null;
      safeExit();
    };
    closeRef.current = closeCall;

    const sendSignal = (to: string, signal: Signal) => {
      socket?.emit('call:signal', { callId, to, signal });
    };

    // Helper: Create peer connection for target user
    const getOrCreatePeer = (peerId: string, iceServers: any[], isInitiator: boolean) => {
      let peer = peersRef.current.get(peerId);
      if (peer) return peer;

      peer = new RTCPeerConnection({ iceServers });
      peersRef.current.set(peerId, peer);

      // Attach existing local tracks
      if (localRef.current) {
        localRef.current.getTracks().forEach(track => {
          try { peer!.addTrack(track, localRef.current!); } catch {}
        });
      }

      // 1. ICE Candidate dispatch
      (peer as any).onicecandidate = (event: any) => {
        if (event.candidate && event.candidate.candidate) {
          const cand = typeof event.candidate.toJSON === 'function' ? event.candidate.toJSON() : event.candidate;
          sendSignal(peerId, { candidate: cand });
        }
      };

      // 2. Track reception - use native stream directly
      (peer as any).ontrack = (event: any) => {
        if (!activeRef.current) return;
        const remoteStream = event.streams?.[0] || (peer as any)._remoteStreams?.values()?.next()?.value;
        if (remoteStream) {
          setRemoteStreams(prev => {
            const next = new Map(prev);
            next.set(peerId, remoteStream);
            return next;
          });
        }
      };

      // 3. Connection state handling
      const handleConnChange = () => {
        if (!activeRef.current || endingRef.current) return;
        const conn = peer!.connectionState;
        const ice = peer!.iceConnectionState;
        if (conn === 'connected' || ice === 'connected' || ice === 'completed') {
          setStatus('Connected');
          applyAudioRoute(speakerOnRef.current);
        } else if (conn === 'failed' || ice === 'failed') {
          const anyConnected = Array.from(peersRef.current.values()).some(
            p => p.connectionState === 'connected' || p.iceConnectionState === 'connected'
          );
          if (!anyConnected) setStatus('Connection failed.');
        }
      };
      (peer as any).onconnectionstatechange = handleConnChange;
      (peer as any).oniceconnectionstatechange = handleConnChange;

      // 4. Initiator offer creation
      if (isInitiator) {
        void (async () => {
          try {
            const offer = await peer!.createOffer();
            await peer!.setLocalDescription(offer);
            sendSignal(peerId, { type: 'offer', sdp: offer.sdp ?? '' });
          } catch (err) {
            console.warn('[Call] Offer failed for peer:', peerId, err);
          }
        })();
      }

      return peer;
    };

    const handleSignal = async (from: string, signal: Signal, iceServers: any[]) => {
      try {
        // ICE candidate
        if ('candidate' in signal) {
          if (!signal.candidate || !signal.candidate.candidate) return;
          const candidate = new RTCIceCandidate(signal.candidate);
          const peer = peersRef.current.get(from);
          if (peer && peer.remoteDescription && peer.localDescription) {
            await peer.addIceCandidate(candidate).catch(() => {});
          } else {
            if (!pendingCandidatesRef.current.has(from)) pendingCandidatesRef.current.set(from, []);
            pendingCandidatesRef.current.get(from)!.push(candidate);
          }
          return;
        }

        // Offer
        if (signal.type === 'offer') {
          let peer = peersRef.current.get(from);
          if (!peer) {
            peer = getOrCreatePeer(from, iceServers, false);
          }
          await peer.setRemoteDescription(new RTCSessionDescription(signal as any));
          const answer = await peer.createAnswer();
          await peer.setLocalDescription(answer);
          sendSignal(from, { type: 'answer', sdp: answer.sdp ?? '' });

          // Drain pending candidates AFTER local answer is set
          const pending = pendingCandidatesRef.current.get(from) || [];
          pendingCandidatesRef.current.delete(from);
          for (const c of pending) await peer.addIceCandidate(c).catch(() => {});
          return;
        }

        // Answer
        if (signal.type === 'answer') {
          const peer = peersRef.current.get(from);
          if (peer && peer.signalingState === 'have-local-offer') {
            await peer.setRemoteDescription(new RTCSessionDescription(signal as any));
            const pending = pendingCandidatesRef.current.get(from) || [];
            pendingCandidatesRef.current.delete(from);
            for (const c of pending) await peer.addIceCandidate(c).catch(() => {});
          }
          return;
        }
      } catch (err) {
        console.warn('[Call] Signal processing error:', err);
      }
    };

    void (async () => {
      try {
        socket = await getRealtimeSocket();

        // Join call on backend
        const joined = await callRequest<CallInfo>('call:join', callId);
        if (!activeRef.current) return;
        setCall(joined);
        void dismissCallNotification(joined.id);

        const me = await socialApi<OwnProfile>('/me').catch(() => null);
        myUserId = me?.id || '';
        if (!myUserId) throw new Error('Could not identify user for call.');
        setSelfUserId(myUserId);

        const wantVideo = joined.media === 'video' || paramMedia === 'video';

        // Permissions: Ensure camera & mic are requested
        if (Platform.OS === 'android') {
          const perms = [PermissionsAndroid.PERMISSIONS.RECORD_AUDIO];
          if (wantVideo) perms.push(PermissionsAndroid.PERMISSIONS.CAMERA);
          await PermissionsAndroid.requestMultiple(perms).catch(() => {});
        }

        // Acquire local media with standard camera constraints
        let stream: MediaStream;
        try {
          stream = await mediaDevices.getUserMedia({
            audio: true,
            video: wantVideo ? { facingMode: 'user', frameRate: 30 } : false,
          });
        } catch {
          stream = await mediaDevices.getUserMedia({ audio: true, video: false });
          setCameraOff(true);
          cameraOffRef.current = true;
        }
        if (!activeRef.current) { stream.getTracks().forEach(t => t.stop()); return; }
        stream.getAudioTracks().forEach(t => { t.enabled = !mutedRef.current; });
        stream.getVideoTracks().forEach(t => { t.enabled = !cameraOffRef.current; });
        localRef.current = stream;
        setLocal(stream);

        // Fetch ICE servers
        const iceConfig = await socialApi<{ iceServers: any[] }>('/calls/ice').catch(() => ({
          iceServers: [
            { urls: ['stun:stun.l.google.com:19302', 'stun:191.215.37.241:3478'] },
          ],
        }));
        if (iceConfig?.iceServers?.length) iceServersRef.current = iceConfig.iceServers;
        const iceServers = iceServersRef.current;

        // Drain any early signals received before media initialization
        while (earlySignals.length > 0) {
          const item = earlySignals.shift();
          if (item) await handleSignal(item.from, item.signal, iceServers);
        }

        // Signal listener
        socket.on('call:signal', async (event: { callId: string; from: string; signal: Signal }) => {
          if (event.callId !== callId || endingRef.current) return;
          if (!localRef.current) {
            earlySignals.push({ from: event.from, signal: event.signal });
            return;
          }
          await handleSignal(event.from, event.signal, iceServers);
        });

        // Peer readiness listener: deterministic initiator rule (myUserId < peerId)
        socket.on('call:ready', (event: { callId: string; from: string }) => {
          if (event.callId !== callId || event.from === myUserId) return;
          if (myUserId < event.from && !peersRef.current.has(event.from)) {
            getOrCreatePeer(event.from, iceServers, true);
          }
        });

        socket.on('call:participant-joined', (event: { callId: string; userId: string; joined?: string[] }) => {
          if (event.callId !== callId || event.userId === myUserId) return;
          if (event.joined) {
            setCall(prev => prev ? { ...prev, joined: event.joined! } : prev);
          }
          if (myUserId < event.userId && !peersRef.current.has(event.userId)) {
            getOrCreatePeer(event.userId, iceServers, true);
          }
        });

        socket.on('call:participant-left', (event: { callId: string; userId: string; joined?: string[] }) => {
          if (event.callId !== callId) return;
          if (event.joined) {
            setCall(prev => prev ? { ...prev, joined: event.joined! } : prev);
          }
          if (joined.target.kind === 'group') {
            const peer = peersRef.current.get(event.userId);
            if (peer) { peer.close(); peersRef.current.delete(event.userId); }
            pendingCandidatesRef.current.delete(event.userId);
            setRemoteStreams(prev => {
              const next = new Map(prev);
              next.delete(event.userId);
              return next;
            });
          } else if (event.userId !== myUserId) {
            closeCall(false);
          }
        });

        socket.on('call:ended', (event: { callId: string }) => {
          if (event.callId === callId) closeCall(false);
        });

        // Announce ready to peers
        setStatus(joined.target.kind === 'group' ? 'Waiting for others…' : (paramRole === 'caller' ? 'Calling…' : 'Connecting…'));
        socket.emit('call:ready', callId);

        // Initiate offers for peers that have already joined where myUserId < peerId
        for (const memberId of joined.joined) {
          if (memberId !== myUserId && myUserId < memberId) {
            getOrCreatePeer(memberId, iceServers, true);
          }
        }
      } catch (error) {
        if (activeRef.current) setStatus(error instanceof Error ? error.message : 'Call failed.');
      }
    })();

    return () => {
      activeRef.current = false;
      socket?.off('call:signal');
      socket?.off('call:ready');
      socket?.off('call:participant-joined');
      socket?.off('call:participant-left');
      socket?.off('call:ended');
      closeCall(true);
    };
  }, [callId, paramRole]);

  // Controls
  const toggleMute = () => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    localRef.current?.getAudioTracks().forEach(t => { t.enabled = !next; });
    setMuted(next);
  };

  const toggleCamera = async () => {
    const next = !cameraOffRef.current;
    cameraOffRef.current = next;
    setCameraOff(next);

    if (localRef.current) {
      const videoTracks = localRef.current.getVideoTracks();
      // If no video track exists yet (call started as audio), acquire camera dynamically!
      if (videoTracks.length === 0 && !next) {
        try {
          if (Platform.OS === 'android') {
            await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.CAMERA).catch(() => {});
          }
          const videoStream = await mediaDevices.getUserMedia({
            audio: false,
            video: { facingMode: 'user', frameRate: 30 },
          });
          const vTrack = videoStream.getVideoTracks()[0];
          if (vTrack) {
            vTrack.enabled = true;
            localRef.current.addTrack(vTrack);
            setLocal(new MediaStream(localRef.current.getTracks()));

            // Send new track to all peers & re-offer
            peersRef.current.forEach(async (peer, peerId) => {
              try {
                peer.addTrack(vTrack, localRef.current!);
                if (peer.signalingState === 'stable') {
                  const offer = await peer.createOffer();
                  await peer.setLocalDescription(offer);
                  getActiveSocket()?.emit('call:signal', {
                    callId,
                    to: peerId,
                    signal: { type: 'offer', sdp: offer.sdp ?? '' },
                  });
                }
              } catch {}
            });
          }
        } catch {
          cameraOffRef.current = true;
          setCameraOff(true);
        }
      } else {
        videoTracks.forEach(t => { t.enabled = !next; });
        setLocal(new MediaStream(localRef.current.getTracks()));
      }
    }
  };

  const flipCamera = () => {
    const track = localRef.current?.getVideoTracks()[0];
    if (track && typeof (track as any)._switchCamera === 'function') {
      (track as any)._switchCamera();
    }
  };

  const toggleSpeaker = () => {
    const next = !speakerOnRef.current;
    applyAudioRoute(next);
    showRouteToast(next ? '🔊 Loud Speaker Active' : isHeadsetConnectedRef.current ? '🎧 Earphones Active' : '👂 Normal Speaker Active');
  };

  const endCall = () => {
    if (closeRef.current) closeRef.current(true);
    else safeExit();
  };

  // Layout calculations
  const isGroup = call?.target.kind === 'group';
  const displayName = name || (isGroup ? 'Group Call' : 'ADDA Call');
  const isVideoCall = call?.media === 'video' || paramMedia === 'video' || (!cameraOff && Boolean(local?.getVideoTracks().length));
  const remoteEntries = Array.from(remoteStreams.entries());
  const firstRemoteStream = remoteEntries[0]?.[1];
  const participantIds = Array.from(new Set([
    ...(selfUserId ? [selfUserId] : []),
    ...(call?.joined ?? []),
    ...remoteEntries.map(([id]) => id),
  ]));

  const getGridTileStyle = (idx: number, total: number) => {
    if (total <= 1) return styles.tileFull;
    if (total === 2) return styles.tileHalfVertical;
    if (total <= 4) return styles.tileQuarter;
    if (total <= 6) return styles.tileSixth;
    return styles.tileEighth;
  };

  return (
    <View style={styles.container}>
      {/* Media Stage */}
      {isVideoCall ? (
        <View style={styles.videoStage}>
          {!isGroup ? (
            // 1:1 Video Call
            firstRemoteStream && firstRemoteStream.getVideoTracks().length > 0 ? (
              <RTCView streamURL={firstRemoteStream.toURL()} style={styles.fillAbsolute} objectFit="cover" zOrder={0} />
            ) : (
              <View style={styles.audioCenterStage}>
                <View style={styles.largeAvatarCircle}>
                  <Text style={styles.largeAvatarText}>{displayName[0]?.toUpperCase() || 'A'}</Text>
                </View>
                <Text style={styles.audioCallerName}>{displayName}</Text>
                <Text style={styles.audioCallTimer}>{status === 'Connected' ? (firstRemoteStream ? 'Camera off' : 'Connecting video…') : status}</Text>
              </View>
            )
          ) : (
            // Group Video Call: WhatsApp adaptive grid
            <View style={styles.fullGridContainer}>
              {participantIds.map((userId, idx) => {
                const ownTile = userId === selfUserId;
                const tileStream = ownTile ? local : remoteStreams.get(userId);
                const hasVideo = ownTile
                  ? (!cameraOff && Boolean(local?.getVideoTracks().length))
                  : Boolean(tileStream && tileStream.getVideoTracks().length > 0);
                const participantName = ownTile ? 'You' : userNames[userId] || `User ${userId.slice(0, 4)}`;

                return (
                  <View
                    key={userId}
                    style={[
                      styles.gridTile,
                      getGridTileStyle(idx, participantIds.length),
                      tileStream && hasVideo ? styles.gridTileVideoActive : null,
                    ]}
                  >
                    {tileStream && hasVideo ? (
                      <RTCView
                        streamURL={tileStream.toURL()}
                        style={styles.fillAbsolute}
                        objectFit="cover"
                        mirror={ownTile}
                        zOrder={0}
                      />
                    ) : (
                      <View style={styles.audioCardAvatarTile}>
                        <View style={styles.audioCardAvatar}>
                          <Text style={styles.audioCardAvatarText}>
                            {(participantName[0] || 'U').toUpperCase()}
                          </Text>
                        </View>
                        <View style={styles.cameraOffPill}>
                          <VideoOff size={12} color="#FFFFFF" style={{ marginRight: 4 }} />
                          <Text style={styles.cameraOffPillText}>Camera off</Text>
                        </View>
                      </View>
                    )}
                    <View style={styles.tileBadge}>
                      <Text style={styles.tileBadgeText} numberOfLines={1}>{participantName}</Text>
                    </View>
                  </View>
                );
              })}
            </View>
          )}

          {/* 1:1 Floating PiP Preview */}
          {!isGroup && local && (
            <Pressable onPress={flipCamera} style={[styles.pipContainer, { top: insets.top + 70 }]}>
              {!cameraOff && local.getVideoTracks().length > 0 ? (
                <RTCView streamURL={local.toURL()} style={styles.fillAbsolute} objectFit="cover" mirror zOrder={1} />
              ) : (
                <View style={styles.pipCameraOffView}>
                  <User size={26} color="#8E9BA8" />
                  <Text style={styles.pipCameraOffText}>Camera off</Text>
                </View>
              )}
              <View style={styles.pipBadge}>
                <Text style={styles.pipBadgeText}>You</Text>
              </View>
            </Pressable>
          )}
        </View>
      ) : (
        /* Audio Call Stage */
        <View style={styles.audioStage}>
          {isGroup && participantIds.length > 0 ? (
            <View style={styles.fullGridContainer}>
              {participantIds.map((userId, idx) => {
                const participantName = userId === selfUserId ? 'You' : userNames[userId] || `User ${userId.slice(0, 4)}`;
                return (
                  <View key={userId} style={[styles.audioGridTile, getGridTileStyle(idx, participantIds.length)]}>
                    <View style={styles.audioCardAvatar}>
                      <Text style={styles.audioCardAvatarText}>{(participantName[0] || 'U').toUpperCase()}</Text>
                    </View>
                    <Text style={styles.audioCardName} numberOfLines={1}>{participantName}</Text>
                  </View>
                );
              })}
            </View>
          ) : (
            <View style={styles.audioCenterStage}>
              <View style={styles.pulseRing}>
                <View style={styles.largeAvatarCircle}>
                  <Text style={styles.largeAvatarText}>{displayName[0]?.toUpperCase() || 'A'}</Text>
                </View>
              </View>
              <Text style={styles.audioCallerName}>{displayName}</Text>
              <Text style={styles.audioCallTimer}>{status === 'Connected' ? formatDuration(callDuration) : status}</Text>
            </View>
          )}
        </View>
      )}

      {/* Top Header */}
      <View style={[styles.topHeader, { top: insets.top + 10 }]}>
        <View style={styles.headerInfoPill}>
          {!isGroup && (
            <View style={styles.encryptedRow}>
              <Lock size={12} color="#34D399" style={{ marginRight: 4 }} />
              <Text style={styles.encryptedText}>End-to-end encrypted</Text>
            </View>
          )}
          <Text style={styles.headerTitle} numberOfLines={1}>{displayName}</Text>
          <Text style={styles.headerSubtitle}>
            {status === 'Connected'
              ? `${formatDuration(callDuration)} • ${speakerOn ? '🔊 Loud Speaker' : isHeadsetConnected ? '🎧 Earphones' : '👂 Normal Speaker'}`
              : status}
          </Text>
        </View>
      </View>

      {/* Bottom Floating Control Bar */}
      <View style={[styles.bottomBarContainer, { bottom: Math.max(insets.bottom, 20) + 12 }]}>
        {routeToast && (
          <View style={styles.routeToastPill}>
            <Text style={styles.routeToastText}>{routeToast}</Text>
          </View>
        )}
        <View style={styles.bottomBarPill}>
          <Pressable onPress={toggleMute} style={[styles.controlBtn, muted && styles.controlBtnActiveRed]}>
            {muted ? <MicOff size={22} color="#FFFFFF" /> : <Mic size={22} color="#FFFFFF" />}
          </Pressable>

          <Pressable onPress={toggleCamera} style={[styles.controlBtn, cameraOff && styles.controlBtnActiveRed]}>
            {cameraOff ? <VideoOff size={22} color="#FFFFFF" /> : <Video size={22} color="#FFFFFF" />}
          </Pressable>

          {!cameraOff && (
            <Pressable onPress={flipCamera} style={styles.controlBtn}>
              <SwitchCamera size={22} color="#FFFFFF" />
            </Pressable>
          )}

          <Pressable
            onPress={toggleSpeaker}
            style={[styles.controlBtn, speakerOn ? styles.controlBtnActiveGreen : isHeadsetConnected ? styles.controlBtnActiveCyan : styles.controlBtn]}
          >
            {speakerOn ? <Volume2 size={22} color="#FFFFFF" /> : isHeadsetConnected ? <Headphones size={22} color="#FFFFFF" /> : <Volume1 size={22} color="#FFFFFF" />}
          </Pressable>

          <Pressable onPress={endCall} style={[styles.controlBtn, styles.hangupBtn]}>
            <PhoneOff size={24} color="#FFFFFF" />
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0A1711' },
  fillAbsolute: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  videoStage: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'transparent' },
  audioStage: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#0D2018' },
  fullGridContainer: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, flexDirection: 'row', flexWrap: 'wrap' },
  gridTile: { backgroundColor: '#12251D', overflow: 'hidden', borderColor: '#0A1711', borderWidth: 1.5 },
  gridTileVideoActive: { backgroundColor: 'transparent' },
  tileFull: { width: '100%', height: '100%' },
  tileHalfVertical: { width: '100%', height: '50%' },
  tileQuarter: { width: '50%', height: '50%' },
  tileSixth: { width: '50%', height: '33.33%' },
  tileEighth: { width: '50%', height: '25%' },
  tileBadge: { position: 'absolute', left: 10, bottom: 10, backgroundColor: 'rgba(0, 0, 0, 0.65)', paddingHorizontal: 9, paddingVertical: 4, borderRadius: 10, zIndex: 10, elevation: 5 },
  tileBadgeText: { color: '#FFFFFF', fontSize: 12, fontWeight: '700' },
  pipContainer: {
    position: 'absolute', right: 16, width: 105, height: 155, borderRadius: 16, borderWidth: 2,
    borderColor: 'rgba(255, 255, 255, 0.45)', overflow: 'hidden', backgroundColor: '#183327', elevation: 15, zIndex: 100,
  },
  pipBadge: { position: 'absolute', bottom: 6, left: 6, backgroundColor: 'rgba(0, 0, 0, 0.6)', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, zIndex: 10 },
  pipBadgeText: { color: '#FFFFFF', fontSize: 10, fontWeight: '700' },
  pipCameraOffView: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#0F261C', alignItems: 'center', justifyContent: 'center', gap: 4 },
  pipCameraOffText: { color: '#8E9BA8', fontSize: 9, fontWeight: '600' },
  audioCardAvatarTile: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#12251D', alignItems: 'center', justifyContent: 'center' },
  cameraOffPill: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(0, 0, 0, 0.55)', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, marginTop: 6 },
  cameraOffPillText: { color: '#D1D5DB', fontSize: 11, fontWeight: '600' },
  audioCenterStage: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  pulseRing: { width: 150, height: 150, borderRadius: 75, backgroundColor: 'rgba(38, 166, 122, 0.15)', alignItems: 'center', justifyContent: 'center', marginBottom: 24 },
  largeAvatarCircle: { width: 120, height: 120, borderRadius: 60, backgroundColor: '#1C3D2F', alignItems: 'center', justifyContent: 'center', borderWidth: 3, borderColor: '#34D399' },
  largeAvatarText: { color: '#FFFFFF', fontSize: 54, fontWeight: '700' },
  audioCallerName: { color: '#FFFFFF', fontSize: 26, fontWeight: '800', marginBottom: 8, textAlign: 'center' },
  audioCallTimer: { color: '#34D399', fontSize: 16, fontWeight: '600' },
  audioGridTile: { backgroundColor: '#142920', alignItems: 'center', justifyContent: 'center', borderColor: '#0A1711', borderWidth: 1.5 },
  audioCardAvatar: { width: 72, height: 72, borderRadius: 36, backgroundColor: '#204334', alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#34D399', marginBottom: 10 },
  audioCardAvatarText: { color: '#FFFFFF', fontSize: 30, fontWeight: '700' },
  audioCardName: { color: '#FFFFFF', fontSize: 14, fontWeight: '700', maxWidth: '80%', textAlign: 'center' },
  topHeader: { position: 'absolute', left: 20, right: 20, alignItems: 'center', zIndex: 9999, elevation: 30 },
  headerInfoPill: { backgroundColor: 'rgba(10, 23, 17, 0.78)', borderRadius: 20, paddingHorizontal: 16, paddingVertical: 8, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255, 255, 255, 0.1)' },
  encryptedRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 2 },
  encryptedText: { color: '#34D399', fontSize: 11, fontWeight: '600' },
  headerTitle: { color: '#FFFFFF', fontSize: 17, fontWeight: '800', textAlign: 'center' },
  headerSubtitle: { color: 'rgba(255, 255, 255, 0.75)', fontSize: 13, fontWeight: '600', marginTop: 2 },
  bottomBarContainer: { position: 'absolute', left: 0, right: 0, alignItems: 'center', zIndex: 9999, elevation: 30 },
  bottomBarPill: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(13, 28, 21, 0.92)', borderRadius: 36, paddingHorizontal: 18, paddingVertical: 12, gap: 16, borderWidth: 1, borderColor: 'rgba(255, 255, 255, 0.15)', elevation: 30 },
  controlBtn: { width: 50, height: 50, borderRadius: 25, backgroundColor: 'rgba(255, 255, 255, 0.15)', alignItems: 'center', justifyContent: 'center' },
  controlBtnActiveRed: { backgroundColor: '#EF4444' },
  controlBtnActiveGreen: { backgroundColor: '#059669' },
  controlBtnActiveCyan: { backgroundColor: '#0284C7' },
  hangupBtn: { backgroundColor: '#DC2626', width: 54, height: 54, borderRadius: 27 },
  routeToastPill: { backgroundColor: 'rgba(10, 23, 17, 0.90)', borderRadius: 20, paddingHorizontal: 16, paddingVertical: 8, marginBottom: 12, borderWidth: 1, borderColor: '#34D399', alignSelf: 'center' },
  routeToastText: { color: '#34D399', fontSize: 13, fontWeight: '700' },
});
