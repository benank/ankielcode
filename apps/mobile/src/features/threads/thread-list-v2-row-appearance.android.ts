import { msg } from "gt-react-native";
import type { ViewStyle } from "react-native";

import { m, type MessageResolver } from "../../i18n/messages";
import { FONT_FAMILIES } from "../../lib/fontFamilies";
import type { MobileThemeVariables } from "../../lib/mobileTheme";

export const THREAD_LIST_V2_MONO_FONT = FONT_FAMILIES.mono;
export const THREAD_LIST_V2_ROW_CONTENT_CLASS_NAME = "px-3 py-2";
export const THREAD_LIST_V2_ROW_DIVIDERS = false;
// Rounded, not a pill: rows stack into a list rather than a column of buttons.
export const THREAD_LIST_V2_ROW_RADIUS = 10;
export const THREAD_LIST_V2_SIDEBAR_ROW_STYLE = {
  borderRadius: 10,
  paddingHorizontal: 12,
  paddingVertical: 10,
} satisfies ViewStyle;
export const THREAD_LIST_V2_SIDEBAR_ROW_CONTAINER_STYLE = {
  borderRadius: 10,
  overflow: "hidden",
  marginHorizontal: 8,
  marginVertical: 2,
} satisfies ViewStyle;

export const selectedThreadRowColors = {
  foregroundClassName: "text-thread-selected-foreground",
  mutedForegroundClassName: "text-thread-selected-foreground-muted",
  iconTintClassName: "accent-thread-selected-foreground",
  mutedIconTintClassName: "accent-thread-selected-foreground-muted",
};

export function getThreadListV2NewBranchMenuTitle(branch: string, resolve: MessageResolver = m) {
  return resolve(msg("New thread on {branch}", { branch }));
}

export function getThreadListV2RowAppearance(
  theme: MobileThemeVariables,
  sidebarPane: boolean,
  selected: boolean,
) {
  const selectedBackgroundColor = theme["--color-thread-selected"];
  const backgroundColor = theme[sidebarPane ? "--color-drawer" : "--color-screen"];
  // The same rounded block on every row: even padding inside, a small gap between, so a
  // pressed or selected row reads as one shape instead of a strip hanging off the next row.
  const style: ViewStyle = {
    backgroundColor: selected ? selectedBackgroundColor : backgroundColor,
    borderRadius: THREAD_LIST_V2_ROW_RADIUS,
  };
  const swipeContainerStyle: ViewStyle = {
    borderRadius: THREAD_LIST_V2_ROW_RADIUS,
    overflow: "hidden",
    marginHorizontal: sidebarPane ? 0 : 8,
    marginVertical: 1,
  };

  return {
    className: undefined,
    interactionClassName: sidebarPane ? "bg-thread-hover" : "bg-row-hover",
    interactionOpacity: selected ? 0 : 1,
    foregroundClassName: sidebarPane ? "text-drawer-foreground" : "text-foreground",
    mutedForegroundClassName: sidebarPane
      ? "text-drawer-foreground-muted"
      : "text-foreground-muted",
    tertiaryForegroundClassName: sidebarPane
      ? "text-drawer-foreground-muted"
      : "text-foreground-tertiary",
    mutedIconTintClassName: sidebarPane
      ? "accent-drawer-foreground-muted"
      : "accent-foreground-muted",
    tertiaryIconTintClassName: sidebarPane
      ? "accent-drawer-foreground-muted"
      : "accent-foreground-tertiary",
    style,
    cardStyle: style,
    swipeContainerStyle,
    swipeBackgroundColor: backgroundColor,
    providerIconSurfaceColor: selected ? selectedBackgroundColor : backgroundColor,
  };
}
