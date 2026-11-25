import { useGT, useMessages } from "gt-react-native";

import { AppBar } from "../../components/ui/AppBar";
import type { AppBarMenu, AppBarMenuItem } from "../../components/ui/AppBar.types";
import {
  useAdaptiveWorkspaceLayout,
  useWorkspacePaneState,
} from "../layout/AdaptiveWorkspaceLayout";
import type { ThreadInspectorMode } from "./thread-inspector-navigation";
import { useWorkspaceBackNavigation } from "../layout/workspace/useAndroidWorkspaceNavigation";
import {
  threadTerminalMenu,
  useThreadGitMenuDefinition,
  type ThreadGitControlsProps,
} from "./ThreadGitControls";
import { useHeaderUsageLimitsControl } from "../usage/useHeaderUsageLimitsControl";

export function ThreadHeader(props: {
  readonly title: string;
  readonly subtitle: string;
  readonly gitControls: ThreadGitControlsProps;
  readonly onReturnToThread?: () => void;
  readonly draft?: boolean;
  readonly hasThreadCwd: boolean;
  readonly inspectorMode: ThreadInspectorMode | null;
  readonly onOpenFilesInspector: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const goBack = useWorkspaceBackNavigation();
  const { toggleAuxiliaryPane, startNewTask } = useAdaptiveWorkspaceLayout();
  const { panes } = useWorkspacePaneState();
  const gitMenu = useThreadGitMenuDefinition(props.gitControls);
  const terminalMenu = threadTerminalMenu(props.gitControls, m);
  const usageControl = useHeaderUsageLimitsControl();
  const filesVisible = props.inspectorMode === "files" && panes.auxiliaryPaneVisible;

  const menuItems: AppBarMenuItem[] = [];
  if (props.hasThreadCwd) {
    menuItems.push({
      id: "files",
      title: filesVisible ? gt("Close files") : gt("Open files"),
      icon: "folder",
      selected: filesVisible,
      disabled: !props.gitControls.canOpenFiles,
      onPress: filesVisible ? toggleAuxiliaryPane : props.onOpenFilesInspector,
    });
  }
  if (gitMenu !== null) {
    menuItems.push({
      id: "git-menu",
      title: gitMenu.title,
      icon: typeof gitMenu.icon === "string" ? gitMenu.icon : gitMenu.icon.ios,
      items: gitMenu.items,
    });
  }
  if (terminalMenu !== null) {
    menuItems.push({
      id: "terminal-menu",
      title: terminalMenu.title,
      icon: typeof terminalMenu.icon === "string" ? terminalMenu.icon : terminalMenu.icon.ios,
      items: terminalMenu.items,
    });
  }
  const menus: AppBarMenu[] =
    menuItems.length > 0
      ? [
          {
            title: gt("More actions"),
            icon: "ellipsis",
            separateBackground: false,
            items: menuItems,
          },
        ]
      : [];

  return (
    <AppBar
      title={props.title}
      subtitle={props.subtitle}
      onBackToList={goBack}
      onCompose={props.draft ? undefined : startNewTask}
      backInSplitView={
        props.onReturnToThread
          ? {
              accessibilityLabel: gt("Return to chat"),
              icon: "chevron.left",
              onPress: props.onReturnToThread,
            }
          : undefined
      }
      actions={usageControl.action ? [usageControl.action] : undefined}
      menus={menus}
      trailing={usageControl.trailing}
      hideBottomBorder
    />
  );
}
