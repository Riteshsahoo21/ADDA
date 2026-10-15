import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { ArrowLeft, Send } from 'lucide-react-native';
import { colors } from '@/constants/theme';
import { socialApi, type ChatMessage, type OwnProfile } from '@/lib/social-api';

export default function ConversationScreen() {
  const { kind, id, name } = useLocalSearchParams<{ kind?: string; id?: string; name?: string }>();
  const [selfId, setSelfId] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const list = useRef<ScrollView>(null);
  const valid = (kind === 'direct' || kind === 'group') && typeof id === 'string' && id.length > 0;
  const path = `/chats/${kind}/${id}`;
  const load = useCallback(async () => {
    if (!valid) return;
    try {
      const [me, items] = await Promise.all([socialApi<OwnProfile>('/me'), socialApi<ChatMessage[]>(path)]);
      setSelfId(me.id); setMessages(items); setError('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load messages.'); }
  }, [path, valid]);
  useFocusEffect(useCallback(() => { void load(); }, [load]));
  useEffect(() => {
    if (!valid) return;
    const interval = setInterval(() => { void load(); }, 5000);
    return () => clearInterval(interval);
  }, [load, valid]);
  const send = async () => {
    const body = draft.trim();
    if (!valid || !body || sending) return;
    setSending(true); setError('');
    try { await socialApi(path, 'POST', { body }); setDraft(''); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not send message.'); }
    finally { setSending(false); }
  };
  return <SafeAreaView style={styles.safe}>
    <View style={styles.top}><Pressable accessibilityLabel="Back" onPress={() => router.back()} style={styles.back}><ArrowLeft size={24} color={colors.text} /></Pressable><View style={styles.avatar}><Text style={styles.initial}>{name?.[0]?.toUpperCase() || '?'}</Text></View><View><Text style={styles.title}>{name || 'Chat'}</Text><Text style={styles.subtitle}>{kind === 'group' ? 'Group' : 'Contact'}</Text></View></View>
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={20}>
      <ScrollView ref={list} contentContainerStyle={styles.messages} onContentSizeChange={() => list.current?.scrollToEnd({ animated: false })}>
        {messages.length === 0 && !error && <View style={styles.empty}><Text style={styles.emptyTitle}>Start the conversation</Text><Text style={styles.emptyText}>Messages in this chat are stored in ADDA.</Text></View>}
        {messages.map((item) => {
          const mine = item.senderId === selfId;
          return <View key={item.id} style={[styles.bubble, mine ? styles.myBubble : styles.theirBubble]}>{kind === 'group' && !mine && <Text style={styles.sender}>{item.senderName}</Text>}<Text style={styles.body}>{item.body}</Text><Text style={styles.messageTime}>{new Date(item.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</Text></View>;
        })}
      </ScrollView>
      {!!error && <Text style={styles.error}>{error}</Text>}
      <View style={styles.composer}><TextInput style={styles.input} placeholder="Message" placeholderTextColor={colors.muted} value={draft} onChangeText={setDraft} multiline maxLength={2000} /><Pressable accessibilityLabel="Send message" disabled={!draft.trim() || sending} onPress={() => void send()} style={[styles.send, (!draft.trim() || sending) && styles.disabled]}><Send size={20} color="#FFFFFF" /></Pressable></View>
    </KeyboardAvoidingView>
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background }, flex: { flex: 1 }, top: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 66, paddingHorizontal: 14, backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border }, back: { padding: 5 }, avatar: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primarySoft }, initial: { color: colors.primaryDark, fontWeight: '800', fontSize: 18 }, title: { color: colors.text, fontWeight: '800', fontSize: 17 }, subtitle: { color: colors.muted, fontSize: 11, marginTop: 2 },
  messages: { flexGrow: 1, paddingHorizontal: 15, paddingVertical: 20, justifyContent: 'flex-end', gap: 9 }, empty: { alignItems: 'center', marginBottom: 45 }, emptyTitle: { color: colors.text, fontWeight: '800', fontSize: 18 }, emptyText: { color: colors.muted, marginTop: 7, textAlign: 'center' },
  bubble: { maxWidth: '83%', borderRadius: 17, paddingHorizontal: 13, paddingVertical: 10, minWidth: 90 }, myBubble: { backgroundColor: colors.primarySoft, alignSelf: 'flex-end', borderBottomRightRadius: 4 }, theirBubble: { backgroundColor: colors.surface, alignSelf: 'flex-start', borderBottomLeftRadius: 4, borderWidth: 1, borderColor: colors.border }, sender: { color: colors.primaryDark, fontWeight: '800', fontSize: 12, marginBottom: 4 }, body: { color: colors.text, fontSize: 15, lineHeight: 20 }, messageTime: { color: colors.muted, fontSize: 10, alignSelf: 'flex-end', marginTop: 4 },
  error: { color: colors.error, paddingHorizontal: 17, paddingVertical: 6 }, composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 10, paddingHorizontal: 14, paddingVertical: 10, backgroundColor: colors.surface }, input: { flex: 1, minHeight: 44, maxHeight: 120, borderRadius: 22, paddingHorizontal: 17, paddingVertical: 10, backgroundColor: colors.surfaceRaised, color: colors.text, fontSize: 15 }, send: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' }, disabled: { opacity: 0.45 },
});
