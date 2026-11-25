import {
  PIXEL_ANIMATIONS,
  PIXEL_GRID_PATH,
  PIXEL_LEVEL_OPACITY,
  PIXEL_STATUS_BOX as BOX,
  PIXEL_STATUS_PITCH as PITCH,
  pixelSpriteStrip,
  type PixelStatusKind,
  type PixelStatusTone,
} from "@ankielcode/shared/pixelStatus";
import { useEffect, useState } from "react";
import { Animated, View } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";

import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";

export type { PixelStatusKind };

const TONE_COLOR: Record<PixelStatusTone, { readonly light: string; readonly dark: string }> = {
  cyan: { light: "#06b6d4", dark: "#67e8f9" },
  amber: { light: "#f59e0b", dark: "#fcd34d" },
  red: { light: "#ef4444", dark: "#f87171" },
  emerald: { light: "#10b981", dark: "#34d399" },
};

/**
 * The web sidebar's pixel status light. The frames are one tall sprite strip that the
 * native driver slides a whole frame at a time, so a playing light costs no JS or commits.
 */
export function PixelStatus(props: { readonly kind: PixelStatusKind }) {
  const { themeAppearance } = useAppearancePreferences();
  const reduceMotion = useReducedMotion();
  const animation = PIXEL_ANIMATIONS[props.kind];
  const strip = pixelSpriteStrip(props.kind);
  const tone = TONE_COLOR[animation.tone];
  const color = themeAppearance === "dark" ? tone.dark : tone.light;
  const frames = strip.frameCount;
  const lastFrameY = -(frames - 1) * PITCH;
  const animated = frames > 1 && !reduceMotion;
  const [progress] = useState(() => new Animated.Value(0));

  // oxlint-disable-next-line ankielcode/no-unreasoned-state-sync -- drives a native-driver animation, which lives outside React
  useEffect(() => {
    progress.setValue(0);
    if (!animated) return;
    const step = Animated.timing(progress, {
      toValue: 1,
      duration: animation.durationMs,
      // Holds each frame for an equal share, then jumps: a pixel display, not a scroll.
      easing: (t) => Math.min(Math.floor(t * frames), frames - 1) / (frames - 1),
      useNativeDriver: true,
    });
    const loop = Animated.loop(step, {
      iterations: animation.iterations === "infinite" ? -1 : animation.iterations,
    });
    loop.start();
    return () => loop.stop();
  }, [animated, animation.durationMs, animation.iterations, frames, progress]);

  const restY = animation.iterations === "infinite" ? 0 : lastFrameY;
  const translateY = animated
    ? progress.interpolate({ inputRange: [0, 1], outputRange: [0, lastFrameY] })
    : restY;

  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={{
        width: BOX,
        height: BOX,
        overflow: "hidden",
        opacity: animation.dim ? 0.8 : 1,
      }}
    >
      <Svg width={BOX} height={BOX} style={{ position: "absolute" }}>
        <Path d={PIXEL_GRID_PATH} fill={color} opacity={0.15} />
      </Svg>
      <Animated.View style={{ position: "absolute", transform: [{ translateY }] }}>
        <Svg width={BOX} height={strip.height}>
          <Path d={strip.haloPath} fill={color} opacity={0.18} />
          {strip.paths.map(([level, d]) => (
            <Path key={level} d={d} fill={color} fillOpacity={PIXEL_LEVEL_OPACITY[level]} />
          ))}
        </Svg>
      </Animated.View>
    </View>
  );
}
