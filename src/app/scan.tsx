import { useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { router } from 'expo-router';
import { ArrowLeft, ScanLine } from 'lucide-react-native';
import { colors } from '@/constants/theme';
import { socialApi, type PublicProfile } from '@/lib/social-api';

export default function ScanScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const [error, setError] = useState('');
  const [added, setAdded] = useState<PublicProfile | null>(null);
  const scanning = useRef(false);
  const onScan = async (value: string) => {
    if (scanning.current) return;
    scanning.current = true; setError('');
    try { setAdded(await socialApi<PublicProfile>('/contacts/qr', 'POST', { code: value })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not add friend.'); scanning.current = false; }
  };
  return <SafeAreaView style={styles.safe}>
    <View style={styles.header}><Pressable accessibilityLabel="Back" onPress={() => router.back()} style={styles.back}><ArrowLeft size={24} color={colors.text} /></Pressable><Text style={styles.title}>Scan friend QR</Text></View>
    <Text style={styles.copy}>Point your camera at an ADDA friend QR. Scanning adds that person to your contacts.</Text>
    {!permission && <Text style={styles.message}>Checking camera access…</Text>}
    {permission && !permission.granted && <View style={styles.permission}><ScanLine size={44} color={colors.primary} /><Text style={styles.message}>Camera access is needed to scan a friend QR.</Text><Pressable onPress={() => void requestPermission()} style={styles.button}><Text style={styles.buttonText}>Allow camera</Text></Pressable></View>}
    {permission?.granted && <View style={styles.cameraWrap}><CameraView style={styles.camera} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={added ? undefined : ({ data }) => { void onScan(data); }} /><View pointerEvents="none" style={styles.frame} /></View>}
    {!!error && <Text style={styles.error}>{error}</Text>}
    {added && <View style={styles.result}><Text style={styles.resultTitle}>Friend added</Text><Text style={styles.resultCopy}>{added.name} · @{added.username}</Text><Pressable style={styles.button} onPress={() => router.replace('/home')}><Text style={styles.buttonText}>Done</Text></Pressable></View>}
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background, paddingHorizontal: 22 }, header: { flexDirection: 'row', alignItems: 'center', gap: 13, marginTop: 20 }, back: { padding: 5 }, title: { color: colors.text, fontSize: 23, fontWeight: '800' },
  copy: { color: colors.muted, fontSize: 14, lineHeight: 21, marginTop: 14, marginBottom: 30 }, cameraWrap: { flex: 1, borderRadius: 24, overflow: 'hidden', marginBottom: 25, backgroundColor: colors.surfaceRaised }, camera: { flex: 1 }, frame: { position: 'absolute', left: '12%', right: '12%', top: '22%', bottom: '22%', borderWidth: 3, borderColor: '#FFFFFF', borderRadius: 24 },
  permission: { alignItems: 'center', marginTop: 90, gap: 20 }, message: { color: colors.muted, textAlign: 'center', fontSize: 15, lineHeight: 21 }, button: { backgroundColor: colors.primary, paddingHorizontal: 25, paddingVertical: 15, borderRadius: 15, alignItems: 'center', marginTop: 14 }, buttonText: { color: '#FFFFFF', fontWeight: '800' },
  error: { color: colors.error, textAlign: 'center', marginBottom: 18 }, result: { position: 'absolute', left: 20, right: 20, bottom: 35, padding: 22, borderRadius: 21, backgroundColor: colors.surface, alignItems: 'center' }, resultTitle: { color: colors.text, fontSize: 19, fontWeight: '800' }, resultCopy: { color: colors.muted, marginTop: 6 },
});
