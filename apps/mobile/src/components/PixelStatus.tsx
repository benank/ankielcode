import {
  PIXEL_ANIMATIONS,
  PIXEL_GRID_PATH,
  PIXEL_LEVEL_OPACITY,
  PIXEL_STATUS_BOX as BOX,
  PIXEL_STATUS_PITCH as PITCH,
  pixelSpriteStrip,
  pixelStripSteps,
  type PixelStatusKind,
  type PixelStatusTone,
} from "@ankielcode/shared/pixelStatus";
import { useEffect, useState } from "react";
import { Animated, Easing, View } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";

import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import type { MobileThemeVariables } from "../lib/mobileTheme";

export type { PixelStatusKind };

/** The one color per status tone; dots and icons that show a state read from here too. */
export const STATUS_TONE_VARIABLE: Record<PixelStatusTone, keyof MobileThemeVariables> = {
  active: "--color-signal-active",
  attention: "--color-warning-foreground",
  failed: "--color-danger-foreground",
  done: "--color-foreground-muted",
};

/**
 * The web sidebar's pixel status light. The frames are one tall sprite strip that the
 * native driver slides a whole frame at a time, so a playing light costs no JS or commits.
 */
export function PixelStatus(props: { readonly kind: PixelStatusKind }) {
  const { themeVariables } = useAppearancePreferences();
  const reduceMotion = useReducedMotion();
  const animation = PIXEL_ANIMATIONS[props.kind];
  const strip = pixelSpriteStrip(props.kind);
  const color = themeVariables[STATUS_TONE_VARIABLE[animation.tone]];
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
      easing: Easing.linear,
      useNativeDriver: true,
    });
    const loop = Animated.loop(step, {
      iterations: animation.iterations === "infinite" ? -1 : animation.iterations,
    });
    loop.start();
    return () => loop.stop();
  }, [animated, animation.durationMs, animation.iterations, progress]);

  const restY = animation.iterations === "infinite" ? 0 : lastFrameY;
  const translateY = animated ? progress.interpolate(pixelStripSteps(frames)) : restY;

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
