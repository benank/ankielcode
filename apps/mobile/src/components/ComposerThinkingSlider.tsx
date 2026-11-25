import { useEffect } from "react";
import * as Haptics from "expo-haptics";
import { View, type LayoutChangeEvent } from "react-native";
import {
  GestureDetector,
  usePanGesture,
  useTapGesture,
  useCompetingGestures,
} from "react-native-gesture-handler";
import Animated, {
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";

const THUMB_SIZE = 26;
const DETENT_SPRING = { duration: 300, dampingRatio: 1, reduceMotion: ReduceMotion.System };

export function ComposerThinkingSlider(props: {
  readonly label: string;
  readonly valueLabel: string | undefined;
  readonly choices: ReadonlyArray<{ readonly label: string; readonly value: string | boolean }>;
  readonly index: number;
  readonly activeIndex: number;
  readonly disabled: boolean;
  readonly onPreviewChange: (index: number | null) => void;
  readonly onChange: (index: number) => void;
}) {
  const { index } = props;
  const last = props.choices.length - 1;
  const disabled = props.disabled || last < 1;
  const width = useSharedValue(0);
  const detent = useSharedValue(index);
  const position = useSharedValue(index);
  // oxlint-disable-next-line ankielcode/no-unreasoned-state-sync -- syncs the UI-thread slider with picks from another client or accessibility actions
  useEffect(() => {
    detent.set(index);
    position.set(withSpring(index, DETENT_SPRING));
  }, [index, detent, position]);

  const haptic = () => void Haptics.selectionAsync().catch(() => undefined);
  const tick = (next: number) => {
    haptic();
    props.onPreviewChange(next);
  };
  const finish = (next: number | null) => {
    if (next !== null && next !== index) props.onChange(next);
    props.onPreviewChange(null);
  };

  const move = (x: number) => {
    "worklet";
    const span = Math.max(1, width.get() - THUMB_SIZE);
    const fraction = Math.max(0, Math.min(1, (x - THUMB_SIZE / 2) / span));
    const next = Math.round(fraction * last);
    position.set(fraction * last);
    if (next === detent.get()) return;
    detent.set(next);
    scheduleOnRN(tick, next);
  };
  const settle = (canceled: boolean) => {
    "worklet";
    const next = canceled ? index : detent.get();
    detent.set(next);
    position.set(withSpring(next, DETENT_SPRING));
    scheduleOnRN(finish, canceled ? null : next);
  };
  const pan = usePanGesture({
    enabled: !disabled,
    activeOffsetX: [-3, 3],
    failOffsetY: [-12, 12],
    onActivate: ({ x }) => move(x),
    onUpdate: ({ x }) => move(x),
    onDeactivate: ({ canceled }) => settle(canceled),
  });
  const tap = useTapGesture({
    enabled: !disabled,
    onDeactivate: ({ x, canceled }) => {
      if (canceled) return;
      move(x);
      settle(false);
    },
  });
  const gesture = useCompetingGestures(pan, tap);
  const thumbStyle = useAnimatedStyle(() => {
    const progress = last > 0 ? position.get() / last : 0;
    return { transform: [{ translateX: Math.max(0, width.get() - THUMB_SIZE) * progress }] };
  });
  const fillStyle = useAnimatedStyle(() => {
    const progress = last > 0 ? position.get() / last : 0;
    return { transform: [{ scaleX: progress }] };
  });

  const onLayout = (event: LayoutChangeEvent) => width.set(event.nativeEvent.layout.width);

  return (
    <View>
      <GestureDetector gesture={gesture}>
        <View
          collapsable={false}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel={props.label}
          accessibilityState={{ disabled }}
          accessibilityValue={{
            min: 0,
            max: last,
            now: props.index,
            text: props.valueLabel,
          }}
          accessibilityActions={disabled ? [] : [{ name: "increment" }, { name: "decrement" }]}
          onAccessibilityAction={({ nativeEvent }) => {
            if (disabled) return;
            const next = Math.max(
              0,
              Math.min(last, props.index + (nativeEvent.actionName === "increment" ? 1 : -1)),
            );
            if (next === props.index) return;
            haptic();
            finish(next);
          }}
          onLayout={onLayout}
          className="h-12 justify-center"
        >
          <View pointerEvents="none" className="h-4 overflow-hidden rounded-full bg-foreground/20">
            <Animated.View className="h-full w-full origin-left bg-foreground" style={fillStyle} />
          </View>
          {last > 1 ? (
            <View
              pointerEvents="none"
              className="absolute inset-y-0 left-[13px] right-[13px] flex-row items-center justify-between"
            >
              {props.choices.map((choice, step) => (
                <View
                  key={String(choice.value)}
                  className={
                    step <= props.activeIndex ? "size-1" : "size-1 rounded-full bg-foreground/35"
                  }
                />
              ))}
            </View>
          ) : null}
          <Animated.View
            pointerEvents="none"
            className="absolute left-0 rounded-full bg-foreground shadow-sm"
            style={[{ width: THUMB_SIZE, height: THUMB_SIZE }, thumbStyle]}
          />
        </View>
      </GestureDetector>
    </View>
  );
}
