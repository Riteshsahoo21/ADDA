import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Image, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as Sharing from 'expo-sharing';
import * as MediaLibrary from 'expo-media-library';
import { useVideoPlayer, VideoView } from 'expo-video';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useFocusEffect, useLocalSearchParams, type Href } from 'expo-router';
import { ArrowLeft, Download, EllipsisVertical, LockKeyhole, Paperclip, Phone, Send, Share2, Trash2, Video, X } from 'lucide-react-native';
import { colors } from '@/constants/theme';
import { socialApi, type ChatGroup, type OwnProfile, type PublicProfile } from '@/lib/social-api';
import { getRealtimeSocket, type ChatTarget, type TypingEvent } from '@/lib/realtime';
import { chatSafetyCode, deleteLocalMessage, initEncryptedChat, localMessages, markChatRead, mediaFromBody, onChatChanged, openEncryptedMedia, releaseDecryptedMedia, sendEncryptedMedia, sendEncryptedMessage, syncEncryptedChat, type EncryptedMedia, type LocalMessage } from '@/lib/encrypted-chat';
import { callRequest, type CallInfo, type CallMedia } from '@/lib/calls';
import { TypingDots } from '@/components/ui/TypingDots';

type ViewerState = {
  uri: string;
  media: EncryptedMedia;
  messageId: string;
  senderName: string;
  createdAt: string;
  mine: boolean;
} | null;

export default function ConversationScreen() {
  const { kind, id, name } = useLocalSearchParams<{ kind?: string; id?: string; name?: string }>();
  const [chatTitle, setChatTitle] = useState(name || '');
  const [selfId, setSelfId] = useState('');
  const [selfName, setSelfName] = useState('');
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [viewerMedia, setViewerMedia] = useState<ViewerState>(null);
  const [showMenu, setShowMenu] = useState(false);
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
  const handleDownload = async (fileUri: string) => {
    try {
      const permission = await MediaLibrary.requestPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('Permission needed', 'Please allow gallery access to save photos to your phone.');
        return;
      }
      await MediaLibrary.saveToLibraryAsync(fileUri);
      Alert.alert('Saved', 'Photo saved to your gallery!');
    } catch (error) {
      Alert.alert('Download failed', error instanceof Error ? error.message : 'Could not save photo.');
    }
  };

  const handleShare = async (fileUri: string) => {
    try {
      const isAvailable = await Sharing.isAvailableAsync();
      if (!isAvailable) {
        Alert.alert('Sharing unavailable', 'Sharing is not supported on this device.');
        return;
      }
      await Sharing.shareAsync(fileUri);
    } catch (error) {
      Alert.alert('Share failed', error instanceof Error ? error.message : 'Could not share photo.');
    }
  };

  const handleDelete = (messageId: string) => {
    Alert.alert(
      'Delete message',
      'Are you sure you want to delete this photo?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteLocalMessage(messageId);
              setMessages(current => current.filter(m => m.id !== messageId));
              setViewerMedia(null);
              setShowMenu(false);
            } catch (error) {
              Alert.alert('Delete failed', error instanceof Error ? error.message : 'Could not delete message.');
            }
          },
        },
      ]
    );
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
              {media ? (
                <MediaMessage
                  media={media}
                  onPress={(mediaUri) =>
                    setViewerMedia({
                      uri: mediaUri,
                      media,
                      messageId: item.id,
                      senderName: item.senderName,
                      createdAt: item.createdAt,
                      mine,
                    })
                  }
                />
              ) : (
                <Text style={styles.body}>{item.body}</Text>
              )}
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

    {viewerMedia && (
      <Modal visible={!!viewerMedia} transparent={false} animationType="fade" onRequestClose={() => { setViewerMedia(null); setShowMenu(false); }}>
        <SafeAreaView style={styles.viewerContainer}>
          <View style={styles.viewerHeader}>
            <Pressable onPress={() => { setViewerMedia(null); setShowMenu(false); }} style={styles.viewerHeaderBtn} accessibilityLabel="Back">
              <ArrowLeft size={24} color="#FFFFFF" />
            </Pressable>
            <View style={styles.viewerTitleWrap}>
              <Text style={styles.viewerTitle}>{viewerMedia.mine ? 'You' : (viewerMedia.senderName || activeTitle)}</Text>
              <Text style={styles.viewerSubtitle}>
                {new Date(viewerMedia.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}{' at '}{new Date(viewerMedia.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
              </Text>
            </View>
            <View style={styles.viewerActions}>
              <Pressable onPress={() => void handleDownload(viewerMedia.uri)} style={styles.viewerActionBtn} accessibilityLabel="Save to device">
                <Download size={22} color="#FFFFFF" />
              </Pressable>
              <Pressable onPress={() => void handleShare(viewerMedia.uri)} style={styles.viewerActionBtn} accessibilityLabel="Share">
                <Share2 size={22} color="#FFFFFF" />
              </Pressable>
              <Pressable onPress={() => setShowMenu(true)} style={styles.viewerActionBtn} accessibilityLabel="More options">
                <EllipsisVertical size={22} color="#FFFFFF" />
              </Pressable>
            </View>
          </View>

          <View style={styles.viewerBody}>
            {viewerMedia.media.mediaKind === 'image' ? (
              <Image source={{ uri: viewerMedia.uri }} style={styles.viewerImage} resizeMode="contain" />
            ) : (
              <InlineVideo uri={viewerMedia.uri} />
            )}
          </View>

          {showMenu && (
            <Modal visible={showMenu} transparent animationType="fade" onRequestClose={() => setShowMenu(false)}>
              <Pressable style={styles.menuBackdrop} onPress={() => setShowMenu(false)}>
                <View style={styles.menuCard}>
                  <Text style={styles.menuHeading}>Photo Options</Text>
                  <Pressable style={styles.menuOption} onPress={() => { setShowMenu(false); void handleDownload(viewerMedia.uri); }}>
                    <View style={styles.menuIconWrap}><Download size={20} color={colors.primary} /></View>
                    <View style={styles.menuTextWrap}>
                      <Text style={styles.menuText}>Save to Gallery</Text>
                      <Text style={styles.menuSubtext}>Save photo to your phone</Text>
                    </View>
                  </Pressable>
                  <Pressable style={styles.menuOption} onPress={() => { setShowMenu(false); void handleShare(viewerMedia.uri); }}>
                    <View style={styles.menuIconWrap}><Share2 size={20} color={colors.primary} /></View>
                    <View style={styles.menuTextWrap}>
                      <Text style={styles.menuText}>Share</Text>
                      <Text style={styles.menuSubtext}>Send via WhatsApp, Telegram, etc.</Text>
                    </View>
                  </Pressable>
                  <View style={styles.menuSeparator} />
                  <Pressable style={styles.menuOption} onPress={() => { setShowMenu(false); handleDelete(viewerMedia.messageId); }}>
                    <View style={[styles.menuIconWrap, { backgroundColor: '#FEE2E2' }]}><Trash2 size={20} color={colors.error} /></View>
                    <View style={styles.menuTextWrap}>
                      <Text style={[styles.menuText, { color: colors.error }]}>Delete</Text>
                      <Text style={styles.menuSubtext}>Delete from this conversation</Text>
                    </View>
                  </Pressable>
                </View>
              </Pressable>
            </Modal>
          )}
        </SafeAreaView>
      </Modal>
    )}
  </SafeAreaView>;
}

function MediaMessage({ media, onPress }: { media: EncryptedMedia; onPress: (uri: string) => void }) {
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
    return (
      <Pressable onPress={() => onPress(uri)} style={styles.mediaPressable}>
        {media.mediaKind === 'image' ? (
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
        )}
      </Pressable>
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
  mediaPressable: { borderRadius: 13, overflow: 'hidden' },
  viewerContainer: { flex: 1, backgroundColor: '#000000' },
  viewerHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 10, backgroundColor: 'rgba(0, 0, 0, 0.88)' },
  viewerHeaderBtn: { padding: 8 },
  viewerTitleWrap: { flex: 1, marginHorizontal: 12 },
  viewerTitle: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
  viewerSubtitle: { color: '#9CA3AF', fontSize: 12, marginTop: 2 },
  viewerActions: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  viewerActionBtn: { padding: 8 },
  viewerBody: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#000000' },
  viewerImage: { width: '100%', height: '100%' },
  menuBackdrop: { flex: 1, backgroundColor: 'rgba(0, 0, 0, 0.65)', justifyContent: 'flex-end' },
  menuCard: { backgroundColor: colors.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 20, paddingTop: 18, paddingBottom: Platform.OS === 'ios' ? 36 : 24 },
  menuHeading: { color: colors.muted, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', marginBottom: 14, letterSpacing: 0.5 },
  menuOption: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, gap: 14 },
  menuIconWrap: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  menuTextWrap: { flex: 1 },
  menuText: { color: colors.text, fontSize: 16, fontWeight: '600' },
  menuSubtext: { color: colors.muted, fontSize: 12, marginTop: 2 },
  menuSeparator: { height: 1, backgroundColor: colors.border, marginVertical: 6 },
});
