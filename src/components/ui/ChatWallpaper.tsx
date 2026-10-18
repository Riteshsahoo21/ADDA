import React from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Circle, G, Path, Rect } from 'react-native-svg';

export type ChatWallpaperTheme = 'light' | 'dark';

interface ChatWallpaperProps {
  theme?: ChatWallpaperTheme;
}

export function ChatWallpaper({ theme = 'light' }: ChatWallpaperProps) {
  const isLight = theme === 'light';
  const bgColor = isLight ? '#EFEAE2' : '#0B141A';
  const strokeColor = isLight ? '#323739' : '#8696A0';
  const doodleOpacity = isLight ? 0.065 : 0.045;

  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: bgColor }]} pointerEvents="none">
      <Svg width="100%" height="100%" style={StyleSheet.absoluteFill}>
        {/* Repeating grid of artistic WhatsApp-style chat doodle icons */}
        {[0, 200, 400, 600, 800].map((yOffset) => (
          <G key={yOffset} transform={`translate(0, ${yOffset})`} opacity={doodleOpacity} stroke={strokeColor} strokeWidth="1.4" fill="none">
            {/* Column 1 */}
            {/* 1. Coffee / Chai Mug */}
            <G transform="translate(24, 20)">
              <Path d="M4 8 h18 v12 a6 6 0 0 1 -6 6 h-6 a6 6 0 0 1 -6 -6 z" />
              <Path d="M22 11 h3 a4 4 0 0 1 0 8 h-3" />
              <Path d="M8 3 q2 3 0 5" strokeLinecap="round" />
              <Path d="M14 3 q2 3 0 5" strokeLinecap="round" />
            </G>

            {/* 2. Chat Speech Bubble */}
            <G transform="translate(140, 26)">
              <Path d="M4 6 a4 4 0 0 1 4 -4 h16 a4 4 0 0 1 4 4 v10 a4 4 0 0 1 -4 4 h-10 l-6 5 v-5 h-0 a4 4 0 0 1 -4 -4 z" />
              <Circle cx="10" cy="11" r="1" fill={strokeColor} />
              <Circle cx="16" cy="11" r="1" fill={strokeColor} />
              <Circle cx="22" cy="11" r="1" fill={strokeColor} />
            </G>

            {/* 3. Paper Airplane */}
            <G transform="translate(270, 24)">
              <Path d="M3 14 l22 -10 l-8 20 l-4 -7 l-10 -3 z" />
              <Path d="M13 17 l12 -13" />
            </G>

            {/* Column 2 */}
            {/* 4. Heart */}
            <G transform="translate(75, 75)">
              <Path d="M12 21 l-8.5 -8.5 a5.5 5.5 0 0 1 7.8 -7.8 l0.7 0.7 l0.7 -0.7 a5.5 5.5 0 0 1 7.8 7.8 z" />
            </G>

            {/* 5. Music Notes */}
            <G transform="translate(210, 80)">
              <Path d="M8 18 v-12 l12 -3 v12" />
              <Circle cx="5" cy="18" r="3" />
              <Circle cx="17" cy="15" r="3" />
            </G>

            {/* 6. Star / Sparkle */}
            <G transform="translate(330, 85)">
              <Path d="M12 2 l2.5 6.5 l6.5 2.5 l-6.5 2.5 l-2.5 6.5 l-2.5 -6.5 l-6.5 -2.5 l6.5 -2.5 z" />
            </G>

            {/* Column 3 */}
            {/* 7. Camera */}
            <G transform="translate(28, 135)">
              <Path d="M4 8 h4 l2 -3 h8 l2 3 h4 a3 3 0 0 1 3 3 v10 a3 3 0 0 1 -3 3 h-20 a3 3 0 0 1 -3 -3 v-10 a3 3 0 0 1 3 -3 z" />
              <Circle cx="14" cy="15" r="4" />
            </G>

            {/* 8. Smiley Face */}
            <G transform="translate(150, 140)">
              <Circle cx="14" cy="14" r="11" />
              <Circle cx="10" cy="11" r="1.2" fill={strokeColor} />
              <Circle cx="18" cy="11" r="1.2" fill={strokeColor} />
              <Path d="M9 16 q5 6 10 0" strokeLinecap="round" />
            </G>

            {/* 9. Game Controller */}
            <G transform="translate(280, 140)">
              <Rect x="3" y="6" width="22" height="14" rx="5" />
              <Path d="M8 10 v6 M5 13 h6" strokeLinecap="round" />
              <Circle cx="18" cy="11" r="1" fill={strokeColor} />
              <Circle cx="21" cy="14" r="1" fill={strokeColor} />
            </G>
          </G>
        ))}
      </Svg>
    </View>
  );
}
