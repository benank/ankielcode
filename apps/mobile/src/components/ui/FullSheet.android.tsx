import { useGT } from "gt-react-native";
import { Modal, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";

import { SheetHeader } from "./SheetHeader";
import type { FullSheetProps } from "./FullSheet.types";
export type { FullSheetProps } from "./FullSheet.types";

/**
 * A full-screen modal: a bottom sheet's drag would take vertical drags from content that owns
 * them, such as a reorder list.
 */
export function FullSheet(props: FullSheetProps) {
  const gt = useGT();
  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={() => {
        if (!props.dismissDisabled) props.onClose();
      }}
    >
      <GestureHandlerRootView style={{ flex: 1 }}>
        {/* A Modal is its own native hierarchy, so measure its own safe area, including side
            insets for the camera, instead of the presenting screen's. */}
        <SafeAreaProvider style={{ flex: 1 }}>
          <View className="flex-1 bg-screen">
            <SafeAreaView style={{ flex: 1 }}>
              <SheetHeader
                presentation="inline"
                title={props.title}
                onClose={props.onClose}
                accessibilityLabel={
                  props.accessibilityLabel ?? gt("Close {title}", { title: props.title })
                }
                dismissDisabled={props.dismissDisabled}
              />
              {props.children}
            </SafeAreaView>
          </View>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </Modal>
  );
}
