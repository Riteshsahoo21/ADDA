import { Pressable, StyleSheet, Text, ViewStyle } from 'react-native';
import { colors } from '@/constants/theme';

type Props = { label: string; onPress: () => void; disabled?: boolean; secondary?: boolean; style?: ViewStyle };

export function ActionButton({ label, onPress, disabled, secondary, style }: Props) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.base, secondary ? styles.secondary : styles.primary, pressed && styles.pressed, disabled && styles.disabled, style]}
    >
      <Text style={[styles.label, secondary && styles.secondaryLabel]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { minHeight: 54, borderRadius: 17, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20 },
  primary: { backgroundColor: colors.primary },
  secondary: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  pressed: { opacity: 0.8 },
  disabled: { opacity: 0.55 },
  label: { color: '#FFFFFF', fontSize: 16, fontWeight: '800', letterSpacing: 0.2 },
  secondaryLabel: { color: colors.text },
});
