import { StyleSheet, Text, View } from 'react-native';
import { colors } from '@/constants/theme';

type Props = { compact?: boolean; centered?: boolean };

export function AddaLogo({ compact = false, centered = false }: Props) {
  const size = compact ? 66 : 104;
  return (
    <View accessible accessibilityLabel="ADDA" style={[styles.lockup, centered && styles.centered]}>
      <View style={[styles.mark, { width: size, height: size, borderRadius: size * 0.3 }]}>
        <Text style={[styles.markLetter, { fontSize: size * 0.57, lineHeight: size * 0.76 }]}>अ</Text>
        <View style={styles.markDot} />
      </View>
      <Text style={[styles.wordmark, compact && styles.compactWordmark]}>
        ADDA<Text style={styles.wordmarkDot}>.</Text>
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  lockup: { alignItems: 'flex-start' },
  centered: { alignItems: 'center' },
  mark: {
    alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary,
    shadowColor: colors.primaryDark, shadowOpacity: 0.14, shadowRadius: 18,
    shadowOffset: { width: 0, height: 7 }, elevation: 5,
  },
  markLetter: { color: '#FFFFFF', fontWeight: '900', textAlign: 'center', includeFontPadding: false },
  markDot: { position: 'absolute', width: 9, height: 9, borderRadius: 5, backgroundColor: colors.amber, right: 13, top: 13 },
  wordmark: { color: colors.text, fontSize: 64, fontWeight: '900', letterSpacing: -3.5, marginTop: 20 },
  compactWordmark: { fontSize: 51, letterSpacing: -3, marginTop: 20 },
  wordmarkDot: { color: colors.amber },
});
