import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as ScreenOrientation from 'expo-screen-orientation';
import { router, useLocalSearchParams } from 'expo-router';
import { DoorOpen, Globe, Lock, Shield, Sparkles, User, Users } from 'lucide-react-native';
import { AvatarPreview } from '@/components/room/AvatarPreview';
import { colors } from '@/constants/theme';
import { useSession } from '@/context/session';
import { AvatarBody, AVATAR_NAMES, AVATAR_TAGLINES } from '@/three/player/avatarStyle';
import { ensureRoomAssets, roomDownloadSize, roomIsDownloaded, type DownloadableRoom } from '@/three/roomAssets';

const avatarLabels: Record<AvatarBody, string> = AVATAR_NAMES;
const avatarList: AvatarBody[] = ['photo_boy', 'uncle', 'man', 'self', 'woman', 'chinese_woman', 'nepali_woman', 'white_top_woman'];

const THEME_NAMES: Record<string, { label: string; emoji: string; color: string; desc: string }> = {
  tea: { label: 'Chai Shop', emoji: '☕', color: '#B26E3A', desc: 'Roadside adda with warm tea and bench talks' },
  beach: { label: 'Sunset Beach', emoji: '🏖️', color: '#F38D68', desc: 'Sunset shores, shacks & ocean waves' },
  loft: { label: 'Lounge Loft', emoji: '🏢', color: '#277A55', desc: 'Cozy modern apartment lounge' },
  roof: { label: 'School Rooftop', emoji: '🏫', color: '#5C6BC0', desc: 'Open sky school rooftop overlooking the city' },
};

export default function LobbyScreen() {
  const { avatarStyle, setAvatarStyle, username } = useSession();
  const params = useLocalSearchParams<{
    room?: string;
    roomId?: string;
    groupId?: string;
    roomOwnerId?: string;
    roomName?: string;
    groupName?: string;
    inviterName?: string;
    isPrivate?: string;
  }>();

  const [selectedBody, setSelectedBody] = useState<AvatarBody>(avatarStyle.body || 'man');
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState('');
  const [downloaded, setDownloaded] = useState(true);

  useEffect(() => {
    void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
  }, []);

  useEffect(() => {
    if (!username) router.replace('/login');
  }, [username]);

  const roomKind = ((params.room && ['tea', 'beach', 'loft', 'roof'].includes(params.room)) ? params.room : 'loft') as DownloadableRoom;
  const theme = THEME_NAMES[roomKind] || THEME_NAMES.loft;
  const isPrivate = params.isPrivate === 'true' || Boolean(params.groupId);
  const serverName = params.roomName || (isPrivate ? 'Private Hangout' : `ADDA Server ${theme.label}`);

  const handleSelectBody = (body: AvatarBody) => {
    setSelectedBody(body);
    setAvatarStyle({ body });
  };

  useEffect(() => { setDownloaded(true); setDownloadProgress(0); setDownloadError(''); }, [roomKind]);

  const handleEnterHangout = () => {
    router.replace({
      pathname: '/hangout',
      params: {
        room: roomKind,
        roomId: params.roomId || '',
        groupId: params.groupId || '',
        roomOwnerId: params.roomOwnerId || '',
        groupName: params.groupName || params.roomName || '',
        roomName: params.roomName || params.groupName || '',
        isPrivate: params.isPrivate || (isPrivate ? 'true' : 'false'),
        avatar: selectedBody,
      },
    } as any);
  };

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {/* Navigation / Header */}
        <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.back}>
          <Text style={styles.backText}>‹  Back</Text>
        </Pressable>

        <View style={styles.header}>
          <View style={styles.badgeRow}>
            <View style={[styles.badge, isPrivate ? styles.badgePrivate : styles.badgePublic]}>
              {isPrivate ? <Lock size={12} color="#D97706" /> : <Globe size={12} color="#25D366" />}
              <Text style={[styles.badgeText, isPrivate ? styles.badgeTextPrivate : styles.badgeTextPublic]}>
                {isPrivate ? 'INVITE ONLY' : 'PUBLIC SERVER'}
              </Text>
            </View>
            <View style={[styles.themePill, { backgroundColor: theme.color + '22', borderColor: theme.color }]}>
              <Text style={styles.themePillEmoji}>{theme.emoji}</Text>
              <Text style={[styles.themePillText, { color: theme.color }]}>{theme.label}</Text>
            </View>
          </View>
          <Text style={styles.title}>{serverName}</Text>
          <Text style={styles.subtitle}>{theme.desc}</Text>
          {!!params.inviterName && (
            <Text style={styles.inviterNote}>Invited by {params.inviterName}</Text>
          )}
        </View>

        {/* 3D Character Preview */}
        <View style={styles.previewBox}>
          <AvatarPreview key={selectedBody} style={{ ...avatarStyle, body: selectedBody }} />
          <View style={styles.previewOverlay}>
            <Text style={styles.previewLabel}>{avatarLabels[selectedBody]}</Text>
            <Text style={styles.previewTagline}>{AVATAR_TAGLINES[selectedBody]}</Text>
          </View>
        </View>

        {/* Character Selection */}
        <View style={styles.sectionHeader}>
          <Sparkles size={16} color={colors.primary} />
          <Text style={styles.sectionTitle}>Pick Your Character</Text>
        </View>

        <View style={styles.characterGrid}>
          {avatarList.map(body => {
            const isSelected = selectedBody === body;
            return (
              <Pressable
                key={body}
                onPress={() => handleSelectBody(body)}
                style={[styles.charCard, isSelected && styles.charCardSelected]}
              >
                <View style={[styles.charIcon, isSelected && styles.charIconSelected]}>
                  <Text style={[styles.charLetter, isSelected && styles.charLetterSelected]}>
                    {avatarLabels[body][0]}
                  </Text>
                </View>
                <View style={styles.charText}>
                  <Text style={[styles.charName, isSelected && styles.charNameSelected]} numberOfLines={1}>
                    {avatarLabels[body]}
                  </Text>
                  <Text style={styles.charSub} numberOfLines={1}>
                    {AVATAR_TAGLINES[body]}
                  </Text>
                </View>
                {isSelected && <Text style={styles.checkMark}>✓</Text>}
              </Pressable>
            );
          })}
        </View>

        {/* Enter Server CTA */}
        {!downloaded && <Text style={styles.downloadHint}>
          This room downloads once ({(roomDownloadSize(roomKind) / 1048576).toFixed(1)} MB). ADDA keeps your two most recently used rooms on this phone.
        </Text>}
        {!!downloadError && <Text style={styles.downloadError}>{downloadError}</Text>}
        {downloading && <View style={styles.downloadTrack}><View style={[styles.downloadFill, { width: `${Math.round(downloadProgress * 100)}%` }]} /></View>}
        <Pressable onPress={() => void handleEnterHangout()} disabled={downloading} style={[styles.enterButton, downloading && { opacity: 0.7 }]}>
          {downloading ? <ActivityIndicator color="#FFFFFF" /> : <DoorOpen size={20} color="#FFFFFF" />}
          <Text style={styles.enterButtonText}>{downloading ? `DOWNLOADING ${Math.round(downloadProgress * 100)}%` : downloaded ? 'ENTER HANGOUT' : 'DOWNLOAD & ENTER'}</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  downloadHint: { color: colors.muted, fontSize: 13, lineHeight: 19, marginTop: 15, marginBottom: 8 },
  downloadError: { color: colors.error, fontSize: 13, marginTop: 10 },
  downloadTrack: { height: 8, borderRadius: 4, backgroundColor: colors.border, overflow: 'hidden', marginVertical: 8 },
  downloadFill: { height: '100%', backgroundColor: colors.primary },
  safe: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 40,
  },
  back: {
    paddingVertical: 8,
    alignSelf: 'flex-start',
  },
  backText: {
    color: colors.primary,
    fontSize: 16,
    fontWeight: '700',
  },
  header: {
    marginTop: 10,
    marginBottom: 16,
  },
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
  },
  badgePublic: {
    backgroundColor: '#DCFCE7',
  },
  badgePrivate: {
    backgroundColor: '#FEF3C7',
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  badgeTextPublic: {
    color: '#166534',
  },
  badgeTextPrivate: {
    color: '#92400E',
  },
  themePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    borderWidth: 1,
  },
  themePillEmoji: {
    fontSize: 12,
  },
  themePillText: {
    fontSize: 11,
    fontWeight: '700',
  },
  title: {
    color: colors.text,
    fontSize: 26,
    fontWeight: '900',
    letterSpacing: -0.3,
  },
  subtitle: {
    color: colors.muted,
    fontSize: 13,
    marginTop: 4,
  },
  inviterNote: {
    color: colors.primary,
    fontSize: 12,
    fontWeight: '600',
    marginTop: 4,
  },
  previewBox: {
    height: 240,
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: '#DEEAE2',
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 20,
    position: 'relative',
  },
  previewOverlay: {
    position: 'absolute',
    bottom: 12,
    left: 14,
    right: 14,
    backgroundColor: 'rgba(255, 255, 255, 0.88)',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 12,
  },
  previewLabel: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '800',
  },
  previewTagline: {
    color: colors.muted,
    fontSize: 12,
    marginTop: 1,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 12,
  },
  sectionTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '800',
  },
  characterGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginBottom: 24,
  },
  charCard: {
    width: '48%',
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: 14,
    padding: 10,
    gap: 8,
  },
  charCardSelected: {
    borderColor: colors.primary,
    backgroundColor: colors.primarySoft,
  },
  charIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: '#E7ECE9',
    alignItems: 'center',
    justifyContent: 'center',
  },
  charIconSelected: {
    backgroundColor: colors.primary,
  },
  charLetter: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '800',
  },
  charLetterSelected: {
    color: '#FFFFFF',
  },
  charText: {
    flex: 1,
  },
  charName: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '800',
  },
  charNameSelected: {
    color: colors.primaryDark,
  },
  charSub: {
    color: colors.muted,
    fontSize: 11,
  },
  checkMark: {
    color: colors.primary,
    fontSize: 16,
    fontWeight: '900',
  },
  enterButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: colors.primary,
    borderRadius: 16,
    paddingVertical: 16,
    elevation: 3,
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
  },
  enterButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '900',
    letterSpacing: 0.5,
  },
});
