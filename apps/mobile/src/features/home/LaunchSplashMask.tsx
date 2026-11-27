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
  computeSplashBackgroundOpacity,
  computeSplashExpandDurationMs,
  computeSplashScale,
  computeSplashTargetScale,
  SPLASH_BACKGROUND_COLOR,
  SPLASH_DIP_DURATION_MS,
  SPLASH_MARK_COLOR,
  SPLASH_REDUCED_MOTION_FADE_MS,
} from "./launch-splash-mask-geometry";

const AnimatedPath = Animated.createAnimatedComponent(Path);

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
  const expandDurationMs = computeSplashExpandDurationMs(targetScale);
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
        easing: Easing.out(Easing.quad),
      }),
    );
    expandProgress.set(
      withDelay(
        SPLASH_DIP_DURATION_MS,
        withTiming(
          1,
          // Linear time: computeSplashScale applies the zoom's speed curve.
          { duration: expandDurationMs, easing: Easing.linear },
          (finished) => {
            if (finished) runOnJS(onComplete)();
          },
        ),
      ),
    );
  }, [
    dipProgress,
    expandDurationMs,
    expandProgress,
    onComplete,
    overlayOpacity,
    ready,
    reducedMotion,
  ]);

  const containerStyle = useAnimatedStyle(() => ({
    opacity: overlayOpacity.value,
  }));

  const backgroundStyle = useAnimatedStyle(() => {
    const scale = computeSplashScale(dipProgress.value, expandProgress.value, targetScale);
    return { opacity: computeSplashBackgroundOpacity(scale, width, height, targetScale) };
  }, [height, targetScale, width]);

  const markProps = useAnimatedProps(() => {
    const scale = computeSplashScale(dipProgress.value, expandProgress.value, targetScale);
    return { d: buildAnkielMarkPath(width, height, scale) };
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
      <Animated.View style={[StyleSheet.absoluteFill, styles.background, backgroundStyle]} />
      {width > 0 && height > 0 ? (
        <Svg width={width} height={height}>
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
  background: {
    backgroundColor: SPLASH_BACKGROUND_COLOR,
  },
});
