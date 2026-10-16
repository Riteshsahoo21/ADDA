import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Mic, MicOff, PhoneOff, Video, VideoOff } from 'lucide-react-native';
import { mediaDevices, RTCIceCandidate, RTCPeerConnection, RTCSessionDescription, RTCView, type MediaStream } from 'react-native-webrtc';
import { colors } from '@/constants/theme';
import { callRequest, type CallInfo } from '@/lib/calls';
import { getRealtimeSocket } from '@/lib/realtime';
import { socialApi } from '@/lib/social-api';
import { GroupMedia, type RemoteTrack } from '@/lib/group-media';

type Signal = { type: 'offer' | 'answer'; sdp: string } | { candidate: object };

export default function CallScreen() {
  const { callId, role, name } = useLocalSearchParams<{ callId?: string; role?: string; name?: string }>();
  const [call, setCall] = useState<CallInfo | null>(null);
  const [status, setStatus] = useState(callId ? 'Connecting…' : 'Call unavailable.');
  const [local, setLocal] = useState<MediaStream | null>(null);
  const [remote, setRemote] = useState<MediaStream | null>(null);
  const [groupTracks, setGroupTracks] = useState<RemoteTrack[]>([]);
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const mutedRef = useRef(false);
  const cameraOffRef = useRef(false);
  const pc = useRef<RTCPeerConnection | null>(null);
  const localRef = useRef<MediaStream | null>(null);
  const pendingCandidates = useRef<RTCIceCandidate[]>([]);
  const pendingSignals = useRef<{ callId: string; from: string; signal: Signal }[]>([]);
  const offered = useRef(false);
  const ending = useRef(false);
  const relayStarted = useRef(false);
  const groupMedia = useRef<GroupMedia | null>(null);
  const pendingPeer = useRef<string | null>(null);

  useEffect(() => {
    if (!callId) return;
    let active = true;
    let socket: Awaited<ReturnType<typeof getRealtimeSocket>> | null = null;
    let currentCall: CallInfo | null = null;
    let connectionTimer: ReturnType<typeof setTimeout> | null = null;
    const clearConnectionTimer = () => { if (connectionTimer) clearTimeout(connectionTimer); connectionTimer = null; };
    const startRelay = async () => {
      if (!currentCall || relayStarted.current || !active) return;
      relayStarted.current = true;
      clearConnectionTimer();
      pc.current?.close(); pc.current = null;
      localRef.current?.getTracks().forEach(track => track.stop()); localRef.current = null;
      setLocal(null); setRemote(null); setStatus('Connecting through ADDA server…');
      try {
        const media = new GroupMedia(tracks => { if (active) setGroupTracks(tracks); }, message => { if (active) setStatus(message); });
        groupMedia.current = media;
        media.setMuted(mutedRef.current);
        media.setCameraOff(cameraOffRef.current);
        await media.join({ kind: 'call', id: callId }, currentCall.media === 'video');
        if (active) { setLocal(media.local); setStatus('Connected through ADDA server'); }
      } catch (error) { if (active) setStatus(error instanceof Error ? error.message : 'Call relay unavailable.'); }
    };
    const requestRelay = () => { if (currentCall && !relayStarted.current) socket?.emit('call:relay', callId); };
    const onRelay = (event: { callId: string }) => { if (event.callId === callId) void startRelay(); };
    const close = (leave: boolean) => {
      if (ending.current) return;
      ending.current = true;
      clearConnectionTimer();
      if (leave) socket?.emit('call:leave', callId);
      pc.current?.close(); pc.current = null;
      groupMedia.current?.close(); groupMedia.current = null;
      localRef.current?.getTracks().forEach(track => track.stop()); localRef.current = null;
      if (active) router.back();
    };
    const sendSignal = (to: string, signal: Signal) => socket?.emit('call:signal', { callId, to, signal });
    const startOffer = async (peerId: string) => {
      if (!pc.current || offered.current) return;
      offered.current = true;
      try {
        const offer = await pc.current.createOffer();
        await pc.current.setLocalDescription(offer);
        sendSignal(peerId, { type: 'offer', sdp: offer.sdp ?? '' });
        clearConnectionTimer();
        connectionTimer = setTimeout(requestRelay, 15_000);
      } catch (error) { if (active) setStatus(error instanceof Error ? error.message : 'Could not start media.'); }
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
        pendingPeer.current = event.userId;
        if (pc.current) void startOffer(event.userId);
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
        socket.on('call:ended', onEnded);
        socket.on('call:relay', onRelay);
        const joined = await callRequest<CallInfo>('call:join', callId);
        if (!active) return;
        currentCall = joined;
        setCall(joined);
        if (joined.usingRelay) { await startRelay(); return; }
        if (joined.target.kind === 'group') {
          const media = new GroupMedia(tracks => { if (active) setGroupTracks(tracks); }, message => { if (active) setStatus(message); });
          groupMedia.current = media;
          media.setMuted(mutedRef.current);
          media.setCameraOff(cameraOffRef.current);
          await media.join({ kind: 'call', id: joined.id }, joined.media === 'video');
          if (!active) return;
          setLocal(media.local);
          setStatus('Connected');
          return;
        }
        const config = await socialApi<{ iceServers: { urls: string; username?: string; credential?: string }[] }>('/calls/ice');
        const stream = await mediaDevices.getUserMedia({ audio: true, video: joined.media === 'video' });
        if (!active) { stream.getTracks().forEach(track => track.stop()); return; }
        stream.getAudioTracks().forEach(track => { track.enabled = !mutedRef.current; });
        stream.getVideoTracks().forEach(track => { track.enabled = !cameraOffRef.current; });
        localRef.current = stream; setLocal(stream);
        const peer = new RTCPeerConnection({ iceServers: config.iceServers });
        pc.current = peer;
        stream.getTracks().forEach(track => peer.addTrack(track, stream));
        // This package exposes EventTarget at runtime, but its current TS declaration omits the inherited method.
        const listen = peer as unknown as { addEventListener: (type: string, listener: (event: { candidate?: RTCIceCandidate; streams?: MediaStream[] }) => void) => void };
        listen.addEventListener('icecandidate', event => {
          if (event.candidate) sendSignal(role === 'caller' ? joined.target.id : joined.callerId, { candidate: event.candidate.toJSON() });
        });
        listen.addEventListener('track', event => {
          const stream = event.streams?.[0];
          if (stream && active) setRemote(stream);
        });
        listen.addEventListener('connectionstatechange', () => {
          if (!active || relayStarted.current) return;
          if (peer.connectionState === 'connected') { clearConnectionTimer(); setStatus('Connected'); }
          else if (peer.connectionState === 'failed') requestRelay();
          else if (peer.connectionState === 'disconnected') { clearConnectionTimer(); connectionTimer = setTimeout(requestRelay, 5000); setStatus('Reconnecting…'); }
          else setStatus('Connecting…');
        });
        for (const signal of pendingSignals.current.splice(0)) await onSignal(signal);
        if (role === 'caller' && (pendingPeer.current || joined.joined.length > 1)) void startOffer(pendingPeer.current || joined.joined.find(id => id !== joined.callerId)!);
        else setStatus(role === 'caller' ? 'Calling…' : 'Connecting…');
      } catch (error) { if (active) setStatus(error instanceof Error ? error.message : 'Call failed.'); }
    })();
    return () => {
      active = false;
      socket?.off('call:signal', onSignal);
      socket?.off('call:participant-joined', onJoined);
      socket?.off('call:ended', onEnded);
      socket?.off('call:relay', onRelay);
      clearConnectionTimer();
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
  };
  const toggleCamera = () => {
    const next = !cameraOffRef.current;
    cameraOffRef.current = next;
    localRef.current?.getVideoTracks().forEach(track => { track.enabled = !next; });
    groupMedia.current?.setCameraOff(next);
    setCameraOff(next);
  };
  const endCall = () => { if (callId) void getRealtimeSocket().then(socket => socket.emit('call:leave', callId)); router.back(); };
  return <SafeAreaView style={styles.safe}>
    <Text style={styles.name}>{name || (call?.target.kind === 'group' ? 'Group call' : 'ADDA call')}</Text>
    <Text style={styles.status}>{status}</Text>
    {remote && call?.media === 'video' && <RTCView streamURL={remote.toURL()} style={styles.remote} objectFit="cover" />}
    {call?.media === 'video' && <View style={styles.groupGrid}>{groupTracks.filter(track => track.kind === 'video').map(track => <View key={track.producerId} style={styles.groupTile}><RTCView streamURL={track.stream.toURL()} style={styles.groupVideo} objectFit="cover" /><Text style={styles.groupLabel}>{track.userId.slice(0, 8)}</Text></View>)}</View>}
    {!remote && groupTracks.filter(track => track.kind === 'video').length === 0 && <View style={styles.waiting}><Text style={styles.waitingText}>{name?.[0]?.toUpperCase() || 'A'}</Text></View>}
    {local && call?.media === 'video' && !cameraOff && <RTCView streamURL={local.toURL()} style={styles.local} objectFit="cover" mirror />}
    <View style={styles.controls}>
      <Pressable accessibilityLabel={muted ? 'Unmute' : 'Mute'} onPress={toggleMute} style={styles.control}>{muted ? <MicOff color={colors.text} /> : <Mic color={colors.text} />}</Pressable>
      {call?.media === 'video' && <Pressable accessibilityLabel={cameraOff ? 'Turn camera on' : 'Turn camera off'} onPress={toggleCamera} style={styles.control}>{cameraOff ? <VideoOff color={colors.text} /> : <Video color={colors.text} />}</Pressable>}
      <Pressable accessibilityLabel="End call" onPress={endCall} style={[styles.control, styles.hangup]}><PhoneOff color="#FFFFFF" /></Pressable>
    </View>
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#11251D', alignItems: 'center', paddingTop: 34 },
  name: { color: '#FFFFFF', fontSize: 26, fontWeight: '800' }, status: { color: '#B9D3C4', fontSize: 14, marginTop: 8 },
  remote: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
  waiting: { width: 170, height: 170, borderRadius: 85, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center', marginTop: '30%' },
  waitingText: { color: '#FFFFFF', fontSize: 72, fontWeight: '700' },
  local: { position: 'absolute', right: 20, top: 100, width: 115, height: 160, borderRadius: 14, overflow: 'hidden' },
  groupGrid: { position: 'absolute', top: 110, left: 12, right: 12, bottom: 125, flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignContent: 'center', justifyContent: 'center' },
  groupTile: { width: '47%', height: 190, backgroundColor: '#1F3B2D', borderRadius: 14, overflow: 'hidden' },
  groupVideo: { flex: 1 }, groupLabel: { color: '#FFFFFF', fontWeight: '700', position: 'absolute', left: 8, bottom: 7 },
  controls: { position: 'absolute', bottom: 45, flexDirection: 'row', gap: 20 },
  control: { width: 62, height: 62, borderRadius: 31, alignItems: 'center', justifyContent: 'center', backgroundColor: '#E4EEE8' },
  hangup: { backgroundColor: '#DA3D3D' },
});
