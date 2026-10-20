import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors } from '@/constants/theme';
import { API_BASE_URL } from '@/lib/auth-client';
import { socialApi, type OwnProfile } from '@/lib/social-api';
import { disconnectRealtime, getRealtimeSocket } from '@/lib/realtime';

export default function PoliciesScreen() {
  const [version, setVersion] = useState<string | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void socialApi<OwnProfile>('/me').then(me => {
      if (me.policyVersion === me.requiredPolicyVersion) { router.replace('/home'); return; }
      setVersion(me.requiredPolicyVersion || null);
    }).catch(error => Alert.alert('Could not load rules', error instanceof Error ? error.message : 'Please try again.'));
  }, []);

  const open = (path: string) => void Linking.openURL(`${API_BASE_URL}${path}`);
  const accept = async () => {
    if (!version || !agreed || busy) return;
    setBusy(true);
    try {
      await socialApi('/safety/accept', 'POST', { version });
      disconnectRealtime();
      void getRealtimeSocket().catch(() => {});
      router.replace('/home');
    } catch (error) {
      Alert.alert('Could not continue', error instanceof Error ? error.message : 'Please try again.');
    } finally { setBusy(false); }
  };

  return <SafeAreaView style={styles.safe}><ScrollView contentContainerStyle={styles.content}>
    <Text style={styles.eyebrow}>WELCOME TO ADDA</Text>
    <Text style={styles.title}>A place to meet safely</Text>
    <Text style={styles.body}>Be kind in chats, calls, and 3D rooms. No harassment, threats, hate, sexual exploitation, scams, or sharing someone else&apos;s private information.</Text>
    <View style={styles.note}><Text style={styles.noteText}>If you are a teen, protect your address, school, passwords, and location. Block or report anyone who makes you uncomfortable, and tell a trusted adult.</Text></View>
    <Text style={styles.body}>ADDA prohibits child sexual abuse and exploitation. Reports are reviewed and action may be taken against accounts that break these rules.</Text>
    <Pressable onPress={() => open('/terms')}><Text style={styles.link}>Read Terms of Use</Text></Pressable>
    <Pressable onPress={() => open('/community-guidelines')}><Text style={styles.link}>Read Community Guidelines</Text></Pressable>
    <Pressable onPress={() => open('/privacy')}><Text style={styles.link}>Read Privacy Policy</Text></Pressable>
    <Pressable onPress={() => setAgreed(value => !value)} accessibilityRole="checkbox" accessibilityState={{ checked: agreed }} style={styles.agreement}>
      <View style={[styles.checkbox, agreed && styles.checked]}><Text style={styles.tick}>{agreed ? '✓' : ''}</Text></View>
      <Text style={styles.agreementText}>I am at least 13 and meet the minimum age where I live. I agree to the Terms and Community Guidelines.</Text>
    </Pressable>
    <Pressable onPress={() => void accept()} disabled={!agreed || !version || busy} style={[styles.button, (!agreed || !version || busy) && styles.disabled]}>
      {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Continue to ADDA</Text>}
    </Pressable>
  </ScrollView></SafeAreaView>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: 28, paddingVertical: 36, gap: 16 },
  eyebrow: { color: colors.primary, fontWeight: '800', fontSize: 12, letterSpacing: 1.2 },
  title: { color: colors.text, fontSize: 30, fontWeight: '800' },
  body: { color: colors.text, fontSize: 16, lineHeight: 24 },
  note: { backgroundColor: colors.primarySoft, padding: 16, borderRadius: 14 },
  noteText: { color: colors.primaryDark, fontSize: 15, lineHeight: 22 },
  link: { color: colors.primaryDark, fontWeight: '700', fontSize: 16, paddingVertical: 4, textDecorationLine: 'underline' },
  agreement: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 12 },
  checkbox: { width: 25, height: 25, borderWidth: 2, borderColor: colors.primary, borderRadius: 5, alignItems: 'center', justifyContent: 'center' },
  checked: { backgroundColor: colors.primary }, tick: { color: '#fff', fontWeight: '800' },
  agreementText: { color: colors.text, flex: 1, fontSize: 15 },
  button: { backgroundColor: colors.primary, padding: 17, borderRadius: 14, alignItems: 'center', marginTop: 8 },
  buttonText: { color: '#fff', fontWeight: '800', fontSize: 16 }, disabled: { opacity: 0.5 },
});
