import { MessageCircle, Radio, DoorOpen, Phone, UserRound } from 'lucide-react-native';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors } from '@/constants/theme';

export type HubTab = 'chats' | 'updates' | 'rooms' | 'calls' | 'you';

const items = [
  { id: 'chats', label: 'Chats', Icon: MessageCircle },
  { id: 'updates', label: 'Updates', Icon: Radio },
  { id: 'rooms', label: 'Rooms', Icon: DoorOpen },
  { id: 'calls', label: 'Calls', Icon: Phone },
  { id: 'you', label: 'You', Icon: UserRound },
] as const;

export function BottomNav({ active, onSelect }: { active: HubTab; onSelect: (tab: HubTab) => void }) {
  return <View style={styles.bar}>
    {items.map(({ id, label, Icon }) => {
      const selected = active === id;
      return <Pressable key={id} accessibilityRole="tab" accessibilityState={{ selected }} onPress={() => onSelect(id)} style={styles.item}>
        <View style={[styles.icon, selected && styles.iconSelected]}><Icon size={23} strokeWidth={selected ? 2.4 : 1.9} color={selected ? colors.primaryDark : colors.muted} /></View>
        <Text style={[styles.label, selected && styles.labelSelected]}>{label}</Text>
      </Pressable>;
    })}
  </View>;
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', backgroundColor: colors.surface, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 8, paddingBottom: 5 },
  item: { flex: 1, alignItems: 'center', gap: 3, paddingVertical: 2 },
  icon: { width: 56, height: 32, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  iconSelected: { backgroundColor: colors.primarySoft },
  label: { color: colors.muted, fontSize: 11, fontWeight: '600' },
  labelSelected: { color: colors.primaryDark, fontWeight: '800' },
});
