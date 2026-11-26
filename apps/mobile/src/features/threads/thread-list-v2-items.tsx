import * as Dialog from "../../components/ui/Dialog";
import type { ThreadRowProviderInstance } from "./thread-provider-instance";
import type { PixelStatusKind } from "@ankielcode/shared/pixelStatus";
import {
  THREAD_LIST_V2_ROW_CONTENT_CLASS_NAME,
  selectedThreadRowColors,
  getThreadListV2NewBranchMenuTitle,
  getThreadListV2RowAppearance,
} from "./thread-list-v2-row-appearance";
import { RowPressable } from "../../components/ui/RowPressable";
import { CustomSnoozeSheet } from "./CustomSnoozeSheet";
import { appAtomRegistry } from "../../state/atom-registry";
import { threadArrangementOpenAtom } from "../../state/thread-order";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import type { ThreadMoveDestination } from "./threadOrder";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@ankielcode/client-runtime/state/shell";
import type { EnvironmentThreadSearchMatch } from "@ankielcode/client-runtime/state/thread-search";
import type { ThreadNavigationBranch } from "@ankielcode/client-runtime/state/threads";
import { AuthOrchestrationOperateScope, type EnvironmentMachineKind } from "@ankielcode/contracts";
import type { SnoozePresetSetting } from "@ankielcode/contracts/settings";
import { canSnooze } from "@ankielcode/client-runtime/state/thread-settled";
import { threadChipCopyTarget } from "@ankielcode/client-runtime/thread-reference";
import type { MenuAction } from "@react-native-menu/menu";
import { msg, T, useGT, useMessages } from "gt-react-native";
import { memo, useCallback, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import { Platform, Pressable, useWindowDimensions, View } from "react-native";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";

import type { ThreadListProvider } from "../../state/thread-list-environments";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";
import { PixelStatus } from "../../components/PixelStatus";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { providerInstanceNameLabel } from "../../components/ProviderIcon";
import { useNowAfter } from "../../lib/clock";
import { cn } from "../../lib/cn";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { copyThreadReference } from "../../lib/copyThreadReference";
import { playSelectionHaptic } from "../../lib/playSelectionHaptic";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { useEnvironmentScope } from "../../state/session";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import {
  resolveThreadPrBadgeAction,
  type ThreadPrPresentation,
} from "../../state/thread-pr-presentation";
import { useThreadPr } from "../../state/use-thread-pr";
import { useSwipeRowDormant } from "../home/swipe-row-activation";
import { ThreadSwipeable } from "../home/thread-swipe-actions";
import { buildThreadTitleRegenerationMenuItems } from "./thread-title-regeneration-menu";
import { canTurnThreadIntoProject, turnThreadIntoProject } from "./turnThreadIntoProject";
import { threadCanArchive } from "../home/threadArchive";
import {
  THREAD_LIST_V2_SETTLED_PAGE_COUNT,
  resolveThreadListV2SnoozeGateExpiryMs,
  resolveThreadListV2SnoozeMenuSelection,
  resolveThreadListV2SnoozePresets,
  threadHasUnseenCompletion,
  resolveThreadListV2RowStatus,
  resolveThreadListV2SwipeActions,
  layoutThreadListV2RowMenuActions,
  threadListV2RowAccessibilityLabel,
  resolveThreadListV2PixelKind,
  type ThreadListV2ProjectFolderListItem,
  type ThreadListV2Status,
} from "./threadListV2";
import { QueuedMessageIcon } from "./queued-message-icon";
import { ThreadSearchMatchExcerpt } from "./thread-search-match";

interface StatusLabel {
  // Null when the pixel light and timer carry the status on their own.
  readonly label: string | null;
}
const STATUS_LABEL_BY_STATUS: Partial<Record<ThreadListV2Status, StatusLabel>> = {
  approval: { label: msg("Approval", { $context: "thread status, waiting for approval" }) },
  input: { label: msg("Input", { $context: "thread status, waiting for user input" }) },
  working: { label: null },
  waiting: { label: null },
  failed: { label: msg("Failed", { $context: "thread status" }) },
  limited: { label: msg("Limited", { $context: "thread status, usage limit reached" }) },
};
const DONE_STATUS_LABEL: StatusLabel = {
  label: msg("Done", { $context: "thread status, turn finished" }),
};

const CARD_MENU_ACTIONS: MenuAction[] = [
  { id: "settle", title: msg("Settle", { $context: "verb, thread action" }), image: "checkmark" },
  {
    id: "delete",
    title: msg("Delete", { $context: "verb, thread action" }),
    image: "trash",
    attributes: { destructive: true },
  },
];

const SLIM_MENU_ACTIONS: MenuAction[] = [
  {
    id: "unsettle",
    title: msg("Un-settle", { $context: "verb, thread action" }),
    image: "arrow.uturn.backward",
  },
  {
    id: "delete",
    title: msg("Delete", { $context: "verb, thread action" }),
    image: "trash",
    attributes: { destructive: true },
  },
];

const SNOOZED_MENU_ACTIONS: MenuAction[] = [
  { id: "unsnooze", title: msg("Wake thread"), image: "clock" },
  {
    id: "delete",
    title: msg("Delete", { $context: "verb, thread action" }),
    image: "trash",
    attributes: { destructive: true },
  },
];

const LEGACY_MENU_ACTIONS: MenuAction[] = [
  {
    id: "archive",
    title: msg("Archive", { $context: "verb, thread action" }),
    image: "archivebox",
  },
  {
    id: "delete",
    title: msg("Delete", { $context: "verb, thread action" }),
    image: "trash",
    attributes: { destructive: true },
  },
];

function ThreadListV2Section(props: {
  readonly label: string;
  readonly pane?: "screen" | "sidebar";
  readonly tone?: "default" | "snoozed";
  readonly disclosure?: {
    readonly expanded: boolean;
    readonly disabled?: boolean;
    readonly onToggle: () => void;
    readonly accessibilityLabel: string;
    readonly accessibilityHint: string;
  };
}) {
  const snoozed = props.tone === "snoozed";
  const sidebarPane = props.pane === "sidebar";
  const className = cn(
    "mb-1.5 mt-4 flex-row items-center gap-2.5",
    props.pane === "sidebar" ? "px-3" : "px-5",
  );
  const content = (
    <>
      <Text
        className={cn(
          "text-xs font-ankiel-medium",
          sidebarPane
            ? "text-drawer-foreground-muted"
            : snoozed
              ? "text-foreground-secondary"
              : "text-foreground-tertiary",
        )}
      >
        {props.label}
      </Text>
      <View
        className={cn(
          "h-px flex-1",
          snoozed ? "bg-primary/20" : sidebarPane ? "bg-drawer-border" : "bg-border",
        )}
      />
      {props.disclosure ? (
        <SymbolView
          name="chevron.down"
          size={10}
          tintColorClassName={
            sidebarPane
              ? "accent-drawer-foreground-muted"
              : snoozed
                ? "accent-icon-muted"
                : "accent-foreground-muted"
          }
          type="monochrome"
          style={{ transform: [{ rotate: props.disclosure.expanded ? "180deg" : "0deg" }] }}
        />
      ) : null}
    </>
  );

  return props.disclosure ? (
    <Pressable
      accessibilityHint={props.disclosure.accessibilityHint}
      accessibilityLabel={props.disclosure.accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{
        disabled: props.disclosure.disabled,
        expanded: props.disclosure.expanded,
      }}
      className={className}
      disabled={props.disclosure.disabled}
      onPress={() => {
        playSelectionHaptic();
        props.disclosure?.onToggle();
      }}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      {content}
    </Pressable>
  ) : (
    <View className={className}>{content}</View>
  );
}

const ThreadListV2SectionDivider = memo(function ThreadListV2SectionDivider(props: {
  readonly label: string;
  readonly pane?: "screen" | "sidebar";
}) {
  return <ThreadListV2Section {...props} />;
});

type ThreadListV2ShelfHeaderProps = {
  readonly count: number;
  readonly disabled?: boolean;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly pane?: "screen" | "sidebar";
};

const SHELF_COPY = {
  working: {
    label: msg("Working", { $context: "thread list section" }),
    count: msg("{count, plural, one {{count} working thread} other {{count} working threads}}"),
    collapse: msg("Collapses the working threads."),
    expand: msg("Expands the working threads."),
  },
  snoozed: {
    label: msg("Snoozed", { $context: "thread list section" }),
    count: msg("{count, plural, one {{count} snoozed thread} other {{count} snoozed threads}}"),
    collapse: msg("Collapses the snoozed threads."),
    expand: msg("Expands the snoozed threads."),
  },
  settled: {
    label: msg("Settled", { $context: "thread list section" }),
    count: msg("{count, plural, one {{count} settled thread} other {{count} settled threads}}"),
    collapse: msg("Collapses the settled threads."),
    expand: msg("Expands the settled threads."),
  },
} as const;

function ThreadListV2ShelfHeader(
  props: ThreadListV2ShelfHeaderProps & { readonly kind: keyof typeof SHELF_COPY },
) {
  const gt = useGT();
  const m = useMessages();
  const copy = SHELF_COPY[props.kind];
  const label = m(copy.label);
  return (
    <ThreadListV2Section
      label={props.expanded ? label : gt("{label} ({count})", { label, count: props.count })}
      pane={props.pane}
      tone={props.kind === "snoozed" ? "snoozed" : "default"}
      disclosure={{
        expanded: props.expanded,
        disabled: props.disabled,
        onToggle: props.onToggle,
        accessibilityLabel: m(copy.count, { count: props.count }),
        accessibilityHint: m(props.expanded ? copy.collapse : copy.expand),
      }}
    />
  );
}

export const ThreadListV2WorkingShelfHeader = memo(function ThreadListV2WorkingShelfHeader(
  props: ThreadListV2ShelfHeaderProps,
) {
  return <ThreadListV2ShelfHeader {...props} kind="working" />;
});

export const ThreadListV2SnoozedShelfHeader = memo(function ThreadListV2SnoozedShelfHeader(
  props: ThreadListV2ShelfHeaderProps,
) {
  return <ThreadListV2ShelfHeader {...props} kind="snoozed" />;
});

export const ThreadListV2SettledShelfHeader = memo(function ThreadListV2SettledShelfHeader(
  props: ThreadListV2ShelfHeaderProps,
) {
  return <ThreadListV2ShelfHeader {...props} kind="settled" />;
});

export const ThreadListV2ShowMoreRow = memo(function ThreadListV2ShowMoreRow(props: {
  readonly pane?: "screen" | "sidebar";
  readonly hiddenCount: number;
  /** Older settled threads are loading, or their last read failed. */
  readonly state?: "loading" | "failed";
  readonly onPress: () => void;
}) {
  const gt = useGT();
  const label =
    props.state === "loading"
      ? gt("Loading", { $context: "older threads are loading" })
      : props.state === "failed"
        ? gt("Could not load older threads. Retry")
        : gt(
            "{count, plural, one {Show more ({count} settled hidden)} other {Show more ({count} settled hidden)}}",
            { count: props.hiddenCount },
          );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        props.state === undefined
          ? gt(
              "{count, plural, one {Show {count} more settled threads} other {Show {count} more settled threads}}",
              {
                count: Math.min(props.hiddenCount, THREAD_LIST_V2_SETTLED_PAGE_COUNT),
              },
            )
          : label
      }
      disabled={props.state === "loading"}
      onPress={() => {
        playSelectionHaptic();
        props.onPress();
      }}
      className="mx-4 mt-2 items-center justify-center rounded-lg border border-dashed border-border py-2.5 ios:min-h-[44px]"
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <Text
        className={
          props.pane === "sidebar"
            ? "text-xs font-ankiel-medium text-drawer-foreground-muted"
            : "text-xs font-ankiel-medium text-foreground-muted"
        }
      >
        {label}
      </Text>
    </Pressable>
  );
});

// The pixel light's slot; the project icon and draft pen share it.
const PIXEL_SLOT_SIZE = 16;

const FOLDER_STATUS_LABEL = {
  attention: msg(", needs you", { $context: "project folder status, read after its name" }),
  failed: msg(", failed", { $context: "project folder status, read after its name" }),
  done: msg(", done", { $context: "project folder status, read after its name" }),
  working: msg(", working", { $context: "project folder status, read after its name" }),
  thinking: msg(", working", { $context: "project folder status, read after its name" }),
  waiting: msg(", working", { $context: "project folder status, read after its name" }),
} satisfies Record<PixelStatusKind, unknown>;

/** A project's folder in the thread list: its icon and name, and a count and light while closed. */
export const ThreadListV2ProjectFolderHeader = memo(
  function ThreadListV2ProjectFolderHeader(props: {
    readonly item: ThreadListV2ProjectFolderListItem;
    readonly project: EnvironmentProject | null;
    readonly pane?: "screen" | "sidebar";
    readonly onToggle: (folderKey: string) => void;
  }) {
    const gt = useGT();
    const m = useMessages();
    const sidebarPane = props.pane === "sidebar";
    const { item } = props;
    const title = props.project?.title ?? gt("Project");
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${title}${item.hiddenStatus ? m(FOLDER_STATUS_LABEL[item.hiddenStatus]) : ""}`}
        accessibilityState={{ expanded: !item.collapsed }}
        onPress={() => {
          playSelectionHaptic();
          props.onToggle(item.folderKey);
        }}
        className={cn(
          "mt-2 min-h-[40px] flex-row items-center gap-2.5 rounded-[10px] px-3",
          !sidebarPane && "mx-2",
        )}
        style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
      >
        <View
          className="items-center justify-center"
          style={{ width: PIXEL_SLOT_SIZE, height: PIXEL_SLOT_SIZE }}
        >
          {props.project ? (
            <ProjectFavicon
              environmentId={item.environmentId}
              faviconPath={props.project.faviconPath}
              projectIcon={props.project.projectIcon}
              size={PIXEL_SLOT_SIZE}
              projectTitle={props.project.title}
              workspaceRoot={props.project.workspaceRoot}
              open={!item.collapsed}
            />
          ) : null}
        </View>
        <Text
          className={cn(
            "flex-1 text-base font-ankiel-medium",
            sidebarPane ? "text-drawer-foreground" : "text-foreground",
          )}
          numberOfLines={1}
        >
          {title}
        </Text>
        {item.collapsed && item.hiddenStatus ? <PixelStatus kind={item.hiddenStatus} /> : null}
        {item.collapsed ? (
          <Text
            className={cn(
              "text-xs tabular-nums",
              sidebarPane ? "text-drawer-foreground-muted" : "text-foreground-tertiary",
            )}
          >
            {item.count}
          </Text>
        ) : null}
        <SymbolView
          name="chevron.down"
          size={10}
          tintColorClassName={
            sidebarPane ? "accent-drawer-foreground-muted" : "accent-foreground-muted"
          }
          type="monochrome"
          style={{ transform: [{ rotate: item.collapsed ? "-90deg" : "0deg" }] }}
        />
      </Pressable>
    );
  },
);

const PENDING_TASK_MENU_ACTIONS: MenuAction[] = [
  {
    id: "delete",
    title: msg("Delete", { $context: "verb, thread action" }),
    image: "trash",
    attributes: { destructive: true },
  },
];

const DRAFT_TASK_MENU_ACTIONS: MenuAction[] = [
  {
    id: "delete",
    title: msg("Discard", { $context: "verb, thread action" }),
    image: "trash",
    attributes: { destructive: true },
  },
];

function ThreadRowMenu({
  children,
  ...props
}: Pick<ComponentProps<typeof Menu>, "accessibilityLabel" | "actions" | "onPressAction"> & {
  readonly children: (highlighted: boolean) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Menu
      {...props}
      shouldOpenOnLongPress
      onOpenMenu={() => setOpen(true)}
      onCloseMenu={() => setOpen(false)}
    >
      {children(open)}
    </Menu>
  );
}

export const ThreadListV2PendingRow = memo(function ThreadListV2PendingRow(props: {
  readonly pendingTask: PendingNewTask;
  readonly selected?: boolean;
  readonly project: EnvironmentProject | null;
  readonly environmentLabel: string | null;
  readonly environmentMachine?: EnvironmentMachineKind;
  readonly pane?: "screen" | "sidebar";
  readonly showPendingDivider: boolean;
  readonly showTrailingDivider?: boolean;
  readonly onSelectPendingTask: (pendingTask: PendingNewTask) => void;
  readonly onDeletePendingTask: (pendingTask: PendingNewTask) => void;
  readonly fullSwipeWidth?: number;
  readonly onSwipeableWillOpen: (methods: SwipeableMethods) => void;
  readonly onSwipeableClose: (methods: SwipeableMethods) => void;
  readonly activationKey?: string;
  readonly simultaneousSwipeGesture?: ComponentProps<typeof ThreadSwipeable>["simultaneousWith"];
}) {
  const { pendingTask, onSelectPendingTask, onDeletePendingTask } = props;
  const { width: windowWidth } = useWindowDimensions();
  const dormant = useSwipeRowDormant(props.activationKey);
  const theme = useUniwindTheme();
  const sidebarPane = props.pane === "sidebar";
  const selected = props.selected ?? false;
  const rowAppearance = getThreadListV2RowAppearance(theme, sidebarPane, selected);
  const gt = useGT();
  const m = useMessages();
  const isDraft = pendingTask.kind === "draft";
  const deleteLabel = isDraft
    ? gt("Discard", { $context: "verb, thread action" })
    : gt("Delete", { $context: "verb, thread action" });
  const handleDelete = useCallback(
    () => onDeletePendingTask(pendingTask),
    [onDeletePendingTask, pendingTask],
  );
  const deleteAction = useMemo(
    () => ({
      accessibilityLabel: isDraft
        ? gt("Discard {title}", { title: pendingTask.title })
        : gt("Delete {title}", { title: pendingTask.title }),
      destructive: true,
      icon: "trash" as const,
      label: deleteLabel,
      onPress: handleDelete,
    }),
    [deleteLabel, gt, handleDelete, isDraft, pendingTask.title],
  );
  const handleMenuAction = useCallback(
    ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) => {
      if (nativeEvent.event === "delete") onDeletePendingTask(pendingTask);
    },
    [onDeletePendingTask, pendingTask],
  );

  const rowContent = (
    <View className="min-h-[40px] flex-row items-center gap-2.5">
      <View
        className="items-center justify-center"
        style={{ width: PIXEL_SLOT_SIZE, height: PIXEL_SLOT_SIZE }}
      >
        <SymbolView
          name={isDraft ? "square.and.pencil" : "clock"}
          size={13}
          tintColorClassName={
            selected
              ? selectedThreadRowColors.iconTintClassName
              : rowAppearance.mutedIconTintClassName
          }
          type="monochrome"
          weight="semibold"
        />
      </View>
      <View className="min-w-0 flex-1">
        <Text
          className={cn(
            "text-base font-ankiel-medium",
            selected
              ? selectedThreadRowColors.foregroundClassName
              : rowAppearance.foregroundClassName,
          )}
          numberOfLines={1}
        >
          {pendingTask.title}
        </Text>
        {!isDraft ? (
          <Text
            className={cn(
              "text-xs",
              selected
                ? selectedThreadRowColors.mutedForegroundClassName
                : rowAppearance.tertiaryForegroundClassName,
            )}
            numberOfLines={1}
          >
            <T>Sends on reconnect</T>
          </Text>
        ) : null}
      </View>
    </View>
  );

  return (
    <>
      {props.showPendingDivider ? (
        <ThreadListV2SectionDivider
          label={gt("Unsent", { $context: "section of tasks not yet sent" })}
          pane={props.pane}
        />
      ) : null}
      <ThreadSwipeable
        dormant={dormant}
        threadKey={pendingTask.key}
        backgroundColor={rowAppearance.swipeBackgroundColor}
        containerStyle={rowAppearance.swipeContainerStyle}
        enableTrackpadSwipe
        fullSwipeAction="primary"
        fullSwipeWidth={props.fullSwipeWidth ?? windowWidth - 32}
        listAnimatesLayout
        onDelete={handleDelete}
        onSwipeableClose={props.onSwipeableClose}
        onSwipeableWillOpen={props.onSwipeableWillOpen}
        primaryAction={deleteAction}
        secondaryAction={null}
        resetKey={pendingTask.key}
        simultaneousWith={props.simultaneousSwipeGesture}
        threadTitle={pendingTask.title}
      >
        {() => (
          <ThreadRowMenu
            key={pendingTask.key}
            actions={(isDraft ? DRAFT_TASK_MENU_ACTIONS : PENDING_TASK_MENU_ACTIONS).map(
              (action) => ({
                ...action,
                title: m(action.title),
              }),
            )}
            onPressAction={handleMenuAction}
          >
            {(highlighted) => (
              <RowPressable
                accessibilityHint={
                  isDraft
                    ? gt("Opens the draft in the new task composer. Swipe left to discard.")
                    : gt(
                        "Sends when the environment reconnects. Opens the task for editing. Swipe left to delete.",
                      )
                }
                accessibilityLabel={pendingTask.title}
                accessibilityRole="button"
                accessibilityState={{ selected: props.selected ?? false }}
                key={pendingTask.key}
                className={rowAppearance.className}
                interactionClassName={rowAppearance.interactionClassName}
                interactionOpacity={rowAppearance.interactionOpacity}
                highlighted={highlighted}
                onPress={() => {
                  playSelectionHaptic();
                  onSelectPendingTask(pendingTask);
                }}
                style={rowAppearance.style}
              >
                <View className={THREAD_LIST_V2_ROW_CONTENT_CLASS_NAME}>{rowContent}</View>
              </RowPressable>
            )}
          </ThreadRowMenu>
        )}
      </ThreadSwipeable>
    </>
  );
});

export const ThreadListV2Row = memo(function ThreadListV2Row(props: {
  readonly thread: EnvironmentThreadShell;
  readonly variant: "card" | "slim";
  readonly branch?: ThreadNavigationBranch | undefined;
  readonly hasQueuedMessages?: boolean;
  readonly snoozed?: boolean;
  readonly pinned?: boolean;
  readonly wokeAt: string | null;
  readonly snoozeWakeLabelText?: string;
  readonly timeLabel: string;
  readonly snoozePresetMinute: string;
  readonly project: EnvironmentProject | null;
  readonly providers: ReadonlyArray<ThreadListProvider> | undefined;
  readonly providerInstance: ThreadRowProviderInstance | null;
  readonly environmentLabel: string | null;
  readonly environmentMachine?: EnvironmentMachineKind;
  readonly pane?: "screen" | "sidebar";
  readonly showTrailingDivider?: boolean;
  readonly selected?: boolean;
  readonly fullSwipeWidth?: number;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  readonly onOpenThreadPullRequests: (
    thread: EnvironmentThreadShell,
    pr: ThreadPrPresentation,
  ) => void;
  readonly onDeleteThread: (thread: EnvironmentThreadShell) => void;
  readonly onNewThreadOnBranch: (thread: EnvironmentThreadShell) => void;
  readonly onRenameThread: (thread: EnvironmentThreadShell) => void;
  readonly onRegenerateThreadTitle: (thread: EnvironmentThreadShell) => void;
  readonly onSettleThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly onSnoozeThread: (thread: EnvironmentThreadShell, snoozedUntil: string) => void;
  readonly onUnsnoozeThread: (thread: EnvironmentThreadShell) => void;
  readonly onUnsettleThread: (thread: EnvironmentThreadShell) => void;
  readonly onArchiveThread: (thread: EnvironmentThreadShell) => void;
  readonly onPinThread: (thread: EnvironmentThreadShell) => void;
  readonly onUnpinThread: (thread: EnvironmentThreadShell) => void;
  readonly onSetThreadAutoSettle: (thread: EnvironmentThreadShell, enabled: boolean) => void;
  readonly settlementSupported: boolean;
  readonly snoozeSupported: boolean;
  readonly snoozePresets: ReadonlyArray<SnoozePresetSetting> | undefined;
  readonly pinningSupported: boolean;
  readonly autoSettleOptOutSupported: boolean;
  readonly titleRegenerationSupported: boolean;
  readonly reorderSupported?: boolean;
  readonly onMoveThread?: (
    thread: EnvironmentThreadShell,
    direction: ThreadMoveDestination,
  ) => void;
  readonly canMoveUp?: boolean;
  readonly canMoveDown?: boolean;
  readonly onSwipeableWillOpen: (methods: SwipeableMethods) => void;
  readonly onSwipeableClose: (methods: SwipeableMethods) => void;
  readonly activationKey?: string;
  readonly searchMatch?: EnvironmentThreadSearchMatch;
  readonly searchQuery?: string;
  readonly inFolder?: boolean;
  readonly simultaneousSwipeGesture?: ComponentProps<typeof ThreadSwipeable>["simultaneousWith"];
}) {
  const { width: windowWidth } = useWindowDimensions();
  const gt = useGT();
  const m = useMessages();
  const {
    thread,
    variant,
    branch,
    onSelectThread,
    onOpenThreadPullRequests,
    onDeleteThread,
    onRenameThread,
    onRegenerateThreadTitle,
    onNewThreadOnBranch,
    onSettleThread,
    onSnoozeThread,
    onUnsnoozeThread,
    onUnsettleThread,
    onArchiveThread,
    onPinThread,
    onUnpinThread,
    onSetThreadAutoSettle,
    onMoveThread,
  } = props;
  const settlementSupported = branch === undefined && props.settlementSupported;
  const snoozeSupported = branch === undefined && props.snoozeSupported;
  const pinningSupported = branch === undefined && props.pinningSupported;
  const autoSettleOptOutSupported = branch === undefined && props.autoSettleOptOutSupported;
  const reorderSupported = branch === undefined && props.reorderSupported === true;
  const snoozedRow = props.snoozed === true;
  const dormant = useSwipeRowDormant(props.activationKey);

  const selectThread = () => {
    playSelectionHaptic();
    onSelectThread(thread);
  };
  const providerIconUrl = useMemo(
    () =>
      props.providers?.find(
        (candidate) =>
          candidate.instanceId ===
          (thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId),
      )?.iconUrl,
    [thread, props.providers],
  );

  const providerInstance = props.providerInstance;
  const providerNameLabel = providerInstance
    ? providerInstanceNameLabel({
        provider: providerInstance.driverKind,
        iconUrl: providerIconUrl,
        displayName: providerInstance.displayName,
        showBadge: providerInstance.showBadge,
      })
    : null;
  const pr = useThreadPr(thread);
  const prBadgeLabel = pr ? resolveThreadPrBadgeAction(pr, m).accessibilityLabel : null;
  const handleOpenPullRequests = useCallback(() => {
    if (pr) {
      playSelectionHaptic();
      onOpenThreadPullRequests(thread, pr);
    }
  }, [onOpenThreadPullRequests, pr, thread]);

  const theme = useUniwindTheme();
  const sidebarPane = props.pane === "sidebar";
  const selected = props.selected === true;
  const rowAppearance = getThreadListV2RowAppearance(theme, sidebarPane, selected);

  const status = resolveThreadListV2RowStatus(thread);
  const isUnread = status === "ready" && threadHasUnseenCompletion(thread);
  const workingLabel = STATUS_LABEL_BY_STATUS[status];
  const showsWoke = status === "ready" && props.wokeAt !== null;
  const statusEntry =
    (status === "working" && workingLabel !== undefined && thread.goal?.status === "active"
      ? {
          ...workingLabel,
          label: msg("Goal", { $context: "thread status, working toward a goal" }),
        }
      : workingLabel) ?? (isUnread ? DONE_STATUS_LABEL : undefined);
  const statusLabel = statusEntry && {
    ...statusEntry,
    label: statusEntry.label === null ? null : m(statusEntry.label),
  };
  const isRegeneratingTitle = thread.titleRegeneration != null;
  // List items keep marked text so they stay the same objects across a language switch.
  const timeLabel = props.timeLabel && m(props.timeLabel);
  const snoozeWakeLabelText =
    props.snoozeWakeLabelText === undefined ? undefined : m(props.snoozeWakeLabelText);
  const rowAccessibilityLabel = threadListV2RowAccessibilityLabel(
    {
      title: thread.title,
      variant,
      woke: showsWoke,
      // Working and waiting rows show only an icon and a duration, so name them for speech.
      statusLabel:
        statusLabel &&
        (statusLabel.label ??
          (status === "waiting"
            ? gt("Waiting", { $context: "thread status" })
            : gt("Working", { $context: "thread status" }))),
      timeLabel,
      snoozeWakeLabel: snoozedRow ? snoozeWakeLabelText : undefined,
      providerNameLabel,
      hasQueuedMessages: props.hasQueuedMessages === true,
      regeneratingTitle: isRegeneratingTitle,
    },
    m,
  );

  const visitThread = useAtomCommand(threadEnvironment.visit, { reportFailure: false });
  const markThreadUnread = useAtomCommand(threadEnvironment.markUnread, { reportFailure: false });
  const handleAcknowledgeWoke = useCallback(() => {
    if (props.wokeAt === null) return;
    void visitThread({
      environmentId: thread.environmentId,
      input: { threadId: thread.id, visitedAt: props.wokeAt },
    });
  }, [props.wokeAt, thread.environmentId, thread.id, visitThread]);
  // VoiceOver cannot focus buttons inside the accessible row.
  const rowAccessibilityActions = useMemo(
    () => [
      ...(prBadgeLabel ? [{ name: "openPullRequests", label: prBadgeLabel }] : []),
      ...(showsWoke ? [{ name: "dismissWoke", label: gt("Dismiss Woke notification") }] : []),
    ],
    [gt, prBadgeLabel, showsWoke],
  );

  const handleDelete = useCallback(() => onDeleteThread(thread), [onDeleteThread, thread]);
  const handleRename = useCallback(() => onRenameThread(thread), [onRenameThread, thread]);
  const canOperateThread = useEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope);
  const handleRegenerateTitle = useCallback(
    () => onRegenerateThreadTitle(thread),
    [onRegenerateThreadTitle, thread],
  );
  const handleSettle = useCallback(() => onSettleThread(thread), [onSettleThread, thread]);
  const [customSnoozeOpen, setCustomSnoozeOpen] = useState(false);
  // Recycling changes identity without remounting; clear local UI directly because equality may skip the render closure.
  const rowIdentity = `${thread.environmentId}:${thread.id}`;
  const [boundIdentity, setBoundIdentity] = useState(rowIdentity);
  if (boundIdentity !== rowIdentity) {
    setBoundIdentity(rowIdentity);
    setCustomSnoozeOpen(false);
  }
  const handleSnooze = useCallback(
    (snoozedUntil: string) => onSnoozeThread(thread, snoozedUntil),
    [onSnoozeThread, thread],
  );
  const handleUnsnooze = useCallback(() => onUnsnoozeThread(thread), [onUnsnoozeThread, thread]);
  const handleUnsettle = useCallback(() => onUnsettleThread(thread), [onUnsettleThread, thread]);
  const handlePin = useCallback(() => onPinThread(thread), [onPinThread, thread]);
  const handleUnpin = useCallback(() => onUnpinThread(thread), [onUnpinThread, thread]);
  const handleSetAutoSettle = useCallback(
    (enabled: boolean) => onSetThreadAutoSettle(thread, enabled),
    [onSetThreadAutoSettle, thread],
  );
  const handleMoveUp = useCallback(() => onMoveThread?.(thread, "up"), [onMoveThread, thread]);
  const handleMoveDown = useCallback(() => onMoveThread?.(thread, "down"), [onMoveThread, thread]);
  const handleArchive = useCallback(() => onArchiveThread(thread), [onArchiveThread, thread]);

  const canUnsettle = variant === "slim";
  // The gate's only time-dependent edge is the queued-turn grace window, so its
  // expiry is known without a clock: evaluate at the message's own timestamp.
  // A gate held by runtime status has no expiry, and no clock tick opens it.
  const snoozeGateExpiryMs = snoozeSupported
    ? resolveThreadListV2SnoozeGateExpiryMs(thread, { now: thread.latestUserMessageAt ?? "" })
    : null;
  // The window is inclusive, so wake just past it.
  const snoozeGateNowMs = useNowAfter(snoozeGateExpiryMs === null ? null : snoozeGateExpiryMs + 1);
  const snoozeGateNow = new Date(snoozeGateNowMs).toISOString();
  const swipeActions = resolveThreadListV2SwipeActions({
    variant,
    settlementSupported,
    snoozeSupported,
    snoozable: canSnooze(thread, { now: snoozeGateNow }),
    snoozed: snoozedRow,
  });
  const snoozePresets = resolveThreadListV2SnoozePresets(
    {
      secondary: swipeActions.secondary,
      now: props.snoozePresetMinute || snoozeGateNow,
      presets: props.snoozePresets,
    },
    m,
  );
  const snoozePresetActions = useMemo<MenuAction[]>(
    () => [
      ...snoozePresets.map((preset) => ({
        id: `snooze:${preset.id}`,
        title: preset.label,
        subtitle: preset.whenLabel,
      })),
      { id: "snooze:custom", title: gt("Custom…", { $context: "custom snooze time" }) },
    ],
    [gt, snoozePresets],
  );
  const reorderMenuItems = useMemo<MenuAction[]>(
    () =>
      reorderSupported
        ? [
            { id: "arrange", title: gt("Arrange threads…"), image: "line.3.horizontal" },
            {
              id: "move-up",
              title: gt("Move up"),
              image: "arrow.up",
              attributes: { disabled: props.canMoveUp !== true },
            } satisfies MenuAction,
            {
              id: "move-down",
              title: gt("Move down"),
              image: "arrow.down",
              attributes: { disabled: props.canMoveDown !== true },
            } satisfies MenuAction,
          ]
        : [],
    [gt, props.canMoveDown, props.canMoveUp, reorderSupported],
  );
  const pinMenuItems = useMemo<MenuAction[]>(
    () =>
      pinningSupported
        ? [
            thread.pinnedAt != null
              ? {
                  id: "unpin",
                  title: gt("Unpin", { $context: "verb, thread action" }),
                  image: "pin.slash",
                }
              : { id: "pin", title: gt("Pin", { $context: "verb, thread action" }), image: "pin" },
          ]
        : [],
    [gt, pinningSupported, thread.pinnedAt],
  );
  const autoSettleMenuItems = useMemo<MenuAction[]>(
    () =>
      autoSettleOptOutSupported
        ? [
            {
              id: "auto-settle",
              title: gt("Auto-settle behavior"),
              image: "timer",
              subactions: [
                {
                  id: "auto-settle:enabled",
                  title: gt("Follow settings"),
                  state: thread.autoSettleDisabledAt == null ? "on" : "off",
                },
                {
                  id: "auto-settle:disabled",
                  title: gt("Never", { $context: "never auto-settle this thread" }),
                  state: thread.autoSettleDisabledAt == null ? "off" : "on",
                },
              ],
            } satisfies MenuAction,
          ]
        : [],
    [gt, autoSettleOptOutSupported, thread.autoSettleDisabledAt],
  );
  const canTurnIntoProject = canTurnThreadIntoProject(thread);
  const titleMenuItems = useMemo<MenuAction[]>(
    () => [
      {
        id: "rename",
        title: gt("Rename", { $context: "verb, thread action" }),
        image: "square.and.pencil",
      },
      ...buildThreadTitleRegenerationMenuItems(
        {
          supported: props.titleRegenerationSupported,
          isRegenerating: isRegeneratingTitle,
        },
        m,
      ),
      ...(thread.latestRun?.completedAt != null && threadCanArchive(thread.runtime)
        ? [{ id: "mark-unread", title: gt("Mark unread"), image: "envelope.badge" }]
        : []),
      ...(canTurnIntoProject
        ? [
            {
              id: "turn-into-project",
              title: gt("Turn into project"),
              image: "folder.badge.plus",
              attributes: { disabled: !threadCanArchive(thread.runtime) },
            } satisfies MenuAction,
          ]
        : []),
    ],
    [
      canTurnIntoProject,
      gt,
      m,
      props.titleRegenerationSupported,
      thread.latestRun,
      thread.runtime,
      isRegeneratingTitle,
    ],
  );
  const menuActions = useMemo<MenuAction[]>(() => {
    const nested = Platform.OS === "ios";
    const localized = (action: MenuAction): MenuAction => ({ ...action, title: m(action.title) });
    const direct: MenuAction[] = [
      ...(thread.branch
        ? [
            {
              id: "new-thread-on-branch",
              title: getThreadListV2NewBranchMenuTitle(thread.branch, m),
              image: "square.and.pencil",
            },
          ]
        : []),
      { id: "copy-thread", title: gt("Copy thread"), image: "text.bubble" },
      { id: "copy-thread-id", title: gt("Copy thread ID"), image: "doc.on.doc" },
    ];
    if (snoozedRow) {
      return layoutThreadListV2RowMenuActions(
        {
          nested,
          direct: [...direct, localized(SNOOZED_MENU_ACTIONS[0]!)],
          reorder: [],
          pin: [],
          secondary: [
            ...titleMenuItems,
            ...autoSettleMenuItems,
            localized(LEGACY_MENU_ACTIONS[0]!),
            localized(SNOOZED_MENU_ACTIONS[1]!),
          ],
        },
        m,
      );
    }
    if (!settlementSupported) {
      return layoutThreadListV2RowMenuActions(
        {
          nested,
          direct: [...direct, localized(LEGACY_MENU_ACTIONS[0]!)],
          reorder: reorderMenuItems,
          pin: pinMenuItems,
          secondary: [...titleMenuItems, localized(LEGACY_MENU_ACTIONS[1]!)],
        },
        m,
      );
    }
    if (canUnsettle) {
      return layoutThreadListV2RowMenuActions(
        {
          nested,
          direct: [...direct, localized(SLIM_MENU_ACTIONS[0]!)],
          reorder: reorderMenuItems.filter(
            (action) => action.id !== "move-up" && action.id !== "move-down",
          ),
          pin: pinMenuItems,
          secondary: [
            ...titleMenuItems,
            ...autoSettleMenuItems,
            localized(LEGACY_MENU_ACTIONS[0]!),
            localized(SLIM_MENU_ACTIONS[1]!),
          ],
        },
        m,
      );
    }
    return layoutThreadListV2RowMenuActions(
      {
        nested,
        direct: [
          ...direct,
          localized(CARD_MENU_ACTIONS[0]!),
          ...(swipeActions.secondary === "snooze"
            ? [
                {
                  id: "snooze",
                  title: gt("Snooze", { $context: "verb, thread action" }),
                  image: "clock",
                  subactions: snoozePresetActions,
                },
              ]
            : []),
        ],
        reorder: reorderMenuItems,
        pin: pinMenuItems,
        secondary: [
          ...titleMenuItems,
          ...autoSettleMenuItems,
          localized(LEGACY_MENU_ACTIONS[0]!),
          localized(CARD_MENU_ACTIONS[1]!),
        ],
      },
      m,
    );
  }, [
    autoSettleMenuItems,
    canUnsettle,
    pinMenuItems,
    settlementSupported,
    reorderMenuItems,
    snoozePresetActions,
    snoozedRow,
    gt,
    m,
    swipeActions.secondary,
    thread.branch,
    titleMenuItems,
  ]);
  const handleMenuAction = useCallback(
    ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) => {
      if (nativeEvent.event === "new-thread-on-branch") onNewThreadOnBranch(thread);
      if (nativeEvent.event === "settle") handleSettle();
      if (nativeEvent.event === "unsettle") handleUnsettle();
      if (nativeEvent.event === "unsnooze") handleUnsnooze();
      if (nativeEvent.event === "pin") handlePin();
      if (nativeEvent.event === "unpin") handleUnpin();
      if (nativeEvent.event === "auto-settle:enabled") handleSetAutoSettle(true);
      if (nativeEvent.event === "auto-settle:disabled") handleSetAutoSettle(false);
      if (nativeEvent.event === "arrange") appAtomRegistry.set(threadArrangementOpenAtom, true);
      if (nativeEvent.event === "move-up") handleMoveUp();
      if (nativeEvent.event === "move-down") handleMoveDown();
      if (nativeEvent.event === "archive") handleArchive();
      if (nativeEvent.event === "rename") handleRename();
      if (nativeEvent.event === "regenerate-title") handleRegenerateTitle();
      if (nativeEvent.event === "turn-into-project") void turnThreadIntoProject(thread);
      if (nativeEvent.event === "mark-unread") {
        void markThreadUnread({
          environmentId: thread.environmentId,
          input: { threadId: thread.id },
        });
      }
      if (nativeEvent.event === "copy-thread") {
        const target = threadChipCopyTarget(
          { environmentId: thread.environmentId, threadId: thread.id },
          thread.title,
          m,
        );
        void copyThreadReference(target).then((didCopy) => {
          if (!didCopy) Dialog.alert(target.failureTitle, gt("Try copying this thread again."));
        });
      }
      if (nativeEvent.event === "copy-thread-id") {
        copyTextWithHaptic(thread.id, { target: "thread-id" });
      }
      if (nativeEvent.event === "delete") handleDelete();
      if (nativeEvent.event === "snooze:custom") {
        setCustomSnoozeOpen(true);
        return;
      }
      const snoozeSelection = resolveThreadListV2SnoozeMenuSelection({
        event: nativeEvent.event,
        displayedPresets: snoozePresets,
        now: new Date(),
        presets: props.snoozePresets,
      });
      if (snoozeSelection._tag === "selected") {
        handleSnooze(snoozeSelection.preset.snoozedUntil);
      } else if (snoozeSelection._tag === "expired") {
        Dialog.alert(
          gt("Could not snooze thread"),
          gt("That snooze time has passed. Choose another time."),
        );
      }
    },
    [
      gt,
      m,
      onNewThreadOnBranch,
      thread,
      handleArchive,
      handleDelete,
      handleRegenerateTitle,
      handleRename,
      handleMoveDown,
      handleMoveUp,
      handlePin,
      handleSettle,
      handleSnooze,
      handleSetAutoSettle,
      handleUnpin,
      handleUnsettle,
      handleUnsnooze,
      markThreadUnread,
      setCustomSnoozeOpen,
      snoozePresets,
      props.snoozePresets,
    ],
  );
  const primaryAction = useMemo(() => {
    if (swipeActions.primary === "archive") {
      return {
        accessibilityLabel: gt("Archive {title}", { title: thread.title }),
        icon: "archivebox" as const,
        label: gt("Archive", { $context: "verb, thread action" }),
        swipeHint: gt("Opens the thread. Swipe left to archive."),
        swipeSnoozeHint: gt("Opens the thread. Swipe left for archive and snooze actions."),
        onPress: handleArchive,
      };
    }
    if (swipeActions.primary === "unsnooze") {
      return {
        accessibilityLabel: gt("Wake {title} now", { title: thread.title }),
        icon: "clock" as const,
        label: gt("Wake", { $context: "verb, thread action" }),
        swipeHint: gt("Opens the thread. Swipe left to wake."),
        swipeSnoozeHint: gt("Opens the thread. Swipe left for wake and snooze actions."),
        onPress: handleUnsnooze,
      };
    }
    return swipeActions.primary === "unsettle"
      ? {
          accessibilityLabel: gt("Un-settle {title}", { title: thread.title }),
          icon: "arrow.uturn.backward" as const,
          label: gt("Un-settle", { $context: "verb, thread action" }),
          swipeHint: gt("Opens the thread. Swipe left to un-settle."),
          swipeSnoozeHint: gt("Opens the thread. Swipe left for un-settle and snooze actions."),
          onPress: handleUnsettle,
        }
      : {
          accessibilityLabel: gt("Settle {title}", { title: thread.title }),
          icon: "checkmark" as const,
          label: gt("Settle", { $context: "verb, thread action" }),
          swipeHint: gt("Opens the thread. Swipe left to settle."),
          swipeSnoozeHint: gt("Opens the thread. Swipe left for settle and snooze actions."),
          onPress: handleSettle,
        };
  }, [
    gt,
    handleArchive,
    handleSettle,
    handleUnsettle,
    handleUnsnooze,
    swipeActions.primary,
    thread.title,
  ]);
  const secondaryAction = useMemo(
    () =>
      swipeActions.secondary === "snooze"
        ? {
            accessibilityLabel: gt("Choose when to snooze {title}", { title: thread.title }),
            icon: "clock" as const,
            label: gt("Snooze", { $context: "verb, thread action" }),
            menu: {
              actions: snoozePresetActions,
              onPressAction: handleMenuAction,
              title: gt("Snooze until"),
            },
            onPress: () => undefined,
          }
        : null,
    [gt, handleMenuAction, snoozePresetActions, swipeActions.secondary, thread.title],
  );
  const swipeAccessibilityHint = !canOperateThread
    ? gt("Opens the thread")
    : secondaryAction === null
      ? primaryAction.swipeHint
      : primaryAction.swipeSnoozeHint;

  const pixelKind = resolveThreadListV2PixelKind(thread, showsWoke ? props.wokeAt : null);
  // Folder rows and sub-threads sit under their project, so only loose rows name it.
  const showProjectIcon = props.project !== null && !props.inFolder && branch === undefined;
  const leading =
    pixelKind !== null ? (
      <PixelStatus kind={pixelKind} />
    ) : showProjectIcon && props.project ? (
      <View className="opacity-45">
        <ProjectFavicon
          environmentId={thread.environmentId}
          faviconPath={props.project.faviconPath}
          projectIcon={props.project.projectIcon}
          size={PIXEL_SLOT_SIZE}
          projectTitle={props.project.title}
          workspaceRoot={props.project.workspaceRoot}
        />
      </View>
    ) : null;

  const rowContent = (close: () => void, highlighted = false) => (
    <RowPressable
      key={`${thread.environmentId}:${thread.id}`}
      highlighted={highlighted}
      interactionClassName={rowAppearance.interactionClassName}
      interactionOpacity={rowAppearance.interactionOpacity}
      className={rowAppearance.className}
      accessibilityHint={swipeAccessibilityHint}
      accessibilityLabel={rowAccessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityActions={rowAccessibilityActions}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === "openPullRequests") handleOpenPullRequests();
        if (event.nativeEvent.actionName === "dismissWoke") handleAcknowledgeWoke();
      }}
      onPress={() => {
        close();
        selectThread();
      }}
      style={rowAppearance.style}
    >
      <View
        className={cn(
          THREAD_LIST_V2_ROW_CONTENT_CLASS_NAME,
          "min-h-[40px] flex-row items-center gap-2.5",
        )}
      >
        {/* Always held open, so a light coming or going never shifts the title. */}
        <View
          className="items-center justify-center"
          style={{ width: PIXEL_SLOT_SIZE, height: PIXEL_SLOT_SIZE }}
        >
          {leading}
        </View>
        <View className="min-w-0 flex-1">
          <Text
            className={cn(
              "text-base",
              variant === "card" && "font-ankiel-medium",
              selected
                ? selectedThreadRowColors.foregroundClassName
                : variant === "slim"
                  ? rowAppearance.mutedForegroundClassName
                  : rowAppearance.foregroundClassName,
              isRegeneratingTitle && "opacity-55",
            )}
            numberOfLines={1}
          >
            {thread.title}
          </Text>
          {props.searchMatch ? (
            <ThreadSearchMatchExcerpt
              sidebar={sidebarPane}
              match={props.searchMatch}
              query={props.searchQuery ?? ""}
              selected={selected}
            />
          ) : null}
        </View>
        {props.hasQueuedMessages ? <QueuedMessageIcon selected={selected} /> : null}
        {snoozedRow && snoozeWakeLabelText !== undefined ? (
          <Text
            className={cn(
              "text-xs tabular-nums",
              selected
                ? selectedThreadRowColors.mutedForegroundClassName
                : rowAppearance.tertiaryForegroundClassName,
            )}
          >
            {snoozeWakeLabelText}
          </Text>
        ) : null}
      </View>
    </RowPressable>
  );

  const branchInset = branch === undefined ? 0 : 10 + (branch.ancestorGuides.length + 1) * 14;
  const row = canOperateThread ? (
    <View collapsable={false}>
      {customSnoozeOpen && (
        <CustomSnoozeSheet onClose={() => setCustomSnoozeOpen(false)} onSnooze={handleSnooze} />
      )}
      <ThreadSwipeable
        dormant={dormant}
        threadKey={`${thread.environmentId}:${thread.id}`}
        backgroundColor={rowAppearance.swipeBackgroundColor}
        compactActions={variant === "slim"}
        containerStyle={rowAppearance.swipeContainerStyle}
        enableTrackpadSwipe
        fullSwipeAction="primary"
        fullSwipeWidth={(props.fullSwipeWidth ?? windowWidth - 32) - branchInset}
        listAnimatesLayout
        onDelete={handleDelete}
        onSwipeableClose={props.onSwipeableClose}
        onSwipeableWillOpen={props.onSwipeableWillOpen}
        primaryAction={primaryAction}
        secondaryAction={secondaryAction}
        resetKey={`${thread.environmentId}:${thread.id}:${variant}:${snoozedRow}:${thread.settledAt}:${thread.unsettledAt}:${thread.snoozedUntil}:${thread.pinnedAt}`}
        simultaneousWith={props.simultaneousSwipeGesture}
        threadTitle={thread.title}
      >
        {(close) => (
          <ThreadRowMenu
            key={`${thread.environmentId}:${thread.id}`}
            accessibilityLabel={rowAccessibilityLabel}
            actions={menuActions}
            onPressAction={handleMenuAction}
          >
            {(highlighted) => rowContent(close, highlighted)}
          </ThreadRowMenu>
        )}
      </ThreadSwipeable>
    </View>
  ) : (
    <View style={rowAppearance.swipeContainerStyle}>{rowContent(() => {})}</View>
  );
  if (branch === undefined) return row;
  return (
    <View className="flex-row ps-2.5">
      <View accessible={false} pointerEvents="none" className="flex-row self-stretch">
        {branch.ancestorGuides.map(({ key, continues }) => (
          <View key={key} className={cn("w-3.5", continues && "border-s border-foreground/30")} />
        ))}
        <View className={cn("w-3.5", branch.hasNextSibling && "border-s border-foreground/30")}>
          <View
            className={cn(
              "h-1/2 border-b border-foreground/30",
              !branch.hasNextSibling && "border-s",
            )}
          />
        </View>
      </View>
      <View className="min-w-0 flex-1">{row}</View>
    </View>
  );
});
