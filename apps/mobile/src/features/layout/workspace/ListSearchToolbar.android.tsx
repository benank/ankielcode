import { useNavigation } from "@react-navigation/native";
import { useGT } from "gt-react-native";
import { useEffect } from "react";
import { BackHandler, Keyboard } from "react-native";
import { AppBar } from "../../../components/ui/AppBar";
import { appBarMenuItemsFromActions } from "../../../components/ui/menuActionItems";
import { useHardwareKeyboardCommand } from "../../keyboard/hardwareKeyboardCommands";
import { WorkspaceConnectionTitle } from "../../home/WorkspaceConnectionTitle";
import { IssuesListTitle } from "./IssuesListTitle";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";
import type { PullRequestFilterMenu } from "../../pull-requests/PullRequestListFilters";
import { openSettings } from "../../settings/settings-navigation";

/** Issue search shares the thread list's Android header. */
export function ListSearchToolbar(props: {
  readonly filters?: PullRequestFilterMenu | null;
  readonly onRequestVisibility?: () => void;
}) {
  const gt = useGT();
  const navigation = useNavigation();
  const { filters } = props;
  const section = "issues";
  const workspace = useWorkspaceTabs()!;
  const { dispatch, getScrollOffset, recordScrollOffset, isTabActive } = workspace;
  const { onRequestVisibility } = props;
  const tab = workspace.state.tabs[section];
  const searching = tab.searchMode !== "resting";
  const openSearch = () => {
    onRequestVisibility?.();
    dispatch({
      type: "scroll",
      tab: section,
      offset: getScrollOffset(section),
    });
    dispatch({ type: "search", tab: section });
    return true;
  };
  useHardwareKeyboardCommand("focusSearch", openSearch);
  const closeSearch = () => {
    Keyboard.dismiss();
    recordScrollOffset(section, tab.searchEntryOffset);
    dispatch({ type: "cancel", tab: section });
  };
  // oxlint-disable-next-line ankielcode/no-unreasoned-state-sync -- subscribes to BackHandler while searching to close the list search on Android back
  useEffect(() => {
    if (!searching) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      // Frozen Home screens stay mounted under a detail route or another tab,
      // so back only applies while this list is in front.
      const state = navigation.getState();
      if (!state || state.routes[state.index]?.name !== "Home" || !isTabActive(section))
        return false;
      if (Keyboard.isVisible()) Keyboard.dismiss();
      else closeSearch();
      return true;
    });
    return () => subscription.remove();
  }, [searching, closeSearch, navigation, isTabActive, section]);
  return (
    <AppBar
      title="Ankiel Code"
      titleContent={
        <WorkspaceConnectionTitle
          grow
          onPress={() => openSettings(navigation, "SettingsEnvironments")}
          brand={<IssuesListTitle />}
        />
      }
      search={{
        value: tab.query,
        onChangeText: (query) => dispatch({ type: "query", tab: section, query }),
        placeholder: gt("Search issues"),
        active: searching,
        onOpen: openSearch,
        onClose: closeSearch,
      }}
      menus={
        filters
          ? [
              {
                title: gt("Filter issues"),
                icon: filters.customized
                  ? "line.3.horizontal.decrease.circle.fill"
                  : "line.3.horizontal.decrease.circle",
                items: appBarMenuItemsFromActions(filters.actions, filters.onSelect),
              },
            ]
          : undefined
      }
    />
  );
}
