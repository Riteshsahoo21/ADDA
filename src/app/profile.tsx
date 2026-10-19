import { BottomNav, type HubTab } from '@/components/ui/BottomNav';
import { FriendQr } from '@/components/ui/FriendQr';
import { colors } from '@/constants/theme';
import { useSession } from '@/context/session';
import { getCachedProfile, setCachedProfile } from '@/lib/encrypted-chat';
import { socialApi, type OwnProfile } from '@/lib/social-api';
import { getCachedSocialBundle, updateCachedProfile } from '@/lib/social-cache';
import * as ImagePicker from 'expo-image-picker';
import { router, useFocusEffect, type Href } from 'expo-router';
import { Camera, Lock, QrCode, ScanLine } from 'lucide-react-native';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

function getUsernameCooldown(changedAt?: string | null): { canChange: boolean; remainingDays: number; unlockDate: string | null } {
  if (!changedAt) return { canChange: true, remainingDays: 0, unlockDate: null };
  const last = new Date(changedAt).getTime();
  if (Number.isNaN(last)) return { canChange: true, remainingDays: 0, unlockDate: null };
  const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;
  const remainingMs = last + fourteenDaysMs - Date.now();
  if (remainingMs <= 0) return { canChange: true, remainingDays: 0, unlockDate: null };
  const remainingDays = Math.ceil(remainingMs / (24 * 60 * 60 * 1000));
  const unlockDate = new Date(last + fourteenDaysMs).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  return { canChange: false, remainingDays, unlockDate };
}

export default function ProfileScreen() {
  const { username, login } = useSession();
  const cachedBundle = getCachedSocialBundle();
  const initial = getCachedProfile() || cachedBundle?.me;

  const [profile, setProfile] = useState<OwnProfile | null>(initial || null);
  const [name, setName] = useState(initial?.name || username || '');
  const [handle, setHandle] = useState(initial?.username || '');
  const [about, setAbout] = useState(initial?.about || 'Hey there! I am using ADDA.');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  // Track if user has modified input fields so background re-fetches never overwrite typed input
  const isDirtyRef = useRef(false);

  useFocusEffect(useCallback(() => {
    if (!username) { router.replace('/login'); return; }

    let active = true;
    socialApi<OwnProfile>('/me').then((result) => {
      if (!active) return;
      setProfile(result);
      setCachedProfile(result);
      updateCachedProfile(result);
      // Only sync form state if user is NOT currently editing
      if (!isDirtyRef.current) {
        setName(result.name);
        setHandle(result.username);
        setAbout(result.about || 'Hey there! I am using ADDA.');
      }
      setError('');
    }).catch((cause) => {
      if (!active) return;
      if (!initial) setError(cause instanceof Error ? cause.message : 'Could not load profile.');
    });

    return () => { active = false; };
  }, [username]));

  const cooldown = getUsernameCooldown(profile?.usernameChangedAt);

  const changeAvatar = () => {
    const options: any[] = [
      {
        text: 'Choose from Gallery',
        onPress: async () => {
          const res = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ['images'],
            allowsEditing: true,
            aspect: [1, 1],
            quality: 0.6,
            base64: true,
          });
          if (!res.canceled && res.assets[0]?.base64) {
            setBusy(true);
            try {
              const dataUrl = `data:image/jpeg;base64,${res.assets[0].base64}`;
              const updated = await socialApi<OwnProfile>('/me', 'PATCH', { avatarUrl: dataUrl });
              setProfile(updated);
              setCachedProfile(updated);
              updateCachedProfile(updated);
            } catch (e) {
              Alert.alert('Error', e instanceof Error ? e.message : 'Could not update photo.');
            } finally {
              setBusy(false);
            }
          }
        },
      },
    ];

    if (profile?.avatarUrl) {
      options.push({
        text: 'Remove Profile Photo',
        style: 'destructive',
        onPress: async () => {
          setBusy(true);
          try {
            const updated = await socialApi<OwnProfile>('/me', 'PATCH', { avatarUrl: null });
            setProfile(updated);
            setCachedProfile(updated);
            updateCachedProfile(updated);
          } catch (e) {
            Alert.alert('Error', e instanceof Error ? e.message : 'Could not remove photo.');
          } finally {
            setBusy(false);
          }
        },
      });
    }

    options.push({ text: 'Cancel', style: 'cancel' });
    Alert.alert('Profile Photo', 'Change or remove your profile photo', options);
  };

  const executeSave = async (cleanHandle: string, isChangingUsername: boolean) => {
    setBusy(true);
    setSaved(false);
    setError('');
    try {
      const payload: { name: string; username?: string; about: string } = {
        name: name.trim(),
        about: about.trim(),
      };
      if (isChangingUsername) {
        payload.username = cleanHandle;
      }
      const result = await socialApi<OwnProfile>('/me', 'PATCH', payload);
      setProfile(result);
      setName(result.name);
      setHandle(result.username);
      setAbout(result.about || 'Hey there! I am using ADDA.');
      isDirtyRef.current = false;
      updateCachedProfile(result);
      setSaved(true);
      if (result.name !== username) {
        login(result.name);
      }
      if (isChangingUsername) {
        Alert.alert('Username Changed', `Your username has been updated to @${result.username}. It is now locked for 14 days.`);
      }
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : 'Could not save your profile.';
      setError(msg);
      Alert.alert('Save Failed', msg);
    } finally {
      setBusy(false);
    }
  };

  const handleSave = () => {
    if (busy || !profile) return;
    const cleanHandle = handle.trim().toLowerCase();
    const isChangingUsername = cleanHandle !== profile.username;

    if (name.trim().length < 2) {
      setError('Display name must be at least 2 characters.');
      return;
    }

    if (isChangingUsername) {
      if (!/^[a-z0-9._]{3,24}$/.test(cleanHandle) || /^[._]|[._]$/.test(cleanHandle)) {
        setError('Username must be 3–24 characters: lowercase letters, numbers, dots, or underscores (cannot start or end with . or _).');
        return;
      }

      if (!cooldown.canChange) {
        Alert.alert(
          'Username Locked',
          `You can only change your username once every 14 days. You can change it again on ${cooldown.unlockDate} (${cooldown.remainingDays} day${cooldown.remainingDays === 1 ? '' : 's'} remaining).`
        );
        return;
      }

      Alert.alert(
        'Change Username?',
        `Are you sure you want to change your username to @${cleanHandle}? You will NOT be able to change it again for 14 days.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Confirm & Change',
            onPress: () => void executeSave(cleanHandle, true),
          },
        ]
      );
      return;
    }

    void executeSave(cleanHandle, false);
  };

  const selectTab = (tab: HubTab) => { if (tab !== 'you') router.replace({ pathname: '/home', params: { tab } }); };
  if (!username) return null;

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.eyebrow}>YOUR ADDA IDENTITY</Text>
        <Text style={styles.title}>Your profile</Text>

        <Pressable onPress={changeAvatar} style={styles.avatarWrap} accessibilityLabel="Change profile photo">
          {profile?.avatarUrl ? (
            <Image source={{ uri: profile.avatarUrl }} style={styles.avatarImg} />
          ) : (
            <View style={styles.avatar}><Text style={styles.avatarText}>{name[0]?.toUpperCase() || username[0].toUpperCase()}</Text></View>
          )}
          <View style={styles.avatarCameraBadge}>
            <Camera size={16} color="#FFFFFF" />
          </View>
        </Pressable>

        <Text style={styles.label}>DISPLAY NAME</Text>
        <TextInput
          style={styles.input}
          value={name}
          onChangeText={(value) => {
            setName(value);
            isDirtyRef.current = true;
            setSaved(false);
          }}
          placeholder="Your name"
          placeholderTextColor={colors.muted}
          maxLength={60}
        />

        <View style={styles.labelRow}>
          <Text style={styles.label}>USERNAME</Text>
          {!cooldown.canChange && (
            <View style={styles.lockedPill}>
              <Lock size={12} color="#D97706" />
              <Text style={styles.lockedPillText}>14-day lock active</Text>
            </View>
          )}
        </View>

        <View style={[styles.usernameRow, !cooldown.canChange && styles.usernameRowDisabled]}>
          <Text style={[styles.at, !cooldown.canChange && styles.atDisabled]}>@</Text>
          <TextInput
            style={[styles.usernameInput, !cooldown.canChange && styles.usernameInputDisabled]}
            value={handle}
            onChangeText={(value) => {
              setHandle(value);
              isDirtyRef.current = true;
              setSaved(false);
            }}
            placeholder="username"
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={24}
            editable={cooldown.canChange && !busy}
          />
          {!cooldown.canChange && (
            <View style={styles.lockIconWrap}>
              <Lock size={16} color={colors.muted} />
            </View>
          )}
        </View>

        {!cooldown.canChange ? (
          <Text style={styles.cooldownText}>
            🔒 Username locked until {cooldown.unlockDate} ({cooldown.remainingDays} day{cooldown.remainingDays === 1 ? '' : 's'} remaining).
          </Text>
        ) : (
          <Text style={styles.hint}>
            Friends find you by username. 3–24 letters, numbers, dots, underscores. Can only be changed once every 14 days.
          </Text>
        )}

        <Text style={[styles.label, { marginTop: 17 }]}>ABOUT</Text>
        <TextInput
          style={styles.input}
          value={about}
          onChangeText={(value) => {
            setAbout(value);
            isDirtyRef.current = true;
            setSaved(false);
          }}
          placeholder="Hey there! I am using ADDA."
          placeholderTextColor={colors.muted}
          maxLength={150}
        />

        {!!error && <Text style={styles.error}>{error}</Text>}
        {saved && <Text style={styles.success}>Profile saved.</Text>}

        <Pressable
          accessibilityRole="button"
          disabled={busy || !profile}
          onPress={handleSave}
          style={[styles.save, (busy || !profile) && styles.disabled]}
        >
          <Text style={styles.saveText}>{busy ? 'Saving…' : 'Save changes'}</Text>
        </Pressable>

        <View style={styles.qrCard}>
          <View style={styles.qrHeading}>
            <QrCode size={22} color={colors.primary} />
            <Text style={styles.qrTitle}>Your friend QR</Text>
          </View>
          <Text style={styles.qrCopy}>
            Someone can scan this to add you. It contains only a random friend code, never your email or private details.
          </Text>
          <View style={styles.qrSurface}>
            {profile ? <FriendQr code={profile.friendCode} /> : <ActivityIndicator color={colors.primary} />}
          </View>
          <Text style={styles.qrUsername}>@{profile?.username || '...'}</Text>
          <Pressable onPress={() => router.push('/scan' as Href)} style={styles.scanButton}>
            <ScanLine size={19} color={colors.primaryDark} />
            <Text style={styles.scanText}>Scan a friend’s QR</Text>
          </Pressable>
        </View>
      </ScrollView>
      <BottomNav active="you" onSelect={selectTab} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: 24, paddingTop: 27, paddingBottom: 36 },
  eyebrow: { color: colors.primary, fontSize: 10, letterSpacing: 1.6, fontWeight: '800' },
  title: { color: colors.text, fontSize: 29, fontWeight: '800', marginTop: 6, marginBottom: 22 },
  avatarWrap: { alignSelf: 'flex-start', position: 'relative', marginBottom: 24 },
  avatar: { width: 84, height: 84, borderRadius: 42, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  avatarImg: { width: 84, height: 84, borderRadius: 42, backgroundColor: colors.surface },
  avatarCameraBadge: { position: 'absolute', bottom: -2, right: -2, backgroundColor: colors.primary, width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: colors.background },
  avatarText: { color: colors.primaryDark, fontSize: 31, fontWeight: '900' },
  labelRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  label: { color: colors.muted, fontSize: 11, fontWeight: '800', letterSpacing: 1, marginBottom: 8 },
  lockedPill: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(217, 119, 6, 0.12)', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6, marginBottom: 6 },
  lockedPillText: { color: '#D97706', fontSize: 11, fontWeight: '700' },
  input: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 14, height: 52, paddingHorizontal: 15, color: colors.text, fontSize: 16, marginBottom: 17 },
  usernameRow: { height: 52, borderRadius: 14, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 15 },
  usernameRowDisabled: { backgroundColor: 'rgba(255, 255, 255, 0.03)', borderColor: 'rgba(255, 255, 255, 0.08)' },
  at: { color: colors.primary, fontSize: 19, fontWeight: '800' },
  atDisabled: { color: colors.muted },
  usernameInput: { flex: 1, fontSize: 16, color: colors.text, marginLeft: 3 },
  usernameInputDisabled: { color: colors.muted },
  lockIconWrap: { paddingLeft: 8 },
  cooldownText: { color: '#F59E0B', fontSize: 12, lineHeight: 18, marginTop: 8, fontWeight: '600' },
  hint: { color: colors.muted, fontSize: 12, lineHeight: 18, marginTop: 8 },
  error: { color: colors.error, marginTop: 12, fontSize: 13 },
  success: { color: colors.primary, marginTop: 12, fontWeight: '700' },
  save: { height: 52, backgroundColor: colors.primary, borderRadius: 16, alignItems: 'center', justifyContent: 'center', marginTop: 18 },
  saveText: { color: '#FFFFFF', fontWeight: '800', fontSize: 15 },
  disabled: { opacity: 0.5 },
  qrCard: { marginTop: 35, padding: 20, backgroundColor: colors.surface, borderRadius: 22, borderWidth: 1, borderColor: colors.border, alignItems: 'center' },
  qrHeading: { flexDirection: 'row', alignItems: 'center', gap: 10, alignSelf: 'flex-start' },
  qrTitle: { color: colors.text, fontSize: 18, fontWeight: '800' },
  qrCopy: { color: colors.muted, alignSelf: 'flex-start', fontSize: 12, lineHeight: 18, marginTop: 9, marginBottom: 18 },
  qrSurface: { width: 258, height: 258, backgroundColor: '#FFFFFF', borderRadius: 15, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border },
  qrUsername: { color: colors.text, fontWeight: '700', marginTop: 12 },
  scanButton: { flexDirection: 'row', gap: 9, alignItems: 'center', marginTop: 21, backgroundColor: colors.primarySoft, paddingHorizontal: 17, paddingVertical: 13, borderRadius: 14 },
  scanText: { color: colors.primaryDark, fontWeight: '800' },
});
