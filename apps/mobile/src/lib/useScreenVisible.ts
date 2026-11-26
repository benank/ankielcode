import { useIsFocused } from "@react-navigation/native";
import { use } from "react";

import { usePaneRole } from "../components/ui/Pane";
import {
  NativePrimaryColumnContext,
  NativeWorkspaceTabActivityContext,
} from "../native/v5-workspace-context";
import { useAppActive } from "./appState";

/**
 * True while the app is active and the owning screen is on screen. Retained routes stay
 * mounted when covered or in a hidden tab, so motion and ticks gate on this.
 */
export function useScreenVisible(): boolean {
  const focused = useIsFocused();
  // The sidebar's route stays unfocused under the page beside it.
  const inSidebar = usePaneRole() === "sidebar";
  // Every iOS workspace tab slot renders the same focused routes; only the selected one shows.
  const tabActive = use(NativeWorkspaceTabActivityContext)?.active ?? true;
  // UIKit reports whether the iOS split's primary column is showing.
  const primaryColumn = use(NativePrimaryColumnContext);
  const appActive = useAppActive();
  const onScreen = primaryColumn ? primaryColumn.presented : focused || inSidebar;
  return appActive && tabActive && onScreen;
}
