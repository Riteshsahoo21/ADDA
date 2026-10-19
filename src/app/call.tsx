import { useEffect, useRef, useState } from 'react';
import {
  AppState,
  DeviceEventEmitter,
  PermissionsAndroid,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
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
  VolumeX,
} from 'lucide-react-native';
import {
  mediaDevices,
  RTCIceCandidate,
  RTCPeerConnection,
  RTCSessionDescription,
  RTCView,
  type MediaStream,
} from 'react-native-webrtc';
import InCallManager from 'react-native-incall-manager';
import { useKeepAwake } from 'expo-keep-awake';
import * as Notifications from 'expo-notifications';
import { colors } from '@/constants/theme';
import { callRequest, type CallInfo } from '@/lib/calls';
import { getRealtimeSocket } from '@/lib/realtime';
import { socialApi, type OwnProfile } from '@/lib/social-api';
import { GroupMedia, type RemoteTrack } from '@/lib/group-media';
import { MusicService } from '@/audio/MusicService';

type Signal = { type: 'offer' | 'answer'; sdp: string } | { candidate: object };
const ONGOING_CALL_NOTIF_ID = 'adda_active_call_notification';

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

export default function CallScreen() {
  useKeepAwake(); // Keeps screen and phone alive while on call without touching

  const insets = useSafeAreaInsets();
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const { callId, role, name, media: paramMedia } = useLocalSearchParams<{ callId?: string; role?: string; name?: string; media?: string }>();

  const initialCameraOff = paramMedia === 'audio';
  const [call, setCall] = useState<CallInfo | null>(null);
  const [status, setStatus] = useState(callId ? 'Connecting…' : 'Call unavailable.');
  const [callDuration, setCallDuration] = useState(0);
  const [local, setLocal] = useState<MediaStream | null>(null);
  const [remote, setRemote] = useState<MediaStream | null>(null);
  const [groupTracks, setGroupTracks] = useState<RemoteTrack[]>([]);
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(initialCameraOff);
  const [speakerOn, setSpeakerOn] = useState(true);
  const [isHeadsetConnected, setIsHeadsetConnected] = useState(false);
  const [routeToast, setRouteToast] = useState<string | null>(null);
  const [userNames, setUserNames] = useState<Record<string, string>>({});

  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mutedRef = useRef(false);
  const cameraOffRef = useRef(initialCameraOff);
  const speakerOnRef = useRef(true);
  const isBluetoothRef = useRef(false);
  const isHeadsetConnectedRef = useRef(false);
  const pc = useRef<RTCPeerConnection | null>(null);
  const localRef = useRef<MediaStream | null>(null);
  const pendingCandidates = useRef<RTCIceCandidate[]>([]);
  const pendingSignals = useRef<{ callId: string; from: string; signal: Signal }[]>([]);
  const offered = useRef(false);
  const ending = useRef(false);
  const relayStarted = useRef(false);
  const groupMedia = useRef<GroupMedia | null>(null);
  const readyPeer = useRef<string | null>(null);

  const showRouteToast = (msg: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setRouteToast(msg);
    toastTimer.current = setTimeout(() => setRouteToast(null), 2500);
  };

  const applyCallAudioRoute = (forceSpeaker: boolean) => {
    speakerOnRef.current = forceSpeaker;
    setSpeakerOn(forceSpeaker);
    if (forceSpeaker) {
      InCallManager.setForceSpeakerphoneOn(true);
      InCallManager.setSpeakerphoneOn(true);
      void InCallManager.chooseAudioRoute('SPEAKER_PHONE');
    } else {
      InCallManager.setSpeakerphoneOn(false);
      if (isBluetoothRef.current) {
        InCallManager.setForceSpeakerphoneOn(null as any);
        void InCallManager.chooseAudioRoute('BLUETOOTH');
      } else if (isHeadsetConnectedRef.current) {
        InCallManager.setForceSpeakerphoneOn(null as any);
        void InCallManager.chooseAudioRoute('WIRED_HEADSET');
      } else {
        InCallManager.setForceSpeakerphoneOn(false);
        void InCallManager.chooseAudioRoute('EARPIECE');
      }
    }
  };

  // InCallManager audio session management
  useEffect(() => {
    // Release any background music completely so Android audio focus belongs solely to the call (no dual volume sliders!)
    MusicService.stopAll();

    // 1. Request Bluetooth permission on Android 12+ so InCallManager can start Bluetooth SCO
    if (Platform.OS === 'android' && Number(Platform.Version) >= 31) {
      void PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT).catch(() => {});
    }

    InCallManager.start({ media: call?.media === 'video' ? 'video' : 'audio', auto: true });
    InCallManager.setKeepScreenOn(true);

    // Initial check for earphones/headsets
    void InCallManager.getIsWiredHeadsetPluggedIn().then(({ isWiredHeadsetPluggedIn }) => {
      const hasHeadset = Boolean(isWiredHeadsetPluggedIn);
      setIsHeadsetConnected(hasHeadset);
      isHeadsetConnectedRef.current = hasHeadset;
      if (hasHeadset) {
        applyCallAudioRoute(false);
      } else {
        const defaultSpeaker = call?.media === 'video';
        applyCallAudioRoute(defaultSpeaker);
      }
    }).catch(() => {});

    // Listen for real audio device changes (wired headset, Bluetooth, or speaker)
    const audioDeviceSub = DeviceEventEmitter.addListener('onAudioDeviceChanged', (data: { selectedAudioDevice?: string; availableAudioDeviceList?: string }) => {
      let hasBt = false;
      let hasWired = false;
      if (data?.availableAudioDeviceList) {
        try {
          const list = JSON.parse(data.availableAudioDeviceList) as string[];
          hasBt = list.includes('BLUETOOTH');
          hasWired = list.includes('WIRED_HEADSET');
          isBluetoothRef.current = hasBt;
          setIsHeadsetConnected(hasBt || hasWired);
          isHeadsetConnectedRef.current = hasBt || hasWired;
        } catch {}
      }
      void InCallManager.getIsWiredHeadsetPluggedIn().then(({ isWiredHeadsetPluggedIn }) => {
        const plugged = Boolean(isWiredHeadsetPluggedIn) || hasBt;
        setIsHeadsetConnected(plugged);
        isHeadsetConnectedRef.current = plugged;
        if (plugged && speakerOnRef.current) {
          applyCallAudioRoute(false);
          showRouteToast(hasBt ? '🎧 Wireless Earphones Connected' : '🎧 Earphones Audio Active');
        }
      }).catch(() => {});
    });

    const headsetSub = DeviceEventEmitter.addListener('WiredHeadset', (data: { isPlugged?: boolean }) => {
      const plugged = Boolean(data?.isPlugged);
      setIsHeadsetConnected(plugged);
      isHeadsetConnectedRef.current = plugged;
      if (plugged && speakerOnRef.current) {
        applyCallAudioRoute(false);
        showRouteToast('🎧 Earphones Audio Active');
      }
    });

    return () => {
      headsetSub.remove();
      audioDeviceSub.remove();
      InCallManager.setForceSpeakerphoneOn(false);
      InCallManager.stop();
      MusicService.stopAll();
    };
  }, [call?.media]);

  // Live call timer
  useEffect(() => {
    if (status !== 'Connected') return;
    const interval = setInterval(() => {
      setCallDuration(prev => prev + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [status]);

  // Fetch participant display names for group call tiles
  useEffect(() => {
    if (!callId) return;
    void socialApi<OwnProfile>('/me').then(me => {
      if (me?.id && me?.name) {
        setUserNames(prev => ({ ...prev, [me.id]: me.name }));
      }
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

  // Keep in call when minimized and show active notification
  useEffect(() => {
    if (!callId) return;
    const displayName = name || (call?.target.kind === 'group' ? 'ADDA Group Call' : 'ADDA Call');

    const sub = AppState.addEventListener('change', async nextState => {
      if (nextState === 'background' || nextState === 'inactive') {
        await Notifications.scheduleNotificationAsync({
          identifier: ONGOING_CALL_NOTIF_ID,
          content: {
            title: `📞 ${call?.media === 'video' ? 'Video Call' : 'Voice Call'} • ${displayName}`,
            body: status === 'Connected' ? `Call active (${formatDuration(callDuration)}) • Tap to return` : 'Call in progress • Tap to return',
            sticky: true,
            autoDismiss: false,
            priority: Notifications.AndroidNotificationPriority.HIGH,
            data: {
              kind: 'call',
              callId,
              role,
              name: displayName,
              isOngoing: true,
            },
          },
          trigger: null,
        }).catch(() => {});
      } else if (nextState === 'active') {
        await Notifications.dismissNotificationAsync(ONGOING_CALL_NOTIF_ID).catch(() => {});
      }
    });

    return () => {
      sub.remove();
      void Notifications.dismissNotificationAsync(ONGOING_CALL_NOTIF_ID).catch(() => {});
    };
  }, [callId, name, role, call, status, callDuration]);

  // WebRTC Call logic
  useEffect(() => {
    if (!callId) return;
    let active = true;
    let socket: Awaited<ReturnType<typeof getRealtimeSocket>> | null = null;
    let currentCall: CallInfo | null = null;
    let connectionTimer: ReturnType<typeof setTimeout> | null = null;
    const clearConnectionTimer = () => { if (connectionTimer) clearTimeout(connectionTimer); connectionTimer = null; };
    const onLocalStream = (stream: MediaStream) => {
      if (!active) return;
      localRef.current = stream;
      setLocal(stream);
    };

    const startRelay = async () => {
      if (!currentCall || relayStarted.current || !active) return;
      relayStarted.current = true;
      clearConnectionTimer();
      pc.current?.close(); pc.current = null;
      localRef.current?.getTracks().forEach(track => track.stop()); localRef.current = null;
      setLocal(null); setRemote(null); setStatus('Connecting through ADDA server…');
      try {
        const media = new GroupMedia(tracks => { if (active) setGroupTracks(tracks); }, message => { if (active) setStatus(message); }, undefined, onLocalStream);
        groupMedia.current = media;
        media.setMuted(mutedRef.current);
        media.setCameraOff(cameraOffRef.current);
        await media.join({ kind: 'call', id: callId }, !cameraOffRef.current);
        if (active) {
          localRef.current = media.local;
          setLocal(media.local);
          setStatus('Connected through ADDA server');
        }
      } catch (error) { if (active) setStatus(error instanceof Error ? error.message : 'Call relay unavailable.'); }
    };

    const requestRelay = () => { if (currentCall && !relayStarted.current) socket?.emit('call:relay', callId); };
    const onRelay = (event: { callId: string }) => { if (event.callId === callId) void startRelay(); };

    const close = (leave: boolean) => {
      if (ending.current) return;
      ending.current = true;
      clearConnectionTimer();
      void Notifications.dismissNotificationAsync(ONGOING_CALL_NOTIF_ID).catch(() => {});
      InCallManager.stop();
      if (leave) socket?.emit('call:leave', callId);
      pc.current?.close(); pc.current = null;
      groupMedia.current?.close(); groupMedia.current = null;
      localRef.current?.getTracks().forEach(track => track.stop()); localRef.current = null;
      if (active) router.back();
    };

    const sendSignal = (to: string, signal: Signal) => socket?.emit('call:signal', { callId, to, signal });

    const startOffer = async (peerId: string) => {
      if (!pc.current || offered.current || pc.current.signalingState !== 'stable') return;
      offered.current = true;
      try {
        const offer = await pc.current.createOffer();
        await pc.current.setLocalDescription(offer);
        sendSignal(peerId, { type: 'offer', sdp: offer.sdp ?? '' });
        clearConnectionTimer();
        connectionTimer = setTimeout(requestRelay, 12000);
      } catch (error) {
        offered.current = false;
        if (active) setStatus(error instanceof Error ? error.message : 'Could not start media.');
        connectionTimer = setTimeout(requestRelay, 12000);
      }
    };

    const onSignal = async (event: { callId: string; from: string; signal: Signal }) => {
      if (event.callId !== callId || relayStarted.current) return;
      if (!pc.current) { pendingSignals.current.push(event); return; }
      try {
        if ('candidate' in event.signal) {
          const candidate = new RTCIceCandidate(event.signal.candidate);
          if (pc.current.remoteDescription) await pc.current.addIceCandidate(candidate);
          else pendingCandidates.current.push(candidate);
          return;
        }
        if (event.signal.type === 'answer' && pc.current.signalingState !== 'have-local-offer') return;
        if (event.signal.type === 'offer' && pc.current.signalingState !== 'stable') return;
        await pc.current.setRemoteDescription(new RTCSessionDescription(event.signal));
        for (const candidate of pendingCandidates.current.splice(0)) await pc.current.addIceCandidate(candidate);
        if (event.signal.type === 'offer') {
          const answer = await pc.current.createAnswer();
          await pc.current.setLocalDescription(answer);
          sendSignal(event.from, { type: 'answer', sdp: answer.sdp ?? '' });
        }
      } catch (error) { if (active) setStatus(error instanceof Error ? error.message : 'Could not connect media.'); }
    };

    const onJoined = (event: { callId: string; userId: string }) => {
      if (event.callId === callId && role === 'caller' && !relayStarted.current) {
        // Joining only means the call screen opened. Wait until the other
        // phone has acquired media and created its peer connection.
        if (pc.current) socket?.emit('call:ready', callId);
      }
    };

    const onReady = (event: { callId: string; from: string }) => {
      if (event.callId !== callId || relayStarted.current) return;
      if (role !== 'caller') {
        // Reply to a caller probe only when this phone can accept an offer.
        if (pc.current) socket?.emit('call:ready', callId);
      } else {
        readyPeer.current = event.from;
        if (pc.current) void startOffer(event.from);
      }
    };

    const onEnded = (event: { callId: string; reason: string }) => {
      if (event.callId === callId) { setStatus(event.reason); setTimeout(() => close(false), 900); }
    };

    void (async () => {
      try {
        socket = await getRealtimeSocket();
        socket.on('call:signal', onSignal);
        socket.on('call:participant-joined', onJoined);
        socket.on('call:ready', onReady);
        socket.on('call:ended', onEnded);
        socket.on('call:relay', onRelay);
        const joined = await callRequest<CallInfo>('call:join', callId);
        if (!active) return;
        currentCall = joined;
        setCall(joined);
        if (joined.media === 'video') {
          setCameraOff(false);
          cameraOffRef.current = false;
        } else if (!paramMedia) {
          const off = joined.media === 'audio';
          setCameraOff(off);
          cameraOffRef.current = off;
        }

        if (joined.usingRelay) { await startRelay(); return; }
        if (joined.target.kind === 'group') {
          const media = new GroupMedia(tracks => { if (active) setGroupTracks(tracks); }, message => { if (active) setStatus(message); }, undefined, onLocalStream);
          groupMedia.current = media;
          media.setMuted(mutedRef.current);
          media.setCameraOff(cameraOffRef.current);
          await media.join({ kind: 'call', id: joined.id }, !cameraOffRef.current);
          if (!active) return;
          localRef.current = media.local;
          setLocal(media.local);
          setStatus('Connected');
          return;
        }

        const config = await socialApi<{ iceServers: { urls: string; username?: string; credential?: string }[] }>('/calls/ice');
        const stream = await mediaDevices.getUserMedia({ audio: true, video: joined.media === 'video' });
        if (!active) { stream.getTracks().forEach(track => track.stop()); return; }
        stream.getAudioTracks().forEach(track => { track.enabled = !mutedRef.current; });
        stream.getVideoTracks().forEach(track => { track.enabled = !cameraOffRef.current; });
        localRef.current = stream;
        setLocal(stream);

        const peer = new RTCPeerConnection({ iceServers: config.iceServers });
        pc.current = peer;
        stream.getTracks().forEach(track => peer.addTrack(track, stream));

        const listen = peer as unknown as { addEventListener: (type: string, listener: (event: { candidate?: RTCIceCandidate; streams?: MediaStream[] }) => void) => void };
        listen.addEventListener('icecandidate', event => {
          if (event.candidate) sendSignal(role === 'caller' ? joined.target.id : joined.callerId, { candidate: event.candidate.toJSON() });
        });
        listen.addEventListener('track', event => {
          const s = event.streams?.[0];
          if (s && active) setRemote(s);
        });
        listen.addEventListener('connectionstatechange', () => {
          if (!active || relayStarted.current) return;
          if (peer.connectionState === 'connected') { clearConnectionTimer(); setStatus('Connected'); }
          else if (peer.connectionState === 'failed') requestRelay();
          else if (peer.connectionState === 'disconnected') { clearConnectionTimer(); connectionTimer = setTimeout(requestRelay, 5000); setStatus('Reconnecting…'); }
          else setStatus('Connecting…');
        });

        for (const signal of pendingSignals.current.splice(0)) await onSignal(signal);
        if (role === 'caller' && readyPeer.current) {
          void startOffer(readyPeer.current);
        } else {
          setStatus(role === 'caller' ? 'Calling…' : 'Connecting…');
          socket.emit('call:ready', callId);
          if (role !== 'caller') {
            clearConnectionTimer();
            connectionTimer = setTimeout(requestRelay, 12000);
          }
        }
      } catch (error) { if (active) setStatus(error instanceof Error ? error.message : 'Call failed.'); }
    })();

    return () => {
      active = false;
      socket?.off('call:signal', onSignal);
      socket?.off('call:participant-joined', onJoined);
      socket?.off('call:ready', onReady);
      socket?.off('call:ended', onEnded);
      socket?.off('call:relay', onRelay);
      clearConnectionTimer();
      void Notifications.dismissNotificationAsync(ONGOING_CALL_NOTIF_ID).catch(() => {});
      InCallManager.stop();
      if (!ending.current) socket?.emit('call:leave', callId);
      pc.current?.close(); pc.current = null;
      groupMedia.current?.close(); groupMedia.current = null;
      localRef.current?.getTracks().forEach(track => track.stop()); localRef.current = null;
    };
  }, [callId, role]);

  const toggleMute = () => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    localRef.current?.getAudioTracks().forEach(track => { track.enabled = !next; });
    groupMedia.current?.setMuted(next);
    setMuted(next);

    // Root fix: when unmuting, WebRTC restarts AudioRecord.
    // Re-assert route after 100ms so WebRTC does NOT kick audio to loudspeaker!
    if (!next) {
      setTimeout(() => {
        applyCallAudioRoute(speakerOnRef.current);
      }, 100);
    }
  };

  const toggleCamera = async () => {
    const next = !cameraOffRef.current;
    cameraOffRef.current = next;
    setCameraOff(next);

    if (groupMedia.current) {
      const updatedStream = await groupMedia.current.setCameraOff(next);
      if (updatedStream) {
        localRef.current = updatedStream;
        setLocal(updatedStream);
      }
    } else if (localRef.current) {
      const videoTracks = localRef.current.getVideoTracks();
      if (videoTracks.length === 0 && !next) {
        try {
          const videoStream = await mediaDevices.getUserMedia({ audio: false, video: true });
          const track = videoStream.getVideoTracks()[0];
          if (track) {
            track.enabled = true;
            localRef.current.addTrack(track);
            pc.current?.addTrack(track, localRef.current);
            setLocal(localRef.current);
          }
        } catch (err) {
          console.warn('Failed to enable camera in 1:1 call:', err);
        }
      } else {
        videoTracks.forEach(track => { track.enabled = !next; });
      }
    }
  };

  const flipCamera = () => {
    if (groupMedia.current) {
      groupMedia.current.flipCamera();
      return;
    }
    const videoTrack = localRef.current?.getVideoTracks()[0];
    if (videoTrack && typeof (videoTrack as any)._switchCamera === 'function') {
      (videoTrack as any)._switchCamera();
    }
  };

  const toggleSpeaker = () => {
    const next = !speakerOnRef.current;
    applyCallAudioRoute(next);
    if (next) {
      showRouteToast('🔊 Loud Speaker Active');
    } else if (isHeadsetConnectedRef.current) {
      showRouteToast('🎧 Earphones Audio Active');
    } else {
      showRouteToast('👂 Normal Speaker (Earpiece)');
    }
  };

  const endCall = () => {
    ending.current = true;
    void Notifications.dismissNotificationAsync(ONGOING_CALL_NOTIF_ID).catch(() => {});
    InCallManager.setForceSpeakerphoneOn(false);
    InCallManager.stop();
    if (callId) void getRealtimeSocket().then(s => s.emit('call:leave', callId));
    router.back();
  };

  const videoTracks = groupTracks.filter(track => track.kind === 'video');
  const audioTracks = groupTracks.filter(track => track.kind === 'audio');
  const isVideoCall =
    call?.media === 'video' ||
    paramMedia === 'video' ||
    videoTracks.length > 0 ||
    (!cameraOff && Boolean(local?.getVideoTracks().length));
  const isGroup = call?.target.kind === 'group' || groupTracks.length > 0;
  const isDirect1on1Video = !isGroup && isVideoCall;
  const displayName = name || (isGroup ? 'Group Call' : 'ADDA Call');
  const participantIds = Array.from(new Set(groupTracks.map(t => t.userId)));

  // Compute WhatsApp-style smart responsive grid tile dimensions
  const getGridTileStyle = (index: number, total: number) => {
    if (total <= 1) {
      return styles.tileFull;
    }
    if (total === 2) {
      return styles.tileHalfVertical;
    }
    if (total === 3) {
      if (index === 0) return styles.tileHalfVertical;
      return styles.tileQuarter;
    }
    if (total === 4) {
      return styles.tileQuarter;
    }
    return styles.tileSixth;
  };

  return (
    <View style={styles.container}>
      {/* ========================================================
          VIDEO CONTENT (1:1 or WhatsApp Smart Adaptive Grid)
          ======================================================== */}
      {isVideoCall ? (
        <View style={styles.videoStage}>
          {isDirect1on1Video ? (
            // 1:1 Video Call
            remote && remote.getVideoTracks().length > 0 ? (
              <RTCView streamURL={remote.toURL()} style={StyleSheet.absoluteFill} objectFit="cover" zOrder={0} />
            ) : (
              <View style={styles.audioCenterStage}>
                <View style={styles.largeAvatarCircle}>
                  <Text style={styles.largeAvatarText}>{displayName[0]?.toUpperCase() || 'A'}</Text>
                </View>
                <Text style={styles.audioCallerName}>{displayName}</Text>
                <Text style={styles.audioCallTimer}>{status === 'Connected' ? (remote ? 'Camera off' : 'Connecting video…') : status}</Text>
              </View>
            )
          ) : participantIds.length > 0 ? (
            // Group Video Call: Dynamic full-screen grid
            <View style={styles.fullGridContainer}>
              {participantIds.map((userId, idx) => {
                const userVideo = videoTracks.find(t => t.userId === userId);
                const participantName = userNames[userId] || `User ${userId.slice(0, 4)}`;
                return (
                  <View key={userId} style={[styles.gridTile, getGridTileStyle(idx, participantIds.length)]}>
                    {userVideo ? (
                      <RTCView streamURL={userVideo.stream.toURL()} style={StyleSheet.absoluteFill} objectFit="cover" zOrder={0} />
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
                      <Text style={styles.tileBadgeText} numberOfLines={1}>
                        {participantName}
                      </Text>
                    </View>
                  </View>
                );
              })}
            </View>
          ) : (
            // Waiting for others to join in group call
            <View style={styles.audioCenterStage}>
              <View style={styles.largeAvatarCircle}>
                <Text style={styles.largeAvatarText}>{displayName[0]?.toUpperCase() || 'A'}</Text>
              </View>
              <Text style={styles.audioCallerName}>{displayName}</Text>
              <Text style={styles.audioCallTimer}>
                {status === 'Connected' ? 'Waiting for others to join…' : status}
              </Text>
            </View>
          )}

          {/* 1:1 or Group Floating PiP Preview (Top-Right) */}
          {local && (
            <Pressable onPress={flipCamera} style={[styles.pipContainer, { top: insets.top + 70 }]}>
              {!cameraOff && local.getVideoTracks().length > 0 ? (
                <RTCView streamURL={local.toURL()} style={StyleSheet.absoluteFill} objectFit="cover" mirror={true} zOrder={1} />
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
        /* ========================================================
           AUDIO CALL SMART GRID / CENTERING
           ======================================================== */
        <View style={styles.audioStage}>
          {participantIds.length > 1 ? (
            // Group Audio Grid (WhatsApp style full tiles)
            <View style={styles.fullGridContainer}>
              {participantIds.map((userId, idx) => {
                const participantName = userNames[userId] || `User ${userId.slice(0, 4)}`;
                return (
                  <View key={userId} style={[styles.audioGridTile, getGridTileStyle(idx, participantIds.length)]}>
                    <View style={styles.audioCardAvatar}>
                      <Text style={styles.audioCardAvatarText}>
                        {(participantName[0] || 'U').toUpperCase()}
                      </Text>
                    </View>
                    <Text style={styles.audioCardName} numberOfLines={1}>
                      {participantName}
                    </Text>
                  </View>
                );
              })}
            </View>
          ) : (
            // 1:1 Audio Call Central Display
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

      {/* ========================================================
          TOP HEADER OVERLAY (Call Info, Encrypted Badge, Timer)
          ======================================================== */}
      <View style={[styles.topHeader, { top: insets.top + 10 }]}>
        <View style={styles.headerInfoPill}>
          <View style={styles.encryptedRow}>
            <Lock size={12} color="#34D399" style={{ marginRight: 4 }} />
            <Text style={styles.encryptedText}>End-to-end encrypted</Text>
          </View>
          <Text style={styles.headerTitle} numberOfLines={1}>{displayName}</Text>
          <Text style={styles.headerSubtitle}>
            {status === 'Connected'
              ? `${formatDuration(callDuration)} • ${speakerOn ? '🔊 Loud Speaker' : isHeadsetConnected ? '🎧 Earphones' : '👂 Normal Speaker'}`
              : status}
          </Text>
        </View>
      </View>

      {/* ========================================================
          BOTTOM FLOATING ACTION BAR (WhatsApp Call Controls)
          ======================================================== */}
      <View style={[styles.bottomBarContainer, { bottom: Math.max(insets.bottom, 20) + 12 }]}>
        {routeToast && (
          <View style={styles.routeToastPill}>
            <Text style={styles.routeToastText}>{routeToast}</Text>
          </View>
        )}
        <View style={styles.bottomBarPill}>
          {/* Mute Button */}
          <Pressable
            accessibilityLabel={muted ? 'Unmute' : 'Mute'}
            onPress={toggleMute}
            style={[styles.controlBtn, muted && styles.controlBtnActiveRed]}
          >
            {muted ? <MicOff size={22} color="#FFFFFF" /> : <Mic size={22} color="#FFFFFF" />}
          </Pressable>

          {/* Video Toggle Button (Turn camera on/off - unhide/hide) */}
          <Pressable
            accessibilityLabel={cameraOff ? 'Turn camera on' : 'Turn camera off'}
            onPress={toggleCamera}
            style={[styles.controlBtn, cameraOff && styles.controlBtnActiveRed]}
          >
            {cameraOff ? <VideoOff size={22} color="#FFFFFF" /> : <Video size={22} color="#FFFFFF" />}
          </Pressable>

          {/* Flip Camera Button (when camera is on) */}
          {!cameraOff && (
            <Pressable
              accessibilityLabel="Flip camera"
              onPress={flipCamera}
              style={styles.controlBtn}
            >
              <SwitchCamera size={22} color="#FFFFFF" />
            </Pressable>
          )}

          {/* Speakerphone / Normal Speaker Toggle Button */}
          <Pressable
            accessibilityLabel={speakerOn ? 'Switch to normal speaker' : 'Switch to loud speaker'}
            onPress={toggleSpeaker}
            style={[
              styles.controlBtn,
              speakerOn ? styles.controlBtnActiveGreen : isHeadsetConnected ? styles.controlBtnActiveCyan : styles.controlBtn,
            ]}
          >
            {speakerOn ? (
              <Volume2 size={22} color="#FFFFFF" />
            ) : isHeadsetConnected ? (
              <Headphones size={22} color="#FFFFFF" />
            ) : (
              <Volume1 size={22} color="#FFFFFF" />
            )}
          </Pressable>

          {/* End Call Button */}
          <Pressable
            accessibilityLabel="End call"
            onPress={endCall}
            style={[styles.controlBtn, styles.hangupBtn]}
          >
            <PhoneOff size={24} color="#FFFFFF" />
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A1711',
  },
  videoStage: {
    ...StyleSheet.absoluteFill,
    backgroundColor: '#0A1711',
  },
  audioStage: {
    ...StyleSheet.absoluteFill,
    backgroundColor: '#0D2018',
  },
  fullGridContainer: {
    ...StyleSheet.absoluteFill,
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  gridTile: {
    backgroundColor: '#12251D',
    overflow: 'hidden',
    borderColor: '#0A1711',
    borderWidth: 1.5,
  },
  tileFull: {
    width: '100%',
    height: '100%',
  },
  tileHalfVertical: {
    width: '100%',
    height: '50%',
  },
  tileQuarter: {
    width: '50%',
    height: '50%',
  },
  tileSixth: {
    width: '50%',
    height: '33.33%',
  },
  tileBadge: {
    position: 'absolute',
    left: 10,
    bottom: 10,
    backgroundColor: 'rgba(0, 0, 0, 0.65)',
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 10,
  },
  tileBadgeText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
  },
  pipContainer: {
    position: 'absolute',
    right: 16,
    width: 105,
    height: 155,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: 'rgba(255, 255, 255, 0.45)',
    overflow: 'hidden',
    backgroundColor: '#183327',
    elevation: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
  },
  pipBadge: {
    position: 'absolute',
    bottom: 6,
    left: 6,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  pipBadgeText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '700',
  },
  pipCameraOffView: {
    ...StyleSheet.absoluteFill,
    backgroundColor: '#0F261C',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  pipCameraOffText: {
    color: '#8E9BA8',
    fontSize: 9,
    fontWeight: '600',
  },
  audioCardAvatarTile: {
    ...StyleSheet.absoluteFill,
    backgroundColor: '#12251D',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cameraOffPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    marginTop: 6,
  },
  cameraOffPillText: {
    color: '#D1D5DB',
    fontSize: 11,
    fontWeight: '600',
  },
  audioCenterStage: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pulseRing: {
    width: 150,
    height: 150,
    borderRadius: 75,
    backgroundColor: 'rgba(38, 166, 122, 0.15)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 24,
  },
  largeAvatarCircle: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: '#1C3D2F',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 3,
    borderColor: '#34D399',
  },
  largeAvatarText: {
    color: '#FFFFFF',
    fontSize: 54,
    fontWeight: '700',
  },
  audioCallerName: {
    color: '#FFFFFF',
    fontSize: 26,
    fontWeight: '800',
    marginBottom: 8,
    textAlign: 'center',
  },
  audioCallTimer: {
    color: '#34D399',
    fontSize: 16,
    fontWeight: '600',
  },
  audioGridTile: {
    backgroundColor: '#142920',
    alignItems: 'center',
    justifyContent: 'center',
    borderColor: '#0A1711',
    borderWidth: 1.5,
  },
  audioCardAvatar: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: '#204334',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#34D399',
    marginBottom: 10,
  },
  audioCardAvatarText: {
    color: '#FFFFFF',
    fontSize: 30,
    fontWeight: '700',
  },
  audioCardName: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
    maxWidth: '80%',
    textAlign: 'center',
  },
  topHeader: {
    position: 'absolute',
    left: 20,
    right: 20,
    alignItems: 'center',
  },
  headerInfoPill: {
    backgroundColor: 'rgba(10, 23, 17, 0.78)',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 8,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  encryptedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 2,
  },
  encryptedText: {
    color: '#34D399',
    fontSize: 11,
    fontWeight: '600',
  },
  headerTitle: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '800',
    textAlign: 'center',
  },
  headerSubtitle: {
    color: 'rgba(255, 255, 255, 0.75)',
    fontSize: 13,
    fontWeight: '600',
    marginTop: 2,
  },
  bottomBarContainer: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  bottomBarPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(13, 28, 21, 0.92)',
    borderRadius: 36,
    paddingHorizontal: 18,
    paddingVertical: 12,
    gap: 16,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.15)',
    elevation: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 8,
  },
  controlBtn: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  controlBtnActiveRed: {
    backgroundColor: '#EF4444',
  },
  controlBtnActiveGreen: {
    backgroundColor: '#059669',
  },
  controlBtnActiveCyan: {
    backgroundColor: '#0284C7',
  },
  hangupBtn: {
    backgroundColor: '#DC2626',
    width: 54,
    height: 54,
    borderRadius: 27,
  },
  routeToastPill: {
    backgroundColor: 'rgba(10, 23, 17, 0.90)',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 8,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#34D399',
    alignSelf: 'center',
  },
  routeToastText: {
    color: '#34D399',
    fontSize: 13,
    fontWeight: '700',
  },
});
