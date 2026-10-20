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

export function BottomNav({
  active,
  onSelect,
  updateCount = 0,
  chatUnreadCount = 0,
}: {
  active: HubTab;
  onSelect: (tab: HubTab) => void;
  updateCount?: number;
  chatUnreadCount?: number;
}) {
  return <View style={styles.bar}>
    {items.map(({ id, label, Icon }) => {
      const selected = active === id;
      return <Pressable key={id} accessibilityRole="tab" accessibilityState={{ selected }} onPress={() => onSelect(id)} style={styles.item}>
        <View style={[styles.icon, selected && styles.iconSelected]}>
          <Icon size={23} strokeWidth={selected ? 2.4 : 1.9} color={selected ? colors.primaryDark : colors.muted} />
          {id === 'chats' && chatUnreadCount > 0 && (
            <View style={[styles.badge, styles.chatBadge]}>
              <Text style={styles.badgeText}>{chatUnreadCount > 99 ? '99+' : chatUnreadCount}</Text>
            </View>
          )}
          {id === 'updates' && updateCount > 0 && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{updateCount > 9 ? '9+' : updateCount}</Text>
            </View>
          )}
        </View>
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
  badge: { position: 'absolute', right: 4, top: -4, minWidth: 19, height: 19, borderRadius: 10, paddingHorizontal: 3, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.amber },
  chatBadge: { backgroundColor: '#25D366' },
  badgeText: { color: '#FFFFFF', fontSize: 10, fontWeight: '800' },
});
