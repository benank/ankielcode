import type { ComponentProps, ReactNode } from "react";
import { Platform, Pressable, View } from "react-native";
import { GestureDetector } from "react-native-gesture-handler";

import { cn } from "../../lib/cn";
import { useHoverGesture } from "../../lib/useHoverGesture";

export function RowPressable({
  children,
  className,
  highlighted = false,
  interactionClassName = "bg-row-hover",
  interactionOpacity = 1,
  ...props
}: Omit<ComponentProps<typeof Pressable>, "children"> & {
  readonly children: ReactNode;
  readonly highlighted?: boolean;
  readonly interactionClassName?: string;
  readonly interactionOpacity?: number;
}) {
  const { hovered, hoverGesture } = useHoverGesture(props.disabled ?? false);
  return (
    <GestureDetector gesture={hoverGesture}>
      <Pressable {...props} className={cn("relative overflow-hidden", className)}>
        {({ pressed }) => {
          const touchHighlighted = Platform.OS === "ios" && (pressed || highlighted);
          return (
            <>
              <View
                pointerEvents="none"
                className={cn(
                  "absolute inset-0",
                  touchHighlighted ? "bg-foreground/10" : interactionClassName,
                )}
                style={{
                  opacity: props.disabled
                    ? 0
                    : touchHighlighted
                      ? 1
                      : hovered
                        ? interactionOpacity
                        : 0,
                }}
              />
              {children}
            </>
          );
        }}
      </Pressable>
    </GestureDetector>
  );
}
