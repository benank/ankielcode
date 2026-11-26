import { useGT } from "gt-react-native";
import { useId, useState } from "react";
import { View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { FormSheet, ScreenStack } from "react-native-screens";
import { useResolveClassNames } from "uniwind";

import { NativeHeader, NativeScreen } from "../../native/ThemedScreenStack";
import type { FullSheetProps } from "./FullSheet.types";
export type { FullSheetProps } from "./FullSheet.types";

/**
 * A full-height sheet for content that owns its vertical drags, such as a reorder list. It has
 * one detent, so a drag the sheet also sees can't resize it, and content sits below the bar.
 */
export function FullSheet(props: FullSheetProps) {
  const gt = useGT();
  const containerStyle = useResolveClassNames("bg-sheet");
  const screenId = useId();
  const [isOpen, setIsOpen] = useState(true);

  return (
    <FormSheet
      isOpen={isOpen}
      detents={[1]}
      prefersGrabberVisible
      preventNativeDismiss={props.dismissDisabled}
      // The header holds the close button, so the Duo needs no rail inside this sheet.
      prefersHorizontalBars
      nativeContainerStyle={containerStyle}
      onDismiss={props.onClose}
      onNativeDismiss={props.onClose}
    >
      {/* Flex children are not bounded by the FormSheet host, so pin to its edges. */}
      <View collapsable={false} className="absolute inset-0 bg-sheet">
        <ScreenStack style={{ flex: 1 }}>
          <NativeScreen
            activityState={2}
            enabled
            isNativeStack
            screenId={`app-full-sheet-${screenId}`}
            className="flex-1 bg-sheet"
          >
            {/* The sheet is its own native hierarchy: gestures need their own root, and the
                safe area measured here starts below the bar. */}
            <GestureHandlerRootView style={{ flex: 1 }}>
              <SafeAreaProvider style={{ flex: 1 }}>
                <SafeAreaView style={{ flex: 1 }}>{props.children}</SafeAreaView>
              </SafeAreaProvider>
            </GestureHandlerRootView>
            <NativeHeader
              backgroundColor="rgba(0,0,0,0)"
              tintColorClassName="accent-foreground"
              hideBackButton
              hideShadow={false}
              title={props.title}
              titleColorClassName="accent-foreground"
              titleFontSize={18}
              titleFontWeight="800"
              translucent
              headerRightBarButtonItems={[
                {
                  type: "button",
                  icon: { name: "xmark", type: "sfSymbol" },
                  accessibilityLabel:
                    props.accessibilityLabel ?? gt("Close {title}", { title: props.title }),
                  identifier: `app-full-sheet-close-${screenId}`,
                  disabled: props.dismissDisabled,
                  onPress: () => {
                    if (!props.dismissDisabled) setIsOpen(false);
                  },
                },
              ]}
            />
          </NativeScreen>
        </ScreenStack>
      </View>
    </FormSheet>
  );
}
