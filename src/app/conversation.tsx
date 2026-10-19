import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as Crypto from 'expo-crypto';
import * as ImagePicker from 'expo-image-picker';
import * as Sharing from 'expo-sharing';
import * as MediaLibrary from 'expo-media-library/legacy';
import { VideoView } from 'expo-video';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useFocusEffect, useLocalSearchParams, type Href } from 'expo-router';
import {
  ArrowLeft,
  Ban,
  Check,
  ChevronDown,
  ChevronUp,
  DoorOpen,
  Download,
  MoreVertical,
  Paperclip,
  Phone,
  Play,
  Reply,
  Search,
  Send,
  Share2,
  Smile,
  Star,
  Trash2,
  Video,
  X,
} from 'lucide-react-native';
import { colors } from '@/constants/theme';
import { socialApi, type ActiveGroupRoom, type ChatGroup, type GroupDetails, type GroupMember, type OwnProfile, type PublicProfile } from '@/lib/social-api';
import { getRealtimeSocket, type ChatTarget, type TypingEvent } from '@/lib/realtime';
import {
  deleteLocalMessage,
  deleteMessageForEveryone,
  getActiveUserId,
  getCachedProfile,
  handleMessageStatusUpdate,
  handleRemoteMessageDeleted,
  handleRemoteReaction,
  clearKeyCache,
  initEncryptedChat,
  isEncryptedChatReady,
  localMessages,
  markChatRead,
  mediaFromBody,
  roomCardFromBody,
  onChatChanged,
  openEncryptedMedia,
  prefetchChatKeys,
  receiveDirectEnvelope,
  sendEncryptedMedia,
  sendEncryptedMessage,
  setCachedProfile,
  syncEncryptedChat,
  toggleMessageReaction,
  type EncryptedMedia,
  type Envelope,
  type LocalMessage,
  type QuotedReply,
  type RoomCardPayload,
} from '@/lib/encrypted-chat';
import { callRequest, type CallInfo, type CallMedia } from '@/lib/calls';
import { TypingDots } from '@/components/ui/TypingDots';
import { ChatWallpaper, type ChatWallpaperTheme } from '@/components/ui/ChatWallpaper';

type ViewerState = {
  uri: string;
  media: EncryptedMedia;
  messageId: string;
  senderName: string;
  createdAt: string;
  mine: boolean;
} | null;

const EMOJI_LIST = [
  '😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '😊', '😇',
  '🙂', '🙃', '😉', '😌', '😍', '🥰', '😘', '😗', '😋', '😛',
  '😜', '🤪', '😎', '🥳', '😏', '😒', '😞', '😔', '😟', '😕',
  '🥺', '😢', '😭', '😤', '😠', '😡', '🤯', '😳', '🥵', '🥶',
  '😱', '😨', '🤔', '🤫', '🤐', '🤗', '😴', '😷', '🤒', '🤕',
  '🤢', '🤮', '🤧', '💀', '💩', '🤡', '👻', '👽', '🤖', '🎃',
  '😺', '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '💔',
  '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '🔥', '✨',
  '🌟', '💥', '💯', '🎉', '🎊', '👍', '👎', '👏', '🙌', '👐',
  '🤲', '🤝', '🙏', '✊', '👊', '✌️', '🤞', '🤟', '🤘', '👌',
  '👈', '👉', '👆', '👇', '👋', '🤙', '💪', '👀', '🧠', '💋',
];

function SwipeableBubbleRow({
  children,
  onSwipeReply,
  onLongPress,
  isSelected,
  disabled,
}: {
  children: React.ReactNode;
  onSwipeReply: () => void;
  onLongPress: () => void;
  isSelected?: boolean;
  disabled?: boolean;
}) {
  const panX = useRef(new Animated.Value(0)).current;

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gestureState) => {
        if (disabled) return false;
        return gestureState.dx > 12 && Math.abs(gestureState.dx) > Math.abs(gestureState.dy * 1.5);
      },
      onPanResponderMove: (_, gestureState) => {
        if (disabled) return;
        if (gestureState.dx > 0) {
          panX.setValue(Math.min(gestureState.dx, 70));
        }
      },
      onPanResponderRelease: (_, gestureState) => {
        if (!disabled && gestureState.dx > 45) {
          onSwipeReply();
        }
        Animated.spring(panX, {
          toValue: 0,
          useNativeDriver: true,
          bounciness: 6,
        }).start();
      },
      onPanResponderTerminate: () => {
        Animated.spring(panX, {
          toValue: 0,
          useNativeDriver: true,
        }).start();
      },
    })
  ).current;

  const iconOpacity = panX.interpolate({
    inputRange: [0, 10, 35],
    outputRange: [0, 0.4, 1],
    extrapolate: 'clamp',
  });

  const iconScale = panX.interpolate({
    inputRange: [0, 10, 45],
    outputRange: [0.4, 0.6, 1],
    extrapolate: 'clamp',
  });

  return (
    <View style={[styles.swipeRowWrapper, isSelected && styles.selectedRowWrapper]}>
      {!disabled && (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.swipeReplyIconArea,
            {
              opacity: iconOpacity,
              transform: [{ scale: iconScale }],
            },
          ]}
        >
          <Reply size={20} color="#25D366" />
        </Animated.View>
      )}
      <Animated.View
        {...panResponder.panHandlers}
        style={{ transform: [{ translateX: panX }] }}
      >
        <Pressable onLongPress={onLongPress} delayLongPress={280}>
          {children}
        </Pressable>
      </Animated.View>
    </View>
  );
}

export default function ConversationScreen() {
  const { kind, id, name, search, avatar } = useLocalSearchParams<{ kind?: string; id?: string; name?: string; search?: string; avatar?: string }>();
  const insets = useSafeAreaInsets();
  const [chatTitle, setChatTitle] = useState(name || '');
  const [chatAvatarUrl, setChatAvatarUrl] = useState<string | null>(avatar || null);
  const [wallpaperTheme, setWallpaperTheme] = useState<ChatWallpaperTheme>('light');
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

  // WhatsApp selection mode & Reactions & In-chat Search & Emoji Picker
  const [selectedMessage, setSelectedMessage] = useState<LocalMessage | null>(null);
  const [isSearching, setIsSearching] = useState(search === '1');
  const [searchQuery, setSearchQuery] = useState('');
  const [currentMatchIdx, setCurrentMatchIdx] = useState(0);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);

  // Group Hangout Rooms
  const [showRoomModal, setShowRoomModal] = useState(false);
  const [activeGroupRoom, setActiveGroupRoom] = useState<ActiveGroupRoom | null>(null);
  const [directRoomInvite, setDirectRoomInvite] = useState<{
    id: string;
    roomId: string;
    roomName?: string;
    roomKind: string;
    inviterId: string;
    inviterName: string;
    isPrivate?: boolean;
  } | null>(null);
  const [selectedRoomTheme, setSelectedRoomTheme] = useState<'beach' | 'tea' | 'loft' | 'roof'>('beach');
  const [creatingRoom, setCreatingRoom] = useState(false);

  const flatListRef = useRef<FlatList<LocalMessage>>(null);

  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingExpiry = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const lastTyping = useRef(0);
  const draftRef = useRef('');
  const typingRevision = useRef(0);
  const valid = (kind === 'direct' || kind === 'group') && typeof id === 'string' && id.length > 0;
  const target: ChatTarget | null = useMemo(() => valid ? { kind: kind as ChatTarget['kind'], id: id as string } : null, [valid, kind, id]);

  const reversedMessages = useMemo(() => [...messages].reverse(), [messages]);

  const searchMatches = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const q = searchQuery.toLowerCase().trim();
    return reversedMessages.filter(m => !m.body.startsWith('__adda_media__') && !m.body.startsWith('__adda_room_card__') && m.body !== '__adda_deleted__' && m.body.toLowerCase().includes(q));
  }, [searchQuery, reversedMessages]);

  useEffect(() => {
    setCurrentMatchIdx(0);
  }, [searchQuery]);

  const jumpToMatch = (idx: number) => {
    if (searchMatches.length === 0) return;
    const targetMsg = searchMatches[idx];
    const flatIdx = reversedMessages.findIndex(m => m.id === targetMsg.id);
    if (flatIdx !== -1) {
      try {
        flatListRef.current?.scrollToIndex({ index: flatIdx, animated: true, viewPosition: 0.5 });
      } catch {}
    }
  };

  const nextSearchMatch = () => {
    if (searchMatches.length === 0) return;
    const nextIdx = (currentMatchIdx + 1) % searchMatches.length;
    setCurrentMatchIdx(nextIdx);
    jumpToMatch(nextIdx);
  };

  const prevSearchMatch = () => {
    if (searchMatches.length === 0) return;
    const prevIdx = (currentMatchIdx - 1 + searchMatches.length) % searchMatches.length;
    setCurrentMatchIdx(prevIdx);
    jumpToMatch(prevIdx);
  };

  useEffect(() => {
    if (name) setChatTitle(name);
  }, [name]);

  useEffect(() => {
    if (avatar) setChatAvatarUrl(avatar);
  }, [avatar]);

  const checkActiveRoom = useCallback(async () => {
    if (!target?.id) return;
    try {
      if (kind === 'group') {
        const res = await socialApi<{ active: boolean; room: ActiveGroupRoom | null }>(`/groups/${target.id}/rooms/active`);
        if (res.active && res.room) {
          setActiveGroupRoom(res.room);
        } else {
          setActiveGroupRoom(null);
        }
      } else if (kind === 'direct') {
        const res = await socialApi<{ activeRooms: any[]; invites: any[] }>('/updates/hangouts');
        const match = res.invites?.find((i: any) => i.inviterId === target.id);
        if (match) {
          setDirectRoomInvite({
            id: match.id,
            roomId: match.roomId,
            roomName: match.roomName || match.groupName,
            roomKind: match.roomKind,
            inviterId: match.inviterId,
            inviterName: match.inviterName,
            isPrivate: match.isPrivate,
          });
        } else {
          setDirectRoomInvite(null);
        }
      }
    } catch {}
  }, [kind, target?.id]);

  useEffect(() => {
    void checkActiveRoom();
  }, [checkActiveRoom]);

  useEffect(() => {
    let live: any = null;
    const onRoomUpdated = (data: any) => {
      if (data?.groupId === target?.id) {
        setActiveGroupRoom(data.active === false ? null : data);
      }
    };
    const onRoomInvite = (inv: any) => {
      if ((kind === 'direct' && inv.inviterId === target?.id) || (kind === 'group' && inv.groupId === target?.id)) {
        setDirectRoomInvite(inv);
      }
    };
    const onPublicClosed = () => {
      void checkActiveRoom();
    };
    void getRealtimeSocket().then(sock => {
      live = sock;
      sock.on('group:room_updated', onRoomUpdated);
      sock.on('room:invitation', onRoomInvite);
      sock.on('room:public_closed', onPublicClosed);
    });
    return () => {
      live?.off('group:room_updated', onRoomUpdated);
      live?.off('room:invitation', onRoomInvite);
      live?.off('room:public_closed', onPublicClosed);
    };
  }, [kind, target?.id, checkActiveRoom]);

  const handleCreateGroupRoom = async (theme: 'beach' | 'tea' | 'loft' | 'roof') => {
    if (!target?.id || creatingRoom) return;
    setCreatingRoom(true);
    try {
      if (kind === 'group') {
        const res = await socialApi<{ ok: boolean; room: any }>(`/groups/${target.id}/rooms`, 'POST', { roomKind: theme });
        const cardPayload: RoomCardPayload = {
          type: 'room_card',
          roomId: res.room.roomId,
          groupId: target.id,
          groupName: activeTitle,
          roomKind: theme,
          creatorId: selfId,
          creatorName: selfName || 'Host',
          createdAt: new Date().toISOString(),
          roomName: `${activeTitle} Hangout`,
          isPrivate: true,
        };
        await sendEncryptedMessage(
          target,
          `__adda_room_card__:${JSON.stringify(cardPayload)}`,
          selfName || 'Host',
          Crypto.randomUUID(),
          undefined,
          undefined,
          `🌴 ${selfName || 'Host'} invited you: ${cardPayload.roomName}`
        );
        setShowRoomModal(false);
        router.push({
          pathname: '/lobby',
          params: {
            room: theme,
            groupId: target.id,
            roomId: res.room.roomId,
            roomOwnerId: selfId,
            roomName: `${activeTitle} Hangout`,
            isPrivate: 'true',
          },
        } as unknown as Href);
      } else {
        const { createRoomServer } = await import('@/lib/rooms');
        const res = await createRoomServer({
          roomKind: theme,
          isPrivate: true,
          name: `Hangout with ${activeTitle}`,
          userInvites: [target.id],
        });
        const cardPayload: RoomCardPayload = {
          type: 'room_card',
          roomId: res.id,
          roomKind: theme,
          creatorId: selfId,
          creatorName: selfName || 'Host',
          createdAt: new Date().toISOString(),
          roomName: res.name,
          isPrivate: true,
        };
        await sendEncryptedMessage(
          target,
          `__adda_room_card__:${JSON.stringify(cardPayload)}`,
          selfName || 'Host',
          Crypto.randomUUID(),
          undefined,
          undefined,
          `🌴 ${selfName || 'Host'} invited you: ${res.name}`
        );
        setShowRoomModal(false);
        router.push({
          pathname: '/lobby',
          params: {
            room: theme,
            roomId: res.id,
            roomOwnerId: selfId,
            roomName: res.name,
            isPrivate: 'true',
          },
        } as unknown as Href);
      }
    } catch (err: any) {
      Alert.alert('Hangout', err?.message || 'Could not create room.');
    } finally {
      setCreatingRoom(false);
    }
  };

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

      if (target.kind === 'direct') {
        const fromOther = local.find(m => m.senderId === target.id && m.senderName);
        if (fromOther?.senderName && !name) {
          setChatTitle(fromOther.senderName);
        }
        void socialApi<PublicProfile[]>('/contacts').then(contacts => {
          const match = contacts.find(c => c.id === target.id);
          if (match?.avatarUrl) setChatAvatarUrl(match.avatarUrl);
          if (match?.name && !name) setChatTitle(match.name);
        }).catch(() => {});
      } else if (target.kind === 'group') {
        void socialApi<GroupDetails>(`/groups/${target.id}`).then(details => {
          setGroupMembers(details.members);
          if (details.avatarUrl) setChatAvatarUrl(details.avatarUrl);
          if (details.name && !name) setChatTitle(details.name);
        }).catch(() => {
          void socialApi<ChatGroup[]>('/groups').then(groups => {
            const match = groups.find(g => g.id === target.id);
            if (match?.avatarUrl) setChatAvatarUrl(match.avatarUrl);
            if (match?.name && !name) setChatTitle(match.name);
          }).catch(() => {});
        });
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

    const onRemoteDelete = (payload: { messageId: string }) => {
      if (payload?.messageId) {
        void handleRemoteMessageDeleted(payload.messageId);
        setMessages(curr => curr.map(m => m.id === payload.messageId ? { ...m, body: '__adda_deleted__', reactions: null, replyTo: null } : m));
        setSelectedMessage(current => (current?.id === payload.messageId ? null : current));
      }
    };

    const onRemoteReaction = (payload: { messageId: string; userId: string; emoji: string }) => {
      if (payload?.messageId) {
        void handleRemoteReaction(payload);
        setMessages(curr => curr.map(m => {
          if (m.id !== payload.messageId) return m;
          const reactions = { ...(m.reactions || {}) };
          if (reactions[payload.userId] === payload.emoji) {
            delete reactions[payload.userId];
          } else {
            reactions[payload.userId] = payload.emoji;
          }
          return { ...m, reactions };
        }));
      }
    };

    const onGroupUpdate = (payload?: { groupId?: string }) => {
      if (target.kind === 'group' && (!payload?.groupId || payload.groupId === target.id)) {
        clearKeyCache(target);
        void socialApi<GroupDetails>(`/groups/${target.id}`).then(details => {
          setGroupMembers(details.members);
          if (details.avatarUrl) setChatAvatarUrl(details.avatarUrl);
          if (details.name) setChatTitle(details.name);
        }).catch(() => {});
        void prefetchChatKeys(target);
      }
    };

    const onFriendsUpdated = () => {
      if (target.kind === 'direct') {
        void socialApi<PublicProfile[]>('/contacts').then(contacts => {
          const match = contacts.find(c => c.id === target.id);
          if (match?.avatarUrl) setChatAvatarUrl(match.avatarUrl);
          if (match?.name && !name) setChatTitle(match.name);
        }).catch(() => {});
      }
    };

    void getRealtimeSocket().then(value => {
      if (!active) return;
      live = value;
      value.on('chat:envelope', onEnvelope);
      value.on('chat:msg_status', onStatus);
      value.on('chat:typing', onTyping);
      value.on('chat:message_deleted', onRemoteDelete);
      value.on('chat:reaction_updated', onRemoteReaction);
      value.on('group:updated', onGroupUpdate);
      value.on('friends:updated', onFriendsUpdated);
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
      live?.off('chat:message_deleted', onRemoteDelete);
      live?.off('chat:reaction_updated', onRemoteReaction);
      live?.off('group:updated', onGroupUpdate);
      live?.off('friends:updated', onFriendsUpdated);
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
    const roomCard = roomCardFromBody(msg.body);
    const snippet = media
      ? (media.mediaKind === 'video' ? '🎥 Video' : '📷 Photo')
      : roomCard
      ? `🌴 Room Invite • ${roomCard.roomName || 'Hangout'}`
      : (msg.body.length > 80 ? msg.body.slice(0, 77) + '...' : msg.body);
    setReplyingTo({
      messageId: msg.id,
      senderId: msg.senderId,
      senderName: msg.senderName,
      snippet,
      mediaKind: media ? (media.mediaKind === 'video' ? 'video' : 'photo') : undefined,
      mediaId: media?.mediaId,
    });
  };

  const onMessageLongPress = (item: LocalMessage) => {
    if (item.body === '__adda_deleted__') {
      Alert.alert('Delete message?', 'Delete this message for yourself?', [
        {
          text: 'Delete for me',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteLocalMessage(item.id);
              setMessages(curr => curr.filter(m => m.id !== item.id));
            } catch {}
          },
        },
        { text: 'Cancel', style: 'cancel' },
      ]);
      return;
    }
    setSelectedMessage(item);
  };

  const handleReact = async (msg: LocalMessage, emoji: string) => {
    if (!target) return;
    const currentReactions: Record<string, string> = { ...(msg.reactions || {}) };
    if (currentReactions[selfId] === emoji) {
      delete currentReactions[selfId];
    } else {
      currentReactions[selfId] = emoji;
    }
    setMessages(curr =>
      curr.map(m => (m.id === msg.id ? { ...m, reactions: currentReactions } : m))
    );
    setSelectedMessage(null);
    try {
      await toggleMessageReaction(target, msg.id, emoji);
    } catch (err) {
      console.warn('React error:', err);
    }
  };

  const handleDeleteSelected = () => {
    if (!selectedMessage || !target) return;
    const isMine = selectedMessage.senderId === selfId;
    if (isMine) {
      Alert.alert(
        'Delete message?',
        'You can delete this message for everyone or just for yourself.',
        [
          {
            text: 'Delete for everyone',
            style: 'destructive',
            onPress: async () => {
              try {
                await deleteMessageForEveryone(target, selectedMessage.id);
                setMessages(curr => curr.map(m => m.id === selectedMessage.id ? { ...m, body: '__adda_deleted__', reactions: null, replyTo: null } : m));
                setSelectedMessage(null);
              } catch {
                Alert.alert('Error', 'Could not delete for everyone.');
              }
            },
          },
          {
            text: 'Delete for me',
            style: 'destructive',
            onPress: async () => {
              try {
                await deleteLocalMessage(selectedMessage.id);
                setMessages(curr => curr.filter(m => m.id !== selectedMessage.id));
                setSelectedMessage(null);
              } catch {
                Alert.alert('Error', 'Could not delete message.');
              }
            },
          },
          { text: 'Cancel', style: 'cancel', onPress: () => setSelectedMessage(null) },
        ]
      );
    } else {
      Alert.alert(
        'Delete message?',
        'Delete this message for yourself? It will remain for other people in this chat.',
        [
          {
            text: 'Delete for me',
            style: 'destructive',
            onPress: async () => {
              try {
                await deleteLocalMessage(selectedMessage.id);
                setMessages(curr => curr.filter(m => m.id !== selectedMessage.id));
                setSelectedMessage(null);
              } catch {
                Alert.alert('Error', 'Could not delete message.');
              }
            },
          },
          { text: 'Cancel', style: 'cancel', onPress: () => setSelectedMessage(null) },
        ]
      );
    }
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
      router.push({ pathname: '/call', params: { callId: call.id, role: call.callerId === selfId ? 'caller' : 'callee', name: activeTitle, media: call.media } } as unknown as Href);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not start call.'); }
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

  const renderMessageBody = (text: string, isMine: boolean, msgId: string, isLight: boolean) => {
    const textStyle = [styles.body, !isMine && styles.theirBody, isLight && styles.bodyLight];
    if (searchQuery.trim()) {
      const q = searchQuery.trim();
      const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`(${escaped})`, 'gi');
      const parts = text.split(regex);
      const isCurrentMatch = searchMatches[currentMatchIdx]?.id === msgId;
      return (
        <Text style={textStyle}>
          {parts.map((part, i) => {
            if (part.toLowerCase() === q.toLowerCase()) {
              return (
                <Text key={i} style={[styles.searchHighlight, isCurrentMatch && styles.searchHighlightActive]}>
                  {part}
                </Text>
              );
            }
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
    }

    const regex = /(@[A-Za-z0-9_]+(?:\s[A-Za-z0-9_]+)?|@everyone)/g;
    const parts = text.split(regex);
    if (parts.length <= 1) {
      return <Text style={textStyle}>{text}</Text>;
    }
    return (
      <Text style={textStyle}>
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
      {/* 1. SELECTION TOP BAR (WhatsApp style matching screenshot) */}
      {selectedMessage ? (
        <View style={styles.topSelectionBar}>
          <View style={styles.selectionLeft}>
            <Pressable onPress={() => setSelectedMessage(null)} style={styles.selectionBtn} accessibilityLabel="Cancel selection">
              <ArrowLeft size={24} color="#FFFFFF" />
            </Pressable>
            <Text style={styles.selectionCount}>1</Text>
          </View>
          <View style={styles.selectionRight}>
            <Pressable onPress={() => { triggerReply(selectedMessage); setSelectedMessage(null); }} style={styles.selectionBtn} accessibilityLabel="Reply">
              <Reply size={22} color="#FFFFFF" />
            </Pressable>
            <Pressable onPress={handleDeleteSelected} style={styles.selectionBtn} accessibilityLabel="Delete">
              <Trash2 size={22} color="#FFFFFF" />
            </Pressable>
            <Pressable onPress={() => setSelectedMessage(null)} style={styles.selectionBtn} accessibilityLabel="More options">
              <MoreVertical size={22} color="#FFFFFF" />
            </Pressable>
          </View>
        </View>
      ) : isSearching ? (
        /* 2. SEARCH TOP BAR */
        <View style={styles.topSearchBar}>
          <Pressable onPress={() => { setIsSearching(false); setSearchQuery(''); }} style={styles.searchBackBtn} accessibilityLabel="Close search">
            <ArrowLeft size={24} color="#FFFFFF" />
          </Pressable>
          <TextInput
            style={styles.searchInput}
            placeholder="Search messages..."
            placeholderTextColor="#8E9BA8"
            value={searchQuery}
            onChangeText={setSearchQuery}
            autoFocus
          />
          {searchQuery.trim().length > 0 && (
            <View style={styles.searchControls}>
              <Text style={styles.searchMatchCount}>
                {searchMatches.length > 0 ? `${currentMatchIdx + 1}/${searchMatches.length}` : '0/0'}
              </Text>
              <Pressable onPress={prevSearchMatch} style={styles.searchNavBtn} accessibilityLabel="Previous match">
                <ChevronUp size={20} color="#FFFFFF" />
              </Pressable>
              <Pressable onPress={nextSearchMatch} style={styles.searchNavBtn} accessibilityLabel="Next match">
                <ChevronDown size={20} color="#FFFFFF" />
              </Pressable>
              <Pressable onPress={() => setSearchQuery('')} style={styles.searchNavBtn} accessibilityLabel="Clear search">
                <X size={18} color="#8E9BA8" />
              </Pressable>
            </View>
          )}
        </View>
      ) : (
        /* 3. NORMAL TOP BAR */
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
                {chatAvatarUrl ? (
                  <Image source={{ uri: chatAvatarUrl }} style={styles.headerAvatarImg} />
                ) : (
                  <Text style={styles.initial}>{activeTitle[0]?.toUpperCase() || '?'}</Text>
                )}
              </View>
              <View style={styles.titleWrap}>
                <Text style={styles.title} numberOfLines={1} ellipsizeMode="tail">{activeTitle}</Text>
                <View style={styles.subtitleRow}>
                  <Text style={[styles.subtitle, Object.keys(typingNames).length > 0 && styles.typingSubtitle]} numberOfLines={1} ellipsizeMode="tail">
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
                {chatAvatarUrl ? (
                  <Image source={{ uri: chatAvatarUrl }} style={styles.headerAvatarImg} />
                ) : (
                  <Text style={styles.initial}>{activeTitle[0]?.toUpperCase() || '?'}</Text>
                )}
              </View>
              <View style={styles.titleWrap}>
                <Text style={styles.title} numberOfLines={1} ellipsizeMode="tail">{activeTitle}</Text>
                <View style={styles.subtitleRow}>
                  <Text style={[styles.subtitle, Object.keys(typingNames).length > 0 && styles.typingSubtitle]} numberOfLines={1} ellipsizeMode="tail">
                    {Object.keys(typingNames).length
                      ? `${Object.values(typingNames).slice(0, 2).join(', ')} typing`
                      : 'Contact'}
                  </Text>
                  {Object.keys(typingNames).length > 0 && <TypingDots />}
                </View>
              </View>
            </View>
          )}

          <View style={styles.headerRightActions}>
            <Pressable
              accessibilityLabel="Hangout Room"
              onPress={() => setShowRoomModal(true)}
              style={[styles.callAction, (activeGroupRoom || directRoomInvite) && styles.callActionActiveRoom]}
            >
              <DoorOpen size={21} color={(activeGroupRoom || directRoomInvite) ? '#25D366' : colors.primary} />
            </Pressable>
            <Pressable accessibilityLabel="Video call" onPress={() => void startCall('video')} style={styles.callAction}>
              <Video size={22} color={colors.primary} />
            </Pressable>
            <Pressable accessibilityLabel="Voice call" onPress={() => void startCall('audio')} style={styles.callAction}>
              <Phone size={20} color={colors.primary} />
            </Pressable>
            <Pressable
              accessibilityLabel="More options"
              onPress={() => setShowMenu(true)}
              style={styles.callAction}
            >
              <MoreVertical size={20} color={colors.text} />
            </Pressable>
          </View>
        </View>
      )}

      {/* Active Room / In-Chat Room Invite Banner */}
      {(activeGroupRoom || directRoomInvite) && (
        <View style={styles.chatRoomBanner}>
          <View style={styles.chatRoomBannerLeft}>
            <View style={styles.chatRoomBannerDot} />
            <Text style={styles.chatRoomBannerTitle} numberOfLines={1}>
              {activeGroupRoom
                ? (activeGroupRoom.name || `${activeGroupRoom.creatorName} started a room`)
                : (directRoomInvite?.roomName || `${directRoomInvite?.inviterName} invited you`)}
            </Text>
          </View>
          <Pressable
            onPress={() => {
              const item = activeGroupRoom || directRoomInvite!;
              router.push({
                pathname: '/lobby',
                params: {
                  room: item.roomKind,
                  groupId: (item as any).groupId || '',
                  roomId: (item as any).roomId || (item as any).id,
                  roomOwnerId: (item as any).creatorId || (item as any).ownerId || (item as any).inviterId,
                  roomName: (item as any).name || (item as any).roomName || 'Hangout',
                  isPrivate: String((item as any).isPrivate ?? true),
                },
              } as unknown as Href);
            }}
            style={styles.chatRoomBannerBtn}
          >
            <DoorOpen size={14} color="#FFFFFF" />
            <Text style={styles.chatRoomBannerBtnText}>Join Room</Text>
          </Pressable>
        </View>
      )}

      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={Platform.OS === 'ios' ? 20 : 0}>
        <ChatWallpaper theme={wallpaperTheme} />
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
            const isDeleted = item.body === '__adda_deleted__';
            const isLight = wallpaperTheme === 'light';

            if (isDeleted) {
              return (
                <SwipeableBubbleRow
                  onSwipeReply={() => {}}
                  onLongPress={() => onMessageLongPress(item)}
                  isSelected={false}
                  disabled={true}
                >
                  <View
                    style={[
                      styles.bubble,
                      mine ? (isLight ? styles.myBubbleLight : styles.myBubble) : (isLight ? styles.theirBubbleLight : styles.theirBubble),
                      styles.deletedBubble,
                      isLight && styles.deletedBubbleLight,
                    ]}
                  >
                    <View style={styles.deletedRow}>
                      <Ban size={15} color={isLight ? '#8696A0' : (mine ? 'rgba(255, 255, 255, 0.65)' : colors.muted)} style={{ marginRight: 6 }} />
                      <Text style={[styles.deletedText, !mine && styles.theirDeletedText, isLight && styles.deletedTextLight]}>
                        {mine ? 'You deleted this message' : 'This message was deleted'}
                      </Text>
                      <Text style={[styles.deletedTime, !mine && styles.theirDeletedTime, isLight && styles.messageTimeLight]}>
                        {new Date(item.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                      </Text>
                    </View>
                  </View>
                </SwipeableBubbleRow>
              );
            }

            const media = mediaFromBody(item.body);
            const roomCard = roomCardFromBody(item.body);
            const isTagged = !mine && (item.mentions?.includes(selfId) || item.mentions?.includes('everyone'));
            const isSelected = selectedMessage?.id === item.id;
            const hasReactions = Boolean(item.reactions && Object.keys(item.reactions).length > 0);

            return (
              <SwipeableBubbleRow
                onSwipeReply={() => triggerReply(item)}
                onLongPress={() => onMessageLongPress(item)}
                isSelected={isSelected}
              >
                {/* Floating WhatsApp Emoji Reaction Pill directly above selected message */}
                {isSelected && (
                  <View style={[styles.floatingReactionPill, mine ? styles.myReactionFloating : styles.theirReactionFloating]}>
                    {['👍', '❤️', '😂', '😮', '😢', '🙏'].map((emoji) => (
                      <Pressable
                        key={emoji}
                        onPress={() => void handleReact(item, emoji)}
                        style={styles.reactionEmojiBtn}
                      >
                        <Text style={styles.reactionEmojiText}>{emoji}</Text>
                      </Pressable>
                    ))}
                    <Pressable
                      onPress={() => {
                        setShowEmojiPicker(true);
                      }}
                      style={styles.reactionPlusBtn}
                    >
                      <Text style={styles.reactionPlusText}>＋</Text>
                    </Pressable>
                  </View>
                )}

                <View
                  style={[
                    styles.bubble,
                    mine ? (isLight ? styles.myBubbleLight : styles.myBubble) : (isLight ? styles.theirBubbleLight : styles.theirBubble),
                    media && styles.mediaBubble,
                    isTagged && styles.taggedBubble,
                    hasReactions && styles.bubbleWithReactions,
                  ]}
                >
                  {kind === 'group' && !mine && <Text style={[styles.sender, isLight && styles.senderLight]}>{item.senderName}</Text>}

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
                      style={[
                        styles.quotedBubbleCard,
                        mine ? (isLight ? styles.myQuotedBubbleCardLight : styles.myQuotedBubbleCard) : (isLight ? styles.theirQuotedBubbleCardLight : styles.theirQuotedBubbleCard)
                      ]}
                    >
                      <View style={styles.quotedAccentBar} />
                      <View style={styles.quotedBubbleContent}>
                        <Text style={[styles.quotedSenderName, isLight && styles.quotedSenderNameLight]} numberOfLines={1}>
                          {item.replyTo.senderId === selfId ? 'You' : item.replyTo.senderName}
                        </Text>
                        <Text style={[styles.quotedSnippet, mine ? styles.myQuotedSnippet : styles.theirQuotedSnippet, isLight && styles.quotedSnippetLight]} numberOfLines={2}>
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

                  {roomCard ? (
                    <RoomCardMessage
                      card={roomCard}
                      isMine={mine}
                      isLight={isLight}
                      onJoin={() => {
                        router.push({
                          pathname: '/lobby',
                          params: {
                            room: roomCard.roomKind,
                            groupId: roomCard.groupId || '',
                            roomId: roomCard.roomId,
                            roomOwnerId: roomCard.creatorId,
                            roomName: roomCard.roomName || name || 'Hangout',
                            isPrivate: String(roomCard.isPrivate ?? false),
                          },
                        } as unknown as Href);
                      }}
                    />
                  ) : media ? (
                    <MediaMessage
                      media={media}
                      onPress={(mediaUri) => {
                        if (selectedMessage) {
                          setSelectedMessage(null);
                          return;
                        }
                        setViewerMedia({
                          uri: mediaUri,
                          media,
                          messageId: item.id,
                          senderName: item.senderName,
                          createdAt: item.createdAt,
                          mine,
                        });
                      }}
                      onLongPress={() => onMessageLongPress(item)}
                    />
                  ) : (
                    renderMessageBody(item.body, mine, item.id, isLight)
                  )}

                  <View style={[styles.messageFooter, media && styles.mediaFooter]}>
                    <Text style={[styles.messageTime, !mine && styles.theirMessageTime, isLight && styles.messageTimeLight]}>
                      {new Date(item.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                    </Text>
                    {mine && (
                      <Text accessibilityLabel={item.status === 'read' ? 'Read' : item.status === 'delivered' ? 'Delivered' : item.status === 'sent' ? 'Sent' : 'Pending'} style={[styles.tick, isLight && styles.tickLight, item.status === 'read' && (isLight ? styles.readTickLight : styles.readTick)]}>
                        {item.status === 'read' || item.status === 'delivered' ? '✓✓' : item.status === 'sent' ? '✓' : '○'}
                      </Text>
                    )}
                  </View>

                  {/* Reaction Badge on message bubble */}
                  {(() => {
                    if (!item.reactions || typeof item.reactions !== 'object') return null;
                    const counts: Record<string, number> = {};
                    for (const e of Object.values(item.reactions)) {
                      if (typeof e === 'string') counts[e] = (counts[e] || 0) + 1;
                    }
                    const entries = Object.entries(counts);
                    if (entries.length === 0) return null;
                    const myEmoji = selfId && item.reactions[selfId];
                    return (
                      <Pressable
                        onPress={() => {
                          if (myEmoji) {
                            void handleReact(item, myEmoji);
                          } else {
                            onMessageLongPress(item);
                          }
                        }}
                        style={[
                          styles.reactionBadge,
                          mine ? styles.myReactionBadge : styles.theirReactionBadge,
                          isLight && styles.reactionBadgeLight,
                          myEmoji && styles.myReactionActiveBadge,
                        ]}
                      >
                        <Text style={[styles.reactionBadgeText, isLight && styles.reactionBadgeTextLight]}>
                          {entries.map(([e]) => e).join('')} {entries.reduce((acc, [, c]) => acc + c, 0) > 1 ? entries.reduce((acc, [, c]) => acc + c, 0) : ''}
                        </Text>
                      </Pressable>
                    );
                  })()}
                </View>
              </SwipeableBubbleRow>
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

        {/* Composer with Emoji, Attach, and Send */}
        <View style={styles.composer}>
          <Pressable
            accessibilityLabel="Emoji tray"
            onPress={() => setShowEmojiPicker(prev => !prev)}
            style={styles.attach}
          >
            <Smile size={23} color={showEmojiPicker ? '#25D366' : colors.primary} />
          </Pressable>
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

        {/* EMOJI TRAY TRAY */}
        {showEmojiPicker && (
          <View style={styles.emojiTrayContainer}>
            {selectedMessage && (
              <View style={styles.emojiTrayHeader}>
                <Text style={styles.emojiTrayHeaderText}>React to message</Text>
                <Pressable onPress={() => setShowEmojiPicker(false)} style={styles.emojiTrayCloseBtn}>
                  <X size={18} color="#8E9BA8" />
                </Pressable>
              </View>
            )}
            <ScrollView
              contentContainerStyle={styles.emojiGrid}
              keyboardShouldPersistTaps="always"
            >
              {EMOJI_LIST.map((emoji) => (
                <Pressable
                  key={emoji}
                  onPress={() => {
                    if (selectedMessage) {
                      void handleReact(selectedMessage, emoji);
                      setShowEmojiPicker(false);
                    } else {
                      onDraftChange(draft + emoji);
                    }
                  }}
                  style={styles.emojiGridItem}
                >
                  <Text style={styles.emojiGridText}>{emoji}</Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        )}
      </KeyboardAvoidingView>

      {/* Group Hangout Room Creation / Active Modal */}
      <Modal
        visible={showRoomModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowRoomModal(false)}
      >
        <KeyboardAvoidingView style={styles.hangoutModalOverlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <Pressable style={styles.scrim} onPress={() => setShowRoomModal(false)} />
          <View style={styles.hangoutModalSheet}>
            <View style={styles.hangoutModalTop}>
              <Text style={styles.hangoutModalTitle}>{kind === 'group' ? 'Group Hangout' : '3D Hangout'}</Text>
              <Pressable onPress={() => setShowRoomModal(false)} accessibilityLabel="Close">
                <X size={22} color={colors.text} />
              </Pressable>
            </View>

            {(activeGroupRoom || directRoomInvite) ? (
              <View style={styles.activeRoomBanner}>
                <Text style={styles.activeRoomBannerTitle}>🟢 Live Hangout in Progress</Text>
                <Text style={styles.activeRoomBannerText}>
                  {activeGroupRoom
                    ? `${activeGroupRoom.creatorName} started ${activeGroupRoom.name || 'a room'} for this group.`
                    : `${directRoomInvite?.inviterName} invited you to ${directRoomInvite?.roomName || 'Hangout'}.`}
                </Text>
                <Pressable
                  onPress={() => {
                    const item = activeGroupRoom || directRoomInvite!;
                    setShowRoomModal(false);
                    router.push({
                      pathname: '/lobby',
                      params: {
                        room: item.roomKind,
                        groupId: (item as any).groupId || '',
                        roomId: (item as any).roomId || (item as any).id,
                        roomOwnerId: (item as any).creatorId || (item as any).ownerId || (item as any).inviterId,
                        roomName: (item as any).name || (item as any).roomName || 'Hangout',
                        isPrivate: String((item as any).isPrivate ?? true),
                      },
                    } as unknown as Href);
                  }}
                  style={styles.activeRoomJoinBtn}
                >
                  <DoorOpen size={19} color="#FFFFFF" />
                  <Text style={styles.activeRoomJoinBtnText}>Join Active Room</Text>
                </Pressable>
              </View>
            ) : null}

            <Text style={styles.hangoutModalSub}>
              {(activeGroupRoom || directRoomInvite) ? 'Or choose a scene to start a new room:' : `Choose a scene to launch a room with ${activeTitle}:`}
            </Text>

            <ScrollView style={{ maxHeight: 280 }}>
              {roomThemes.map(t => {
                const selected = selectedRoomTheme === t.id;
                return (
                  <Pressable
                    key={t.id}
                    onPress={() => setSelectedRoomTheme(t.id)}
                    style={[styles.hangoutThemeRow, selected && styles.hangoutThemeRowActive]}
                  >
                    <Text style={styles.hangoutThemeEmoji}>{t.emoji}</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.hangoutThemeName}>{t.name}</Text>
                      <Text style={styles.hangoutThemeDesc}>{t.desc}</Text>
                    </View>
                    {selected && <Check size={20} color="#25D366" />}
                  </Pressable>
                );
              })}
            </ScrollView>

            <Pressable
              disabled={creatingRoom}
              onPress={() => void handleCreateGroupRoom(selectedRoomTheme)}
              style={[styles.hangoutStartBtn, creatingRoom && { opacity: 0.6 }]}
            >
              <DoorOpen size={20} color="#FFFFFF" />
              <Text style={styles.hangoutStartBtnText}>
                {creatingRoom ? 'Starting Room…' : 'Start & Enter Room'}
              </Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* WhatsApp-style 3-dots Dropdown Menu */}
      <Modal
        visible={showMenu}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setShowMenu(false)}
      >
        <Pressable style={styles.menuOverlay} onPress={() => setShowMenu(false)}>
          <View style={[styles.menuDropdown, { top: insets.top + (Platform.OS === 'ios' ? 44 : 40) }, wallpaperTheme === 'dark' && styles.menuDropdownDark]}>
            {kind === 'group' && (
              <Pressable
                style={styles.menuItem}
                onPress={() => {
                  setShowMenu(false);
                  router.push({
                    pathname: '/group-info',
                    params: { id: target?.id, name: activeTitle },
                  } as unknown as Href);
                }}
              >
                <Text style={[styles.menuItemText, wallpaperTheme === 'dark' && styles.menuItemTextDark]}>Group info</Text>
              </Pressable>
            )}

            <Pressable
              style={styles.menuItem}
              onPress={() => {
                setShowMenu(false);
                setIsSearching(true);
              }}
            >
              <Text style={[styles.menuItemText, wallpaperTheme === 'dark' && styles.menuItemTextDark]}>Search</Text>
            </Pressable>

            {kind === 'group' && (
              <Pressable
                style={styles.menuItem}
                onPress={() => {
                  setShowMenu(false);
                  setShowRoomModal(true);
                }}
              >
                <Text style={[styles.menuItemText, wallpaperTheme === 'dark' && styles.menuItemTextDark]}>3D Hangout Room</Text>
              </Pressable>
            )}

            <Pressable
              style={styles.menuItem}
              onPress={() => {
                setShowMenu(false);
                setWallpaperTheme(curr => curr === 'light' ? 'dark' : 'light');
              }}
            >
              <Text style={[styles.menuItemText, wallpaperTheme === 'dark' && styles.menuItemTextDark]}>
                {wallpaperTheme === 'light' ? '🌙 Dark wallpaper' : '☀️ Light wallpaper'}
              </Text>
            </Pressable>

            <Pressable
              style={styles.menuItem}
              onPress={() => {
                setShowMenu(false);
                Alert.alert(
                  'Clear messages?',
                  'Clear local messages in this conversation?',
                  [
                    {
                      text: 'Clear',
                      style: 'destructive',
                      onPress: async () => {
                        try {
                          for (const m of messages) {
                            await deleteLocalMessage(m.id);
                          }
                          setMessages([]);
                        } catch {}
                      },
                    },
                    { text: 'Cancel', style: 'cancel' },
                  ]
                );
              }}
            >
              <Text style={[styles.menuItemText, styles.menuItemTextDanger]}>Clear chat</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>

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

            {/* Quick Reaction Bar in Full-Screen Viewer */}
            <View style={styles.viewerFooterBar}>
              <View style={styles.viewerReactionPill}>
                {['👍', '❤️', '😂', '😮', '😢', '🙏'].map((emoji) => {
                  const currentViewerMsg = messages.find(m => m.id === viewerMedia.messageId);
                  const isReacted = currentViewerMsg?.reactions?.[selfId] === emoji;
                  return (
                    <Pressable
                      key={emoji}
                      onPress={() => {
                        if (currentViewerMsg) {
                          void handleReact(currentViewerMsg, emoji);
                        }
                      }}
                      style={[styles.viewerReactionEmojiBtn, isReacted && styles.viewerReactionEmojiActive]}
                    >
                      <Text style={styles.viewerReactionEmojiText}>{emoji}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          </SafeAreaView>
        </Modal>
      )}
    </SafeAreaView>
  );
}

function MediaMessage({
  media,
  onPress,
  onLongPress,
}: {
  media: EncryptedMedia;
  onPress: (uri: string) => void;
  onLongPress?: () => void;
}) {
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
      <Pressable onLongPress={onLongPress} delayLongPress={280} style={styles.mediaLoading}>
        <ActivityIndicator size="small" color={colors.primary} />
        <Text style={styles.mediaLoadingText}>Downloading {media.mediaKind}...</Text>
      </Pressable>
    );
  }

  if (uri) {
    return (
      <Pressable
        onPress={() => onPress(uri)}
        onLongPress={onLongPress}
        delayLongPress={280}
        style={styles.mediaPressable}
      >
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
      onLongPress={onLongPress}
      delayLongPress={280}
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

const roomThemes = [
  { id: 'beach', name: 'Goa Beach', emoji: '🏖️', desc: 'Sunset shores, shacks & ocean waves' },
  { id: 'tea', name: 'Tea Party', emoji: '☕', desc: 'Meet at the roadside adda' },
  { id: 'loft', name: 'Loft 16', emoji: '🏢', desc: 'A cozy place to gather' },
  { id: 'roof', name: 'School Rooftop', emoji: '🏫', desc: 'Evening sky & school rooftop' },
] as const;

function RoomCardMessage({
  card,
  isMine,
  isLight,
  onJoin,
}: {
  card: RoomCardPayload;
  isMine: boolean;
  isLight: boolean;
  onJoin: () => void;
}) {
  const info = roomThemes.find(t => t.id === card.roomKind) || roomThemes[0];
  return (
    <View style={styles.roomCardBox}>
      <View style={styles.roomCardHeader}>
        <View style={styles.roomCardBadge}>
          <Text style={styles.roomCardBadgeText}>3D HANGOUT</Text>
        </View>
        <Text style={styles.roomCardEmoji}>{info.emoji}</Text>
      </View>
      <Text style={[styles.roomCardTitle, isLight && styles.roomCardTitleLight]}>{card.roomName || info.name}</Text>
      <Text style={[styles.roomCardDesc, isLight && styles.roomCardDescLight]}>{info.desc}</Text>
      <Text style={[styles.roomCardAuthor, isLight && styles.roomCardAuthorLight]}>
        {isMine ? `Hosted by you • ${card.isPrivate ? 'Private' : 'Public'} Server` : `Hosted by ${card.creatorName} • ${card.isPrivate ? 'Private' : 'Public'} Server`}
      </Text>
      <Pressable onPress={onJoin} style={styles.roomCardJoinButton}>
        <DoorOpen size={18} color="#FFFFFF" />
        <Text style={styles.roomCardJoinButtonText}>Join Room</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  top: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  back: { padding: 6, marginRight: 2 },
  headerPressable: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: 6,
  },
  avatar: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  initial: { color: '#FFFFFF', fontWeight: '800', fontSize: 17 },
  titleWrap: { flex: 1, minWidth: 0, justifyContent: 'center' },
  title: { color: colors.text, fontWeight: '700', fontSize: 16, lineHeight: 20 },
  subtitleRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 1, minWidth: 0 },
  subtitle: { color: colors.muted, fontSize: 12, lineHeight: 15, flexShrink: 1 },
  typingSubtitle: { color: colors.primary, fontWeight: '600' },
  headerRightActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  callAction: {
    padding: 7,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
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
  topSelectionBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#1F2C34',
    borderBottomWidth: 1,
    borderBottomColor: '#2D383E',
  },
  selectionLeft: { flexDirection: 'row', alignItems: 'center', gap: 18 },
  selectionCount: { color: '#FFFFFF', fontSize: 18, fontWeight: '700' },
  selectionRight: { flexDirection: 'row', alignItems: 'center', gap: 20 },
  selectionBtn: { padding: 4 },
  topSearchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: '#1F2C34',
    borderBottomWidth: 1,
    borderBottomColor: '#2D383E',
    gap: 12,
  },
  searchBackBtn: { padding: 4 },
  searchInput: {
    flex: 1,
    height: 40,
    backgroundColor: '#121B22',
    borderRadius: 8,
    paddingHorizontal: 12,
    color: '#FFFFFF',
    fontSize: 15,
  },
  searchControls: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  searchMatchCount: { color: '#8E9BA8', fontSize: 13, fontWeight: '600' },
  searchNavBtn: { padding: 4 },
  searchHighlight: { backgroundColor: '#F59E0B', color: '#000000', borderRadius: 2 },
  searchHighlightActive: { backgroundColor: '#25D366', color: '#000000', fontWeight: '800' },
  swipeRowWrapper: { position: 'relative', width: '100%', marginVertical: 2 },
  selectedRowWrapper: { backgroundColor: 'rgba(37, 211, 102, 0.16)', borderRadius: 12 },
  swipeReplyIconArea: {
    position: 'absolute',
    left: 8,
    top: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    width: 32,
    zIndex: 0,
  },
  floatingReactionPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#202C33',
    borderRadius: 24,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginBottom: 6,
    elevation: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 6,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    gap: 6,
  },
  myReactionFloating: { alignSelf: 'flex-end', marginRight: 8 },
  theirReactionFloating: { alignSelf: 'flex-start', marginLeft: 8 },
  reactionEmojiBtn: { paddingHorizontal: 6, paddingVertical: 2 },
  reactionEmojiText: { fontSize: 24 },
  reactionPlusBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#2A3942',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 4,
  },
  reactionPlusText: { color: '#8E9BA8', fontSize: 18, fontWeight: '700' },
  bubbleWithReactions: {
    marginBottom: 10,
  },
  reactionBadge: {
    position: 'absolute',
    bottom: -10,
    backgroundColor: '#202C33',
    borderRadius: 12,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderWidth: 1.5,
    borderColor: '#0B1014',
    elevation: 4,
    zIndex: 10,
  },
  myReactionBadge: { right: 8 },
  theirReactionBadge: { left: 8 },
  myReactionActiveBadge: {
    borderColor: '#25D366',
    backgroundColor: '#1E3A2F',
  },
  reactionBadgeText: { fontSize: 12, color: '#FFFFFF' },
  viewerFooterBar: {
    position: 'absolute',
    bottom: 24,
    left: 0,
    right: 0,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 20,
  },
  viewerReactionPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(32, 44, 51, 0.92)',
    borderRadius: 28,
    paddingHorizontal: 12,
    paddingVertical: 6,
    elevation: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    gap: 8,
  },
  viewerReactionEmojiBtn: {
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderRadius: 16,
  },
  viewerReactionEmojiActive: {
    backgroundColor: 'rgba(37, 211, 102, 0.25)',
  },
  viewerReactionEmojiText: {
    fontSize: 26,
  },
  emojiTrayHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#202C33',
  },
  emojiTrayHeaderText: {
    color: '#8E9BA8',
    fontSize: 13,
    fontWeight: '600',
  },
  emojiTrayCloseBtn: {
    padding: 4,
  },
  emojiTrayContainer: {
    height: 220,
    backgroundColor: '#121B22',
    borderTopWidth: 1,
    borderTopColor: '#202C33',
  },
  emojiGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 8,
    paddingVertical: 10,
    justifyContent: 'flex-start',
  },
  emojiGridItem: {
    width: '12.5%',
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emojiGridText: {
    fontSize: 26,
  },
  deletedBubble: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 16,
    maxWidth: '85%',
  },
  deletedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  deletedText: {
    fontStyle: 'italic',
    fontSize: 14,
    color: 'rgba(255, 255, 255, 0.75)',
    flexShrink: 1,
  },
  theirDeletedText: {
    color: colors.muted,
  },
  deletedTime: {
    fontSize: 10,
    color: 'rgba(255, 255, 255, 0.6)',
    marginLeft: 8,
    alignSelf: 'flex-end',
  },
  theirDeletedTime: {
    color: colors.muted,
  },
  headerAvatarImg: {
    width: 40,
    height: 40,
    borderRadius: 20,
  },
  myBubbleLight: {
    alignSelf: 'flex-end',
    backgroundColor: '#D9FDD3',
    borderBottomRightRadius: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 1.5,
    elevation: 1,
  },
  theirBubbleLight: {
    alignSelf: 'flex-start',
    backgroundColor: '#FFFFFF',
    borderBottomLeftRadius: 4,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.06)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 1.5,
    elevation: 1,
  },
  bodyLight: {
    color: '#111B21',
  },
  senderLight: {
    color: '#008069',
  },
  messageTimeLight: {
    color: '#667781',
  },
  tickLight: {
    color: '#8696A0',
  },
  readTickLight: {
    color: '#53BDEB',
  },
  myQuotedBubbleCardLight: {
    backgroundColor: 'rgba(0, 0, 0, 0.05)',
  },
  theirQuotedBubbleCardLight: {
    backgroundColor: 'rgba(0, 0, 0, 0.05)',
  },
  quotedSenderNameLight: {
    color: '#008069',
  },
  quotedSnippetLight: {
    color: '#3B4A54',
  },
  deletedBubbleLight: {
    backgroundColor: 'rgba(0, 0, 0, 0.04)',
    borderWidth: 1,
    borderColor: 'rgba(0, 0, 0, 0.08)',
  },
  deletedTextLight: {
    color: '#667781',
  },
  reactionBadgeLight: {
    backgroundColor: '#FFFFFF',
    borderColor: 'rgba(0, 0, 0, 0.1)',
  },
  reactionBadgeTextLight: {
    color: '#111B21',
  },
  roomCardBox: {
    padding: 12,
    backgroundColor: 'rgba(0, 0, 0, 0.22)',
    borderRadius: 14,
    minWidth: 240,
    maxWidth: 290,
    marginVertical: 4,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.12)',
  },
  roomCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  roomCardBadge: {
    backgroundColor: '#277A55',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
  },
  roomCardBadgeText: {
    color: '#FFFFFF',
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  roomCardEmoji: {
    fontSize: 22,
  },
  roomCardTitle: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '800',
    marginBottom: 2,
  },
  roomCardTitleLight: {
    color: '#111B21',
  },
  roomCardDesc: {
    color: 'rgba(255, 255, 255, 0.75)',
    fontSize: 12,
    marginBottom: 6,
  },
  roomCardDescLight: {
    color: 'rgba(17, 27, 33, 0.75)',
  },
  roomCardAuthor: {
    color: '#25D366',
    fontSize: 10,
    fontWeight: '600',
    marginBottom: 10,
  },
  roomCardAuthorLight: {
    color: '#128C7E',
  },
  roomCardJoinButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#25D366',
    paddingVertical: 9,
    borderRadius: 10,
  },
  roomCardJoinButtonText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
  callActionActiveRoom: {
    borderWidth: 1.5,
    borderColor: '#25D366',
    borderRadius: 18,
  },
  scrim: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
  },
  hangoutModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    justifyContent: 'flex-end',
  },
  hangoutModalSheet: {
    backgroundColor: '#10221D',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 20,
    paddingBottom: Platform.OS === 'ios' ? 36 : 24,
    maxHeight: '80%',
  },
  hangoutModalTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  hangoutModalTitle: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '800',
  },
  hangoutModalSub: {
    color: '#A7B6AC',
    fontSize: 13,
    marginBottom: 16,
  },
  hangoutThemeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderRadius: 14,
    padding: 12,
    marginBottom: 10,
    gap: 12,
  },
  hangoutThemeRowActive: {
    borderWidth: 1.5,
    borderColor: '#25D366',
    backgroundColor: 'rgba(37, 211, 102, 0.12)',
  },
  hangoutThemeEmoji: {
    fontSize: 26,
  },
  hangoutThemeName: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
  hangoutThemeDesc: {
    color: '#A7B6AC',
    fontSize: 12,
    marginTop: 2,
  },
  hangoutStartBtn: {
    backgroundColor: '#25D366',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    borderRadius: 14,
    marginTop: 10,
    gap: 8,
  },
  hangoutStartBtnText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
  activeRoomBanner: {
    backgroundColor: 'rgba(37, 211, 102, 0.15)',
    borderWidth: 1,
    borderColor: '#25D366',
    borderRadius: 14,
    padding: 14,
    marginBottom: 16,
  },
  activeRoomBannerTitle: {
    color: '#25D366',
    fontSize: 14,
    fontWeight: '800',
    marginBottom: 4,
  },
  activeRoomBannerText: {
    color: '#FFFFFF',
    fontSize: 13,
    marginBottom: 12,
  },
  activeRoomJoinBtn: {
    backgroundColor: '#25D366',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    borderRadius: 10,
    gap: 8,
  },
  activeRoomJoinBtnText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  menuOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.15)',
  },
  menuDropdown: {
    position: 'absolute',
    right: 12,
    backgroundColor: '#FFFFFF',
    borderRadius: 8,
    paddingVertical: 6,
    minWidth: 180,
    elevation: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(0, 0, 0, 0.08)',
  },
  menuDropdownDark: {
    backgroundColor: '#202C33',
    borderColor: '#2A3942',
  },
  menuItem: {
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  menuItemText: {
    color: '#111B21',
    fontSize: 15,
    fontWeight: '500',
  },
  menuItemTextDark: {
    color: '#E9EDEF',
  },
  menuItemTextDanger: {
    color: colors.error,
  },
  chatRoomBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#10221DF5',
    borderBottomWidth: 1,
    borderBottomColor: '#277A5544',
    paddingHorizontal: 14,
    paddingVertical: 9,
    zIndex: 10,
  },
  chatRoomBannerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    marginRight: 10,
    gap: 8,
  },
  chatRoomBannerDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#25D366',
  },
  chatRoomBannerTitle: {
    color: '#F7FAF8',
    fontSize: 13,
    fontWeight: '700',
    flex: 1,
  },
  chatRoomBannerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#25D366',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  chatRoomBannerBtnText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '800',
  },
});
