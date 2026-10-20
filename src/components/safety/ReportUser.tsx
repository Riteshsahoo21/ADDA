import { useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors } from '@/constants/theme';
import { socialApi } from '@/lib/social-api';

type Kind = 'user' | 'message' | 'room';
type Props = { visible: boolean; userId: string; userName: string; kind: Kind; messageId?: string; roomId?: string; evidenceText?: string; onClose: () => void };
const reasons = [
  ['harassment', 'Harassment or bullying'], ['hate', 'Hate or discrimination'],
  ['sexual', 'Sexual content'], ['child_safety', 'Child safety concern'],
  ['violence', 'Threats or violence'], ['spam', 'Spam or scam'], ['other', 'Something else'],
] as const;

export function ReportUser({ visible, userId, userName, kind, messageId, roomId, evidenceText, onClose }: Props) {
  const [reason, setReason] = useState<string | null>(null);
  const [includeText, setIncludeText] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!reason || busy) return;
    setBusy(true);
    try {
      await socialApi('/safety/reports', 'POST', {
        userId, kind, reason, messageId, roomId,
        evidenceText: includeText && evidenceText ? evidenceText.slice(0, 2000) : '',
      });
      setReason(null); setIncludeText(false); onClose();
      Alert.alert('Report sent', 'Thanks. The ADDA team will review it. You can also block this user.');
    } catch (error) {
      Alert.alert('Could not send report', error instanceof Error ? error.message : 'Please try again.');
    } finally { setBusy(false); }
  };
  return <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
    <View style={styles.overlay}><View style={styles.card}>
      <Text style={styles.title}>Report {userName}</Text>
      <Text style={styles.explanation}>Choose the reason that best describes what happened.</Text>
      <ScrollView style={styles.list}>{reasons.map(([value, label]) =>
        <Pressable key={value} onPress={() => setReason(value)} style={[styles.reason, reason === value && styles.selected]}>
          <Text style={styles.reasonText}>{label}</Text><Text style={styles.radio}>{reason === value ? '●' : '○'}</Text>
        </Pressable>)}</ScrollView>
      {!!evidenceText && <Pressable onPress={() => setIncludeText(value => !value)} style={styles.evidence} accessibilityRole="checkbox" accessibilityState={{ checked: includeText }}>
        <Text style={styles.reasonText}>{includeText ? '☑' : '☐'} Include this message text for moderators</Text>
      </Pressable>}
      <Text style={styles.explanation}>Reports are private. If you include message text, moderators can read that selected text.</Text>
      <View style={styles.actions}>
        <Pressable onPress={onClose} style={styles.cancel}><Text style={styles.cancelText}>Cancel</Text></Pressable>
        <Pressable onPress={() => void submit()} disabled={!reason || busy} style={[styles.submit, (!reason || busy) && styles.disabled]}><Text style={styles.submitText}>{busy ? 'Sending…' : 'Send report'}</Text></Pressable>
      </View>
    </View></View>
  </Modal>;
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: '#0008' },
  card: { backgroundColor: colors.surface, borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 22, maxHeight: '85%' },
  title: { color: colors.text, fontSize: 23, fontWeight: '800' },
  explanation: { color: colors.muted, fontSize: 13, lineHeight: 19, marginTop: 8 },
  list: { marginTop: 14 }, reason: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
  selected: { backgroundColor: colors.primarySoft }, reasonText: { color: colors.text, fontSize: 15 }, radio: { color: colors.primary, fontSize: 18 },
  evidence: { paddingVertical: 13 }, actions: { flexDirection: 'row', gap: 12, marginTop: 20 },
  cancel: { flex: 1, padding: 14, alignItems: 'center' }, cancelText: { color: colors.text, fontWeight: '700' },
  submit: { flex: 1, padding: 14, alignItems: 'center', backgroundColor: colors.primary, borderRadius: 12 },
  submitText: { color: '#fff', fontWeight: '800' }, disabled: { opacity: 0.5 },
});
