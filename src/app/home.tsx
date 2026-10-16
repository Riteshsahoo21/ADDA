import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as ScreenOrientation from 'expo-screen-orientation';
import { router, useFocusEffect, useLocalSearchParams, type Href } from 'expo-router';
import { CirclePlus, DoorOpen, EllipsisVertical, MessageCircle, Phone, Plus, QrCode, Search, UserPlus, UsersRound, Video, X } from 'lucide-react-native';
import { BottomNav, type HubTab } from '@/components/ui/BottomNav';
import { colors } from '@/constants/theme';
import { useSession } from '@/context/session';
import { socialApi, type ChatGroup, type FriendRequest, type OwnProfile, type PublicProfile } from '@/lib/social-api';
import { getRealtimeSocket } from '@/lib/realtime';
import type { TypingEvent } from '@/lib/realtime';
import { TypingDots } from '@/components/ui/TypingDots';
import { callRequest, type CallInfo, type CallMedia } from '@/lib/calls';
import { type AvatarBody } from '@/three/player/avatarStyle';

const avatars: { body: AvatarBody; label: string }[] = [
  { body: 'man', label: 'Indian Man' }, { body: 'uncle', label: 'Uncle' },
  { body: 'photo_boy', label: 'Photo Boy' }, { body: 'self', label: 'My Avatar' },
  { body: 'woman', label: 'Indian Woman' }, { body: 'chinese_woman', label: 'Chinese Woman' },
  { body: 'nepali_woman', label: 'Nepali Woman' }, { body: 'white_top_woman', label: 'White Top Woman' },
];
type Sheet = 'add' | 'group' | 'menu' | 'room' | null;
type Room = 'loft' | 'tea';

export default function HomeScreen() {
  const { username, logout, avatarStyle, setAvatarStyle } = useSession();
  const params = useLocalSearchParams<{ tab?: string }>();
  const [tab, setTab] = useState<HubTab>(params.tab === 'rooms' || params.tab === 'updates' || params.tab === 'calls' ? params.tab : 'chats');
  const [profile, setProfile] = useState<OwnProfile | null>(null);
  const [contacts, setContacts] = useState<PublicProfile[]>([]);
  const [people, setPeople] = useState<PublicProfile[]>([]);
  const [groups, setGroups] = useState<ChatGroup[]>([]);
  const [friendRequests, setFriendRequests] = useState<FriendRequest[]>([]);
  const [search, setSearch] = useState('');
  const [sheet, setSheet] = useState<Sheet>(null);
  const [room, setRoom] = useState<Room>('loft');
  const [newUsername, setNewUsername] = useState('');
  const [groupName, setGroupName] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sheetError, setSheetError] = useState('');
  const [typing, setTyping] = useState<Record<string, Record<string, string>>>({});
  const typingExpiry = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => { void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP); }, []);
  useEffect(() => { if (!username) router.replace('/login'); }, [username]);

  const refresh = useCallback(async () => {
    if (!username) return;
    try {
      const [me, friends, suggested, joined, requests] = await Promise.all([
        socialApi<OwnProfile>('/me'), socialApi<PublicProfile[]>('/contacts'),
        socialApi<PublicProfile[]>('/people'), socialApi<ChatGroup[]>('/groups'),
        socialApi<FriendRequest[]>('/friend-requests'),
      ]);
      setProfile(me); setContacts(friends); setPeople(suggested); setGroups(joined); setFriendRequests(requests); setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load ADDA.');
    } finally { setLoading(false); }
  }, [username]);
  useFocusEffect(useCallback(() => { void refresh(); }, [refresh]));
  useEffect(() => {
    if (!username) return;
    let active = true;
    let live: Awaited<ReturnType<typeof getRealtimeSocket>> | null = null;
    const onUpdate = () => { void refresh(); };
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
    void getRealtimeSocket().then(value => {
      if (!active) return;
      live = value;
      value.on('chat:message', onUpdate);
      value.on('friends:updated', onUpdate);
      value.on('connect', onUpdate);
      value.on('disconnect', clearTyping);
      value.on('chat:typing', onTyping);
    }).catch(() => {});
    return () => { active = false; clearTyping(); live?.off('chat:message', onUpdate); live?.off('friends:updated', onUpdate); live?.off('connect', onUpdate); live?.off('disconnect', clearTyping); live?.off('chat:typing', onTyping); };
  }, [username, refresh, profile?.id]);

  const visibleContacts = useMemo(() => contacts.filter((item) => `${item.name} ${item.username}`.toLowerCase().includes(search.toLowerCase())), [contacts, search]);
  const visibleGroups = useMemo(() => groups.filter((item) => item.name.toLowerCase().includes(search.toLowerCase())), [groups, search]);
  const visiblePeople = useMemo(() => people.filter((item) => `${item.name} ${item.username}`.toLowerCase().includes(search.toLowerCase())), [people, search]);

  const openSheet = (next: Sheet) => { setSheetError(''); setSheet(next); };
  const addFriend = async (value: string) => {
    if (busy) return;
    setBusy(true); setSheetError('');
    try {
      await socialApi('/contacts/username', 'POST', { username: value.trim().toLowerCase() });
      setNewUsername(''); setSheet(null); await refresh();
    } catch (cause) { setSheetError(cause instanceof Error ? cause.message : 'Could not add contact.'); }
    finally { setBusy(false); }
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
    if (busy) return;
    setBusy(true); setError('');
    try { await socialApi(`/friend-requests/${encodeURIComponent(id)}/respond`, 'POST', { decision }); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not respond to request.'); }
    finally { setBusy(false); }
  };
  const handleLogout = async () => { setSheet(null); await logout(); router.replace('/login'); };
  const selectTab = (next: HubTab) => { if (next === 'you') router.push('/profile' as Href); else setTab(next); };
  const joinRoom = (body: AvatarBody) => {
    setAvatarStyle({ body }); setSheet(null);
    router.push({ pathname: '/hangout', params: { room, avatar: body } });
  };
  const openConversation = (kind: 'direct' | 'group', id: string, name: string) => {
    router.push(`/conversation?kind=${kind}&id=${encodeURIComponent(id)}&name=${encodeURIComponent(name)}` as Href);
  };
  const startCall = async (kind: 'direct' | 'group', id: string, name: string, media: CallMedia) => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const call = await callRequest<CallInfo>('call:start', { target: { kind, id }, media });
      router.push({ pathname: '/call', params: { callId: call.id, role: call.callerId === profile?.id ? 'caller' : 'callee', name } } as unknown as Href);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not start call.'); }
    finally { setBusy(false); }
  };

  if (!username) return null;
  return <SafeAreaView style={styles.safe}>
    <View style={styles.top}>
      <View><Text style={styles.brand}>ADDA<Text style={styles.brandDot}>.</Text></Text><Text style={styles.subBrand}>{profile ? `@${profile.username}` : 'APNA VIRTUAL HANGOUT'}</Text></View>
      <Pressable accessibilityLabel="More options" onPress={() => openSheet('menu')} style={styles.iconButton}><EllipsisVertical size={25} color={colors.text} /></Pressable>
    </View>

    {tab === 'chats' && <View style={styles.searchBox}><Search size={21} color={colors.muted} /><TextInput style={styles.searchInput} placeholder="Search people and groups" placeholderTextColor={colors.muted} value={search} onChangeText={setSearch} autoCapitalize="none" /></View>}

    <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
      {tab === 'chats' && <>
        {loading && <ActivityIndicator color={colors.primary} style={styles.loader} />}
        {!!error && <View style={styles.errorBox}><Text style={styles.errorText}>{error}</Text><Pressable onPress={() => { if (error.toLowerCase().includes('sign in')) void handleLogout(); else { setLoading(true); void refresh(); } }}><Text style={styles.retry}>{error.toLowerCase().includes('sign in') ? 'Sign in again' : 'Retry'}</Text></Pressable></View>}
        {!loading && !error && <>
          {visibleGroups.length > 0 && <><Text style={styles.section}>Groups</Text>{visibleGroups.map((item) => <PersonRow key={item.id} name={item.name} detail={item.lastMessage || `${item.memberCount} members`} time={item.lastAt} typingNames={Object.values(typing[`group:${item.id}`] ?? {})} group onPress={() => openConversation('group', item.id, item.name)} />)}</>}
          {visibleContacts.length > 0 && <><Text style={styles.section}>Contacts</Text>{visibleContacts.map((item) => <PersonRow key={item.id} name={item.name} detail={item.lastMessage || `@${item.username}`} time={item.lastAt} typingNames={Object.values(typing[`direct:${item.id}`] ?? {})} onPress={() => openConversation('direct', item.id, item.name)} />)}</>}
          {visibleGroups.length === 0 && visibleContacts.length === 0 && <View style={styles.empty}><MessageCircle size={34} color={colors.primary} /><Text style={styles.emptyTitle}>{search ? 'No matches' : 'Your chats start here'}</Text><Text style={styles.emptyCopy}>{search ? 'Try another name or username.' : 'Add a friend or create a group to get started.'}</Text></View>}
          {visiblePeople.length > 0 && <><Text style={styles.section}>People on ADDA</Text>{visiblePeople.map((item) => <PersonRow key={item.id} name={item.name} detail={friendRequests.some(request => request.senderId === profile?.id && request.recipientId === item.id) ? 'Request sent' : `@${item.username}`} action={friendRequests.some(request => request.senderId === profile?.id && request.recipientId === item.id) ? undefined : <Pressable accessibilityLabel={`Request ${item.name}`} onPress={() => void addFriend(item.username)} style={styles.addSmall}><UserPlus size={19} color={colors.primary} /></Pressable>} />)}</>}
        </>}
      </>}

      {tab === 'rooms' && <>
        <Text style={styles.pageTitle}>Choose your hangout</Text><Text style={styles.pageCopy}>Pick a place, then choose the character you’ll bring.</Text>
        <Pressable style={styles.avatarCard} onPress={() => router.push('/avatar')}><View style={styles.avatarIcon}><Text style={styles.avatarLetter}>{username[0].toUpperCase()}</Text></View><View style={styles.fill}><Text style={styles.cardTitle}>Your character</Text><Text style={styles.cardSub}>{avatars.find((item) => item.body === avatarStyle.body)?.label || 'Choose an avatar'}</Text></View><Text style={styles.chevron}>›</Text></Pressable>
        <Pressable style={styles.roomCard} onPress={() => { setRoom('loft'); openSheet('room'); }}><View style={styles.roomIcon}><DoorOpen size={25} color={colors.primaryDark} /></View><View style={styles.fill}><Text style={styles.cardTitle}>Loft 16</Text><Text style={styles.cardSub}>A cozy place to gather</Text></View><Text style={styles.chevron}>›</Text></Pressable>
        <Pressable style={styles.roomCard} onPress={() => { setRoom('tea'); openSheet('room'); }}><View style={[styles.roomIcon, styles.teaIcon]}><Text style={styles.teaEmoji}>☕</Text></View><View style={styles.fill}><Text style={styles.cardTitle}>Tea Party</Text><Text style={styles.cardSub}>Meet at the roadside adda</Text></View><Text style={styles.chevron}>›</Text></Pressable>
      </>}

      {tab === 'updates' && <>
        <Text style={styles.pageTitle}>Updates</Text>
        <Text style={styles.pageCopy}>Friend requests appear here.</Text>
        {!!error && <Text style={styles.errorText}>{error}</Text>}
        {friendRequests.filter(item => item.recipientId === profile?.id).map(item => <View key={item.id} style={styles.requestCard}>
          <Text style={styles.personName}>{item.senderName}</Text><Text style={styles.personDetail}>@{item.senderUsername} sent you a friend request</Text>
          <View style={styles.requestActions}><Pressable disabled={busy} onPress={() => void respondToFriend(item.id, 'accept')} style={styles.acceptButton}><Text style={styles.acceptText}>Accept</Text></Pressable><Pressable disabled={busy} onPress={() => void respondToFriend(item.id, 'decline')} style={styles.declineButton}><Text style={styles.declineText}>Decline</Text></Pressable></View>
        </View>)}
        {friendRequests.filter(item => item.senderId === profile?.id).map(item => <View key={item.id} style={styles.requestCard}><Text style={styles.personName}>{item.recipientName}</Text><Text style={styles.personDetail}>Request sent to @{item.recipientUsername}</Text></View>)}
        {friendRequests.length === 0 && <View style={styles.empty}><Text style={styles.emptyTitle}>No friend requests</Text><Text style={styles.emptyCopy}>Requests you send or receive will appear here.</Text></View>}
      </>}
      {tab === 'calls' && <>
        <Text style={styles.pageTitle}>Calls</Text><Text style={styles.pageCopy}>Start a voice or video call with your contacts or groups.</Text>
        {!!error && <Text style={styles.errorText}>{error}</Text>}
        {groups.map(item => <PersonRow key={item.id} name={item.name} detail={`${item.memberCount} members`} group action={<View style={styles.callActions}><Pressable disabled={busy} accessibilityLabel={`Voice call ${item.name}`} onPress={() => void startCall('group', item.id, item.name, 'audio')} style={styles.callSmall}><Phone size={19} color={colors.primary} /></Pressable><Pressable disabled={busy} accessibilityLabel={`Video call ${item.name}`} onPress={() => void startCall('group', item.id, item.name, 'video')} style={styles.callSmall}><Video size={20} color={colors.primary} /></Pressable></View>} />)}
        {contacts.map(item => <PersonRow key={item.id} name={item.name} detail={`@${item.username}`} action={<View style={styles.callActions}><Pressable disabled={busy} accessibilityLabel={`Voice call ${item.name}`} onPress={() => void startCall('direct', item.id, item.name, 'audio')} style={styles.callSmall}><Phone size={19} color={colors.primary} /></Pressable><Pressable disabled={busy} accessibilityLabel={`Video call ${item.name}`} onPress={() => void startCall('direct', item.id, item.name, 'video')} style={styles.callSmall}><Video size={20} color={colors.primary} /></Pressable></View>} />)}
        {groups.length === 0 && contacts.length === 0 && <View style={styles.empty}><Text style={styles.emptyTitle}>No one to call yet</Text><Text style={styles.emptyCopy}>Add a contact or create a group in Chats.</Text></View>}
      </>}
    </ScrollView>

    {tab === 'chats' && <Pressable accessibilityLabel="Add contact or group" onPress={() => openSheet('add')} style={styles.fab}><Plus size={30} strokeWidth={2.4} color="#FFFFFF" /></Pressable>}
    <BottomNav active={tab} onSelect={selectTab} updateCount={friendRequests.filter(item => item.recipientId === profile?.id).length} />

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
            <Text style={styles.helper}>Enter {room === 'loft' ? 'Loft 16' : 'Tea Party'} as:</Text>
            <ScrollView style={styles.memberList}>{avatars.map((item) => <Pressable key={item.body} style={styles.memberRow} onPress={() => joinRoom(item.body)}><View style={styles.characterIcon}><Text style={styles.characterLetter}>{item.label[0]}</Text></View><Text style={styles.memberName}>{item.label}</Text><Text style={styles.chevron}>›</Text></Pressable>)}</ScrollView>
          </>}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  </SafeAreaView>;
}

function PersonRow({ name, detail, time, group, action, onPress, typingNames = [] }: { name: string; detail: string; time?: string | null; group?: boolean; action?: React.ReactNode; onPress?: () => void; typingNames?: string[] }) {
  const content = <><View style={[styles.personAvatar, group && styles.groupAvatar]}>{group ? <UsersRound size={23} color={colors.primaryDark} /> : <Text style={styles.personInitial}>{name[0]?.toUpperCase()}</Text>}</View><View style={styles.personText}><Text style={styles.personName}>{name}</Text>{typingNames.length ? <View style={styles.typingRow}><Text numberOfLines={1} style={styles.typingText}>{group ? `${typingNames.slice(0, 2).join(', ')} typing` : 'typing'}</Text><TypingDots /></View> : <Text numberOfLines={1} style={styles.personDetail}>{detail}</Text>}</View>{!typingNames.length && time ? <Text style={styles.time}>{new Date(time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</Text> : action}</>;
  return onPress ? <Pressable onPress={onPress} style={styles.personRow}>{content}</Pressable> : <View style={styles.personRow}>{content}</View>;
}
function MenuAction({ Icon, label, onPress }: { Icon: typeof QrCode; label: string; onPress: () => void }) {
  return <Pressable onPress={onPress} style={styles.menuAction}><Icon size={21} color={colors.primary} /><Text style={styles.menuText}>{label}</Text></Pressable>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  top: { paddingHorizontal: 22, paddingTop: 15, paddingBottom: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  brand: { color: colors.text, fontSize: 31, fontWeight: '900', letterSpacing: -1.5 }, brandDot: { color: colors.amber },
  subBrand: { color: colors.primary, fontSize: 9, letterSpacing: 1.5, fontWeight: '800' }, iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  searchBox: { marginHorizontal: 20, marginBottom: 10, height: 52, borderRadius: 25, backgroundColor: colors.surfaceRaised, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 17, gap: 11 },
  searchInput: { flex: 1, color: colors.text, fontSize: 15 },
  content: { paddingHorizontal: 20, paddingBottom: 120, flexGrow: 1 }, loader: { marginTop: 40 },
  section: { color: colors.primaryDark, fontSize: 12, fontWeight: '800', letterSpacing: 0.8, marginTop: 22, marginBottom: 5 },
  personRow: { minHeight: 75, backgroundColor: colors.surface, flexDirection: 'row', alignItems: 'center', borderBottomColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 3 },
  personAvatar: { width: 52, height: 52, borderRadius: 26, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' }, groupAvatar: { backgroundColor: colors.amberSoft },
  personInitial: { color: colors.primaryDark, fontSize: 22, fontWeight: '800' }, personText: { flex: 1, marginLeft: 14 },
  personName: { color: colors.text, fontSize: 16, fontWeight: '700' }, personDetail: { color: colors.muted, fontSize: 13, marginTop: 4 },
  typingRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 }, typingText: { color: colors.primary, fontSize: 13, fontWeight: '700', flexShrink: 1 },
  time: { color: colors.muted, fontSize: 11, alignSelf: 'flex-start', marginTop: 18 },
  addSmall: { padding: 10, borderRadius: 22, backgroundColor: colors.primarySoft },
  callActions: { flexDirection: 'row', gap: 5 }, callSmall: { padding: 10, borderRadius: 22, backgroundColor: colors.primarySoft },
  requestCard: { backgroundColor: colors.surface, borderRadius: 16, padding: 16, marginBottom: 12 },
  requestActions: { flexDirection: 'row', gap: 10, marginTop: 14 },
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
});
