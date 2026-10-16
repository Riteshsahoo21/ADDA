import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useFocusEffect, useLocalSearchParams, type Href } from 'expo-router';
import { ArrowLeft, Phone, Send, Video } from 'lucide-react-native';
import { colors } from '@/constants/theme';
import { socialApi, type ChatMessage, type OwnProfile } from '@/lib/social-api';
import { getRealtimeSocket, makeClientMessageId, sendLiveMessage, type ChatTarget, type LiveMessage, type TypingEvent } from '@/lib/realtime';
import { callRequest, type CallInfo, type CallMedia } from '@/lib/calls';
import { TypingDots } from '@/components/ui/TypingDots';

export default function ConversationScreen() {
  const { kind, id, name } = useLocalSearchParams<{ kind?: string; id?: string; name?: string }>();
  const [selfId, setSelfId] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
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
  const pendingClientId = useRef<string | null>(null);
  const valid = (kind === 'direct' || kind === 'group') && typeof id === 'string' && id.length > 0;
  const path = `/chats/${kind}/${id}`;
  const target: ChatTarget | null = useMemo(() => valid ? { kind: kind as ChatTarget['kind'], id: id as string } : null, [valid, kind, id]);
  const load = useCallback(async () => {
    if (!valid) return;
    try {
      const [me, items] = await Promise.all([socialApi<OwnProfile>('/me'), socialApi<ChatMessage[]>(path)]);
      setSelfId(me.id); setMessages(items); setError('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load messages.'); }
  }, [path, valid]);
  useFocusEffect(useCallback(() => { void load(); }, [load]));
  useEffect(() => {
    if (!target) return;
    let active = true;
    let live: Awaited<ReturnType<typeof getRealtimeSocket>> | null = null;
    const expiry = typingExpiry.current;
    const revision = typingRevision;
    const matches = (message: LiveMessage) => message.kind === target.kind && message.targetId === target.id;
    const onMessage = (message: LiveMessage) => {
      if (!matches(message)) return;
      setMessages(current => current.some(item => item.id === message.id) ? current : [...current, message]);
      setTypingNames(current => { const next = { ...current }; delete next[message.senderId]; return next; });
    };
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
      value.on('chat:message', onMessage);
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
      live?.off('chat:message', onMessage);
      live?.off('chat:typing', onTyping);
      live?.off('connect', onConnect);
      live?.off('disconnect', onDisconnect);
    };
  }, [target, selfId, load]);

  const onDraftChange = (value: string) => {
    if (value !== draft) pendingClientId.current = null;
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
      pendingClientId.current ??= makeClientMessageId();
      const message = await sendLiveMessage(target, body, pendingClientId.current);
      setMessages(current => current.some(item => item.id === message.id) ? current : [...current, message]);
      pendingClientId.current = null;
      onDraftChange('');
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not send message.'); }
    finally { setSending(false); }
  };
  const startCall = async (media: CallMedia) => {
    if (!target) return;
    setError('');
    try {
      const call = await callRequest<CallInfo>('call:start', { target, media });
      router.push({ pathname: '/call', params: { callId: call.id, role: call.callerId === selfId ? 'caller' : 'callee', name: name || 'ADDA call' } } as unknown as Href);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not start call.'); }
  };
  return <SafeAreaView style={styles.safe}>
    <View style={styles.top}><Pressable accessibilityLabel="Back" onPress={() => router.back()} style={styles.back}><ArrowLeft size={24} color={colors.text} /></Pressable><View style={styles.avatar}><Text style={styles.initial}>{name?.[0]?.toUpperCase() || '?'}</Text></View><View style={styles.titleWrap}><Text style={styles.title}>{name || 'Chat'}</Text><View style={styles.subtitleRow}><Text style={[styles.subtitle, Object.keys(typingNames).length > 0 && styles.typingSubtitle]}>{Object.keys(typingNames).length ? `${Object.values(typingNames).slice(0, 2).join(', ')} typing` : kind === 'group' ? 'Group' : 'Contact'}</Text>{Object.keys(typingNames).length > 0 && <TypingDots />}</View></View><Pressable accessibilityLabel="Voice call" onPress={() => void startCall('audio')} style={styles.callAction}><Phone size={20} color={colors.primary} /></Pressable><Pressable accessibilityLabel="Video call" onPress={() => void startCall('video')} style={styles.callAction}><Video size={22} color={colors.primary} /></Pressable></View>
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={Platform.OS === 'ios' ? 20 : 0}>
      <ScrollView ref={list} contentContainerStyle={styles.messages} onContentSizeChange={() => list.current?.scrollToEnd({ animated: false })}>
        {messages.length === 0 && !error && <View style={styles.empty}><Text style={styles.emptyTitle}>Start the conversation</Text><Text style={styles.emptyText}>Messages in this chat are stored in ADDA.</Text></View>}
        {messages.map((item) => {
          const mine = item.senderId === selfId;
          return <View key={item.id} style={[styles.bubble, mine ? styles.myBubble : styles.theirBubble]}>{kind === 'group' && !mine && <Text style={styles.sender}>{item.senderName}</Text>}<Text style={styles.body}>{item.body}</Text><Text style={styles.messageTime}>{new Date(item.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</Text></View>;
        })}
        {Object.keys(typingNames).length > 0 && <View style={styles.typingBubble}><TypingDots /></View>}
      </ScrollView>
      {!!error && <Text style={styles.error}>{error}</Text>}
      <View style={styles.composer}><TextInput style={styles.input} placeholder="Message" placeholderTextColor={colors.muted} value={draft} onChangeText={onDraftChange} multiline maxLength={2000} /><Pressable accessibilityLabel="Send message" disabled={!draft.trim() || sending} onPress={() => void send()} style={[styles.send, (!draft.trim() || sending) && styles.disabled]}><Send size={20} color="#FFFFFF" /></Pressable></View>
    </KeyboardAvoidingView>
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background }, flex: { flex: 1 }, top: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 66, paddingHorizontal: 14, backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border }, back: { padding: 5 }, avatar: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primarySoft }, initial: { color: colors.primaryDark, fontWeight: '800', fontSize: 18 }, titleWrap: { flex: 1 }, title: { color: colors.text, fontWeight: '800', fontSize: 17 }, subtitleRow: { flexDirection: 'row', alignItems: 'center', gap: 5 }, subtitle: { color: colors.muted, fontSize: 11, marginTop: 2 }, typingSubtitle: { color: colors.primary, fontWeight: '700' }, callAction: { padding: 6 },
  messages: { flexGrow: 1, paddingHorizontal: 15, paddingVertical: 20, justifyContent: 'flex-end', gap: 9 }, empty: { alignItems: 'center', marginBottom: 45 }, emptyTitle: { color: colors.text, fontWeight: '800', fontSize: 18 }, emptyText: { color: colors.muted, marginTop: 7, textAlign: 'center' },
  bubble: { maxWidth: '83%', borderRadius: 17, paddingHorizontal: 13, paddingVertical: 10, minWidth: 90 }, myBubble: { backgroundColor: colors.primarySoft, alignSelf: 'flex-end', borderBottomRightRadius: 4 }, theirBubble: { backgroundColor: colors.surface, alignSelf: 'flex-start', borderBottomLeftRadius: 4, borderWidth: 1, borderColor: colors.border }, sender: { color: colors.primaryDark, fontWeight: '800', fontSize: 12, marginBottom: 4 }, body: { color: colors.text, fontSize: 15, lineHeight: 20 }, messageTime: { color: colors.muted, fontSize: 10, alignSelf: 'flex-end', marginTop: 4 },
  typingBubble: { alignSelf: 'flex-start', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 17, borderBottomLeftRadius: 4, paddingHorizontal: 15, paddingVertical: 12 },
  error: { color: colors.error, paddingHorizontal: 17, paddingVertical: 6 }, composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 10, paddingHorizontal: 14, paddingVertical: 10, backgroundColor: colors.surface }, input: { flex: 1, minHeight: 44, maxHeight: 120, borderRadius: 22, paddingHorizontal: 17, paddingVertical: 10, backgroundColor: colors.surfaceRaised, color: colors.text, fontSize: 15 }, send: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' }, disabled: { opacity: 0.45 },
});
