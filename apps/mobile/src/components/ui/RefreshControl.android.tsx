import * as Haptics from "expo-haptics";
import { use } from "react";
// oxlint-disable-next-line eslint/no-restricted-imports -- The wrapper every screen must use.
import { RefreshControl as NativeRefreshControl } from "react-native";
import { View, type RefreshControlProps } from "react-native";

import { BottomSheetContext } from "./BottomSheetContext";

/**
 * A bottom sheet takes the pull at the top, and Material reads the swipe-refresh layout as unable
 * to scroll up, so the sheet collapses instead of scrolling back. Sheets get a plain wrapper that
 * keeps the layout style the scroll view hands its refresh control.
 */
export function RefreshControl(props: RefreshControlProps) {
  if (use(BottomSheetContext)) {
    return (
      <View collapsable={false} style={props.style}>
        {props.children}
      </View>
    );
  }
  // UIRefreshControl plays a haptic when a pull triggers; SwipeRefreshLayout does not.
  const onRefresh =
    props.onRefresh &&
    (() => {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
      props.onRefresh?.();
    });
  return <NativeRefreshControl {...props} onRefresh={onRefresh} />;
}
