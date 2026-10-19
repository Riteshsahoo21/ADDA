import { useEffect } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as ScreenOrientation from 'expo-screen-orientation';
import { router } from 'expo-router';
import { AvatarPreview } from '@/components/room/AvatarPreview';
import { colors } from '@/constants/theme';
import { useSession } from '@/context/session';
import { AvatarBody, AVATAR_NAMES, AVATAR_TAGLINES } from '@/three/player/avatarStyle';

const avatarLabels: Record<AvatarBody, string> = AVATAR_NAMES;
const attire: Record<AvatarBody, { name: string; description: string }> = {
  man: { name: AVATAR_TAGLINES.man, description: 'Turquoise crew tee with fitted dark denim and trainers' },
  uncle: { name: AVATAR_TAGLINES.uncle, description: 'White banyan, checked gamcha, trousers and sandals' },
  photo_boy: { name: AVATAR_TAGLINES.photo_boy, description: 'Maroon shirt, dark trousers and black shoes' },
  self: { name: AVATAR_TAGLINES.self, description: 'Black tee, dark trousers and sneakers' },
  woman: { name: AVATAR_TAGLINES.woman, description: 'Black jacket, dark jeans and white sneakers' },
  chinese_woman: { name: AVATAR_TAGLINES.chinese_woman, description: 'Black modern outfit and sneakers' },
  nepali_woman: { name: AVATAR_TAGLINES.nepali_woman, description: 'Red Nepali outfit' },
  white_top_woman: { name: AVATAR_TAGLINES.white_top_woman, description: 'White top, navy trousers and white shoes' },
};

export default function AvatarScreen() {
  const { avatarStyle, setAvatarStyle, username } = useSession();
  useEffect(() => { void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP); }, []);
  useEffect(() => { if (!username) router.replace('/login'); }, [username]);
  if (!username) return null;
  const chooseBody = (body: AvatarBody) => setAvatarStyle({ body });

  return <SafeAreaView style={styles.safe}>
    <ScrollView contentContainerStyle={styles.content}>
      <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.back}><Text style={styles.backText}>‹  Home</Text></Pressable>
      <Text style={styles.eyebrow}>YOUR CHARACTER</Text>
      <Text style={styles.title}>Make it yours.</Text>
      <Text style={styles.subtitle}>Choose a character for both hangouts.</Text>
      <AvatarPreview key={avatarStyle.body} style={avatarStyle} />
      <Text style={styles.section}>Character</Text>
      <View style={styles.row}>
        {(['man', 'uncle', 'photo_boy', 'self', 'woman', 'chinese_woman', 'nepali_woman', 'white_top_woman'] as const).map(body => (
          <Pressable
            key={body}
            accessibilityRole="button"
            accessibilityState={{ selected: avatarStyle.body === body }}
            onPress={() => chooseBody(body)}
            style={[styles.choice, avatarStyle.body === body && styles.selected]}
          >
            <Text style={[styles.choiceText, avatarStyle.body === body && styles.selectedChoiceText]}>{avatarLabels[body]}</Text>
            <Text style={styles.choiceSub}>{attire[body].name}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={styles.section}>Attire & Style</Text>
      <View style={styles.outfit}>
        <View style={styles.outfitText}>
          <Text style={styles.choiceText}>{avatarLabels[avatarStyle.body]} • {attire[avatarStyle.body].name}</Text>
          <Text style={styles.description}>{attire[avatarStyle.body].description}</Text>
        </View>
        <Text style={styles.check}>✓</Text>
      </View>
      <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.done}><Text style={styles.doneText}>Done</Text></Pressable>
    </ScrollView>
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: 22, paddingTop: 12, paddingBottom: 32 },
  back: { paddingVertical: 8, alignSelf: 'flex-start' },
  backText: { color: colors.primary, fontSize: 15, fontWeight: '700' },
  eyebrow: { color: colors.primary, fontSize: 10, fontWeight: '800', letterSpacing: 1.8, marginTop: 20 },
  title: { color: colors.text, fontSize: 31, fontWeight: '800', marginTop: 6 },
  subtitle: { color: colors.muted, fontSize: 13, lineHeight: 19, marginTop: 7, marginBottom: 20 },
  section: { color: colors.text, fontSize: 17, fontWeight: '800', marginTop: 22, marginBottom: 11 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  choice: { width: '47%', minHeight: 60, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 14, alignItems: 'center', justifyContent: 'center', paddingVertical: 10, paddingHorizontal: 6 },
  selected: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  choiceText: { color: colors.text, fontSize: 16, fontWeight: '800' },
  selectedChoiceText: { color: colors.primaryDark },
  choiceSub: { color: colors.muted, fontSize: 11, marginTop: 3, fontWeight: '600' },
  outfit: { minHeight: 65, flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 14, paddingHorizontal: 15, marginBottom: 9 },
  outfitText: { flex: 1 },
  description: { color: colors.muted, fontSize: 11, marginTop: 4 },
  check: { color: colors.primary, fontSize: 22, fontWeight: '800' },
  done: { backgroundColor: colors.primary, borderRadius: 15, alignItems: 'center', paddingVertical: 15, marginTop: 20 },
  doneText: { color: '#FFFFFF', fontSize: 15, fontWeight: '800' },
});

