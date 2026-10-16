import { useEffect, useState } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { colors } from '@/constants/theme';

export function TypingDots() {
  const [phases] = useState(() => [new Animated.Value(0), new Animated.Value(0), new Animated.Value(0)]);

  useEffect(() => {
    const animation = Animated.loop(Animated.stagger(140, phases.map(value => Animated.sequence([
      Animated.timing(value, { toValue: 1, duration: 230, useNativeDriver: true }),
      Animated.timing(value, { toValue: 0, duration: 230, useNativeDriver: true }),
      Animated.delay(360),
    ]))));
    animation.start();
    return () => animation.stop();
  }, [phases]);

  return <View style={styles.dots} accessibilityLabel="Typing">
    {phases.map((value, index) => <Animated.View key={index} style={[styles.dot, {
      opacity: value.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] }),
      transform: [{ translateY: value.interpolate({ inputRange: [0, 1], outputRange: [0, -4] }) }],
    }]} />)}
  </View>;
}

const styles = StyleSheet.create({
  dots: { flexDirection: 'row', alignItems: 'center', gap: 3, height: 13 },
  dot: { width: 5, height: 5, borderRadius: 3, backgroundColor: colors.primary },
});
