import { useEffect, useRef, useState } from "react";
import { Dimensions, StyleSheet } from "react-native";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedProps,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";

import {
  buildAnkielMarkPath,
  buildSplashCutoutPath,
  computeMarkFillOpacity,
  computeSplashScale,
  computeSplashTargetScale,
  SPLASH_BACKGROUND_COLOR,
  SPLASH_DIP_DURATION_MS,
  SPLASH_EXPAND_DURATION_MS,
  SPLASH_MARK_COLOR,
  SPLASH_REDUCED_MOTION_FADE_MS,
} from "./launch-splash-mask-geometry";

const AnimatedPath = Animated.createAnimatedComponent(Path);
const EXPAND_EASING = Easing.bezier(0.55, 0, 0.85, 0.25);

export function LaunchSplashMask({
  ready,
  onComplete,
}: {
  readonly ready: boolean;
  readonly onComplete: () => void;
}) {
  const reducedMotion = useReducedMotion();
  const [size, setSize] = useState(() => {
    const window = Dimensions.get("window");
    return { width: window.width, height: window.height };
  });
  const startedRef = useRef(false);

  const dipProgress = useSharedValue(0);
  const expandProgress = useSharedValue(0);
  const overlayOpacity = useSharedValue(1);

  const width = size.width;
  const height = size.height;
  const targetScale = computeSplashTargetScale(width, height);
  const initialCutoutPath = buildSplashCutoutPath(width, height, 1);
  const initialMarkPath = buildAnkielMarkPath(width, height, 1);

  // oxlint-disable-next-line ankielcode/no-unreasoned-state-sync -- drives the one-shot UI-thread splash reveal animation once the app signals readiness
  useEffect(() => {
    if (!ready || startedRef.current) return;
    startedRef.current = true;

    if (process.env.EXPO_PUBLIC_SHOWCASE === "1") {
      onComplete();
      return;
    }

    if (reducedMotion) {
      overlayOpacity.set(
        withTiming(
          0,
          { duration: SPLASH_REDUCED_MOTION_FADE_MS, easing: Easing.out(Easing.quad) },
          (finished) => {
            if (finished) runOnJS(onComplete)();
          },
        ),
      );
      return;
    }

    dipProgress.set(
      withTiming(1, {
        duration: SPLASH_DIP_DURATION_MS,
        // Start from rest: the static native splash hands off to this frame, and an ease-out
        // would jump most of the dip in the first frame, reading as a cut to a smaller mark.
        easing: Easing.inOut(Easing.quad),
      }),
    );
    expandProgress.set(
      withDelay(
        SPLASH_DIP_DURATION_MS,
        withTiming(
          1,
          {
            duration: SPLASH_EXPAND_DURATION_MS,
            easing: EXPAND_EASING,
          },
          (finished) => {
            if (finished) runOnJS(onComplete)();
          },
        ),
      ),
    );
  }, [dipProgress, expandProgress, onComplete, overlayOpacity, ready, reducedMotion]);

  const containerStyle = useAnimatedStyle(() => ({
    opacity: overlayOpacity.value,
  }));

  const cutoutProps = useAnimatedProps(() => {
    const scale = computeSplashScale(dipProgress.value, expandProgress.value, targetScale);
    return {
      d: buildSplashCutoutPath(width, height, scale),
    };
  }, [height, targetScale, width]);

  const markProps = useAnimatedProps(() => {
    const scale = computeSplashScale(dipProgress.value, expandProgress.value, targetScale);
    return {
      d: buildAnkielMarkPath(width, height, scale),
      fillOpacity: computeMarkFillOpacity(expandProgress.value),
    };
  }, [height, targetScale, width]);

  return (
    <Animated.View
      pointerEvents={ready ? "none" : "auto"}
      style={[StyleSheet.absoluteFill, styles.overlay, containerStyle]}
      onLayout={(event) => {
        const nextWidth = event.nativeEvent.layout.width;
        const nextHeight = event.nativeEvent.layout.height;
        if (nextWidth > 0 && nextHeight > 0) {
          setSize((current) =>
            current.width === nextWidth && current.height === nextHeight
              ? current
              : { width: nextWidth, height: nextHeight },
          );
        }
      }}
    >
      {width > 0 && height > 0 ? (
        <Svg width={width} height={height}>
          <AnimatedPath
            d={initialCutoutPath}
            fill={SPLASH_BACKGROUND_COLOR}
            fillRule="evenodd"
            animatedProps={cutoutProps}
          />
          <AnimatedPath d={initialMarkPath} fill={SPLASH_MARK_COLOR} animatedProps={markProps} />
        </Svg>
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    zIndex: 9999,
    elevation: 9999,
  },
});
