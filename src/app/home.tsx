import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Image, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as ScreenOrientation from 'expo-screen-orientation';
import { router, useFocusEffect, useLocalSearchParams, type Href } from 'expo-router';
import { Check, CirclePlus, Compass, DoorOpen, EllipsisVertical, Globe, Lock, MessageCircle, Phone, Plus, QrCode, RefreshCw, Search, Shield, Sparkles, UserPlus, UsersRound, Video, X } from 'lucide-react-native';
import { BottomNav, type HubTab } from '@/components/ui/BottomNav';
import { colors } from '@/constants/theme';
import { useSession } from '@/context/session';
import { socialApi, type ActiveGroupRoom, type ChatGroup, type FriendRequest, type HangoutUpdatesResponse, type OwnProfile, type PublicProfile, type PublicServerInfo, type RoomInvitation, type SocialBundle } from '@/lib/social-api';
import { getRealtimeSocket, type TypingEvent } from '@/lib/realtime';
import { TypingDots } from '@/components/ui/TypingDots';
import { callRequest, type CallInfo, type CallMedia } from '@/lib/calls';
import { type AvatarBody, AVATAR_NAMES, AVATAR_TAGLINES } from '@/three/player/avatarStyle';
import { initEncryptedChat, localPreviews, onChatChanged, previewBody, formatChatPreview, setCachedProfile, getCachedProfile, sendEncryptedMessage, type RoomCardPayload } from '@/lib/encrypted-chat';
import { getCachedSocialBundle, initSocialCache, setCachedSocialBundle, updateCachedContacts, updateCachedGroups, updateCachedFriendRequests } from '@/lib/social-cache';
import { createRoomServer, fetchPublicRooms } from '@/lib/rooms';

const avatars: { body: AvatarBody; label: string; tagline: string }[] = [
  { body: 'man', label: AVATAR_NAMES.man, tagline: AVATAR_TAGLINES.man },
  { body: 'uncle', label: AVATAR_NAMES.uncle, tagline: AVATAR_TAGLINES.uncle },
  { body: 'photo_boy', label: AVATAR_NAMES.photo_boy, tagline: AVATAR_TAGLINES.photo_boy },
  { body: 'self', label: AVATAR_NAMES.self, tagline: AVATAR_TAGLINES.self },
  { body: 'woman', label: AVATAR_NAMES.woman, tagline: AVATAR_TAGLINES.woman },
  { body: 'chinese_woman', label: AVATAR_NAMES.chinese_woman, tagline: AVATAR_TAGLINES.chinese_woman },
  { body: 'nepali_woman', label: AVATAR_NAMES.nepali_woman, tagline: AVATAR_TAGLINES.nepali_woman },
  { body: 'white_top_woman', label: AVATAR_NAMES.white_top_woman, tagline: AVATAR_TAGLINES.white_top_woman },
];
type Sheet = 'add' | 'group' | 'menu' | null;
type RoomKind = 'loft' | 'tea' | 'beach' | 'roof';

const THEMES: { id: RoomKind; title: string; subtitle: string; emoji: string; color: string }[] = [
  { id: 'tea', title: 'Chai Shop', subtitle: 'Roadside adda with warm tea & bench talks', emoji: '☕', color: '#B26E3A' },
  { id: 'beach', title: 'Sunset Beach', subtitle: 'Sunset shores, ocean breeze & waves', emoji: '🏖️', color: '#F38D68' },
  { id: 'loft', title: 'Lounge Loft', subtitle: 'Modern apartment lounge & sofas', emoji: '🏢', color: '#277A55' },
  { id: 'roof', title: 'School Rooftop', subtitle: 'Open sky rooftop overlooking the city', emoji: '🏫', color: '#5C6BC0' },
];

export default function HomeScreen() {
  const { username, logout, avatarStyle, setAvatarStyle } = useSession();
  const params = useLocalSearchParams<{ tab?: string }>();
  const [tab, setTab] = useState<HubTab>(params.tab === 'rooms' || params.tab === 'updates' || params.tab === 'calls' ? params.tab : 'chats');
  
  // 1. INSTANT FRAME 0 INITIALIZATION FROM IN-MEMORY / DISK CACHE
  const initialCache = getCachedSocialBundle();
  const [profile, setProfile] = useState<OwnProfile | null>(initialCache?.me || getCachedProfile() || null);
  const [contacts, setContacts] = useState<PublicProfile[]>(initialCache?.contacts || []);
  const [people, setPeople] = useState<PublicProfile[]>([]);
  const [groups, setGroups] = useState<ChatGroup[]>(initialCache?.groups || []);
  const [friendRequests, setFriendRequests] = useState<FriendRequest[]>(initialCache?.friendRequests || []);
  const [activeHangouts, setActiveHangouts] = useState<ActiveGroupRoom[]>([]);
  const [roomInvites, setRoomInvites] = useState<RoomInvitation[]>([]);
  const [search, setSearch] = useState('');

  // Rooms State
  const [roomsSubTab, setRoomsSubTab] = useState<'create' | 'join'>('create');
  const [publicRooms, setPublicRooms] = useState<PublicServerInfo[]>([]);
  const [loadingPublicRooms, setLoadingPublicRooms] = useState(false);
  const [selectedTheme, setSelectedTheme] = useState<RoomKind>('tea');
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [isPrivateServer, setIsPrivateServer] = useState(false);
  const [customServerName, setCustomServerName] = useState('');
  const [selectedGroupInvites, setSelectedGroupInvites] = useState<string[]>([]);
  const [selectedContactInvites, setSelectedContactInvites] = useState<string[]>([]);
  const [creatingServer, setCreatingServer] = useState(false);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [newUsername, setNewUsername] = useState('');
  const [groupName, setGroupName] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(!initialCache && !contacts.length && !groups.length);
  const [error, setError] = useState('');
  const [sheetError, setSheetError] = useState('');
  const [typing, setTyping] = useState<Record<string, Record<string, string>>>({});
  const typingExpiry = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const refreshingRef = useRef(false);
  const updateLocalPreviews = useCallback(async () => {
    try {
      const previews = await localPreviews();
      const byChat = new Map(previews.map(item => [`${item.kind}:${item.targetId}`, item]));
      setContacts(current => current.map(item => {
        const preview = byChat.get(`direct:${item.id}`);
        return {
          ...item,
          lastMessage: preview ? formatChatPreview(preview, profile?.id) : null,
          lastAt: preview?.createdAt ?? null,
        };
      }));
      setGroups(current => current.map(item => {
        const preview = byChat.get(`group:${item.id}`);
        return {
          ...item,
          lastMessage: preview ? formatChatPreview(preview, profile?.id) : null,
          lastAt: preview?.createdAt ?? null,
        };
      }));
    } catch { /* Chat storage may still be starting. */ }
  }, [profile?.id]);
  useEffect(() => onChatChanged(() => { void updateLocalPreviews(); }), [updateLocalPreviews]);

  useEffect(() => { void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP); }, []);
  useEffect(() => { if (!username) router.replace('/login'); }, [username]);

  useEffect(() => {
    void initSocialCache().then(disk => {
      if (disk) {
        setProfile(curr => curr || disk.me);
        setContacts(curr => curr.length ? curr : disk.contacts);
        setGroups(curr => curr.length ? curr : disk.groups);
        setPeople(curr => curr.length ? curr : disk.people);
        setFriendRequests(curr => curr.length ? curr : disk.friendRequests);
        setLoading(false);
      }
    });
  }, []);

  const refresh = useCallback(async () => {
    if (!username || refreshingRef.current) return;
    refreshingRef.current = true;
    try {
      let bundle: SocialBundle;
      try {
        bundle = await socialApi<SocialBundle>('/social/bundle');
      } catch {
        const [me, friends, joined, requests] = await Promise.all([
          socialApi<OwnProfile>('/me'),
          socialApi<PublicProfile[]>('/contacts'),
          socialApi<ChatGroup[]>('/groups'),
          socialApi<FriendRequest[]>('/friend-requests'),
        ]);
        bundle = { me, contacts: friends, people: [], groups: joined, friendRequests: requests };
      }

      void initEncryptedChat(bundle.me.id);
      const previews = await localPreviews().catch(() => []);
      const byChat = new Map(previews.map(item => [`${item.kind}:${item.targetId}`, item]));

      const enrichedContacts = bundle.contacts.map(item => {
        const preview = byChat.get(`direct:${item.id}`);
        return {
          ...item,
          lastMessage: preview ? formatChatPreview(preview, bundle.me.id) : null,
          lastAt: preview?.createdAt ?? null,
        };
      });

      const enrichedGroups = bundle.groups.map(item => {
        const preview = byChat.get(`group:${item.id}`);
        return {
          ...item,
          lastMessage: preview ? formatChatPreview(preview, bundle.me.id) : null,
          lastAt: preview?.createdAt ?? null,
        };
      });

      setProfile(bundle.me);
      setCachedProfile(bundle.me);
      setContacts(enrichedContacts);
      setPeople([]);
      setGroups(enrichedGroups);
      setFriendRequests(bundle.friendRequests);
      setError('');

      setCachedSocialBundle({
        me: bundle.me,
        contacts: enrichedContacts,
        groups: enrichedGroups,
        people: [],
        friendRequests: bundle.friendRequests,
      });
    } catch (cause) {
      if (!initialCache && !contacts.length) {
        setError(cause instanceof Error ? cause.message : 'Could not load ADDA.');
      }
    } finally {
      refreshingRef.current = false;
      setLoading(false);
    }
  }, [username]);

  const refreshHangouts = useCallback(async () => {
    try {
      const res = await socialApi<HangoutUpdatesResponse>('/updates/hangouts');
      setActiveHangouts(res.activeRooms || []);
      setRoomInvites(res.invites || []);
    } catch {}
  }, []);

  const loadPublicRooms = useCallback(async () => {
    try {
      setLoadingPublicRooms(true);
      const rooms = await fetchPublicRooms();
      setPublicRooms(rooms);
    } catch {}
    finally {
      setLoadingPublicRooms(false);
    }
  }, []);

  const respondToInvite = async (inviteId: string, decision: 'accept' | 'dismiss') => {
    const invite = roomInvites.find(i => i.id === inviteId);
    setRoomInvites(curr => curr.filter(i => i.id !== inviteId));
    try {
      await socialApi(`/room-invites/${encodeURIComponent(inviteId)}/respond`, 'POST', { decision });
    } catch {}
    if (decision === 'accept' && invite) {
      router.push({
        pathname: '/lobby',
        params: {
          room: invite.roomKind,
          groupId: invite.groupId || '',
          roomId: invite.roomId,
          roomOwnerId: '',
          roomName: invite.roomName || invite.groupName,
          inviterName: invite.inviterName,
          isPrivate: String(invite.isPrivate ?? true),
        },
      } as unknown as Href);
    }
  };

  useFocusEffect(useCallback(() => {
    const cached = getCachedProfile() || getCachedSocialBundle()?.me;
    if (cached) setProfile(cached);
    void refresh();
    void refreshHangouts();
    void loadPublicRooms();
  }, [refresh, refreshHangouts, loadPublicRooms]));

  const refreshSocial = useCallback(async () => {
    try {
      let bundle: SocialBundle;
      try {
        bundle = await socialApi<SocialBundle>('/social/bundle');
      } catch {
        const [friends, requests] = await Promise.all([
          socialApi<PublicProfile[]>('/contacts'),
          socialApi<FriendRequest[]>('/friend-requests'),
        ]);
        bundle = { me: profile!, contacts: friends, groups: [], people: [], friendRequests: requests };
      }

      setContacts(current => {
        const prevMap = new Map(current.map(c => [c.id, c]));
        return bundle.contacts.map(item => {
          const existing = prevMap.get(item.id);
          return {
            ...item,
            lastMessage: existing?.lastMessage ?? null,
            lastAt: existing?.lastAt ?? null,
          };
        });
      });
      setFriendRequests(bundle.friendRequests);
      setPeople([]);
    } catch { /* Silent background sync */ }
  }, [profile]);

  useEffect(() => {
    if (!username) return;
    let active = true;
    let live: Awaited<ReturnType<typeof getRealtimeSocket>> | null = null;
    const onUpdate = () => { void refreshSocial(); };
    const onFriendUpdate = (payload?: {
      type?: string;
      request?: FriendRequest;
      decision?: 'accept' | 'decline';
      requestId?: string;
      senderContact?: PublicProfile | null;
      recipientContact?: PublicProfile | null;
    }) => {
      if (payload?.type === 'request_created' && payload.request) {
        const req = payload.request;
        if (req.recipientId === profile?.id) {
          setFriendRequests(curr => {
            if (curr.some(r => r.id === req.id)) return curr;
            return [req, ...curr];
          });
          return;
        }
        if (req.senderId === profile?.id) {
          setFriendRequests(curr => curr.map(r =>
            (r.recipientId === req.recipientId || r.recipientUsername.toLowerCase() === req.recipientUsername.toLowerCase())
              ? req : r
          ));
          return;
        }
      }

      if (payload?.type === 'request_responded' && payload.requestId) {
        setFriendRequests(curr => curr.filter(r => r.id !== payload.requestId));
        const newContact = payload.decision === 'accept'
          ? (payload.senderContact?.id === profile?.id ? payload.recipientContact : payload.senderContact)
          : null;
        if (newContact) {
          setContacts(curr => {
            if (curr.some(c => c.id === newContact.id)) return curr;
            return [
              {
                id: newContact.id,
                name: newContact.name,
                username: newContact.username,
                avatarUrl: newContact.avatarUrl,
                about: null,
                lastMessage: null,
                lastAt: new Date().toISOString(),
              },
              ...curr,
            ];
          });
        }
        return;
      }

      void refreshSocial();
    };

    const onTyping = (event: TypingEvent) => {
      if (event.userId === profile?.id) return;
      const key = `${event.kind}:${event.id}`;
      const timerKey = `${key}:${event.userId}`;
      const old = typingExpiry.current.get(timerKey);
      if (old) clearTimeout(old);
      typingExpiry.current.delete(timerKey);
      const update = (name?: string) => setTyping(current => {
        const members = { ...current[key] };
        if (name) members[event.userId] = name;
        else delete members[event.userId];
        const next = { ...current };
        if (Object.keys(members).length) next[key] = members;
        else delete next[key];
        return next;
      });
      update(event.typing ? event.name : undefined);
      if (event.typing) typingExpiry.current.set(timerKey, setTimeout(() => {
        typingExpiry.current.delete(timerKey);
        update();
      }, 4000));
    };
    const clearTyping = () => {
      for (const timer of typingExpiry.current.values()) clearTimeout(timer);
      typingExpiry.current.clear();
      setTyping({});
    };
    const onRoomUpdated = () => { void refreshHangouts(); };
    const onRoomInvite = (inv: RoomInvitation) => {
      setRoomInvites(curr => [inv, ...curr.filter(i => i.id !== inv.id)]);
    };
    const onPublicRoomsUpdated = () => { void loadPublicRooms(); };

    void getRealtimeSocket().then(value => {
      if (!active) return;
      live = value;
      value.on('chat:encrypted:update', onUpdate);
      value.on('chat:message_deleted', onUpdate);
      value.on('friends:updated', onFriendUpdate);
      value.on('group:room_updated', onRoomUpdated);
      value.on('room:invitation', onRoomInvite);
      value.on('rooms:public_updated', onPublicRoomsUpdated);
      value.on('room:public_closed', onPublicRoomsUpdated);
      value.on('connect', onUpdate);
      value.on('disconnect', clearTyping);
      value.on('chat:typing', onTyping);
    }).catch(() => {});
    return () => {
      active = false;
      clearTyping();
      live?.off('chat:encrypted:update', onUpdate);
      live?.off('chat:message_deleted', onUpdate);
      live?.off('friends:updated', onFriendUpdate);
      live?.off('group:room_updated', onRoomUpdated);
      live?.off('room:invitation', onRoomInvite);
      live?.off('rooms:public_updated', onPublicRoomsUpdated);
      live?.off('room:public_closed', onPublicRoomsUpdated);
      live?.off('connect', onUpdate);
      live?.off('disconnect', clearTyping);
      live?.off('chat:typing', onTyping);
    };
  }, [username, refresh, profile?.id, refreshSocial, refreshHangouts, loadPublicRooms]);

  const visibleContacts = useMemo(() => {
    return contacts
      .filter((item) => `${item.name} ${item.username}`.toLowerCase().includes(search.toLowerCase()))
      .sort((a, b) => (b.lastAt || '').localeCompare(a.lastAt || ''));
  }, [contacts, search]);

  const visibleGroups = useMemo(() => {
    return groups
      .filter((item) => item.name.toLowerCase().includes(search.toLowerCase()))
      .sort((a, b) => (b.lastAt || '').localeCompare(a.lastAt || ''));
  }, [groups, search]);

  const openSheet = (next: Sheet) => { setSheetError(''); setSheet(next); };
  const addFriend = async (value: string, explicitTarget?: PublicProfile) => {
    const cleanUsername = value.trim().toLowerCase();
    if (!cleanUsername && !explicitTarget) return;

    // 1. INSTANT OPTIMISTIC UI UPDATE (0ms)
    const targetId = explicitTarget?.id || `user-${cleanUsername}`;
    const tempId = `temp-${Date.now()}`;

    const optimisticRequest: FriendRequest = {
      id: tempId,
      senderId: profile?.id || '',
      recipientId: targetId,
      senderName: profile?.name || '',
      senderUsername: profile?.username || '',
      senderAvatarUrl: profile?.avatarUrl || null,
      recipientName: explicitTarget?.name || cleanUsername,
      recipientUsername: explicitTarget?.username || cleanUsername,
      recipientAvatarUrl: explicitTarget?.avatarUrl || null,
      createdAt: new Date().toISOString(),
      status: 'pending',
    };

    setSheet(null);
    setNewUsername('');
    setSheetError('');

    setFriendRequests(curr => {
      const matchUsername = (explicitTarget?.username || cleanUsername).toLowerCase();
      if (curr.some(r => r.recipientUsername.toLowerCase() === matchUsername || r.recipientId === targetId)) {
        return curr;
      }
      return [optimisticRequest, ...curr];
    });

    // 2. Perform API call in background
    try {
      const added = explicitTarget?.id
        ? await socialApi<PublicProfile>(`/contacts/user/${encodeURIComponent(explicitTarget.id)}`, 'POST')
        : await socialApi<PublicProfile>('/contacts/username', 'POST', { username: cleanUsername });

      setFriendRequests(curr => curr.map(r => r.id === tempId ? {
        ...r,
        recipientId: added.id,
        recipientName: added.name,
        recipientUsername: added.username,
        recipientAvatarUrl: added.avatarUrl,
      } : r));
    } catch (cause) {
      setFriendRequests(curr => curr.filter(r => r.id !== tempId));
      const msg = cause instanceof Error ? cause.message : 'Could not add contact.';
      Alert.alert('Friend request', msg);
    }
  };
  const createGroup = async () => {
    if (busy) return;
    setBusy(true); setSheetError('');
    try {
      await socialApi('/groups', 'POST', { name: groupName.trim(), memberIds: selectedIds });
      setGroupName(''); setSelectedIds([]); setSheet(null); await refresh();
    } catch (cause) { setSheetError(cause instanceof Error ? cause.message : 'Could not create group.'); }
    finally { setBusy(false); }
  };
  const respondToFriend = async (id: string, decision: 'accept' | 'decline') => {
    // 1. INSTANT OPTIMISTIC REMOVAL (0ms)
    const targetReq = friendRequests.find(item => item.id === id);
    setFriendRequests(curr => curr.filter(item => item.id !== id));

    if (decision === 'accept' && targetReq) {
      setPeople(curr => curr.filter(p => p.id !== targetReq.senderId));
      setContacts(curr => {
        if (curr.some(c => c.id === targetReq.senderId)) return curr;
        return [
          {
            id: targetReq.senderId,
            name: targetReq.senderName,
            username: targetReq.senderUsername,
            avatarUrl: targetReq.senderAvatarUrl,
            about: null,
            lastMessage: null,
            lastAt: new Date().toISOString(),
          },
          ...curr,
        ];
      });
    }

    // 2. Background network call
    try {
      await socialApi(`/friend-requests/${encodeURIComponent(id)}/respond`, 'POST', { decision });
    } catch (cause) {
      if (targetReq) setFriendRequests(curr => [targetReq, ...curr]);
      if (decision === 'accept' && targetReq) {
        setContacts(curr => curr.filter(c => c.id !== targetReq.senderId));
      }
      setError(cause instanceof Error ? cause.message : 'Could not respond to request.');
    }
  };
  const handleLogout = async () => { setSheet(null); await logout(); router.replace('/login'); };
  const selectTab = (next: HubTab) => { if (next === 'you') router.push('/profile' as Href); else setTab(next); };

  const handleOpenCreateModal = (theme?: RoomKind) => {
    if (theme) setSelectedTheme(theme);
    setIsPrivateServer(false);
    setCustomServerName('');
    setSelectedGroupInvites([]);
    setSelectedContactInvites([]);
    setCreateModalOpen(true);
  };

  const handleCreateServer = async () => {
    if (creatingServer) return;
    setCreatingServer(true);
    try {
      const created = await createRoomServer({
        roomKind: selectedTheme,
        isPrivate: isPrivateServer,
        name: customServerName.trim() || undefined,
        groupInvites: selectedGroupInvites.length > 0 ? selectedGroupInvites : undefined,
        userInvites: selectedContactInvites.length > 0 ? selectedContactInvites : undefined,
      });

      // Post invitation cards to invited group chats
      for (const gId of selectedGroupInvites) {
        const groupObj = groups.find(g => g.id === gId);
        const cardPayload: RoomCardPayload = {
          type: 'room_card',
          roomId: created.id,
          groupId: gId,
          groupName: groupObj?.name || 'Group',
          roomKind: created.roomKind,
          creatorId: created.creatorId,
          creatorName: username || 'Host',
          createdAt: new Date().toISOString(),
          roomName: created.name,
          isPrivate: created.isPrivate,
        };
        void sendEncryptedMessage(
          { kind: 'group', id: gId },
          `__adda_room_card__:${JSON.stringify(cardPayload)}`,
          username || 'Host',
          undefined,
          undefined,
          undefined,
          `🌴 ${username || 'Host'} invited you: ${created.name}`
        ).catch(err => console.warn('[ADDA] Error posting group room card:', err));
      }

      // Post invitation cards to invited contact DM chats
      for (const cId of selectedContactInvites) {
        const cardPayload: RoomCardPayload = {
          type: 'room_card',
          roomId: created.id,
          roomKind: created.roomKind,
          creatorId: created.creatorId,
          creatorName: username || 'Host',
          createdAt: new Date().toISOString(),
          roomName: created.name,
          isPrivate: created.isPrivate,
        };
        void sendEncryptedMessage(
          { kind: 'direct', id: cId },
          `__adda_room_card__:${JSON.stringify(cardPayload)}`,
          username || 'Host',
          undefined,
          undefined,
          undefined,
          `🌴 ${username || 'Host'} invited you: ${created.name}`
        ).catch(err => console.warn('[ADDA] Error posting DM room card:', err));
      }

      setCreateModalOpen(false);
      router.push({
        pathname: '/lobby',
        params: {
          room: created.roomKind,
          roomId: created.id,
          roomOwnerId: created.creatorId,
          roomName: created.name,
          isPrivate: String(created.isPrivate),
        },
      } as unknown as Href);
    } catch (err: any) {
      Alert.alert('Server Creation Failed', err.message || 'Could not create server.');
    } finally {
      setCreatingServer(false);
    }
  };

  const handleJoinServer = (server: PublicServerInfo) => {
    router.push({
      pathname: '/lobby',
      params: {
        room: server.roomKind,
        roomId: server.id,
        roomOwnerId: server.creatorId,
        roomName: server.name,
        isPrivate: String(server.isPrivate),
      },
    } as unknown as Href);
  };

  const openConversation = (kind: 'direct' | 'group', id: string, name: string, avatar?: string | null) => {
    router.push({
      pathname: '/conversation',
      params: { kind, id, name, avatar: avatar || '' },
    } as unknown as Href);
  };
  const startCall = async (kind: 'direct' | 'group', id: string, name: string, media: CallMedia) => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const call = await callRequest<CallInfo>('call:start', { target: { kind, id }, media });
      router.push({ pathname: '/call', params: { callId: call.id, role: call.callerId === profile?.id ? 'caller' : 'callee', name, media: call.media } } as unknown as Href);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not start call.'); }
    finally { setBusy(false); }
  };

  if (!username) return null;
  return <SafeAreaView style={styles.safe}>
    <View style={styles.top}>
      <Pressable onPress={() => router.push('/profile' as Href)} style={styles.headerProfileBtn} accessibilityLabel="Your profile">
        {profile?.avatarUrl ? (
          <Image source={{ uri: profile.avatarUrl }} style={styles.headerAvatarImg} />
        ) : (
          <View style={styles.headerAvatarPlaceholder}>
            <Text style={styles.headerAvatarInitial}>{profile?.name?.[0]?.toUpperCase() || username[0]?.toUpperCase()}</Text>
          </View>
        )}
      </Pressable>
      <View style={styles.brandContainer}>
        <Text style={styles.brand}>ADDA<Text style={styles.brandDot}>.</Text></Text>
        <Text style={styles.subBrand}>{profile ? `@${profile.username}` : 'APNA VIRTUAL HANGOUT'}</Text>
      </View>
      <Pressable accessibilityLabel="More options" onPress={() => openSheet('menu')} style={styles.iconButton}><EllipsisVertical size={25} color={colors.text} /></Pressable>
    </View>

    {tab === 'chats' && <View style={styles.searchBox}><Search size={21} color={colors.muted} /><TextInput style={styles.searchInput} placeholder="Search contacts and groups" placeholderTextColor={colors.muted} value={search} onChangeText={setSearch} autoCapitalize="none" /></View>}

    <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
      {tab === 'chats' && <>
        {loading && <ActivityIndicator color={colors.primary} style={styles.loader} />}
        {!!error && <View style={styles.errorBox}><Text style={styles.errorText}>{error}</Text><Pressable onPress={() => { if (error.toLowerCase().includes('sign in')) void handleLogout(); else { setLoading(true); void refresh(); } }}><Text style={styles.retry}>{error.toLowerCase().includes('sign in') ? 'Sign in again' : 'Retry'}</Text></Pressable></View>}
        {!loading && !error && <>
          {visibleGroups.length > 0 && <><Text style={styles.section}>Groups</Text>{visibleGroups.map((item) => <PersonRow key={item.id} name={item.name} avatarUrl={item.avatarUrl} detail={item.lastMessage || `${item.memberCount} members`} time={item.lastAt} typingNames={Object.values(typing[`group:${item.id}`] ?? {})} group onPress={() => openConversation('group', item.id, item.name, item.avatarUrl)} />)}</>}
          {visibleContacts.length > 0 && <><Text style={styles.section}>Contacts</Text>{visibleContacts.map((item) => <PersonRow key={item.id} name={item.name} avatarUrl={item.avatarUrl} detail={item.lastMessage || `@${item.username}`} time={item.lastAt} typingNames={Object.values(typing[`direct:${item.id}`] ?? {})} onPress={() => openConversation('direct', item.id, item.name, item.avatarUrl)} />)}</>}
          {visibleGroups.length === 0 && visibleContacts.length === 0 && <View style={styles.empty}><MessageCircle size={34} color={colors.primary} /><Text style={styles.emptyTitle}>{search ? 'No matches' : 'Your chats start here'}</Text><Text style={styles.emptyCopy}>{search ? 'Try another name or username.' : 'Add a friend or create a group to get started.'}</Text></View>}
        </>}
      </>}

      {tab === 'rooms' && <>
        {/* Sub-Tab Navigation Bar */}
        <View style={styles.roomsTabBar}>
          <Pressable
            onPress={() => setRoomsSubTab('create')}
            style={[styles.roomsTabBtn, roomsSubTab === 'create' && styles.roomsTabBtnActive]}
          >
            <Plus size={16} color={roomsSubTab === 'create' ? '#FFFFFF' : colors.text} />
            <Text style={[styles.roomsTabBtnText, roomsSubTab === 'create' && styles.roomsTabBtnTextActive]}>
              Create Server
            </Text>
          </Pressable>
          <Pressable
            onPress={() => {
              setRoomsSubTab('join');
              void loadPublicRooms();
            }}
            style={[styles.roomsTabBtn, roomsSubTab === 'join' && styles.roomsTabBtnActive]}
          >
            <Globe size={16} color={roomsSubTab === 'join' ? '#FFFFFF' : colors.text} />
            <Text style={[styles.roomsTabBtnText, roomsSubTab === 'join' && styles.roomsTabBtnTextActive]}>
              Join Server
            </Text>
            {publicRooms.length > 0 && (
              <View style={[styles.serverCountBadge, roomsSubTab === 'join' && styles.serverCountBadgeActive]}>
                <Text style={[styles.serverCountBadgeText, roomsSubTab === 'join' && styles.serverCountBadgeTextActive]}>
                  {publicRooms.length}
                </Text>
              </View>
            )}
          </Pressable>
        </View>

        {roomsSubTab === 'create' && (
          <>
            <Text style={styles.pageTitle}>Create a Server</Text>
            <Text style={styles.pageCopy}>Pick a map environment to launch a live public or private server instance.</Text>

            <View style={styles.themeList}>
              {THEMES.map(theme => {
                const isSelected = selectedTheme === theme.id;
                return (
                  <Pressable
                    key={theme.id}
                    onPress={() => setSelectedTheme(theme.id)}
                    style={[styles.themeCard, isSelected && styles.themeCardSelected]}
                  >
                    <View style={[styles.themeCardEmojiBox, { backgroundColor: theme.color + '22' }]}>
                      <Text style={{ fontSize: 26 }}>{theme.emoji}</Text>
                    </View>
                    <View style={styles.fill}>
                      <Text style={[styles.cardTitle, isSelected && { color: colors.primaryDark }]}>{theme.title}</Text>
                      <Text style={styles.cardSub}>{theme.subtitle}</Text>
                    </View>
                    <View style={[styles.themeCardRadio, isSelected && styles.themeCardRadioSelected]}>
                      {isSelected && <View style={styles.themeCardRadioDot} />}
                    </View>
                  </Pressable>
                );
              })}
            </View>

            <Pressable
              onPress={() => handleOpenCreateModal(selectedTheme)}
              style={styles.launchServerButton}
            >
              <CirclePlus size={20} color="#FFFFFF" />
              <Text style={styles.launchServerButtonText}>CONFIGURE & CREATE SERVER</Text>
            </Pressable>
          </>
        )}

        {roomsSubTab === 'join' && (
          <>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 }}>
              <Text style={[styles.pageTitle, { marginTop: 0 }]}>Active Servers</Text>
              <Pressable onPress={() => void loadPublicRooms()} style={styles.refreshIconBtn}>
                <RefreshCw size={18} color={colors.primary} />
              </Pressable>
            </View>
            <Text style={styles.pageCopy}>Real-time public servers. Pick one to select your character and enter.</Text>

            {loadingPublicRooms && (
              <ActivityIndicator color={colors.primary} style={{ marginVertical: 30 }} />
            )}

            {!loadingPublicRooms && publicRooms.length === 0 && (
              <View style={styles.empty}>
                <DoorOpen size={42} color={colors.primary} />
                <Text style={styles.emptyTitle}>No active servers</Text>
                <Text style={styles.emptyCopy}>There are no public rooms online right now. Be the first to start one!</Text>
                <Pressable
                  onPress={() => setRoomsSubTab('create')}
                  style={[styles.acceptButton, { marginTop: 8 }]}
                >
                  <Text style={styles.acceptText}>Create a Server</Text>
                </Pressable>
              </View>
            )}

            {!loadingPublicRooms && publicRooms.length > 0 && (
              <View style={{ gap: 12, marginBottom: 20 }}>
                {publicRooms.map(server => {
                  const theme = THEMES.find(t => t.id === server.roomKind) || THEMES[0];
                  return (
                    <View key={server.id} style={styles.serverCard}>
                      <View style={styles.serverCardHeader}>
                        <View style={[styles.roomIcon, { backgroundColor: theme.color + '22', width: 44, height: 44, borderRadius: 12 }]}>
                          <Text style={{ fontSize: 22 }}>{theme.emoji}</Text>
                        </View>
                        <View style={{ flex: 1, marginLeft: 12 }}>
                          <Text style={styles.serverCardTitle} numberOfLines={1}>{server.name}</Text>
                          <Text style={styles.serverCardHost}>Hosted by {server.creatorName}</Text>
                        </View>
                        <View style={styles.peerCountBadge}>
                          <View style={styles.onlineDot} />
                          <Text style={styles.peerCountText}>{server.peerCount} online</Text>
                        </View>
                      </View>
                      <Pressable
                        onPress={() => handleJoinServer(server)}
                        style={styles.serverJoinButton}
                      >
                        <DoorOpen size={17} color="#FFFFFF" />
                        <Text style={styles.serverJoinButtonText}>JOIN SERVER</Text>
                      </Pressable>
                    </View>
                  );
                })}
              </View>
            )}
          </>
        )}
      </>}

      {tab === 'updates' && <>
        <Text style={styles.pageTitle}>Updates</Text>
        <Text style={styles.pageCopy}>Live group rooms, invitations and friend requests.</Text>
        {!!error && <Text style={styles.errorText}>{error}</Text>}

        {/* 1. ACTIVE GROUP ROOMS */}
        {activeHangouts.length > 0 && (
          <View style={{ marginBottom: 16 }}>
            <Text style={styles.section}>Live Group Rooms</Text>
            {activeHangouts.map(item => {
              const roomTitle = item.roomKind === 'beach' ? 'Goa Beach'
                : item.roomKind === 'tea' ? 'Tea Party'
                : item.roomKind === 'roof' ? 'School Rooftop'
                : 'Loft 16';
              const emoji = item.roomKind === 'beach' ? '🏖️'
                : item.roomKind === 'tea' ? '☕'
                : item.roomKind === 'roof' ? '🏫'
                : '🏢';
              return (
                <View key={item.id} style={styles.requestCard}>
                  <View style={styles.requestHeaderRow}>
                    <View style={[styles.roomIcon, { width: 44, height: 44, borderRadius: 12, backgroundColor: '#277A55' }]}>
                      <Text style={{ fontSize: 22 }}>{emoji}</Text>
                    </View>
                    <View style={{ flex: 1, marginLeft: 10 }}>
                      <Text style={styles.personName}>{item.groupName}</Text>
                      <Text style={styles.personDetail}>
                        {item.creatorName} started a room • {roomTitle}
                      </Text>
                    </View>
                  </View>
                  <View style={styles.requestActions}>
                    <Pressable
                      onPress={() => {
                        router.push({
                          pathname: '/lobby',
                          params: {
                            room: item.roomKind,
                            groupId: item.groupId || '',
                            roomId: item.id,
                            roomOwnerId: item.creatorId,
                            roomName: item.name || item.groupName,
                            isPrivate: String(item.isPrivate ?? false),
                          },
                        } as unknown as Href);
                      }}
                      style={[styles.acceptButton, { backgroundColor: '#25D366', flexDirection: 'row', gap: 6, alignItems: 'center' }]}
                    >
                      <DoorOpen size={16} color="#FFFFFF" />
                      <Text style={styles.acceptText}>Join Room</Text>
                    </Pressable>
                  </View>
                </View>
              );
            })}
          </View>
        )}

        {/* 2. ROOM INVITATIONS */}
        {roomInvites.length > 0 && (
          <View style={{ marginBottom: 16 }}>
            <Text style={styles.section}>Room Invitations</Text>
            {roomInvites.map(item => {
              const roomTitle = item.roomKind === 'beach' ? 'Goa Beach'
                : item.roomKind === 'tea' ? 'Tea Party'
                : item.roomKind === 'roof' ? 'School Rooftop'
                : 'Loft 16';
              return (
                <View key={item.id} style={styles.requestCard}>
                  <View style={styles.requestHeaderRow}>
                    {item.inviterAvatarUrl ? (
                      <Image source={{ uri: item.inviterAvatarUrl }} style={styles.requestAvatarImg} />
                    ) : (
                      <View style={styles.requestAvatarPlaceholder}>
                        <Text style={styles.requestAvatarInitial}>{item.inviterName[0]?.toUpperCase()}</Text>
                      </View>
                    )}
                    <View style={{ flex: 1, marginLeft: item.inviterAvatarUrl ? 10 : 0 }}>
                      <Text style={styles.personName}>{item.inviterName}</Text>
                      <Text style={styles.personDetail}>
                        Invited you to join {roomTitle} in {item.groupName}
                      </Text>
                    </View>
                  </View>
                  <View style={styles.requestActions}>
                    <Pressable onPress={() => void respondToInvite(item.id, 'accept')} style={styles.acceptButton}>
                      <Text style={styles.acceptText}>Join</Text>
                    </Pressable>
                    <Pressable onPress={() => void respondToInvite(item.id, 'dismiss')} style={styles.declineButton}>
                      <Text style={styles.declineText}>Dismiss</Text>
                    </Pressable>
                  </View>
                </View>
              );
            })}
          </View>
        )}

        {/* 3. FRIEND REQUESTS */}
        {friendRequests.filter(item => item.recipientId === profile?.id).length > 0 && (
          <View style={{ marginBottom: 16 }}>
            <Text style={styles.section}>Friend Requests</Text>
            {friendRequests.filter(item => item.recipientId === profile?.id).map(item => (
              <View key={item.id} style={styles.requestCard}>
                <View style={styles.requestHeaderRow}>
                  {item.senderAvatarUrl ? (
                    <Image source={{ uri: item.senderAvatarUrl }} style={styles.requestAvatarImg} />
                  ) : (
                    <View style={styles.requestAvatarPlaceholder}><Text style={styles.requestAvatarInitial}>{item.senderName[0]?.toUpperCase()}</Text></View>
                  )}
                  <View style={{ flex: 1 }}>
                    <Text style={styles.personName}>{item.senderName}</Text>
                    <Text style={styles.personDetail}>@{item.senderUsername} sent you a friend request</Text>
                  </View>
                </View>
                <View style={styles.requestActions}>
                  <Pressable onPress={() => void respondToFriend(item.id, 'accept')} style={styles.acceptButton}><Text style={styles.acceptText}>Accept</Text></Pressable>
                  <Pressable onPress={() => void respondToFriend(item.id, 'decline')} style={styles.declineButton}><Text style={styles.declineText}>Decline</Text></Pressable>
                </View>
              </View>
            ))}
          </View>
        )}

        {friendRequests.filter(item => item.senderId === profile?.id).map(item => <View key={item.id} style={styles.requestCard}><Text style={styles.personName}>{item.recipientName}</Text><Text style={styles.personDetail}>Request sent to @{item.recipientUsername}</Text></View>)}
        {friendRequests.length === 0 && activeHangouts.length === 0 && roomInvites.length === 0 && (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>No updates right now</Text>
            <Text style={styles.emptyCopy}>Live group hangouts, room invites, and friend requests will appear here.</Text>
          </View>
        )}
      </>}
      {tab === 'calls' && <>
        <Text style={styles.pageTitle}>Calls</Text><Text style={styles.pageCopy}>Start a voice or video call with your contacts or groups.</Text>
        {!!error && <Text style={styles.errorText}>{error}</Text>}
        {groups.map(item => <PersonRow key={item.id} name={item.name} avatarUrl={item.avatarUrl} detail={`${item.memberCount} members`} group action={<View style={styles.callActions}><Pressable disabled={busy} accessibilityLabel={`Voice call ${item.name}`} onPress={() => void startCall('group', item.id, item.name, 'audio')} style={styles.callSmall}><Phone size={19} color={colors.primary} /></Pressable><Pressable disabled={busy} accessibilityLabel={`Video call ${item.name}`} onPress={() => void startCall('group', item.id, item.name, 'video')} style={styles.callSmall}><Video size={20} color={colors.primary} /></Pressable></View>} />)}
        {contacts.map(item => <PersonRow key={item.id} name={item.name} avatarUrl={item.avatarUrl} detail={`@${item.username}`} action={<View style={styles.callActions}><Pressable disabled={busy} accessibilityLabel={`Voice call ${item.name}`} onPress={() => void startCall('direct', item.id, item.name, 'audio')} style={styles.callSmall}><Phone size={19} color={colors.primary} /></Pressable><Pressable disabled={busy} accessibilityLabel={`Video call ${item.name}`} onPress={() => void startCall('direct', item.id, item.name, 'video')} style={styles.callSmall}><Video size={20} color={colors.primary} /></Pressable></View>} />)}
        {groups.length === 0 && contacts.length === 0 && <View style={styles.empty}><Text style={styles.emptyTitle}>No one to call yet</Text><Text style={styles.emptyCopy}>Add a contact or create a group in Chats.</Text></View>}
      </>}
    </ScrollView>

    {tab === 'chats' && <Pressable accessibilityLabel="Add contact or group" onPress={() => openSheet('add')} style={styles.fab}><Plus size={30} strokeWidth={2.4} color="#FFFFFF" /></Pressable>}
    <BottomNav active={tab} onSelect={selectTab} updateCount={friendRequests.filter(item => item.recipientId === profile?.id).length + roomInvites.length + activeHangouts.length} />

    <Modal visible={sheet !== null} transparent animationType="fade" onRequestClose={() => setSheet(null)}>
      <KeyboardAvoidingView style={styles.overlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable style={styles.scrim} onPress={() => setSheet(null)} />
        <View style={styles.sheet}>
          <View style={styles.sheetTop}><Text style={styles.sheetTitle}>{sheet === 'group' ? 'New group' : sheet === 'menu' ? 'More' : 'Start something'}</Text><Pressable onPress={() => setSheet(null)} accessibilityLabel="Close"><X size={23} color={colors.text} /></Pressable></View>
          {!!sheetError && <Text style={styles.sheetError}>{sheetError}</Text>}
          {sheet === 'menu' && <>
            <MenuAction Icon={QrCode} label="My friend QR" onPress={() => { setSheet(null); router.push('/profile' as Href); }} />
            <MenuAction Icon={UsersRound} label="New group" onPress={() => openSheet('group')} />
            <MenuAction Icon={DoorOpen} label="Rooms" onPress={() => { setSheet(null); setTab('rooms'); }} />
            <Pressable onPress={() => void handleLogout()} style={styles.menuAction}><Text style={styles.logoutText}>Log out</Text></Pressable>
          </>}
          {sheet === 'add' && <>
            <Text style={styles.fieldLabel}>ADD BY USERNAME</Text>
            <View style={styles.inputRow}><Text style={styles.at}>@</Text><TextInput style={styles.entry} placeholder="username" placeholderTextColor={colors.muted} value={newUsername} onChangeText={setNewUsername} autoCapitalize="none" autoCorrect={false} returnKeyType="done" onSubmitEditing={() => void addFriend(newUsername)} /></View>
            <Pressable disabled={busy} onPress={() => void addFriend(newUsername)} style={styles.primaryAction}><UserPlus size={19} color="#FFFFFF" /><Text style={styles.primaryActionText}>{busy ? 'Adding…' : 'Add contact'}</Text></Pressable>
            <MenuAction Icon={QrCode} label="Scan friend QR" onPress={() => { setSheet(null); router.push('/scan' as Href); }} />
            <MenuAction Icon={UsersRound} label="Create group" onPress={() => openSheet('group')} />
          </>}
          {sheet === 'group' && <>
            <Text style={styles.fieldLabel}>GROUP NAME</Text><TextInput style={styles.groupInput} placeholder="Give your group a name" placeholderTextColor={colors.muted} value={groupName} onChangeText={setGroupName} maxLength={60} />
            <Text style={styles.fieldLabel}>CHOOSE CONTACTS</Text>
            <ScrollView style={styles.memberList}>{contacts.length === 0 ? <Text style={styles.helper}>Add a contact before creating a group.</Text> : contacts.map((item) => <Pressable key={item.id} style={styles.memberRow} onPress={() => setSelectedIds((current) => current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id])}><View style={[styles.checkbox, selectedIds.includes(item.id) && styles.checked]}>{selectedIds.includes(item.id) && <Text style={styles.checkMark}>✓</Text>}</View><Text style={styles.memberName}>{item.name}</Text><Text style={styles.memberUsername}>@{item.username}</Text></Pressable>)}</ScrollView>
            <Pressable disabled={busy || !groupName.trim() || selectedIds.length === 0} onPress={() => void createGroup()} style={[styles.primaryAction, (busy || !groupName.trim() || selectedIds.length === 0) && styles.disabled]}><CirclePlus size={19} color="#FFFFFF" /><Text style={styles.primaryActionText}>{busy ? 'Creating…' : 'Create group'}</Text></Pressable>
          </>}
        </View>
      </KeyboardAvoidingView>
    </Modal>

    {/* Create Server Modal */}
    <Modal visible={createModalOpen} transparent animationType="slide" onRequestClose={() => setCreateModalOpen(false)}>
      <KeyboardAvoidingView style={styles.overlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable style={styles.scrim} onPress={() => setCreateModalOpen(false)} />
        <View style={[styles.sheet, { maxHeight: '90%' }]}>
          <View style={styles.sheetTop}>
            <Text style={styles.sheetTitle}>Create Server</Text>
            <Pressable onPress={() => setCreateModalOpen(false)} accessibilityLabel="Close">
              <X size={23} color={colors.text} />
            </Pressable>
          </View>

          <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
            {/* Selected Theme Header */}
            <View style={styles.modalThemeHeader}>
              <Text style={{ fontSize: 28 }}>{THEMES.find(t => t.id === selectedTheme)?.emoji}</Text>
              <View style={{ flex: 1, marginLeft: 10 }}>
                <Text style={styles.cardTitle}>{THEMES.find(t => t.id === selectedTheme)?.title}</Text>
                <Text style={styles.cardSub}>{THEMES.find(t => t.id === selectedTheme)?.subtitle}</Text>
              </View>
            </View>

            {/* Privacy Mode Selector */}
            <Text style={styles.fieldLabel}>SERVER TYPE</Text>
            <View style={styles.privacyToggleRow}>
              <Pressable
                onPress={() => setIsPrivateServer(false)}
                style={[styles.privacyOption, !isPrivateServer && styles.privacyOptionSelected]}
              >
                <Globe size={18} color={!isPrivateServer ? colors.primaryDark : colors.muted} />
                <Text style={[styles.privacyOptionTitle, !isPrivateServer && styles.privacyOptionTitleSelected]}>
                  Public Server
                </Text>
                <Text style={styles.privacyOptionDesc}>Listed in Join Server tab for anyone on ADDA to discover & join</Text>
              </Pressable>

              <Pressable
                onPress={() => setIsPrivateServer(true)}
                style={[styles.privacyOption, isPrivateServer && styles.privacyOptionSelected]}
              >
                <Lock size={18} color={isPrivateServer ? colors.primaryDark : colors.muted} />
                <Text style={[styles.privacyOptionTitle, isPrivateServer && styles.privacyOptionTitleSelected]}>
                  Private Server
                </Text>
                <Text style={styles.privacyOptionDesc}>Invite-only: hidden from Join Server tab</Text>
              </Pressable>
            </View>

            {/* Server Name input */}
            <Text style={styles.fieldLabel}>SERVER NAME (OPTIONAL)</Text>
            <TextInput
              style={styles.groupInput}
              placeholder={isPrivateServer ? "e.g. Private Server#2400" : `e.g. ADDA Server ${THEMES.find(t => t.id === selectedTheme)?.title}#2400`}
              placeholderTextColor={colors.muted}
              value={customServerName}
              onChangeText={setCustomServerName}
              maxLength={50}
            />

            {/* Invite Groups & Contacts multi-selectors (Available for both public and private servers) */}
            <Text style={styles.fieldLabel}>INVITE GROUPS ({selectedGroupInvites.length} SELECTED)</Text>
            {groups.length === 0 ? (
              <Text style={styles.helper}>You have not joined any groups yet.</Text>
            ) : (
              <View style={styles.inviteListContainer}>
                {groups.map(group => {
                  const isSelected = selectedGroupInvites.includes(group.id);
                  return (
                    <Pressable
                      key={group.id}
                      style={styles.memberRow}
                      onPress={() => {
                        setSelectedGroupInvites(curr =>
                          isSelected ? curr.filter(id => id !== group.id) : [...curr, group.id]
                        );
                      }}
                    >
                      <View style={[styles.checkbox, isSelected && styles.checked]}>
                        {isSelected && <Text style={styles.checkMark}>✓</Text>}
                      </View>
                      <UsersRound size={18} color={colors.primaryDark} style={{ marginRight: 6 }} />
                      <Text style={styles.memberName}>{group.name}</Text>
                      <Text style={styles.memberUsername}>{group.memberCount} members</Text>
                    </Pressable>
                  );
                })}
              </View>
            )}

            <Text style={[styles.fieldLabel, { marginTop: 14 }]}>
              INVITE CONTACTS ({selectedContactInvites.length} SELECTED)
            </Text>
            {contacts.length === 0 ? (
              <Text style={styles.helper}>No contacts yet.</Text>
            ) : (
              <View style={styles.inviteListContainer}>
                {contacts.map(contact => {
                  const isSelected = selectedContactInvites.includes(contact.id);
                  return (
                    <Pressable
                      key={contact.id}
                      style={styles.memberRow}
                      onPress={() => {
                        setSelectedContactInvites(curr =>
                          isSelected ? curr.filter(id => id !== contact.id) : [...curr, contact.id]
                        );
                      }}
                    >
                      <View style={[styles.checkbox, isSelected && styles.checked]}>
                        {isSelected && <Text style={styles.checkMark}>✓</Text>}
                      </View>
                      <Text style={styles.memberName}>{contact.name}</Text>
                      <Text style={styles.memberUsername}>@{contact.username}</Text>
                    </Pressable>
                  );
                })}
              </View>
            )}

            <Pressable
              disabled={creatingServer}
              onPress={() => void handleCreateServer()}
              style={[styles.primaryAction, { marginTop: 20 }, creatingServer && styles.disabled]}
            >
              {creatingServer ? (
                <ActivityIndicator color="#FFFFFF" size="small" />
              ) : (
                <>
                  <CirclePlus size={19} color="#FFFFFF" />
                  <Text style={styles.primaryActionText}>Create Server & Choose Character</Text>
                </>
              )}
            </Pressable>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  </SafeAreaView>;
}

function PersonRow({
  name,
  detail,
  avatarUrl,
  time,
  group,
  action,
  onPress,
  typingNames = []
}: {
  name: string;
  detail: string;
  avatarUrl?: string | null;
  time?: string | null;
  group?: boolean;
  action?: React.ReactNode;
  onPress?: () => void;
  typingNames?: string[]
}) {
  const content = (
    <>
      <View style={[styles.personAvatar, group && styles.groupAvatar]}>
        {avatarUrl ? (
          <Image source={{ uri: avatarUrl }} style={styles.rowAvatarImg} />
        ) : group ? (
          <UsersRound size={23} color={colors.primaryDark} />
        ) : (
          <Text style={styles.personInitial}>{name[0]?.toUpperCase()}</Text>
        )}
      </View>
      <View style={styles.personText}>
        <Text style={styles.personName}>{name}</Text>
        {typingNames.length ? (
          <View style={styles.typingRow}>
            <Text numberOfLines={1} style={styles.typingText}>
              {group ? `${typingNames.slice(0, 2).join(', ')} typing` : 'typing'}
            </Text>
            <TypingDots />
          </View>
        ) : (
          <Text numberOfLines={1} style={styles.personDetail}>{detail}</Text>
        )}
      </View>
      {!typingNames.length && time ? (
        <Text style={styles.time}>{new Date(time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</Text>
      ) : action}
    </>
  );
  return onPress ? <Pressable onPress={onPress} style={styles.personRow}>{content}</Pressable> : <View style={styles.personRow}>{content}</View>;
}
function MenuAction({ Icon, label, onPress }: { Icon: typeof QrCode; label: string; onPress: () => void }) {
  return <Pressable onPress={onPress} style={styles.menuAction}><Icon size={21} color={colors.primary} /><Text style={styles.menuText}>{label}</Text></Pressable>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  top: { paddingHorizontal: 22, paddingTop: 15, paddingBottom: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerProfileBtn: { padding: 2 },
  headerAvatarImg: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.surfaceRaised },
  headerAvatarPlaceholder: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  headerAvatarInitial: { color: colors.primaryDark, fontSize: 18, fontWeight: '800' },
  brandContainer: { flex: 1, marginLeft: 12 },
  brand: { color: colors.text, fontSize: 31, fontWeight: '900', letterSpacing: -1.5 }, brandDot: { color: colors.amber },
  subBrand: { color: colors.primary, fontSize: 9, letterSpacing: 1.5, fontWeight: '800' }, iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  searchBox: { marginHorizontal: 20, marginBottom: 10, height: 52, borderRadius: 25, backgroundColor: colors.surfaceRaised, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 17, gap: 11 },
  searchInput: { flex: 1, color: colors.text, fontSize: 15 },
  content: { paddingHorizontal: 20, paddingBottom: 120, flexGrow: 1 }, loader: { marginTop: 40 },
  section: { color: colors.primaryDark, fontSize: 12, fontWeight: '800', letterSpacing: 0.8, marginTop: 22, marginBottom: 5 },
  personRow: { minHeight: 75, backgroundColor: colors.surface, flexDirection: 'row', alignItems: 'center', borderBottomColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 3 },
  personAvatar: { width: 52, height: 52, borderRadius: 26, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }, groupAvatar: { backgroundColor: colors.amberSoft },
  rowAvatarImg: { width: 52, height: 52, borderRadius: 26 },
  personInitial: { color: colors.primaryDark, fontSize: 22, fontWeight: '800' }, personText: { flex: 1, marginLeft: 14 },
  personName: { color: colors.text, fontSize: 16, fontWeight: '700' }, personDetail: { color: colors.muted, fontSize: 13, marginTop: 4 },
  typingRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 }, typingText: { color: colors.primary, fontSize: 13, fontWeight: '700', flexShrink: 1 },
  time: { color: colors.muted, fontSize: 11, alignSelf: 'flex-start', marginTop: 18 },
  addSmall: { padding: 10, borderRadius: 22, backgroundColor: colors.primarySoft },
  callActions: { flexDirection: 'row', gap: 5 }, callSmall: { padding: 10, borderRadius: 22, backgroundColor: colors.primarySoft },
  requestCard: { backgroundColor: colors.surface, borderRadius: 16, padding: 16, marginBottom: 12 },
  requestHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 8 },
  requestAvatarImg: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.surfaceRaised },
  requestAvatarPlaceholder: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  requestAvatarInitial: { color: colors.primaryDark, fontSize: 17, fontWeight: '800' },
  requestActions: { flexDirection: 'row', gap: 10, marginTop: 10 },
  acceptButton: { backgroundColor: colors.primary, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 20 }, acceptText: { color: '#FFFFFF', fontWeight: '800' },
  declineButton: { backgroundColor: colors.surfaceRaised, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 20 }, declineText: { color: colors.text, fontWeight: '800' },
  empty: { alignItems: 'center', paddingVertical: 43, paddingHorizontal: 25, gap: 9 }, emptyTitle: { color: colors.text, fontSize: 18, fontWeight: '800' }, emptyCopy: { color: colors.muted, fontSize: 13, textAlign: 'center', lineHeight: 20 },
  errorBox: { marginTop: 20, padding: 16, backgroundColor: colors.errorSoft, borderRadius: 16, gap: 9 }, errorText: { color: colors.error }, retry: { color: colors.primary, fontWeight: '800' },
  fab: { position: 'absolute', right: 24, bottom: 85, width: 62, height: 62, borderRadius: 20, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center', elevation: 5, shadowColor: colors.primary, shadowOpacity: 0.2, shadowRadius: 8 },
  pageTitle: { color: colors.text, fontSize: 27, fontWeight: '800', marginTop: 16 }, pageCopy: { color: colors.muted, fontSize: 14, lineHeight: 21, marginTop: 6, marginBottom: 24 },
  avatarCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.amberSoft, borderRadius: 20, padding: 16, marginBottom: 19 },
  avatarIcon: { width: 49, height: 49, borderRadius: 16, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' }, avatarLetter: { color: colors.amber, fontWeight: '900', fontSize: 22 },
  roomCard: { flexDirection: 'row', alignItems: 'center', padding: 16, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 20, marginBottom: 12 },
  roomIcon: { width: 49, height: 49, borderRadius: 16, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' }, teaIcon: { backgroundColor: colors.amberSoft }, teaEmoji: { fontSize: 23 },
  fill: { flex: 1, marginLeft: 13 }, cardTitle: { color: colors.text, fontSize: 16, fontWeight: '800' }, cardSub: { color: colors.muted, fontSize: 12, marginTop: 4 }, chevron: { color: colors.primary, fontSize: 26 },
  overlay: { flex: 1, justifyContent: 'flex-end' }, scrim: { ...StyleSheet.absoluteFill, backgroundColor: '#0A2317A8' },
  sheet: { backgroundColor: colors.surface, borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingHorizontal: 23, paddingTop: 21, paddingBottom: 28, maxHeight: '86%' },
  sheetTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 22 }, sheetTitle: { color: colors.text, fontSize: 22, fontWeight: '800' }, sheetError: { color: colors.error, fontSize: 13, marginBottom: 12 },
  fieldLabel: { color: colors.muted, fontSize: 11, fontWeight: '800', letterSpacing: 1, marginBottom: 10 }, inputRow: { flexDirection: 'row', height: 52, borderWidth: 1, borderColor: colors.border, borderRadius: 15, alignItems: 'center', paddingHorizontal: 14 }, at: { color: colors.primary, fontSize: 18, fontWeight: '700' }, entry: { flex: 1, fontSize: 15, color: colors.text, marginLeft: 3 },
  groupInput: { borderWidth: 1, borderColor: colors.border, borderRadius: 15, height: 52, paddingHorizontal: 14, color: colors.text, fontSize: 15, marginBottom: 20 },
  primaryAction: { flexDirection: 'row', gap: 10, backgroundColor: colors.primary, minHeight: 52, borderRadius: 16, alignItems: 'center', justifyContent: 'center', marginTop: 16, marginBottom: 12 }, primaryActionText: { color: '#FFFFFF', fontSize: 15, fontWeight: '800' }, disabled: { opacity: 0.48 },
  menuAction: { minHeight: 54, flexDirection: 'row', alignItems: 'center', gap: 15, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }, menuText: { color: colors.text, fontSize: 15, fontWeight: '700' }, logoutText: { color: colors.error, fontWeight: '700', fontSize: 15 },
  memberList: { maxHeight: 300 }, memberRow: { flexDirection: 'row', alignItems: 'center', minHeight: 56, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, gap: 12 },
  checkbox: { width: 23, height: 23, borderWidth: 1.5, borderColor: colors.border, borderRadius: 8, alignItems: 'center', justifyContent: 'center' }, checked: { backgroundColor: colors.primary, borderColor: colors.primary }, checkMark: { color: '#FFFFFF', fontWeight: '900' }, memberName: { color: colors.text, fontWeight: '700', fontSize: 14, flex: 1 }, memberUsername: { color: colors.muted, fontSize: 12 }, helper: { color: colors.muted, fontSize: 13, lineHeight: 20, marginBottom: 12 },
  characterIcon: { width: 36, height: 36, backgroundColor: colors.primarySoft, borderRadius: 18, alignItems: 'center', justifyContent: 'center' }, characterLetter: { color: colors.primaryDark, fontWeight: '800' },
  sentBadge: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(37, 211, 102, 0.12)', paddingHorizontal: 9, paddingVertical: 5, borderRadius: 12, gap: 4 },
  sentBadgeText: { color: '#25D366', fontSize: 12, fontWeight: '700' },

  // Rooms Tab Navigation
  roomsTabBar: { flexDirection: 'row', backgroundColor: colors.surfaceRaised, borderRadius: 14, padding: 4, marginBottom: 16 },
  roomsTabBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 10, borderRadius: 10 },
  roomsTabBtnActive: { backgroundColor: colors.primary },
  roomsTabBtnText: { fontSize: 13, fontWeight: '700', color: colors.text },
  roomsTabBtnTextActive: { color: '#FFFFFF' },
  serverCountBadge: { backgroundColor: colors.surface, paddingHorizontal: 7, paddingVertical: 1, borderRadius: 10, marginLeft: 2 },
  serverCountBadgeActive: { backgroundColor: 'rgba(255, 255, 255, 0.25)' },
  serverCountBadgeText: { fontSize: 11, fontWeight: '800', color: colors.primaryDark },
  serverCountBadgeTextActive: { color: '#FFFFFF' },

  // Themes
  themeList: { gap: 12, marginBottom: 20 },
  themeCard: { flexDirection: 'row', alignItems: 'center', padding: 14, backgroundColor: colors.surface, borderWidth: 1.5, borderColor: colors.border, borderRadius: 18 },
  themeCardSelected: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  themeCardEmojiBox: { width: 50, height: 50, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  themeCardRadio: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  themeCardRadioSelected: { borderColor: colors.primary },
  themeCardRadioDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: colors.primary },
  launchServerButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: colors.primary, borderRadius: 16, paddingVertical: 16, marginBottom: 24, elevation: 2 },
  launchServerButtonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '900', letterSpacing: 0.5 },

  // Join Server Cards
  refreshIconBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  serverCard: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 18, padding: 14, gap: 12 },
  serverCardHeader: { flexDirection: 'row', alignItems: 'center' },
  serverCardTitle: { color: colors.text, fontSize: 16, fontWeight: '800' },
  serverCardHost: { color: colors.muted, fontSize: 12, marginTop: 2 },
  peerCountBadge: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: '#DCFCE7', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 },
  onlineDot: { width: 7, height: 7, borderRadius: 3.5, backgroundColor: '#22C55E' },
  peerCountText: { color: '#15803D', fontSize: 11, fontWeight: '800' },
  serverJoinButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: '#25D366', borderRadius: 12, paddingVertical: 11 },
  serverJoinButtonText: { color: '#FFFFFF', fontSize: 14, fontWeight: '800' },

  // Create Server Modal
  modalThemeHeader: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surfaceRaised, padding: 12, borderRadius: 14, marginBottom: 16 },
  privacyToggleRow: { flexDirection: 'row', gap: 10, marginBottom: 16 },
  privacyOption: { flex: 1, backgroundColor: colors.surfaceRaised, borderWidth: 1.5, borderColor: colors.border, borderRadius: 14, padding: 12, alignItems: 'center', gap: 4 },
  privacyOptionSelected: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  privacyOptionTitle: { fontSize: 14, fontWeight: '800', color: colors.text },
  privacyOptionTitleSelected: { color: colors.primaryDark },
  privacyOptionDesc: { fontSize: 10, color: colors.muted, textAlign: 'center', marginTop: 2 },
  inviteListContainer: { maxHeight: 180, borderWidth: 1, borderColor: colors.border, borderRadius: 14, paddingHorizontal: 12, marginBottom: 12 },
});
