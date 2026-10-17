import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useVideoPlayer, VideoView } from 'expo-video';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useFocusEffect, useLocalSearchParams, type Href } from 'expo-router';
import { ArrowLeft, LockKeyhole, Paperclip, Phone, Send, Video } from 'lucide-react-native';
import { colors } from '@/constants/theme';
import { socialApi, type ChatGroup, type OwnProfile, type PublicProfile } from '@/lib/social-api';
import { getRealtimeSocket, type ChatTarget, type TypingEvent } from '@/lib/realtime';
import { chatSafetyCode, initEncryptedChat, localMessages, markChatRead, mediaFromBody, onChatChanged, openEncryptedMedia, releaseDecryptedMedia, sendEncryptedMedia, sendEncryptedMessage, syncEncryptedChat, type EncryptedMedia, type LocalMessage } from '@/lib/encrypted-chat';
import { callRequest, type CallInfo, type CallMedia } from '@/lib/calls';
import { TypingDots } from '@/components/ui/TypingDots';

export default function ConversationScreen() {
  const { kind, id, name } = useLocalSearchParams<{ kind?: string; id?: string; name?: string }>();
  const [chatTitle, setChatTitle] = useState(name || '');
  const [selfId, setSelfId] = useState('');
  const [selfName, setSelfName] = useState('');
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [typingNames, setTypingNames] = useState<Record<string, string>>({});
  const list = useRef<ScrollView>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingExpiry = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const lastTyping = useRef(0);
  const draftRef = useRef('');
  const typingRevision = useRef(0);
  const valid = (kind === 'direct' || kind === 'group') && typeof id === 'string' && id.length > 0;
  const target: ChatTarget | null = useMemo(() => valid ? { kind: kind as ChatTarget['kind'], id: id as string } : null, [valid, kind, id]);

  useEffect(() => {
    if (name) setChatTitle(name);
  }, [name]);

  const load = useCallback(async () => {
    if (!target) return;
    try {
      const me = await socialApi<OwnProfile>('/me');
      await initEncryptedChat(me.id);
      setSelfId(me.id);
      setSelfName(me.name);
      const local = await localMessages(target);
      setMessages(local);
      if (!name) {
        if (target.kind === 'direct') {
          const fromOther = local.find(m => m.senderId === target.id && m.senderName);
          if (fromOther?.senderName) {
            setChatTitle(fromOther.senderName);
          } else {
            void socialApi<PublicProfile[]>('/contacts').then(contacts => {
              const match = contacts.find(c => c.id === target.id);
              if (match?.name) setChatTitle(match.name);
            }).catch(() => {});
          }
        } else if (target.kind === 'group') {
          void socialApi<ChatGroup[]>('/groups').then(groups => {
            const match = groups.find(g => g.id === target.id);
            if (match?.name) setChatTitle(match.name);
          }).catch(() => {});
        }
      }
      try { await syncEncryptedChat(); } catch (e) { console.warn('Sync warning:', e); }
      const refreshed = await localMessages(target);
      setMessages(refreshed);
      if (!name && target.kind === 'direct') {
        const fromOther = refreshed.find(m => m.senderId === target.id && m.senderName);
        if (fromOther?.senderName) setChatTitle(fromOther.senderName);
      }
      await markChatRead(target).catch(() => {});
      setError('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load messages.'); }
  }, [target, name]);
  useFocusEffect(useCallback(() => { void load(); }, [load]));
  useEffect(() => onChatChanged(() => { if (target) void localMessages(target).then(setMessages).catch(() => {}); }), [target]);
  useEffect(() => {
    if (!target) return;
    let active = true;
    let live: Awaited<ReturnType<typeof getRealtimeSocket>> | null = null;
    const expiry = typingExpiry.current;
    const revision = typingRevision;
    const onEncryptedUpdate = () => { void syncEncryptedChat().then(() => markChatRead(target)).catch(error => setError(error instanceof Error ? error.message : 'Could not sync chat.')); };
    const onTyping = (event: TypingEvent) => {
      if (event.kind !== target.kind || event.id !== target.id || event.userId === selfId) return;
      const old = typingExpiry.current.get(event.userId);
      if (old) clearTimeout(old);
      if (!event.typing) {
        typingExpiry.current.delete(event.userId);
        setTypingNames(current => { const next = { ...current }; delete next[event.userId]; return next; });
        return;
      }
      setTypingNames(current => ({ ...current, [event.userId]: event.name }));
      typingExpiry.current.set(event.userId, setTimeout(() => {
        typingExpiry.current.delete(event.userId);
        setTypingNames(current => { const next = { ...current }; delete next[event.userId]; return next; });
      }, 4000));
    };
    const onConnect = () => {
      live?.timeout(5000).emit('chat:join', target, (error: Error | null, reply?: { ok: boolean }) => {
        if (!error && reply?.ok && draftRef.current.trim()) { live?.emit('chat:typing', { target, typing: true }); lastTyping.current = Date.now(); }
      });
      void load();
    };
    const onDisconnect = () => { setTypingNames({}); for (const timer of expiry.values()) clearTimeout(timer); expiry.clear(); lastTyping.current = 0; };
    void getRealtimeSocket().then(value => {
      if (!active) return;
      live = value;
      value.on('chat:encrypted:update', onEncryptedUpdate);
      value.on('chat:typing', onTyping);
      value.on('connect', onConnect);
      value.on('disconnect', onDisconnect);
      if (value.connected) onConnect();
    }).catch(error => setError(error instanceof Error ? error.message : 'Live chat unavailable.'));
    return () => {
      active = false;
      revision.current++;
      if (typingTimer.current) clearTimeout(typingTimer.current);
      for (const timer of expiry.values()) clearTimeout(timer);
      expiry.clear();
      live?.emit('chat:typing', { target, typing: false });
      live?.emit('chat:leave', target);
      live?.off('chat:encrypted:update', onEncryptedUpdate);
      live?.off('chat:typing', onTyping);
      live?.off('connect', onConnect);
      live?.off('disconnect', onDisconnect);
    };
  }, [target, selfId, load]);

  const onDraftChange = (value: string) => {
    setDraft(value);
    draftRef.current = value;
    const revision = ++typingRevision.current;
    if (!target) return;
    void getRealtimeSocket().then(live => {
      if (revision !== typingRevision.current) return;
      if (typingTimer.current) clearTimeout(typingTimer.current);
      if (!value.trim()) { live.emit('chat:typing', { target, typing: false }); lastTyping.current = 0; return; }
      if (Date.now() - lastTyping.current > 1500) {
        live.volatile.emit('chat:typing', { target, typing: true });
        lastTyping.current = Date.now();
      }
      typingTimer.current = setTimeout(() => { live.emit('chat:typing', { target, typing: false }); lastTyping.current = 0; }, 2500);
    }).catch(() => {});
  };
  const send = async () => {
    const body = draft.trim();
    if (!target || !body || sending) return;
    setSending(true); setError('');
    try {
      const senderName = selfName || (await socialApi<OwnProfile>('/me')).name;
      const message = await sendEncryptedMessage(target, body, senderName);
      setMessages(current => current.some(item => item.id === message.id) ? current : [...current, message]);
      onDraftChange('');
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not send message.'); }
    finally { setSending(false); }
  };
  const attach = async () => {
    if (!target || sending) return;
    const selection = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images', 'videos'], allowsMultipleSelection: false, quality: 0.65 });
    if (selection.canceled || !selection.assets[0]) return;
    const asset = selection.assets[0];
    setSending(true); setError('');
    try {
      const senderName = selfName || (await socialApi<OwnProfile>('/me')).name;
      const sent = await sendEncryptedMedia(target, asset.uri, asset.type === 'video' ? 'video' : 'image', asset.mimeType ?? (asset.type === 'video' ? 'video/mp4' : 'image/jpeg'), senderName);
      setMessages(current => current.some(item => item.id === sent.id) ? current : [...current, sent]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not share encrypted media.'); }
    finally { setSending(false); }
  };
  const handleBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/home');
  };
  const activeTitle = chatTitle || name || (kind === 'group' ? 'Group' : 'Chat');

  const startCall = async (media: CallMedia) => {
    if (!target) return;
    setError('');
    try {
      const call = await callRequest<CallInfo>('call:start', { target, media });
      router.push({ pathname: '/call', params: { callId: call.id, role: call.callerId === selfId ? 'caller' : 'callee', name: activeTitle } } as unknown as Href);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not start call.'); }
  };
  const showSafetyCode = async () => {
    if (!target) return;
    try {
      const code = await chatSafetyCode(target);
      Alert.alert('Compare chat keys', `${code}\n\nCompare this code with the other people in this chat through a trusted channel. If it differs, do not share sensitive messages.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not check chat keys.'); }
  };
  return <SafeAreaView style={styles.safe}>
    <View style={styles.top}><Pressable accessibilityLabel="Back" onPress={handleBack} style={styles.back}><ArrowLeft size={24} color={colors.text} /></Pressable><View style={styles.avatar}><Text style={styles.initial}>{activeTitle[0]?.toUpperCase() || '?'}</Text></View><View style={styles.titleWrap}><Text style={styles.title}>{activeTitle}</Text><View style={styles.subtitleRow}><Text style={[styles.subtitle, Object.keys(typingNames).length > 0 && styles.typingSubtitle]}>{Object.keys(typingNames).length ? `${Object.values(typingNames).slice(0, 2).join(', ')} typing` : kind === 'group' ? 'Group' : 'Contact'}</Text>{Object.keys(typingNames).length > 0 && <TypingDots />}</View></View><Pressable accessibilityLabel="Compare encryption keys" onPress={() => void showSafetyCode()} style={styles.callAction}><LockKeyhole size={19} color={colors.primary} /></Pressable><Pressable accessibilityLabel="Voice call" onPress={() => void startCall('audio')} style={styles.callAction}><Phone size={20} color={colors.primary} /></Pressable><Pressable accessibilityLabel="Video call" onPress={() => void startCall('video')} style={styles.callAction}><Video size={22} color={colors.primary} /></Pressable></View>
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={Platform.OS === 'ios' ? 20 : 0}>
      <ScrollView ref={list} contentContainerStyle={styles.messages} onContentSizeChange={() => list.current?.scrollToEnd({ animated: false })}>
        {messages.length === 0 && !error && <View style={styles.empty}><Text style={styles.emptyTitle}>Start the conversation</Text><Text style={styles.emptyText}>New messages are encrypted and saved on this phone.</Text></View>}
        {messages.map((item) => {
          const mine = item.senderId === selfId;
          const media = mediaFromBody(item.body);
          return (
            <View key={item.id} style={[styles.bubble, mine ? styles.myBubble : styles.theirBubble, media && styles.mediaBubble]}>
              {kind === 'group' && !mine && <Text style={styles.sender}>{item.senderName}</Text>}
              {media ? <MediaMessage media={media} /> : <Text style={styles.body}>{item.body}</Text>}
              <View style={[styles.messageFooter, media && styles.mediaFooter]}>
                <Text style={styles.messageTime}>{new Date(item.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</Text>
                {mine && <Text accessibilityLabel={item.status === 'read' ? 'Read' : item.status === 'delivered' ? 'Delivered' : item.status === 'sent' ? 'Sent' : 'Pending'} style={[styles.tick, item.status === 'read' && styles.readTick]}>{item.status === 'read' || item.status === 'delivered' ? '✓✓' : item.status === 'sent' ? '✓' : '○'}</Text>}
              </View>
            </View>
          );
        })}
        {Object.keys(typingNames).length > 0 && <View style={styles.typingBubble}><TypingDots /></View>}
      </ScrollView>
      {!!error && <Text style={styles.error}>{error}</Text>}
      <View style={styles.composer}><Pressable accessibilityLabel="Attach photo or video" disabled={sending} onPress={() => void attach()} style={styles.attach}><Paperclip size={23} color={colors.primary} /></Pressable><TextInput style={styles.input} placeholder="Message" placeholderTextColor={colors.muted} value={draft} onChangeText={onDraftChange} multiline maxLength={2000} /><Pressable accessibilityLabel="Send message" disabled={!draft.trim() || sending} onPress={() => void send()} style={[styles.send, (!draft.trim() || sending) && styles.disabled]}><Send size={20} color="#FFFFFF" /></Pressable></View>
    </KeyboardAvoidingView>
  </SafeAreaView>;
}

function MediaMessage({ media }: { media: EncryptedMedia }) {
  const [uri, setUri] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    openEncryptedMedia(media)
      .then(fileUri => {
        if (active) {
          setUri(fileUri);
          setLoading(false);
        }
      })
      .catch(cause => {
        if (active) {
          setError(cause instanceof Error ? cause.message : 'Could not load media.');
          setLoading(false);
        }
      });
    return () => { active = false; };
  }, [media.mediaId]);

  if (loading) {
    return (
      <View style={styles.mediaLoading}>
        <ActivityIndicator size="small" color={colors.primary} />
        <Text style={styles.mediaLoadingText}>Loading {media.mediaKind}...</Text>
      </View>
    );
  }

  if (uri) {
    return media.mediaKind === 'image' ? (
      <Image
        source={{ uri }}
        style={styles.mediaImage}
        resizeMode="cover"
        onError={(e) => {
          console.warn('Image render failed:', e.nativeEvent);
          setError('Could not display image.');
          setUri(null);
        }}
      />
    ) : (
      <InlineVideo uri={uri} />
    );
  }

  return (
    <Pressable
      onPress={() => {
        setLoading(true);
        setError('');
        openEncryptedMedia(media)
          .then(setUri)
          .catch(cause => setError(cause instanceof Error ? cause.message : 'Could not load media.'))
          .finally(() => setLoading(false));
      }}
      style={styles.mediaButton}
    >
      <Text style={styles.mediaLabel}>{error || `Tap to retry ${media.mediaKind}`}</Text>
    </Pressable>
  );
}

function InlineVideo({ uri }: { uri: string }) {
  const player = useVideoPlayer(uri);
  return <VideoView player={player} nativeControls style={styles.mediaImage} />;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background }, flex: { flex: 1 }, top: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 66, paddingHorizontal: 14, backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border }, back: { padding: 5 }, avatar: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primarySoft }, initial: { color: colors.primaryDark, fontWeight: '800', fontSize: 18 }, titleWrap: { flex: 1 }, title: { color: colors.text, fontWeight: '800', fontSize: 17 }, subtitleRow: { flexDirection: 'row', alignItems: 'center', gap: 5 }, subtitle: { color: colors.muted, fontSize: 11, marginTop: 2 }, typingSubtitle: { color: colors.primary, fontWeight: '700' }, callAction: { padding: 6 },
  messages: { flexGrow: 1, paddingHorizontal: 15, paddingVertical: 20, justifyContent: 'flex-end', gap: 9 }, empty: { alignItems: 'center', marginBottom: 45 }, emptyTitle: { color: colors.text, fontWeight: '800', fontSize: 18 }, emptyText: { color: colors.muted, marginTop: 7, textAlign: 'center' },
  bubble: { maxWidth: '83%', borderRadius: 17, paddingHorizontal: 13, paddingVertical: 10, minWidth: 90 }, myBubble: { backgroundColor: colors.primarySoft, alignSelf: 'flex-end', borderBottomRightRadius: 4 }, theirBubble: { backgroundColor: colors.surface, alignSelf: 'flex-start', borderBottomLeftRadius: 4, borderWidth: 1, borderColor: colors.border }, sender: { color: colors.primaryDark, fontWeight: '800', fontSize: 12, marginBottom: 4 }, body: { color: colors.text, fontSize: 15, lineHeight: 20 }, messageTime: { color: colors.muted, fontSize: 10, alignSelf: 'flex-end', marginTop: 4 },
  typingBubble: { alignSelf: 'flex-start', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 17, borderBottomLeftRadius: 4, paddingHorizontal: 15, paddingVertical: 12 },
  error: { color: colors.error, paddingHorizontal: 17, paddingVertical: 6 }, composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 10, paddingHorizontal: 14, paddingVertical: 10, backgroundColor: colors.surface }, attach: { width: 34, height: 44, alignItems: 'center', justifyContent: 'center' }, input: { flex: 1, minHeight: 44, maxHeight: 120, borderRadius: 22, paddingHorizontal: 17, paddingVertical: 10, backgroundColor: colors.surfaceRaised, color: colors.text, fontSize: 15 }, send: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' }, disabled: { opacity: 0.45 },
  messageFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 4, marginTop: 4 }, tick: { color: colors.muted, fontSize: 12, fontWeight: '800' }, readTick: { color: '#2897D5' }, mediaButton: { minWidth: 160, minHeight: 80, justifyContent: 'center', alignItems: 'center' }, mediaLabel: { color: colors.primary, fontSize: 13, fontWeight: '700' }, mediaImage: { width: 230, height: 230, borderRadius: 13, backgroundColor: '#111827' },
  mediaLoading: { width: 230, height: 160, borderRadius: 13, backgroundColor: colors.surfaceRaised, justifyContent: 'center', alignItems: 'center', gap: 8 },
  mediaLoadingText: { color: colors.muted, fontSize: 12, fontWeight: '600' },
  mediaBubble: { paddingHorizontal: 6, paddingTop: 6, paddingBottom: 6 },
  mediaFooter: { marginRight: 6, marginTop: 4 },
});
