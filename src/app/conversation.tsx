import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Image, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import * as ImagePicker from 'expo-image-picker';
import * as Sharing from 'expo-sharing';
import * as MediaLibrary from 'expo-media-library/legacy';
import { VideoView } from 'expo-video';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useFocusEffect, useLocalSearchParams, type Href } from 'expo-router';
import { ArrowLeft, Download, LockKeyhole, Paperclip, Phone, Play, Reply, Send, Share2, Trash2, Video, X } from 'lucide-react-native';
import { colors } from '@/constants/theme';
import { socialApi, type ChatGroup, type GroupDetails, type GroupMember, type OwnProfile, type PublicProfile } from '@/lib/social-api';
import { getRealtimeSocket, type ChatTarget, type TypingEvent } from '@/lib/realtime';
import {
  chatSafetyCode, deleteLocalMessage, getActiveUserId, getCachedProfile,
  handleMessageStatusUpdate, initEncryptedChat, isEncryptedChatReady, localMessages,
  markChatRead, mediaFromBody, onChatChanged, openEncryptedMedia, prefetchChatKeys,
  receiveDirectEnvelope, sendEncryptedMedia, sendEncryptedMessage, setCachedProfile,
  syncEncryptedChat, type EncryptedMedia, type Envelope, type LocalMessage, type QuotedReply
} from '@/lib/encrypted-chat';
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
  const [replyingTo, setReplyingTo] = useState<QuotedReply | null>(null);
  const [groupMembers, setGroupMembers] = useState<GroupMember[]>([]);
  const [selectedMentions, setSelectedMentions] = useState<string[]>([]);
  const [mentionQuery, setMentionQuery] = useState<{ active: boolean; prefix: string; query: string } | null>(null);
  const flatListRef = useRef<FlatList<LocalMessage>>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingExpiry = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const lastTyping = useRef(0);
  const draftRef = useRef('');
  const typingRevision = useRef(0);
  const valid = (kind === 'direct' || kind === 'group') && typeof id === 'string' && id.length > 0;
  const target: ChatTarget | null = useMemo(() => valid ? { kind: kind as ChatTarget['kind'], id: id as string } : null, [valid, kind, id]);

  const reversedMessages = useMemo(() => [...messages].reverse(), [messages]);

  useEffect(() => {
    if (name) setChatTitle(name);
  }, [name]);

  const load = useCallback(async () => {
    if (!target) return;
    
    // 1. INSTANT LOCAL-FIRST RENDER (0ms latency from local SQLite)
    if (isEncryptedChatReady()) {
      const cached = getCachedProfile();
      if (cached) {
        setSelfId(cached.id);
        setSelfName(cached.name);
      } else {
        const uid = getActiveUserId();
        if (uid) setSelfId(uid);
      }
      try {
        const local = await localMessages(target);
        setMessages(local);
        if (!name && target.kind === 'direct') {
          const fromOther = local.find(m => m.senderId === target.id && m.senderName);
          if (fromOther?.senderName) setChatTitle(fromOther.senderName);
        }
      } catch (err) {
        console.warn('Instant local-load error:', err);
      }
    }

    // 2. Background sync & profile validation (non-blocking)
    try {
      const cached = getCachedProfile();
      const me = cached ?? await socialApi<OwnProfile>('/me');
      setCachedProfile(me);
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
          void socialApi<GroupDetails>(`/groups/${target.id}`).then(details => {
            setGroupMembers(details.members);
            if (details.name) setChatTitle(details.name);
          }).catch(() => {
            void socialApi<ChatGroup[]>('/groups').then(groups => {
              const match = groups.find(g => g.id === target.id);
              if (match?.name) setChatTitle(match.name);
            }).catch(() => {});
          });
        }
      }

      if (target.kind === 'group') {
        void socialApi<GroupDetails>(`/groups/${target.id}`).then(details => {
          setGroupMembers(details.members);
        }).catch(() => {});
      }

      void prefetchChatKeys(target);
      void markChatRead(target);
      void syncEncryptedChat().catch(() => {});
      void getRealtimeSocket().then(live => live.emit('chat:drain_spool')).catch(() => {});
      setError('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load messages.'); }
  }, [target, name]);

  useFocusEffect(useCallback(() => {
    void load();
    if (target) {
      void markChatRead(target);
      void getRealtimeSocket().then(live => live.emit('chat:drain_spool')).catch(() => {});
    }
  }, [load, target]));

  useEffect(() => onChatChanged(() => {
    if (target) void localMessages(target).then(setMessages).catch(() => {});
  }), [target]);

  useEffect(() => {
    if (!target) return;
    let active = true;
    let live: Awaited<ReturnType<typeof getRealtimeSocket>> | null = null;
    const expiry = typingExpiry.current;
    const revision = typingRevision;

    const onEnvelope = (envelope: Envelope) => {
      void receiveDirectEnvelope(envelope)
        .then(() => markChatRead(target))
        .catch(() => {});
    };

    const onStatus = (update: any) => {
      void handleMessageStatusUpdate(update).catch(() => {});
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
      void syncEncryptedChat();
      void markChatRead(target);
    };

    const onDisconnect = () => { setTypingNames({}); for (const timer of expiry.values()) clearTimeout(timer); expiry.clear(); lastTyping.current = 0; };

    void getRealtimeSocket().then(value => {
      if (!active) return;
      live = value;
      value.on('chat:envelope', onEnvelope);
      value.on('chat:msg_status', onStatus);
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
      live?.off('chat:envelope', onEnvelope);
      live?.off('chat:msg_status', onStatus);
      live?.off('chat:typing', onTyping);
      live?.off('connect', onConnect);
      live?.off('disconnect', onDisconnect);
    };
  }, [target, selfId]);

  const onDraftChange = (value: string) => {
    setDraft(value);
    draftRef.current = value;

    if (target?.kind === 'group') {
      const lastAt = value.lastIndexOf('@');
      if (lastAt !== -1 && (lastAt === 0 || /\s/.test(value[lastAt - 1]))) {
        const queryAfterAt = value.slice(lastAt + 1);
        if (!/\s/.test(queryAfterAt)) {
          setMentionQuery({
            active: true,
            prefix: value.slice(0, lastAt),
            query: queryAfterAt,
          });
        } else {
          setMentionQuery(null);
        }
      } else {
        setMentionQuery(null);
      }
    } else {
      setMentionQuery(null);
    }

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

  const selectMention = (member: { id: string; name: string }) => {
    if (!mentionQuery) return;
    const newDraft = `${mentionQuery.prefix}@${member.name} `;
    setDraft(newDraft);
    draftRef.current = newDraft;
    setSelectedMentions(prev => prev.includes(member.id) ? prev : [...prev, member.id]);
    setMentionQuery(null);
  };

  const filteredMentionMembers = useMemo(() => {
    if (!mentionQuery || target?.kind !== 'group') return [];
    const q = mentionQuery.query.toLowerCase();
    const list = groupMembers.filter(m => m.name.toLowerCase().includes(q) || m.username.toLowerCase().includes(q));
    const everyoneItem = { id: 'everyone', name: 'everyone', username: 'all members', about: 'Notify all members', avatarUrl: null, role: 'member' as const, joinedAt: '', isSelf: false };
    if ('everyone'.includes(q)) {
      return [everyoneItem, ...list];
    }
    return list;
  }, [mentionQuery, groupMembers, target]);

  const triggerReply = (msg: LocalMessage) => {
    const media = mediaFromBody(msg.body);
    const snippet = media ? (media.mediaKind === 'video' ? '🎥 Video' : '📷 Photo') : (msg.body.length > 80 ? msg.body.slice(0, 77) + '...' : msg.body);
    setReplyingTo({
      messageId: msg.id,
      senderId: msg.senderId,
      senderName: msg.senderName,
      snippet,
      mediaKind: media ? (media.mediaKind === 'video' ? 'video' : 'photo') : undefined,
      mediaId: media?.mediaId,
    });
  };

  const onMessageLongPress = (item: LocalMessage, mine: boolean) => {
    const media = mediaFromBody(item.body);
    Alert.alert(
      item.senderName,
      media ? (media.mediaKind === 'video' ? '🎥 Video' : '📷 Photo') : (item.body.length > 60 ? item.body.slice(0, 57) + '...' : item.body),
      [
        { text: 'Reply', onPress: () => triggerReply(item) },
        ...(mine ? [{
          text: 'Delete',
          style: 'destructive' as const,
          onPress: async () => {
            try {
              await deleteLocalMessage(item.id);
              setMessages(curr => curr.filter(m => m.id !== item.id));
            } catch {}
          }
        }] : []),
        { text: 'Cancel', style: 'cancel' as const },
      ]
    );
  };

  const send = async () => {
    const body = draft.trim();
    if (!target || !body) return;
    const currentReply = replyingTo;
    const currentMentions = selectedMentions.length > 0 ? [...selectedMentions] : undefined;
    onDraftChange('');
    setReplyingTo(null);
    setSelectedMentions([]);
    setMentionQuery(null);
    setError('');
    const messageId = Crypto.randomUUID();
    const myName = selfName || getCachedProfile()?.name || 'Me';

    try {
      await sendEncryptedMessage(target, body, myName, messageId, currentReply, currentMentions);
    } catch (cause) {
      console.warn('Send error:', cause);
      setError(cause instanceof Error ? cause.message : 'Could not send message.');
    }
  };

  const attach = async () => {
    if (!target || sending) return;
    const selection = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images', 'videos'],
      allowsMultipleSelection: false,
      quality: 0.7,
    });
    if (selection.canceled || !selection.assets[0]) return;
    const asset = selection.assets[0];

    const currentReply = replyingTo;
    const currentMentions = selectedMentions.length > 0 ? [...selectedMentions] : undefined;
    setReplyingTo(null);
    setSelectedMentions([]);
    setMentionQuery(null);

    const messageId = Crypto.randomUUID();
    const myId = selfId || getActiveUserId() || '';
    const myName = selfName || getCachedProfile()?.name || 'Me';
    const mediaKind = asset.type === 'video' ? 'video' : 'image';
    const mimeType = asset.mimeType ?? (mediaKind === 'video' ? 'video/mp4' : 'image/jpeg');
    const now = new Date().toISOString();

    // 1. INSTANT 0MS OPTIMISTIC MEDIA PREVIEW (WhatsApp style!)
    const optimisticMedia: EncryptedMedia = {
      type: 'media',
      mediaId: messageId,
      mediaKind,
      key: '',
      nonce: '',
      mimeType,
      createdAt: now,
      senderName: myName,
      localUri: asset.uri,
    };
    const optimisticMessage: LocalMessage = {
      id: messageId,
      kind: target.kind,
      targetId: target.id,
      senderId: myId,
      senderName: myName,
      body: '__adda_media__:' + JSON.stringify(optimisticMedia),
      createdAt: now,
      status: 'queued',
      replyTo: currentReply,
      mentions: currentMentions,
    };

    setMessages(current => current.some(item => item.id === messageId) ? current : [...current, optimisticMessage]);

    // 2. BACKGROUND ENCRYPTION & R2 UPLOAD
    setSending(true);
    setError('');
    void (async () => {
      try {
        const sent = await sendEncryptedMedia(target, asset.uri, mediaKind, mimeType, myName, messageId, currentReply, currentMentions);
        setMessages(current => current.map(item => item.id === messageId ? sent : item));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Could not share encrypted media.');
      } finally {
        setSending(false);
      }
    })();
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

  const handleDownload = async (fileUri: string, mediaKind: 'image' | 'video' = 'image') => {
    try {
      const permission = await MediaLibrary.requestPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('Permission needed', 'Please allow gallery access to save media to your phone.');
        return;
      }
      await MediaLibrary.saveToLibraryAsync(fileUri);
      Alert.alert('Saved', `${mediaKind === 'video' ? 'Video' : 'Photo'} saved to your gallery!`);
    } catch (error) {
      Alert.alert('Download failed', error instanceof Error ? error.message : 'Could not save media.');
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
      Alert.alert('Share failed', error instanceof Error ? error.message : 'Could not share media.');
    }
  };

  const handleDelete = (messageId: string, mediaKind: 'image' | 'video' = 'image') => {
    Alert.alert(
      'Delete message',
      `Are you sure you want to delete this ${mediaKind === 'video' ? 'video' : 'photo'}?`,
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

  const renderMessageBody = (text: string, isMine: boolean) => {
    const regex = /(@[A-Za-z0-9_]+(?:\s[A-Za-z0-9_]+)?|@everyone)/g;
    const parts = text.split(regex);
    if (parts.length <= 1) {
      return <Text style={[styles.body, !isMine && styles.theirBody]}>{text}</Text>;
    }
    return (
      <Text style={[styles.body, !isMine && styles.theirBody]}>
        {parts.map((part, i) => {
          if (part.startsWith('@')) {
            return (
              <Text key={i} style={styles.mentionText}>
                {part}
              </Text>
            );
          }
          return part;
        })}
      </Text>
    );
  };

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.top}>
        <Pressable accessibilityLabel="Back" onPress={handleBack} style={styles.back}>
          <ArrowLeft size={24} color={colors.text} />
        </Pressable>

        {kind === 'group' ? (
          <Pressable
            onPress={() =>
              router.push({
                pathname: '/group-info',
                params: { id: target?.id, name: activeTitle },
              } as unknown as Href)
            }
            style={styles.headerPressable}
          >
            <View style={styles.avatar}>
              <Text style={styles.initial}>{activeTitle[0]?.toUpperCase() || '?'}</Text>
            </View>
            <View style={styles.titleWrap}>
              <Text style={styles.title} numberOfLines={1}>{activeTitle}</Text>
              <View style={styles.subtitleRow}>
                <Text style={[styles.subtitle, Object.keys(typingNames).length > 0 && styles.typingSubtitle]}>
                  {Object.keys(typingNames).length
                    ? `${Object.values(typingNames).slice(0, 2).join(', ')} typing`
                    : 'Tap for group info'}
                </Text>
                {Object.keys(typingNames).length > 0 && <TypingDots />}
              </View>
            </View>
          </Pressable>
        ) : (
          <View style={styles.headerPressable}>
            <View style={styles.avatar}>
              <Text style={styles.initial}>{activeTitle[0]?.toUpperCase() || '?'}</Text>
            </View>
            <View style={styles.titleWrap}>
              <Text style={styles.title} numberOfLines={1}>{activeTitle}</Text>
              <View style={styles.subtitleRow}>
                <Text style={[styles.subtitle, Object.keys(typingNames).length > 0 && styles.typingSubtitle]}>
                  {Object.keys(typingNames).length
                    ? `${Object.values(typingNames).slice(0, 2).join(', ')} typing`
                    : 'Contact'}
                </Text>
                {Object.keys(typingNames).length > 0 && <TypingDots />}
              </View>
            </View>
          </View>
        )}

        <Pressable accessibilityLabel="Compare encryption keys" onPress={() => void showSafetyCode()} style={styles.callAction}>
          <LockKeyhole size={19} color={colors.primary} />
        </Pressable>
        <Pressable accessibilityLabel="Voice call" onPress={() => void startCall('audio')} style={styles.callAction}>
          <Phone size={20} color={colors.primary} />
        </Pressable>
        <Pressable accessibilityLabel="Video call" onPress={() => void startCall('video')} style={styles.callAction}>
          <Video size={22} color={colors.primary} />
        </Pressable>
      </View>

      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={Platform.OS === 'ios' ? 20 : 0}>
        <FlatList
          ref={flatListRef}
          inverted
          data={reversedMessages}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.messages}
          initialNumToRender={20}
          maxToRenderPerBatch={15}
          windowSize={7}
          removeClippedSubviews={Platform.OS === 'android'}
          renderItem={({ item }) => {
            const mine = item.senderId === selfId;
            const media = mediaFromBody(item.body);
            const isTagged = !mine && (item.mentions?.includes(selfId) || item.mentions?.includes('everyone'));
            return (
              <Pressable
                onLongPress={() => onMessageLongPress(item, mine)}
                delayLongPress={300}
                style={[
                  styles.bubble,
                  mine ? styles.myBubble : styles.theirBubble,
                  media && styles.mediaBubble,
                  isTagged && styles.taggedBubble,
                ]}
              >
                {kind === 'group' && !mine && <Text style={styles.sender}>{item.senderName}</Text>}

                {/* Quoted Reply inside message bubble */}
                {item.replyTo && (
                  <Pressable
                    onPress={() => {
                      const idx = reversedMessages.findIndex(m => m.id === item.replyTo?.messageId);
                      if (idx !== -1) {
                        try {
                          flatListRef.current?.scrollToIndex({ index: idx, animated: true, viewPosition: 0.5 });
                        } catch {}
                      }
                    }}
                    style={[styles.quotedBubbleCard, mine ? styles.myQuotedBubbleCard : styles.theirQuotedBubbleCard]}
                  >
                    <View style={styles.quotedAccentBar} />
                    <View style={styles.quotedBubbleContent}>
                      <Text style={styles.quotedSenderName} numberOfLines={1}>
                        {item.replyTo.senderId === selfId ? 'You' : item.replyTo.senderName}
                      </Text>
                      <Text style={[styles.quotedSnippet, mine ? styles.myQuotedSnippet : styles.theirQuotedSnippet]} numberOfLines={2}>
                        {item.replyTo.snippet}
                      </Text>
                    </View>
                    {item.replyTo.mediaId && (
                      <View style={styles.quotedBubbleThumbnail}>
                        <Text style={{ fontSize: 16 }}>{item.replyTo.mediaKind === 'video' ? '🎥' : '📷'}</Text>
                      </View>
                    )}
                  </Pressable>
                )}

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
                  renderMessageBody(item.body, mine)
                )}

                <View style={[styles.messageFooter, media && styles.mediaFooter]}>
                  <Text style={[styles.messageTime, !mine && styles.theirMessageTime]}>
                    {new Date(item.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                  </Text>
                  {mine && (
                    <Text accessibilityLabel={item.status === 'read' ? 'Read' : item.status === 'delivered' ? 'Delivered' : item.status === 'sent' ? 'Sent' : 'Pending'} style={[styles.tick, item.status === 'read' && styles.readTick]}>
                      {item.status === 'read' || item.status === 'delivered' ? '✓✓' : item.status === 'sent' ? '✓' : '○'}
                    </Text>
                  )}
                </View>
              </Pressable>
            );
          }}
          ListFooterComponent={
            messages.length === 0 && !error ? (
              <View style={styles.empty}>
                <Text style={styles.emptyTitle}>Start the conversation</Text>
                <Text style={styles.emptyText}>New messages are encrypted and saved on this phone.</Text>
              </View>
            ) : null
          }
          ListHeaderComponent={
            Object.keys(typingNames).length > 0 ? (
              <View style={styles.typingBubble}>
                <TypingDots />
              </View>
            ) : null
          }
        />

        {!!error && <Text style={styles.error}>{error}</Text>}

        {/* Group @ Mentions Autocomplete Dropdown */}
        {mentionQuery?.active && filteredMentionMembers.length > 0 && (
          <View style={styles.mentionOverlay}>
            <ScrollView style={styles.mentionScroll} keyboardShouldPersistTaps="always">
              {filteredMentionMembers.slice(0, 6).map((m) => (
                <Pressable key={m.id} style={styles.mentionRow} onPress={() => selectMention(m)}>
                  <View style={styles.mentionAvatar}>
                    <Text style={styles.mentionInitial}>{m.name[0]?.toUpperCase()}</Text>
                  </View>
                  <View style={styles.mentionInfo}>
                    <Text style={styles.mentionName}>
                      {m.name} {m.id === 'everyone' ? '(all members)' : ''}
                    </Text>
                    <Text style={styles.mentionUsername}>@{m.username}</Text>
                  </View>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        )}

        {/* Docked WhatsApp Reply Preview Card above Composer */}
        {replyingTo && (
          <View style={styles.dockedReplyContainer}>
            <View style={styles.dockedReplyBar} />
            <View style={styles.dockedReplyContent}>
              <Text style={styles.dockedReplySender} numberOfLines={1}>
                {replyingTo.senderId === selfId ? 'You' : replyingTo.senderName}
              </Text>
              <Text style={styles.dockedReplySnippet} numberOfLines={1}>
                {replyingTo.snippet}
              </Text>
            </View>
            {replyingTo.mediaId && (
              <View style={styles.dockedReplyThumbnail}>
                <Text style={{ fontSize: 18 }}>{replyingTo.mediaKind === 'video' ? '🎥' : '📷'}</Text>
              </View>
            )}
            <Pressable onPress={() => setReplyingTo(null)} style={styles.dockedReplyClose} accessibilityLabel="Cancel reply">
              <X size={18} color="#8E9BA8" />
            </Pressable>
          </View>
        )}

        <View style={styles.composer}>
          <Pressable accessibilityLabel="Attach photo or video" disabled={sending} onPress={() => void attach()} style={styles.attach}>
            <Paperclip size={23} color={colors.primary} />
          </Pressable>
          <TextInput
            style={styles.input}
            placeholder="Message"
            placeholderTextColor={colors.muted}
            value={draft}
            onChangeText={onDraftChange}
            multiline
            maxLength={2000}
          />
          <Pressable accessibilityLabel="Send message" disabled={!draft.trim()} onPress={() => void send()} style={[styles.send, !draft.trim() && styles.disabled]}>
            <Send size={20} color="#FFFFFF" />
          </Pressable>
        </View>
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
                <Pressable onPress={() => void handleDownload(viewerMedia.uri, viewerMedia.media.mediaKind)} style={styles.viewerActionBtn} accessibilityLabel="Save to device">
                  <Download size={22} color="#FFFFFF" />
                </Pressable>
                <Pressable onPress={() => void handleShare(viewerMedia.uri)} style={styles.viewerActionBtn} accessibilityLabel="Share">
                  <Share2 size={22} color="#FFFFFF" />
                </Pressable>
                <Pressable onPress={() => handleDelete(viewerMedia.messageId, viewerMedia.media.mediaKind)} style={styles.viewerActionBtn} accessibilityLabel="Delete">
                  <Trash2 size={22} color="#FFFFFF" />
                </Pressable>
              </View>
            </View>

            <View style={styles.viewerBody}>
              {viewerMedia.media.mediaKind === 'video' ? (
                <VideoPlayerView uri={viewerMedia.uri} />
              ) : (
                <Image source={{ uri: viewerMedia.uri }} style={styles.viewerImage} resizeMode="contain" />
              )}
            </View>
          </SafeAreaView>
        </Modal>
      )}
    </SafeAreaView>
  );
}

function MediaMessage({ media, onPress }: { media: EncryptedMedia; onPress: (uri: string) => void }) {
  const [uri, setUri] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadMedia = useCallback(() => {
    let active = true;
    setLoading(true);
    setError('');

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
  }, [media]);

  useEffect(() => {
    return loadMedia();
  }, [loadMedia]);

  if (loading) {
    return (
      <View style={styles.mediaLoading}>
        <ActivityIndicator size="small" color={colors.primary} />
        <Text style={styles.mediaLoadingText}>Downloading {media.mediaKind}...</Text>
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
            onError={() => {
              setError('Could not display image.');
              setUri(null);
            }}
          />
        ) : (
          <VideoThumbnailBubble uri={uri} />
        )}
      </Pressable>
    );
  }

  return (
    <Pressable
      onPress={loadMedia}
      style={styles.mediaButton}
    >
      <Text style={styles.mediaErrorText}>{error || `Tap to load ${media.mediaKind}`}</Text>
    </Pressable>
  );
}

function VideoThumbnailBubble({ uri }: { uri: string }) {
  return (
    <View style={styles.videoPreviewWrap}>
      <VideoView
        style={styles.mediaImage}
        player={{
          src: uri,
          currentTime: 0,
          duration: 0,
          playing: false,
          muted: true,
          loop: false,
          playbackRate: 1,
          status: 'idle',
        } as any}
        contentFit="cover"
        nativeControls={false}
      />
      <View style={styles.playOverlay}>
        <Play size={28} color="#FFFFFF" fill="#FFFFFF" />
      </View>
    </View>
  );
}

function VideoPlayerView({ uri }: { uri: string }) {
  return (
    <VideoView
      style={styles.viewerVideo}
      player={{
        src: uri,
        currentTime: 0,
        duration: 0,
        playing: true,
        muted: false,
        loop: true,
        playbackRate: 1,
        status: 'readyToPlay',
      } as any}
      contentFit="contain"
      nativeControls={true}
    />
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  top: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
    gap: 12,
  },
  back: { padding: 4 },
  headerPressable: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12 },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  initial: { color: '#FFFFFF', fontWeight: '800', fontSize: 18 },
  titleWrap: { flex: 1 },
  title: { color: colors.text, fontWeight: '800', fontSize: 16 },
  subtitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  subtitle: { color: colors.muted, fontSize: 12 },
  typingSubtitle: { color: colors.primary, fontWeight: '600' },
  callAction: { padding: 6 },
  flex: { flex: 1 },
  messages: { padding: 16, gap: 10 },
  bubble: {
    maxWidth: '82%',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 18,
  },
  taggedBubble: { borderWidth: 1.5, borderColor: '#25D366' },
  mentionText: { color: '#25D366', fontWeight: '700' },
  quotedBubbleCard: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
    marginBottom: 6,
    gap: 8,
    overflow: 'hidden',
  },
  myQuotedBubbleCard: { backgroundColor: 'rgba(0, 0, 0, 0.22)' },
  theirQuotedBubbleCard: { backgroundColor: 'rgba(255, 255, 255, 0.08)' },
  quotedAccentBar: { width: 4, height: '100%', borderRadius: 2, backgroundColor: '#25D366' },
  quotedBubbleContent: { flex: 1 },
  quotedSenderName: { fontSize: 12, fontWeight: '700', color: '#25D366', marginBottom: 2 },
  quotedSnippet: { fontSize: 12, lineHeight: 16 },
  myQuotedSnippet: { color: 'rgba(255, 255, 255, 0.9)' },
  theirQuotedSnippet: { color: colors.text },
  quotedBubbleThumbnail: {
    width: 32,
    height: 32,
    borderRadius: 4,
    backgroundColor: 'rgba(0,0,0,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dockedReplyContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1E242B',
    marginHorizontal: 8,
    marginBottom: 4,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  dockedReplyBar: { width: 4, height: '80%', borderRadius: 2, backgroundColor: '#25D366' },
  dockedReplyContent: { flex: 1 },
  dockedReplySender: { fontSize: 13, fontWeight: '700', color: '#25D366', marginBottom: 2 },
  dockedReplySnippet: { fontSize: 13, color: '#C5D1DC' },
  dockedReplyThumbnail: {
    width: 40,
    height: 40,
    borderRadius: 6,
    backgroundColor: '#111B21',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dockedReplyClose: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  mentionOverlay: {
    maxHeight: 180,
    marginHorizontal: 8,
    marginBottom: 4,
    borderRadius: 12,
    backgroundColor: '#1E242B',
    borderWidth: 1,
    borderColor: '#2D3748',
    overflow: 'hidden',
    elevation: 6,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
  },
  mentionScroll: { paddingVertical: 4 },
  mentionRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8, gap: 10 },
  mentionAvatar: { width: 34, height: 34, borderRadius: 17, backgroundColor: '#202C33', alignItems: 'center', justifyContent: 'center' },
  mentionInitial: { color: '#FFFFFF', fontSize: 14, fontWeight: '700' },
  mentionInfo: { flex: 1 },
  mentionName: { color: '#FFFFFF', fontSize: 14, fontWeight: '700' },
  mentionUsername: { color: '#8E9BA8', fontSize: 12 },
  myBubble: {
    alignSelf: 'flex-end',
    backgroundColor: colors.primary,
    borderBottomRightRadius: 4,
  },
  theirBubble: {
    alignSelf: 'flex-start',
    backgroundColor: colors.surface,
    borderBottomLeftRadius: 4,
    borderWidth: 1,
    borderColor: colors.border,
  },
  mediaBubble: { padding: 4, borderRadius: 16 },
  sender: { fontSize: 11, fontWeight: '700', color: colors.muted, marginBottom: 4 },
  body: { fontSize: 15, color: '#FFFFFF', lineHeight: 21 },
  theirBody: { color: colors.text },
  messageFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 4, marginTop: 4 },
  mediaFooter: { paddingHorizontal: 8, paddingBottom: 6 },
  messageTime: { fontSize: 10, color: 'rgba(255, 255, 255, 0.7)' },
  theirMessageTime: { color: colors.muted },
  tick: { fontSize: 11, color: 'rgba(255, 255, 255, 0.7)', fontWeight: '700' },
  readTick: { color: '#60A5FA' },
  mediaPressable: { borderRadius: 12, overflow: 'hidden' },
  mediaImage: { width: 240, height: 240, borderRadius: 12 },
  videoPreviewWrap: { position: 'relative', width: 240, height: 240, borderRadius: 12, overflow: 'hidden' },
  playOverlay: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.35)' },
  mediaLoading: { width: 240, height: 160, borderRadius: 12, backgroundColor: 'rgba(0,0,0,0.06)', alignItems: 'center', justifyContent: 'center', gap: 8 },
  mediaLoadingText: { color: colors.muted, fontSize: 13, fontWeight: '600' },
  mediaButton: { width: 240, height: 120, borderRadius: 12, backgroundColor: 'rgba(0,0,0,0.06)', alignItems: 'center', justifyContent: 'center', padding: 12, gap: 6 },
  mediaErrorText: { color: colors.error, fontSize: 12, textAlign: 'center' },
  typingBubble: {
    alignSelf: 'flex-start',
    backgroundColor: colors.surface,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 18,
    borderBottomLeftRadius: 4,
    marginTop: 4,
  },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40, marginTop: 80 },
  emptyTitle: { fontSize: 18, fontWeight: '800', color: colors.text, marginBottom: 8 },
  emptyText: { fontSize: 13, color: colors.muted, textAlign: 'center', lineHeight: 18 },
  error: { color: colors.error, paddingHorizontal: 16, paddingVertical: 4, fontSize: 12, textAlign: 'center' },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: 8,
  },
  attach: { padding: 8, marginBottom: 2 },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    backgroundColor: colors.background,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 10,
    fontSize: 15,
    color: colors.text,
  },
  send: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  disabled: { opacity: 0.5 },
  viewerContainer: { flex: 1, backgroundColor: '#000000' },
  viewerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: 'rgba(0,0,0,0.7)',
    gap: 12,
  },
  viewerHeaderBtn: { padding: 6 },
  viewerTitleWrap: { flex: 1 },
  viewerTitle: { color: '#FFFFFF', fontSize: 16, fontWeight: '800' },
  viewerSubtitle: { color: '#AAAAAA', fontSize: 12 },
  viewerActions: { flexDirection: 'row', gap: 12 },
  viewerActionBtn: { padding: 6 },
  viewerBody: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  viewerImage: { width: '100%', height: '100%' },
  viewerVideo: { width: '100%', height: '100%' },
});
