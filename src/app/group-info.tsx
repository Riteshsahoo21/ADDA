import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import {
  ArrowLeft,
  Camera,
  Check,
  Edit2,
  LogOut,
  MessageSquare,
  MoreVertical,
  Phone,
  Plus,
  Search,
  Shield,
  Trash2,
  UserCheck,
  UserMinus,
  UserPlus,
  Video,
  X,
} from 'lucide-react-native';
import { colors } from '@/constants/theme';
import {
  socialApi,
  type GroupDetails,
  type GroupMediaItem,
  type GroupMember,
  type PublicProfile,
} from '@/lib/social-api';
import { callRequest, type CallInfo, type CallMedia } from '@/lib/calls';
import { getActiveUserId } from '@/lib/encrypted-chat';

export default function GroupInfoScreen() {
  const { id, name } = useLocalSearchParams<{ id?: string; name?: string }>();
  const groupId = id as string;

  const [loading, setLoading] = useState(true);
  const [group, setGroup] = useState<GroupDetails | null>(null);
  const [activeTab, setActiveTab] = useState<'members' | 'media'>('members');
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);

  // Group media
  const [mediaList, setMediaList] = useState<GroupMediaItem[]>([]);
  const [loadingMedia, setLoadingMedia] = useState(false);

  // Edit info modal (admin only)
  const [showEditModal, setShowEditModal] = useState(false);
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);

  // Add members modal (admin only)
  const [showAddModal, setShowAddModal] = useState(false);
  const [contacts, setContacts] = useState<PublicProfile[]>([]);
  const [selectedContacts, setSelectedContacts] = useState<string[]>([]);
  const [loadingContacts, setLoadingContacts] = useState(false);
  const [submittingAdd, setSubmittingAdd] = useState(false);

  // Member action sheet modal
  const [selectedMember, setSelectedMember] = useState<GroupMember | null>(null);

  const myUserId = getActiveUserId();

  const loadDetails = useCallback(async () => {
    if (!groupId) return;
    try {
      setLoading(true);
      const details = await socialApi<GroupDetails>(`/groups/${groupId}`);
      setGroup(details);
      setEditName(details.name);
      setEditDesc(details.description || '');
    } catch (err) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Could not load group info.');
    } finally {
      setLoading(false);
    }
  }, [groupId]);

  const loadMedia = useCallback(async () => {
    if (!groupId) return;
    try {
      setLoadingMedia(true);
      const media = await socialApi<GroupMediaItem[]>(`/groups/${groupId}/media`);
      setMediaList(media);
    } catch {
      // Non-critical if media list fails to fetch
    } finally {
      setLoadingMedia(false);
    }
  }, [groupId]);

  useEffect(() => {
    void loadDetails();
    void loadMedia();
  }, [loadDetails, loadMedia]);

  const filteredMembers = useMemo(() => {
    if (!group) return [];
    if (!searchQuery.trim()) return group.members;
    const q = searchQuery.toLowerCase().trim();
    return group.members.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.username.toLowerCase().includes(q) ||
        (m.about && m.about.toLowerCase().includes(q))
    );
  }, [group, searchQuery]);

  const handleStartCall = async (media: CallMedia) => {
    if (!group) return;
    try {
      const call = await callRequest<CallInfo>('call:start', {
        target: { kind: 'group', id: group.id },
        media,
      });
      router.push({
        pathname: '/call',
        params: { callId: call.id, role: 'caller', name: group.name },
      } as unknown as Href);
    } catch (err) {
      Alert.alert('Call error', err instanceof Error ? err.message : 'Could not start call.');
    }
  };

  const handleSaveEdit = async () => {
    if (!group || !editName.trim()) return;
    try {
      setSavingEdit(true);
      await socialApi(`/groups/${group.id}`, 'PATCH', {
        name: editName.trim(),
        description: editDesc.trim(),
      });
      setShowEditModal(false);
      await loadDetails();
      Alert.alert('Success', 'Group updated successfully.');
    } catch (err) {
      Alert.alert('Update failed', err instanceof Error ? err.message : 'Could not update group.');
    } finally {
      setSavingEdit(false);
    }
  };

  const handleOpenAddMembers = async () => {
    if (!group) return;
    setShowAddModal(true);
    setLoadingContacts(true);
    setSelectedContacts([]);
    try {
      const allContacts = await socialApi<PublicProfile[]>('/contacts');
      const existingIds = new Set(group.members.map((m) => m.id));
      setContacts(allContacts.filter((c) => !existingIds.has(c.id)));
    } catch (err) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Could not fetch contacts.');
    } finally {
      setLoadingContacts(false);
    }
  };

  const handleConfirmAddMembers = async () => {
    if (!group || selectedContacts.length === 0) return;
    try {
      setSubmittingAdd(true);
      await socialApi(`/groups/${group.id}/members`, 'POST', {
        memberIds: selectedContacts,
      });
      setShowAddModal(false);
      setSelectedContacts([]);
      await loadDetails();
      Alert.alert('Success', 'New members added!');
    } catch (err) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Could not add members.');
    } finally {
      setSubmittingAdd(false);
    }
  };

  const handleToggleAdminRole = async (member: GroupMember) => {
    if (!group) return;
    const newRole = member.role === 'admin' ? 'member' : 'admin';
    const actionText = newRole === 'admin' ? 'promote this member to Admin' : 'dismiss this Admin';
    Alert.alert('Confirm Role Change', `Are you sure you want to ${actionText}?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Confirm',
        onPress: async () => {
          try {
            await socialApi(`/groups/${group.id}/members/${member.id}`, 'PATCH', { role: newRole });
            setSelectedMember(null);
            await loadDetails();
          } catch (err) {
            Alert.alert('Error', err instanceof Error ? err.message : 'Could not change role.');
          }
        },
      },
    ]);
  };

  const handleRemoveMember = (member: GroupMember) => {
    if (!group) return;
    Alert.alert('Remove Member', `Remove ${member.name} from this group?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          try {
            await socialApi(`/groups/${group.id}/members/${member.id}`, 'DELETE');
            setSelectedMember(null);
            await loadDetails();
          } catch (err) {
            Alert.alert('Error', err instanceof Error ? err.message : 'Could not remove member.');
          }
        },
      },
    ]);
  };

  const handleExitGroup = () => {
    if (!group || !myUserId) return;
    Alert.alert(
      'Exit group?',
      `Are you sure you want to leave "${group.name}"? You will no longer receive messages from this group.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Exit group',
          style: 'destructive',
          onPress: async () => {
            try {
              await socialApi(`/groups/${group.id}/members/${myUserId}`, 'DELETE');
              router.replace('/home');
            } catch (err) {
              Alert.alert('Error', err instanceof Error ? err.message : 'Could not exit group.');
            }
          },
        },
      ]
    );
  };

  const handleDirectMessage = (member: GroupMember) => {
    setSelectedMember(null);
    router.push({
      pathname: '/conversation',
      params: { kind: 'direct', id: member.id, name: member.name },
    } as unknown as Href);
  };

  if (loading && !group) {
    return (
      <SafeAreaView style={styles.centerContainer}>
        <ActivityIndicator size="large" color="#25D366" />
        <Text style={styles.loadingText}>Loading group info...</Text>
      </SafeAreaView>
    );
  }

  const displayName = group?.name || name || 'Group';

  return (
    <SafeAreaView style={styles.safe}>
      {/* Top Bar */}
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} style={styles.iconBtn} accessibilityLabel="Back">
          <ArrowLeft size={24} color="#FFFFFF" />
        </Pressable>
        <Text style={styles.topBarTitle} numberOfLines={1}>
          {displayName}
        </Text>
        <Pressable
          onPress={() => {
            if (group?.isAdmin) setShowEditModal(true);
            else Alert.alert('Group', `Group created on ${new Date(group?.members[0]?.joinedAt || Date.now()).toLocaleDateString()}`);
          }}
          style={styles.iconBtn}
          accessibilityLabel="Options"
        >
          <MoreVertical size={22} color="#FFFFFF" />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        {/* Hero Section */}
        <View style={styles.heroSection}>
          <View style={styles.avatarWrap}>
            {group?.avatarUrl ? (
              <Image source={{ uri: group.avatarUrl }} style={styles.avatarImg} />
            ) : (
              <View style={styles.avatarCircle}>
                <Text style={styles.avatarInitial}>{displayName[0]?.toUpperCase() || 'G'}</Text>
              </View>
            )}
            {group?.isAdmin && (
              <Pressable
                onPress={() => setShowEditModal(true)}
                style={styles.avatarBadge}
                accessibilityLabel="Edit group icon"
              >
                <Camera size={16} color="#FFFFFF" />
              </Pressable>
            )}
          </View>

          <View style={styles.titleRow}>
            <Text style={styles.groupTitle}>{displayName}</Text>
            {group?.isAdmin && (
              <Pressable onPress={() => setShowEditModal(true)} style={styles.editTitleBtn}>
                <Edit2 size={16} color="#25D366" />
              </Pressable>
            )}
          </View>

          <Pressable
            onPress={() => {
              if (group?.isAdmin) setShowEditModal(true);
            }}
            style={styles.descWrap}
          >
            <Text style={[styles.groupDesc, !group?.description && styles.placeholderDesc]}>
              {group?.description?.trim() || (group?.isAdmin ? 'Add group description' : 'No group description')}
            </Text>
          </Pressable>
        </View>

        {/* 3 Circular Quick Action Buttons (Voice, Video, Search) */}
        <View style={styles.actionRow}>
          <View style={styles.actionItem}>
            <Pressable
              onPress={() => void handleStartCall('audio')}
              style={styles.actionCircle}
              accessibilityLabel="Voice Call"
            >
              <Phone size={22} color="#25D366" />
            </Pressable>
            <Text style={styles.actionLabel}>Voice</Text>
          </View>

          <View style={styles.actionItem}>
            <Pressable
              onPress={() => void handleStartCall('video')}
              style={styles.actionCircle}
              accessibilityLabel="Video Call"
            >
              <Video size={24} color="#25D366" />
            </Pressable>
            <Text style={styles.actionLabel}>Video</Text>
          </View>

          <View style={styles.actionItem}>
            <Pressable
              onPress={() => {
                setShowSearch((prev) => !prev);
                if (showSearch) setSearchQuery('');
              }}
              style={[styles.actionCircle, showSearch && styles.actionCircleActive]}
              accessibilityLabel="Search"
            >
              <Search size={22} color={showSearch ? '#FFFFFF' : '#25D366'} />
            </Pressable>
            <Text style={styles.actionLabel}>Search</Text>
          </View>
        </View>

        {/* EXACTLY TWO TABS: Members | Media (NO settings tab) */}
        <View style={styles.tabContainer}>
          <Pressable
            onPress={() => setActiveTab('members')}
            style={[styles.tabButton, activeTab === 'members' && styles.tabButtonActive]}
          >
            <Text style={[styles.tabText, activeTab === 'members' && styles.tabTextActive]}>
              Members ({group?.memberCount || group?.members.length || 0})
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setActiveTab('media')}
            style={[styles.tabButton, activeTab === 'media' && styles.tabButtonActive]}
          >
            <Text style={[styles.tabText, activeTab === 'media' && styles.tabTextActive]}>
              Media ({mediaList.length})
            </Text>
          </Pressable>
        </View>

        {/* TAB 1: MEMBERS */}
        {activeTab === 'members' && (
          <View style={styles.tabContent}>
            {/* Live Search Bar if toggled */}
            {showSearch && (
              <View style={styles.searchBar}>
                <Search size={18} color="#8E9BA8" />
                <TextInput
                  style={styles.searchInput}
                  placeholder="Search members..."
                  placeholderTextColor="#8E9BA8"
                  value={searchQuery}
                  onChangeText={setSearchQuery}
                  autoFocus
                />
                {!!searchQuery && (
                  <Pressable onPress={() => setSearchQuery('')}>
                    <X size={18} color="#8E9BA8" />
                  </Pressable>
                )}
              </View>
            )}

            {/* Add Members Row for Admin */}
            {group?.isAdmin && (
              <Pressable onPress={handleOpenAddMembers} style={styles.addMemberRow}>
                <View style={styles.addMemberIconCircle}>
                  <UserPlus size={20} color="#FFFFFF" />
                </View>
                <Text style={styles.addMemberText}>Add members</Text>
              </Pressable>
            )}

            {/* Members List */}
            {filteredMembers.map((member) => (
              <Pressable
                key={member.id}
                onPress={() => {
                  if (member.isSelf) return;
                  setSelectedMember(member);
                }}
                style={styles.memberRow}
              >
                <View style={styles.memberAvatar}>
                  <Text style={styles.memberInitial}>{member.name[0]?.toUpperCase() || 'U'}</Text>
                </View>

                <View style={styles.memberInfo}>
                  <View style={styles.memberNameRow}>
                    <Text style={styles.memberName}>
                      {member.name} {member.isSelf && <Text style={styles.selfTag}>(You)</Text>}
                    </Text>
                    {member.role === 'admin' && (
                      <View style={styles.adminBadge}>
                        <Text style={styles.adminBadgeText}>Group Admin</Text>
                      </View>
                    )}
                  </View>
                  <Text style={styles.memberAbout} numberOfLines={1}>
                    {member.about || 'Hey there! I am using ADDA.'}
                  </Text>
                </View>
              </Pressable>
            ))}
          </View>
        )}

        {/* TAB 2: MEDIA */}
        {activeTab === 'media' && (
          <View style={styles.tabContent}>
            {loadingMedia ? (
              <View style={styles.mediaLoading}>
                <ActivityIndicator size="small" color="#25D366" />
                <Text style={styles.loadingText}>Loading shared media...</Text>
              </View>
            ) : mediaList.length === 0 ? (
              <View style={styles.emptyMedia}>
                <Text style={styles.emptyMediaTitle}>No media shared yet</Text>
                <Text style={styles.emptyMediaSub}>Photos and videos sent to this group will appear here.</Text>
              </View>
            ) : (
              <View style={styles.mediaGrid}>
                {mediaList.map((item) => (
                  <View key={item.id} style={styles.mediaGridItem}>
                    <View style={styles.mediaPlaceholder}>
                      <Text style={styles.mediaPlaceholderText}>
                        {item.mediaKind === 'video' ? '🎥 Video' : '📷 Photo'}
                      </Text>
                    </View>
                  </View>
                ))}
              </View>
            )}
          </View>
        )}

        {/* Exit Group Button at the Bottom */}
        <View style={styles.footerSection}>
          <Pressable onPress={handleExitGroup} style={styles.exitBtn}>
            <LogOut size={20} color="#FF453A" />
            <Text style={styles.exitBtnText}>Exit group</Text>
          </Pressable>
        </View>
      </ScrollView>

      {/* MEMBER ACTION SHEET MODAL */}
      {selectedMember && (
        <Modal
          visible={!!selectedMember}
          transparent
          animationType="fade"
          onRequestClose={() => setSelectedMember(null)}
        >
          <Pressable style={styles.modalOverlay} onPress={() => setSelectedMember(null)}>
            <View style={styles.sheetCard}>
              <View style={styles.sheetHeader}>
                <View style={styles.sheetAvatar}>
                  <Text style={styles.sheetInitial}>{selectedMember.name[0]?.toUpperCase()}</Text>
                </View>
                <View style={styles.sheetInfo}>
                  <Text style={styles.sheetName}>{selectedMember.name}</Text>
                  <Text style={styles.sheetSub}>@{selectedMember.username}</Text>
                </View>
              </View>

              <View style={styles.sheetDivider} />

              <Pressable
                style={styles.sheetAction}
                onPress={() => handleDirectMessage(selectedMember)}
              >
                <MessageSquare size={20} color="#FFFFFF" />
                <Text style={styles.sheetActionText}>Message {selectedMember.name}</Text>
              </Pressable>

              {group?.isAdmin && (
                <>
                  <Pressable
                    style={styles.sheetAction}
                    onPress={() => handleToggleAdminRole(selectedMember)}
                  >
                    {selectedMember.role === 'admin' ? (
                      <>
                        <UserMinus size={20} color="#E5A93C" />
                        <Text style={[styles.sheetActionText, { color: '#E5A93C' }]}>
                          Dismiss as admin
                        </Text>
                      </>
                    ) : (
                      <>
                        <Shield size={20} color="#25D366" />
                        <Text style={[styles.sheetActionText, { color: '#25D366' }]}>
                          Make group admin
                        </Text>
                      </>
                    )}
                  </Pressable>

                  <Pressable
                    style={styles.sheetAction}
                    onPress={() => handleRemoveMember(selectedMember)}
                  >
                    <Trash2 size={20} color="#FF453A" />
                    <Text style={[styles.sheetActionText, { color: '#FF453A' }]}>
                      Remove {selectedMember.name}
                    </Text>
                  </Pressable>
                </>
              )}

              <Pressable style={styles.sheetCancelBtn} onPress={() => setSelectedMember(null)}>
                <Text style={styles.sheetCancelText}>Cancel</Text>
              </Pressable>
            </View>
          </Pressable>
        </Modal>
      )}

      {/* EDIT GROUP MODAL */}
      <Modal visible={showEditModal} transparent animationType="slide" onRequestClose={() => setShowEditModal(false)}>
        <SafeAreaView style={styles.modalSafeContainer}>
          <View style={styles.editModalContent}>
            <View style={styles.editModalHeader}>
              <Pressable onPress={() => setShowEditModal(false)} style={styles.iconBtn}>
                <X size={24} color="#FFFFFF" />
              </Pressable>
              <Text style={styles.editModalTitle}>Edit Group</Text>
              <Pressable
                onPress={handleSaveEdit}
                disabled={savingEdit || !editName.trim()}
                style={styles.saveBtn}
              >
                {savingEdit ? (
                  <ActivityIndicator size="small" color="#25D366" />
                ) : (
                  <Text style={[styles.saveBtnText, !editName.trim() && styles.saveBtnDisabled]}>
                    Save
                  </Text>
                )}
              </Pressable>
            </View>

            <View style={styles.editForm}>
              <Text style={styles.inputLabel}>Group Name</Text>
              <TextInput
                style={styles.textInput}
                value={editName}
                onChangeText={setEditName}
                placeholder="Group name"
                placeholderTextColor="#8E9BA8"
                maxLength={60}
              />

              <Text style={styles.inputLabel}>Description</Text>
              <TextInput
                style={[styles.textInput, styles.descInput]}
                value={editDesc}
                onChangeText={setEditDesc}
                placeholder="Add group description or rules..."
                placeholderTextColor="#8E9BA8"
                multiline
                numberOfLines={4}
                maxLength={500}
              />
            </View>
          </View>
        </SafeAreaView>
      </Modal>

      {/* ADD MEMBERS MODAL */}
      <Modal visible={showAddModal} transparent animationType="slide" onRequestClose={() => setShowAddModal(false)}>
        <SafeAreaView style={styles.modalSafeContainer}>
          <View style={styles.editModalContent}>
            <View style={styles.editModalHeader}>
              <Pressable onPress={() => setShowAddModal(false)} style={styles.iconBtn}>
                <X size={24} color="#FFFFFF" />
              </Pressable>
              <Text style={styles.editModalTitle}>Add Members</Text>
              <Pressable
                onPress={handleConfirmAddMembers}
                disabled={submittingAdd || selectedContacts.length === 0}
                style={styles.saveBtn}
              >
                {submittingAdd ? (
                  <ActivityIndicator size="small" color="#25D366" />
                ) : (
                  <Text
                    style={[
                      styles.saveBtnText,
                      selectedContacts.length === 0 && styles.saveBtnDisabled,
                    ]}
                  >
                    Add ({selectedContacts.length})
                  </Text>
                )}
              </Pressable>
            </View>

            {loadingContacts ? (
              <View style={styles.centerContainer}>
                <ActivityIndicator size="large" color="#25D366" />
                <Text style={styles.loadingText}>Fetching contacts...</Text>
              </View>
            ) : contacts.length === 0 ? (
              <View style={styles.emptyMedia}>
                <Text style={styles.emptyMediaTitle}>No new contacts to add</Text>
                <Text style={styles.emptyMediaSub}>All your contacts are already members of this group.</Text>
              </View>
            ) : (
              <FlatList
                data={contacts}
                keyExtractor={(item) => item.id}
                contentContainerStyle={{ padding: 16, gap: 12 }}
                renderItem={({ item }) => {
                  const isSelected = selectedContacts.includes(item.id);
                  return (
                    <Pressable
                      onPress={() => {
                        setSelectedContacts((prev) =>
                          isSelected ? prev.filter((id) => id !== item.id) : [...prev, item.id]
                        );
                      }}
                      style={[styles.contactSelectRow, isSelected && styles.contactSelectRowActive]}
                    >
                      <View style={styles.memberAvatar}>
                        <Text style={styles.memberInitial}>{item.name[0]?.toUpperCase()}</Text>
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.memberName}>{item.name}</Text>
                        <Text style={styles.memberAbout}>@{item.username}</Text>
                      </View>
                      <View style={[styles.checkbox, isSelected && styles.checkboxActive]}>
                        {isSelected && <Check size={16} color="#FFFFFF" />}
                      </View>
                    </Pressable>
                  );
                }}
              />
            )}
          </View>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#0B1014' },
  centerContainer: { flex: 1, backgroundColor: '#0B1014', alignItems: 'center', justifyContent: 'center', gap: 12 },
  loadingText: { color: '#8E9BA8', fontSize: 14, fontWeight: '600' },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#0B1014',
  },
  iconBtn: { padding: 6 },
  topBarTitle: { flex: 1, color: '#FFFFFF', fontSize: 18, fontWeight: '700', marginHorizontal: 12 },
  scrollContent: { paddingBottom: 40 },
  heroSection: { alignItems: 'center', paddingHorizontal: 20, paddingTop: 16, paddingBottom: 20 },
  avatarWrap: { position: 'relative', marginBottom: 16 },
  avatarCircle: {
    width: 104,
    height: 104,
    borderRadius: 52,
    backgroundColor: '#202C33',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  avatarImg: { width: 104, height: 104, borderRadius: 52 },
  avatarInitial: { color: '#FFFFFF', fontSize: 44, fontWeight: '800' },
  avatarBadge: {
    position: 'absolute',
    bottom: 2,
    right: 2,
    backgroundColor: '#25D366',
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#0B1014',
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  groupTitle: { color: '#FFFFFF', fontSize: 22, fontWeight: '800', textAlign: 'center' },
  editTitleBtn: { padding: 4 },
  descWrap: { paddingHorizontal: 16, paddingVertical: 4 },
  groupDesc: { color: '#8E9BA8', fontSize: 14, textAlign: 'center', lineHeight: 20 },
  placeholderDesc: { color: '#25D366', fontWeight: '500' },
  actionRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 36,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.08)',
  },
  actionItem: { alignItems: 'center', gap: 6 },
  actionCircle: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: '#202C33',
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionCircleActive: { backgroundColor: '#25D366' },
  actionLabel: { color: '#8E9BA8', fontSize: 12, fontWeight: '600' },
  tabContainer: {
    flexDirection: 'row',
    backgroundColor: '#111B21',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.08)',
  },
  tabButton: { flex: 1, paddingVertical: 14, alignItems: 'center', borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabButtonActive: { borderBottomColor: '#25D366' },
  tabText: { color: '#8E9BA8', fontSize: 14, fontWeight: '700' },
  tabTextActive: { color: '#25D366' },
  tabContent: { paddingHorizontal: 16, paddingTop: 12 },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#202C33',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 12,
    gap: 8,
  },
  searchInput: { flex: 1, color: '#FFFFFF', fontSize: 14 },
  addMemberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    gap: 14,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.04)',
  },
  addMemberIconCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#25D366',
    alignItems: 'center',
    justifyContent: 'center',
  },
  addMemberText: { color: '#25D366', fontSize: 16, fontWeight: '700' },
  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    gap: 14,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.04)',
  },
  memberAvatar: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: '#202C33',
    alignItems: 'center',
    justifyContent: 'center',
  },
  memberInitial: { color: '#FFFFFF', fontSize: 18, fontWeight: '700' },
  memberInfo: { flex: 1 },
  memberNameRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 },
  memberName: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
  selfTag: { color: '#8E9BA8', fontWeight: '500' },
  adminBadge: {
    backgroundColor: '#1E2D27',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderWidth: 1,
    borderColor: 'rgba(37, 211, 102, 0.3)',
  },
  adminBadgeText: { color: '#25D366', fontSize: 11, fontWeight: '700' },
  memberAbout: { color: '#8E9BA8', fontSize: 13 },
  mediaLoading: { padding: 32, alignItems: 'center', gap: 8 },
  emptyMedia: { padding: 36, alignItems: 'center', gap: 6 },
  emptyMediaTitle: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
  emptyMediaSub: { color: '#8E9BA8', fontSize: 13, textAlign: 'center' },
  mediaGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingTop: 8 },
  mediaGridItem: { width: '31%', aspectRatio: 1, borderRadius: 8, overflow: 'hidden' },
  mediaPlaceholder: {
    flex: 1,
    backgroundColor: '#202C33',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
  },
  mediaPlaceholderText: { color: '#8E9BA8', fontSize: 12, fontWeight: '600' },
  footerSection: { marginTop: 24, paddingHorizontal: 16 },
  exitBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: 'rgba(255, 69, 58, 0.1)',
    borderRadius: 14,
    paddingVertical: 14,
    borderWidth: 1,
    borderColor: 'rgba(255, 69, 58, 0.25)',
  },
  exitBtnText: { color: '#FF453A', fontSize: 15, fontWeight: '700' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheetCard: {
    backgroundColor: '#1E242B',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    gap: 12,
  },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  sheetAvatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#202C33',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetInitial: { color: '#FFFFFF', fontSize: 20, fontWeight: '700' },
  sheetInfo: { flex: 1 },
  sheetName: { color: '#FFFFFF', fontSize: 17, fontWeight: '700' },
  sheetSub: { color: '#8E9BA8', fontSize: 13 },
  sheetDivider: { height: 1, backgroundColor: 'rgba(255,255,255,0.08)', marginVertical: 4 },
  sheetAction: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 12 },
  sheetActionText: { color: '#FFFFFF', fontSize: 15, fontWeight: '600' },
  sheetCancelBtn: {
    marginTop: 8,
    alignItems: 'center',
    paddingVertical: 12,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 10,
  },
  sheetCancelText: { color: '#8E9BA8', fontSize: 15, fontWeight: '600' },
  modalSafeContainer: { flex: 1, backgroundColor: '#0B1014' },
  editModalContent: { flex: 1, paddingHorizontal: 16 },
  editModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.08)',
  },
  editModalTitle: { color: '#FFFFFF', fontSize: 18, fontWeight: '700' },
  saveBtn: { paddingHorizontal: 12, paddingVertical: 6 },
  saveBtnText: { color: '#25D366', fontSize: 16, fontWeight: '700' },
  saveBtnDisabled: { color: '#8E9BA8', opacity: 0.5 },
  editForm: { paddingVertical: 20, gap: 16 },
  inputLabel: { color: '#8E9BA8', fontSize: 13, fontWeight: '700', textTransform: 'uppercase' },
  textInput: {
    backgroundColor: '#202C33',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    color: '#FFFFFF',
    fontSize: 16,
  },
  descInput: { height: 110, textAlignVertical: 'top' },
  contactSelectRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 12,
    borderRadius: 12,
    backgroundColor: '#111B21',
  },
  contactSelectRowActive: { backgroundColor: '#202C33', borderWidth: 1, borderColor: '#25D366' },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: '#8E9BA8',
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxActive: { backgroundColor: '#25D366', borderColor: '#25D366' },
});
