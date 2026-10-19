import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Image, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as ScreenOrientation from 'expo-screen-orientation';
import { router, useFocusEffect, useLocalSearchParams, type Href } from 'expo-router';
import { Check, CirclePlus, DoorOpen, EllipsisVertical, MessageCircle, Phone, Plus, QrCode, Search, UserPlus, UsersRound, Video, X } from 'lucide-react-native';
import { BottomNav, type HubTab } from '@/components/ui/BottomNav';
import { colors } from '@/constants/theme';
import { useSession } from '@/context/session';
import { socialApi, type ActiveGroupRoom, type ChatGroup, type FriendRequest, type HangoutUpdatesResponse, type OwnProfile, type PublicProfile, type RoomInvitation, type SocialBundle } from '@/lib/social-api';
import { getRealtimeSocket, type TypingEvent } from '@/lib/realtime';
import { TypingDots } from '@/components/ui/TypingDots';
import { callRequest, type CallInfo, type CallMedia } from '@/lib/calls';
import { type AvatarBody, AVATAR_NAMES, AVATAR_TAGLINES } from '@/three/player/avatarStyle';
import { initEncryptedChat, localPreviews, onChatChanged, previewBody, formatChatPreview, setCachedProfile, getCachedProfile } from '@/lib/encrypted-chat';
import { getCachedSocialBundle, initSocialCache, setCachedSocialBundle, updateCachedContacts, updateCachedGroups, updateCachedFriendRequests } from '@/lib/social-cache';

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
type Sheet = 'add' | 'group' | 'menu' | 'room' | null;
type Room = 'loft' | 'tea' | 'beach';

export default function HomeScreen() {
  const { username, logout, avatarStyle, setAvatarStyle } = useSession();
  const params = useLocalSearchParams<{ tab?: string }>();
  const [tab, setTab] = useState<HubTab>(params.tab === 'rooms' || params.tab === 'updates' || params.tab === 'calls' ? params.tab : 'chats');
  
  // 1. INSTANT FRAME 0 INITIALIZATION FROM IN-MEMORY / DISK CACHE
  const initialCache = getCachedSocialBundle();
  const [profile, setProfile] = useState<OwnProfile | null>(initialCache?.me || getCachedProfile() || null);
  const [contacts, setContacts] = useState<PublicProfile[]>(initialCache?.contacts || []);
  const [people, setPeople] = useState<PublicProfile[]>(initialCache?.people || []);
  const [groups, setGroups] = useState<ChatGroup[]>(initialCache?.groups || []);
  const [friendRequests, setFriendRequests] = useState<FriendRequest[]>(initialCache?.friendRequests || []);
  const [activeHangouts, setActiveHangouts] = useState<ActiveGroupRoom[]>([]);
  const [roomInvites, setRoomInvites] = useState<RoomInvitation[]>([]);
  const [search, setSearch] = useState('');
  const [sheet, setSheet] = useState<Sheet>(null);
  const [room, setRoom] = useState<Room>('loft');
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
        const [me, friends, suggested, joined, requests] = await Promise.all([
          socialApi<OwnProfile>('/me'), socialApi<PublicProfile[]>('/contacts'),
          socialApi<PublicProfile[]>('/people'), socialApi<ChatGroup[]>('/groups'),
          socialApi<FriendRequest[]>('/friend-requests'),
        ]);
        bundle = { me, contacts: friends, people: suggested, groups: joined, friendRequests: requests };
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
      setPeople(bundle.people);
      setGroups(enrichedGroups);
      setFriendRequests(bundle.friendRequests);
      setError('');

      setCachedSocialBundle({
        me: bundle.me,
        contacts: enrichedContacts,
        groups: enrichedGroups,
        people: bundle.people,
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

  const respondToInvite = async (inviteId: string, decision: 'accept' | 'dismiss') => {
    const invite = roomInvites.find(i => i.id === inviteId);
    setRoomInvites(curr => curr.filter(i => i.id !== inviteId));
    try {
      await socialApi(`/room-invites/${encodeURIComponent(inviteId)}/respond`, 'POST', { decision });
    } catch {}
    if (decision === 'accept' && invite) {
      router.push({
        pathname: '/hangout',
        params: {
          room: invite.roomKind,
          groupId: invite.groupId,
          roomId: invite.roomId,
          roomOwnerId: '',
        },
      } as unknown as Href);
    }
  };

  useFocusEffect(useCallback(() => {
    const cached = getCachedProfile() || getCachedSocialBundle()?.me;
    if (cached) setProfile(cached);
    void refresh();
    void refreshHangouts();
  }, [refresh, refreshHangouts]));

  const refreshSocial = useCallback(async () => {
    try {
      let bundle: SocialBundle;
      try {
        bundle = await socialApi<SocialBundle>('/social/bundle');
      } catch {
        const [friends, requests, suggested] = await Promise.all([
          socialApi<PublicProfile[]>('/contacts'),
          socialApi<FriendRequest[]>('/friend-requests'),
          socialApi<PublicProfile[]>('/people'),
        ]);
        bundle = { me: profile!, contacts: friends, groups: [], people: suggested, friendRequests: requests };
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
      setPeople(bundle.people);
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
          setPeople(curr => curr.filter(p => p.id !== newContact.id));
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
    void getRealtimeSocket().then(value => {
      if (!active) return;
      live = value;
      value.on('chat:encrypted:update', onUpdate);
      value.on('chat:message_deleted', onUpdate);
      value.on('friends:updated', onFriendUpdate);
      value.on('group:room_updated', onRoomUpdated);
      value.on('room:invitation', onRoomInvite);
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
      live?.off('connect', onUpdate);
      live?.off('disconnect', clearTyping);
      live?.off('chat:typing', onTyping);
    };
  }, [username, refresh, profile?.id, refreshSocial, refreshHangouts]);

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
  const contactIds = useMemo(() => new Set(contacts.map(c => c.id)), [contacts]);
  const visiblePeople = useMemo(() => {
    return people.filter((item) => !contactIds.has(item.id) && `${item.name} ${item.username}`.toLowerCase().includes(search.toLowerCase()));
  }, [people, contactIds, search]);

  const openSheet = (next: Sheet) => { setSheetError(''); setSheet(next); };
  const addFriend = async (value: string, explicitTarget?: PublicProfile) => {
    const cleanUsername = value.trim().toLowerCase();
    if (!cleanUsername && !explicitTarget) return;

    // 1. INSTANT OPTIMISTIC UI UPDATE (0ms)
    const targetUser = explicitTarget || people.find(p => p.username.toLowerCase() === cleanUsername);
    const targetId = explicitTarget?.id || targetUser?.id || `user-${cleanUsername}`;
    const tempId = `temp-${Date.now()}`;

    const optimisticRequest: FriendRequest = {
      id: tempId,
      senderId: profile?.id || '',
      recipientId: targetId,
      senderName: profile?.name || '',
      senderUsername: profile?.username || '',
      senderAvatarUrl: profile?.avatarUrl || null,
      recipientName: explicitTarget?.name || targetUser?.name || cleanUsername,
      recipientUsername: explicitTarget?.username || targetUser?.username || cleanUsername,
      recipientAvatarUrl: explicitTarget?.avatarUrl || targetUser?.avatarUrl || null,
      createdAt: new Date().toISOString(),
      status: 'pending',
    };

    setSheet(null);
    setNewUsername('');
    setSheetError('');

    setFriendRequests(curr => {
      const matchUsername = (explicitTarget?.username || targetUser?.username || cleanUsername).toLowerCase();
      if (curr.some(r => r.recipientUsername.toLowerCase() === matchUsername || r.recipientId === targetId)) {
        return curr;
      }
      return [optimisticRequest, ...curr];
    });

    // 2. Perform API call in background
    try {
      const added = explicitTarget?.id
        ? await socialApi<PublicProfile>(`/contacts/user/${encodeURIComponent(explicitTarget.id)}`, 'POST')
        : targetUser?.id
          ? await socialApi<PublicProfile>(`/contacts/user/${encodeURIComponent(targetUser.id)}`, 'POST')
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
  const joinRoom = (body: AvatarBody) => {
    setAvatarStyle({ body }); setSheet(null);
    router.push({ pathname: '/hangout', params: { room, avatar: body } });
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

    {tab === 'chats' && <View style={styles.searchBox}><Search size={21} color={colors.muted} /><TextInput style={styles.searchInput} placeholder="Search people and groups" placeholderTextColor={colors.muted} value={search} onChangeText={setSearch} autoCapitalize="none" /></View>}

    <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
      {tab === 'chats' && <>
        {loading && <ActivityIndicator color={colors.primary} style={styles.loader} />}
        {!!error && <View style={styles.errorBox}><Text style={styles.errorText}>{error}</Text><Pressable onPress={() => { if (error.toLowerCase().includes('sign in')) void handleLogout(); else { setLoading(true); void refresh(); } }}><Text style={styles.retry}>{error.toLowerCase().includes('sign in') ? 'Sign in again' : 'Retry'}</Text></Pressable></View>}
        {!loading && !error && <>
          {visibleGroups.length > 0 && <><Text style={styles.section}>Groups</Text>{visibleGroups.map((item) => <PersonRow key={item.id} name={item.name} avatarUrl={item.avatarUrl} detail={item.lastMessage || `${item.memberCount} members`} time={item.lastAt} typingNames={Object.values(typing[`group:${item.id}`] ?? {})} group onPress={() => openConversation('group', item.id, item.name, item.avatarUrl)} />)}</>}
          {visibleContacts.length > 0 && <><Text style={styles.section}>Contacts</Text>{visibleContacts.map((item) => <PersonRow key={item.id} name={item.name} avatarUrl={item.avatarUrl} detail={item.lastMessage || `@${item.username}`} time={item.lastAt} typingNames={Object.values(typing[`direct:${item.id}`] ?? {})} onPress={() => openConversation('direct', item.id, item.name, item.avatarUrl)} />)}</>}
          {visibleGroups.length === 0 && visibleContacts.length === 0 && <View style={styles.empty}><MessageCircle size={34} color={colors.primary} /><Text style={styles.emptyTitle}>{search ? 'No matches' : 'Your chats start here'}</Text><Text style={styles.emptyCopy}>{search ? 'Try another name or username.' : 'Add a friend or create a group to get started.'}</Text></View>}
          {visiblePeople.length > 0 && <><Text style={styles.section}>People on ADDA</Text>{visiblePeople.map((item) => {
            const isRequested = friendRequests.some(request =>
              (request.senderId === profile?.id && request.recipientId === item.id) ||
              (request.recipientId === profile?.id && request.senderId === item.id) ||
              (request.senderId === profile?.id && request.recipientUsername?.toLowerCase() === item.username.toLowerCase())
            );
            return (
              <PersonRow
                key={item.id}
                name={item.name}
                avatarUrl={item.avatarUrl}
                detail={isRequested ? 'Request sent' : `@${item.username}`}
                action={isRequested ? (
                  <View style={styles.sentBadge}>
                    <Check size={14} color="#25D366" />
                    <Text style={styles.sentBadgeText}>Sent</Text>
                  </View>
                ) : (
                  <Pressable accessibilityLabel={`Request ${item.name}`} onPress={() => void addFriend(item.username, item)} style={styles.addSmall}>
                    <UserPlus size={19} color={colors.primary} />
                  </Pressable>
                )}
              />
            );
          })}</>}
        </>}
      </>}

      {tab === 'rooms' && <>
        <Text style={styles.pageTitle}>Choose your hangout</Text><Text style={styles.pageCopy}>Pick a place, then choose the character you’ll bring.</Text>
        <Pressable style={styles.avatarCard} onPress={() => router.push('/avatar')}><View style={styles.avatarIcon}><Text style={styles.avatarLetter}>{username[0].toUpperCase()}</Text></View><View style={styles.fill}><Text style={styles.cardTitle}>Your character</Text><Text style={styles.cardSub}>{avatars.find((item) => item.body === avatarStyle.body) ? `${avatars.find((item) => item.body === avatarStyle.body)?.label} • ${avatars.find((item) => item.body === avatarStyle.body)?.tagline}` : 'Choose a character'}</Text></View><Text style={styles.chevron}>›</Text></Pressable>
        <Pressable style={styles.roomCard} onPress={() => { setRoom('loft'); openSheet('room'); }}><View style={styles.roomIcon}><DoorOpen size={25} color={colors.primaryDark} /></View><View style={styles.fill}><Text style={styles.cardTitle}>Loft 16</Text><Text style={styles.cardSub}>A cozy place to gather</Text></View><Text style={styles.chevron}>›</Text></Pressable>
        <Pressable style={styles.roomCard} onPress={() => { setRoom('tea'); openSheet('room'); }}><View style={[styles.roomIcon, styles.teaIcon]}><Text style={styles.teaEmoji}>☕</Text></View><View style={styles.fill}><Text style={styles.cardTitle}>Tea Party</Text><Text style={styles.cardSub}>Meet at the roadside adda</Text></View><Text style={styles.chevron}>›</Text></Pressable>
        <Pressable style={styles.roomCard} onPress={() => { setRoom('beach'); openSheet('room'); }}><View style={[styles.roomIcon, { backgroundColor: '#F38D68' }]}><Text style={styles.teaEmoji}>🏖️</Text></View><View style={styles.fill}><Text style={styles.cardTitle}>Goa Beach</Text><Text style={styles.cardSub}>Sunset shores, shacks & ocean waves</Text></View><Text style={styles.chevron}>›</Text></Pressable>
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
                          pathname: '/hangout',
                          params: {
                            room: item.roomKind,
                            groupId: item.groupId,
                            roomId: item.id,
                            roomOwnerId: item.creatorId,
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
          <View style={styles.sheetTop}><Text style={styles.sheetTitle}>{sheet === 'group' ? 'New group' : sheet === 'room' ? 'Choose a character' : sheet === 'menu' ? 'More' : 'Start something'}</Text><Pressable onPress={() => setSheet(null)} accessibilityLabel="Close"><X size={23} color={colors.text} /></Pressable></View>
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
          {sheet === 'room' && <>
            <Text style={styles.helper}>Enter {room === 'beach' ? 'Goa Beach' : room === 'loft' ? 'Loft 16' : 'Tea Party'} as:</Text>
            <ScrollView style={styles.memberList}>{avatars.map((item) => <Pressable key={item.body} style={styles.memberRow} onPress={() => joinRoom(item.body)}><View style={styles.characterIcon}><Text style={styles.characterLetter}>{item.label[0]}</Text></View><View style={{ flex: 1 }}><Text style={styles.memberName}>{item.label}</Text><Text style={styles.memberUsername}>{item.tagline}</Text></View><Text style={styles.chevron}>›</Text></Pressable>)}</ScrollView>
          </>}
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
});
