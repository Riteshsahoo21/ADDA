import { StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { colors } from '@/constants/theme';
import {
  LETTERS_PATH,
  RAYS_PATH,
  WORDMARK_HEIGHT,
  WORDMARK_VIEWBOX,
  WORDMARK_WIDTH,
} from './wordmark-paths';

type Props = { compact?: boolean; centered?: boolean; header?: boolean; showTagline?: boolean };

export function AddaLogo({ compact = false, centered = false, header = false, showTagline = false }: Props) {
  const width = header ? 122 : compact ? 220 : 284;
  const height = (width * WORDMARK_HEIGHT) / WORDMARK_WIDTH;
  return (
    <View accessible accessibilityLabel={showTagline ? 'ADDA. Milte hain ADDA pe.' : 'ADDA'}
      style={[styles.lockup, centered && styles.centered]}>
      <Svg width={width} height={height} viewBox={WORDMARK_VIEWBOX} fill="none" accessibilityElementsHidden>
        {/* Radiating Spark Rays (Warm Golden Amber) */}
        <Path d={RAYS_PATH} fill={colors.amber} fillRule="evenodd" />
        {/* Stylized ADDA Wordmark (Deep Forest Pine Green) */}
        <Path d={LETTERS_PATH} fill={colors.primaryDark} fillRule="evenodd" />
      </Svg>
      {showTagline && <Text style={styles.tagline}>Milte hain ADDA pe.</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  lockup: { alignItems: 'flex-start' },
  centered: { alignItems: 'center' },
  tagline: { color: colors.primaryDark, fontSize: 14, fontWeight: '700', letterSpacing: 0.2, marginTop: 7 },
});
