import { useAtomMount } from "@effect/atom-react";
import { asLaunchingThread } from "@ankielcode/client-runtime/state/thread-inbox";
import type { ThreadNavigationBranch } from "@ankielcode/client-runtime/state/threads";
import { ThreadHoverCard, ThreadHoverCardPopup } from "../ThreadHoverCard";
import { formatWorktreePathForDisplay } from "../../worktreeCleanup";
import { contextMenuSourceOf } from "../../contextMenuSource";
import { useSupportsMultiplePullRequests } from "~/hooks/useSupportsMultiplePullRequests";
import { useDraggable } from "@dnd-kit/core";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { resolveThreadActivityTimestamp } from "@ankielcode/client-runtime/state/thread-sort";
import { type EnvironmentThreadSearchMatch } from "@ankielcode/client-runtime/state/thread-search";
import { scopeThreadRef, scopedThreadKey } from "@ankielcode/client-runtime/environment";
import {
  AuthOrchestrationOperateScope,
  type ContextMenuSource,
  type EnvironmentMachineKind,
  type ScopedThreadRef,
} from "@ankielcode/contracts";

import {
  AlarmClockIcon,
  AlarmClockOffIcon,
  ArrowRightLeftIcon,
  CheckIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  FolderGit2Icon,
  GitBranchIcon,
  PinIcon,
  PinOffIcon,
  SquarePenIcon,
  TerminalIcon,
  Undo2Icon,
} from "lucide-react";
import {
  memo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { msg, T, useGT, useMessages, Var } from "gt-react";

import type { MessageResolver } from "../../i18n/messages";

import { useUiStateStore } from "../../uiStateStore";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import { useNowMinute } from "../../hooks/useNowMinute";
import { vcsEnvironment, vcsBranchRevalidation } from "../../state/vcs";
import { useEnvironmentQuery } from "../../state/query";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { formatRelativeTime, parseTimestampDate } from "../../timestampFormat";
import type { SidebarThreadSummary } from "../../types";
import type { EnvironmentProject } from "@ankielcode/client-runtime/state/shell";
import { cn } from "~/lib/utils";
import { textDirection } from "~/textDirection";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import {
  animateSidebarLayoutChanges,
  hasUnseenCompletion,
  resolveSidebarRowAccessibility,
  type SidebarDropVerb,
  type SidebarThreadStatus,
  resolveSidebarRowStatus,
  resolveThreadLastVisitedAt,
  useRetainedValue,
  withoutRemovedCheckout,
  useSidebarRowSubscriptionLease,
  setFileDragActive,
} from "../Sidebar.logic";
import { resolveLocalCheckoutBranchMismatch } from "../BranchToolbar.logic";
import {
  ThreadPullRequestsMiniList,
  terminalStatusFromRunningIds,
  type TerminalStatusIndicator,
  ThreadSearchPullRequestNumber,
} from "../ThreadStatusIndicators";
import { useThreadShell } from "../../state/entities";
import { ProjectFavicon, type ProjectFaviconProject } from "../ProjectFavicon";
import { PixelStatus, type PixelStatusKind } from "../PixelStatus";
import { ThreadSearchMatchExcerpt } from "../ThreadSearchMatch";
import { makeWorkspaceFileDropHandlers } from "../chat/workspaceFileDrop";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { getTriggerDisplayModelName } from "../chat/providerIconUtils";
import { shouldShowInstanceBadge, type ProviderInstanceEntry } from "../../providerInstances";
import { useThreadRunningTerminalIds } from "../../state/terminalSessions";
import { Kbd } from "../ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { MiddleTruncate } from "../ui/middle-truncate";
import { ActivityShimmerOverlay } from "../chat/TimelineRowParts";
import { observeVisibleAnimation } from "~/lib/visibleAnimation";
import { useThreadHasUnsentDraft } from "../../composerDraftStore";

// The fields thread rows show. Provider status pushes refresh `checkedAt`,
// status and auth on every provider; leaving those out keeps each
// environment's map, and every memoized row, stable across them.
export type SidebarProviderEntry = Pick<
  ProviderInstanceEntry,
  | "instanceId"
  | "driverKind"
  | "enabled"
  | "displayName"
  | "accentColor"
  | "acpRegistryAgentId"
  | "acpRegistryIconUrl"
  | "models"
>;
function compactSidebarTimeLabel(timestamp: string, nowMs: number, resolve: MessageResolver) {
  const parts = formatRelativeTime(timestamp, nowMs, resolve);
  if (parts === null) return "";
  return parts.suffix === null ? resolve(msg("now", { $context: "relative time" })) : parts.value;
}

// Subscribes to the minute tick itself, so only the label re-renders each
// minute. The minute is passed as the clock so it is the formatter's input.
function RelativeTimeLabel(props: { timestamp: string | null }) {
  const nowMinute = useNowMinute();
  const m = useMessages();
  return props.timestamp === null
    ? null
    : compactSidebarTimeLabel(props.timestamp, Date.parse(`${nowMinute}:00.000Z`), m);
}

export function JumpHintBadge(props: { label: string }) {
  return (
    <Kbd aria-hidden data-jump-hint>
      {props.label}
    </Kbd>
  );
}

export const JUMP_HINT_SLOT_CLASS_NAME =
  "[&>:not([data-jump-hint])]:invisible [&>:not([data-jump-hint])]:absolute";

function terminalProcessLabel(count: number, resolve: MessageResolver): string {
  return resolve(
    msg(
      "{count, plural, one {{count} terminal process running} other {{count} terminal processes running}}",
      { count },
    ),
  );
}

function SidebarThreadTooltip({
  thread,
  project,
  projectDisplayName,
  environmentLabel,
  environmentMachine,
  providerEntry,
  providerEntryByInstanceId,
  showInstanceBadge,
  modelInstanceId,
  modelLabel,
  branchMismatch,
  terminalStatus,
  terminalProcessCount,
}: {
  thread: SidebarThreadSummary;
  project: ProjectFaviconProject | null;
  projectDisplayName: string | null;
  environmentLabel: string | null;
  environmentMachine: EnvironmentMachineKind;
  providerEntry: SidebarProviderEntry | null;
  providerEntryByInstanceId: ReadonlyMap<string, SidebarProviderEntry>;
  showInstanceBadge: boolean;
  modelInstanceId: string;
  modelLabel: string;
  branchMismatch: {
    threadBranch: string;
    currentBranch: string;
  } | null;
  terminalStatus: TerminalStatusIndicator | null;
  terminalProcessCount: number;
}) {
  const driverKind = providerEntry?.driverKind ?? null;
  const worktreePath = thread.worktreePath?.trim();
  const previousProviderNames = thread.providerInstanceHistory
    .filter((instanceId) => instanceId !== modelInstanceId)
    .map((instanceId) => providerEntryByInstanceId.get(instanceId)?.displayName ?? instanceId);
  const supportsMultiplePullRequests = useSupportsMultiplePullRequests(thread.environmentId);
  const gt = useGT();
  const m = useMessages();
  return (
    <ThreadHoverCardPopup side="right" align="start" sideOffset={4}>
      <ThreadHoverCard
        title={thread.title}
        footer={
          supportsMultiplePullRequests && thread.pullRequests.length > 0 ? (
            <div className="border-t border-border/60 pt-2 pl-0.5 text-xs text-muted-foreground">
              <ThreadPullRequestsMiniList pullRequests={thread.pullRequests} />
            </div>
          ) : null
        }
      >
        {projectDisplayName ? (
          <div className="flex min-w-0 items-center gap-2">
            {project ? <ProjectFavicon project={project} className="size-3 shrink-0" /> : null}
            <div className="min-w-0 truncate text-foreground/75">{projectDisplayName}</div>
          </div>
        ) : null}
        {environmentLabel ? (
          <div className="flex min-w-0 items-center gap-2">
            <EnvironmentMachineIcon
              kind={environmentMachine}
              className="size-3 shrink-0 stroke-muted-foreground"
            />
            <div className="min-w-0 truncate text-foreground/75">{environmentLabel}</div>
          </div>
        ) : null}
        {thread.branch ? (
          <div className="flex min-w-0 items-center gap-2">
            <GitBranchIcon className="size-3 shrink-0 stroke-muted-foreground" />
            <MiddleTruncate value={thread.branch} className="flex" />
          </div>
        ) : null}
        {worktreePath ? (
          <div className="flex min-w-0 items-center gap-2">
            <FolderGit2Icon className="size-3 shrink-0 stroke-muted-foreground" />
            <MiddleTruncate value={formatWorktreePathForDisplay(worktreePath)} className="flex" />
          </div>
        ) : null}
        {branchMismatch ? (
          <div className="flex min-w-0 items-start gap-2">
            <CircleAlertIcon aria-hidden className="mt-0.5 size-3 shrink-0 stroke-warning" />
            <div className="min-w-0 flex-1 wrap-break-word text-foreground/75">
              <T>You're currently checked out on another branch.</T>
            </div>
          </div>
        ) : null}
        {driverKind ? (
          <div className="flex min-w-0 items-center gap-2">
            <ProviderInstanceIcon
              driverKind={driverKind}
              displayName={
                providerEntry?.displayName ?? thread.runtime?.providerName ?? modelInstanceId
              }
              accentColor={providerEntry?.accentColor}
              acpRegistryAgentId={providerEntry?.acpRegistryAgentId}
              acpRegistryIconUrl={providerEntry?.acpRegistryIconUrl}
              showBadge={showInstanceBadge && providerEntry?.accentColor !== undefined}
              badgeContent="none"
              badgeClassName="h-2 min-w-2 px-0"
              iconClassName="size-3 shrink-0 opacity-60"
            />
            <div className="min-w-0 truncate text-foreground/75">
              {showInstanceBadge && providerEntry
                ? `${modelLabel} · ${providerEntry.displayName}`
                : modelLabel}
            </div>
          </div>
        ) : null}
        {previousProviderNames.length > 0 ? (
          <div className="flex min-w-0 items-center gap-2">
            <ArrowRightLeftIcon className="size-3 shrink-0 stroke-muted-foreground" />
            <div className="min-w-0 truncate text-foreground/75">
              <T>
                Handed off from <Var>{previousProviderNames.join(", ")}</Var>
              </T>
            </div>
          </div>
        ) : null}
        {terminalStatus ? (
          <div className="flex min-w-0 items-center gap-2">
            <TerminalIcon
              aria-hidden
              className={cn("size-3 shrink-0", terminalStatus.colorClass)}
            />
            <div className="min-w-0 truncate text-foreground/75">
              {terminalProcessLabel(terminalProcessCount, m)}
            </div>
          </div>
        ) : null}
        {thread.runtime?.lastError ? (
          <div className="flex min-w-0 items-center gap-2">
            <CircleAlertIcon
              className={cn(
                "size-3 shrink-0",
                thread.runtime.lastErrorClass === "usage_limit"
                  ? "stroke-warning"
                  : "stroke-destructive",
              )}
            />
            <div className="min-w-0 truncate text-foreground/75">
              {thread.runtime.lastErrorClass === "usage_limit"
                ? gt("Usage limit reached")
                : gt("Error occurred")}
            </div>
          </div>
        ) : null}
      </ThreadHoverCard>
    </ThreadHoverCardPopup>
  );
}

type SortableThreadRowBag = Pick<
  ReturnType<typeof useSortable>,
  "listeners" | "setNodeRef" | "transform" | "transition" | "isDragging"
>;

export const draftPenClassName = "size-3 shrink-0 text-sidebar-muted-foreground";

// useSortable memoizes on its `disabled` object, so a fresh one per render
// re-renders every row and marker on each sidebar update.
export const SIDEBAR_SORTABLE_DRAG_DISABLED = { draggable: true } as const;
const SIDEBAR_SORTABLE_DRAG_ENABLED = { draggable: false } as const;

// Takes the row's props rather than a render function: a closure from the
// sidebar body is new on every sidebar render, which rebuilt the bag and
// re-rendered every memoized row with it.
type SortableThreadRowProps = Omit<SidebarThreadRowProps, "sortable"> & {
  sortableId: string;
  sortableDisabled: boolean;
  contextDrag: boolean;
};

export function SortableThreadRow(props: SortableThreadRowProps) {
  if (props.branch === undefined) return <DraggableThreadRow {...props} />;
  const { sortableId: _id, sortableDisabled: _disabled, contextDrag: _drag, ...rowProps } = props;
  return <LiveSidebarThreadRow {...rowProps} />;
}

function DraggableThreadRow(props: SortableThreadRowProps) {
  const { sortableId, sortableDisabled, contextDrag, ...rowProps } = props;
  const canOperateThread = useEnvironmentScope(
    rowProps.thread.environmentId,
    AuthOrchestrationOperateScope,
  );
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: sortableId,
    disabled:
      sortableDisabled || !canOperateThread
        ? SIDEBAR_SORTABLE_DRAG_DISABLED
        : SIDEBAR_SORTABLE_DRAG_ENABLED,
    animateLayoutChanges: animateSidebarLayoutChanges,
  });
  // dnd-kit memoizes each field but not the bag, so the memoized row would
  // rerender on every shell update without this.
  const bag = {
    listeners,
    setNodeRef,
    transform: contextDrag ? null : transform,
    transition: contextDrag && isDragging ? "transform 150ms ease-out" : transition,
    isDragging: isDragging && !contextDrag,
  };
  return <LiveSidebarThreadRow {...rowProps} sortable={bag} />;
}

function LiveSidebarThreadRow(props: SidebarThreadRowProps) {
  // The sidebar arranges rows from quiet shells, which hold still while a
  // thread streams; reading the live shell here re-renders only this row.
  const liveThread = useThreadShell(scopeThreadRef(props.thread.environmentId, props.thread.id));
  // A runtime on the arranged copy but not the run-less live shell is the list's launch overlay.
  const thread =
    liveThread === null
      ? props.thread
      : props.thread.runtime !== null
        ? asLaunchingThread(liveThread)
        : liveThread;
  // Keyed by variant so a card/slim switch remounts the row.
  return <SidebarThreadRow key={props.variant} {...props} thread={thread} />;
}
export type SidebarSweepAction = "settle" | "unsettle" | "unsnooze";
const dropVerbBadge: Record<SidebarDropVerb, ReactNode> = {
  pin: (
    <>
      <PinIcon aria-hidden className="size-3" />
      <T>Pin</T>
    </>
  ),
  unpin: (
    <>
      <PinOffIcon aria-hidden className="size-3" />
      <T>Unpin</T>
    </>
  ),
  settle: (
    <>
      <CircleCheckIcon aria-hidden className="size-3" />
      <T>Settle</T>
    </>
  ),
  unsettle: (
    <>
      <Undo2Icon aria-hidden className="size-3" />
      <T>Un-settle</T>
    </>
  ),
  wake: (
    <>
      <AlarmClockOffIcon aria-hidden className="size-3" />
      <T>Wake</T>
    </>
  ),
};

function sidebarPixelStatusKind(
  status: SidebarThreadStatus,
  seen: { isUnread: boolean; isWoke: boolean },
): PixelStatusKind | null {
  switch (status) {
    case "preparing":
    case "working":
      return "working";
    case "waiting":
      return "waiting";
    case "approval":
    case "input":
    case "limited":
      return "attention";
    case "failed":
      return "failed";
    case "ready":
      return seen.isWoke ? "attention" : seen.isUnread ? "done" : null;
  }
}

type SidebarThreadRowProps = {
  thread: SidebarThreadSummary;
  // "folder" sits inside a project folder, which already shows the project icon.
  variant: "slim" | "folder";
  navigationParent?: string | undefined;
  branch?: ThreadNavigationBranch | undefined;
  children?: ReactNode;
  variantAction: SidebarSweepAction;
  settlementSupported: boolean;
  snoozeSupported: boolean;
  sortable?: SortableThreadRowBag | undefined;
  dropVerb: SidebarDropVerb | null;
  dragOverPinned: boolean;
  sweepAction: SidebarSweepAction | null;
  snoozeWakeLabelText: string | null;
  wokeAt: string | null;
  isActive: boolean;
  // Set on the active row only; scrolls it into view when a reveal is owed.
  revealRef?: ((row: HTMLElement, threadKey: string) => (() => void) | undefined) | undefined;
  // Unlike isActive, never true for the ancestor standing in for an open
  // subagent: drafts and PR clicks care about which composer is on screen.
  isRouteThread: boolean;
  jumpLabel: string | null;
  environmentLabel: string | null;
  environmentMachine: EnvironmentMachineKind;
  project: EnvironmentProject | null;
  projectDisplayName: string | null;
  providerEntryByInstanceId: ReadonlyMap<string, SidebarProviderEntry>;
  onThreadClick: (event: ReactMouseEvent, threadRef: ScopedThreadRef) => void;
  onThreadActivate: (threadRef: ScopedThreadRef) => void;
  onStartRename: (threadRef: ScopedThreadRef, title: string) => void;
  onRenameTitleChange: (title: string) => void;
  onCommitRename: (threadRef: ScopedThreadRef, title: string) => void;
  onCancelRename: () => void;
  isRenaming: boolean;
  renamingTitle: string;
  onContextMenu: (
    threadRef: ScopedThreadRef,
    position: { x: number; y: number },
    source: ContextMenuSource,
  ) => void;
  onSettle: (threadRef: ScopedThreadRef) => void;
  onActionSweepStart: (
    threadRef: ScopedThreadRef,
    action: SidebarSweepAction,
    event: PointerEvent,
  ) => void;
  onUnsettle: (threadRef: ScopedThreadRef) => void;
  onUnsnooze: (threadRef: ScopedThreadRef) => void;
  onFileDropThreads?: ((threadRef: ScopedThreadRef, files: File[]) => void) | undefined;
};

// Mounted only while renaming, so each rename starts uncommitted.
function ThreadRenameInput(props: {
  title: string;
  onTitleChange: (title: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  // Enter and Escape blur the input as it unmounts; that blur must not commit again.
  const settledRef = useRef(false);
  const gt = useGT();
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter") {
      event.preventDefault();
      settledRef.current = true;
      props.onCommit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      settledRef.current = true;
      props.onCancel();
    }
  };
  return (
    <input
      autoFocus
      value={props.title}
      dir="auto"
      aria-label={gt("Thread title")}
      onChange={(event) => props.onTitleChange(event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={handleKeyDown}
      onBlur={() => {
        if (!settledRef.current) props.onCommit();
      }}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      className="-mx-1 min-w-0 flex-1 rounded-sm bg-card px-1 text-sm font-medium text-card-foreground outline-none ring-1 ring-inset ring-input focus:ring-foreground"
    />
  );
}

const SidebarThreadRow = memo(function SidebarThreadRow(props: SidebarThreadRowProps) {
  const gt = useGT();
  const messages = useMessages();
  const {
    isRenaming,
    onCancelRename,
    onCommitRename,
    onContextMenu,
    onFileDropThreads,
    onRenameTitleChange,
    onSettle,
    onActionSweepStart,
    onStartRename,
    onThreadActivate,
    onThreadClick,
    onUnsettle,
    onUnsnooze,
    renamingTitle,
    thread,
    variant,
    variantAction,
  } = props;
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const threadKey = scopedThreadKey(threadRef);
  const { leaseLiveStatus, rowRef: leaseRowRef } = useSidebarRowSubscriptionLease(props.isActive);
  const { revealRef } = props;
  const rowRef = (row: HTMLElement | null) => {
    const stopReveal = row === null ? undefined : revealRef?.(row, threadKey);
    const releaseLease = leaseRowRef(row);
    if (!stopReveal) return releaseLease;
    return () => {
      stopReveal();
      releaseLease?.();
    };
  };
  const isRegeneratingTitle = thread.titleRegeneration != null;
  const localLastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[threadKey]);
  const lastVisitedAt = resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt);
  const isSelected = useThreadSelectionStore((state) => state.selectedThreadKeys.has(threadKey));
  const runningTerminalIds = useThreadRunningTerminalIds({
    environmentId: thread.environmentId,
    threadId: thread.id,
  });
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds, messages);
  const terminalProcessCount = runningTerminalIds.length;
  const hasUnsentDraft = useThreadHasUnsentDraft(threadRef) && !props.isRouteThread;

  const gitCwd = thread.worktreePath ?? props.project?.workspaceRoot ?? null;
  const branchTarget =
    leaseLiveStatus && (thread.branch != null || thread.worktreePath !== null) && gitCwd !== null
      ? { environmentId: thread.environmentId, cwd: gitCwd }
      : null;
  const gitStatus = useEnvironmentQuery(
    branchTarget === null
      ? null
      : vcsEnvironment.branch({
          environmentId: branchTarget.environmentId,
          input: { cwd: branchTarget.cwd },
        }),
  );
  useAtomMount(vcsBranchRevalidation(branchTarget));
  const visibleGitStatus = useRetainedValue(
    JSON.stringify([thread.environmentId, gitCwd]),
    gitStatus.data,
  );
  const checkoutThread = withoutRemovedCheckout(thread, visibleGitStatus, props.project);

  const isUnread = hasUnseenCompletion({ ...thread, lastVisitedAt });
  const status = resolveSidebarRowStatus({ ...thread, lastVisitedAt });
  const lastVisitedDate = lastVisitedAt === undefined ? null : parseTimestampDate(lastVisitedAt);
  const wokeAtDate = props.wokeAt === null ? null : parseTimestampDate(props.wokeAt);
  const isWoke =
    wokeAtDate !== null &&
    (lastVisitedDate === null || lastVisitedDate < wokeAtDate) &&
    thread.settledOverride !== "settled";
  const statusLabel =
    status === "preparing"
      ? gt("Setting up")
      : status === "working"
        ? thread.goal?.status === "active"
          ? gt("Goal", { $context: "thread status: working on a goal" })
          : gt("Working", { $context: "thread status" })
        : status === "waiting"
          ? gt("Waiting", { $context: "thread status" })
          : status === "approval"
            ? gt("Approval", { $context: "thread status: needs approval" })
            : status === "input"
              ? gt("Input", { $context: "thread status: needs user input" })
              : status === "limited"
                ? gt("Limited", { $context: "thread status: usage limited" })
                : status === "failed"
                  ? gt("Failed", { $context: "thread status" })
                  : isWoke
                    ? gt("Woke", { $context: "thread status: woke from snooze" })
                    : isUnread
                      ? gt("Done", { $context: "thread status" })
                      : null;
  const pixelKind = sidebarPixelStatusKind(status, { isUnread, isWoke });

  const branchMismatch = resolveLocalCheckoutBranchMismatch({
    effectiveEnvMode: thread.worktreePath === null ? "local" : "worktree",
    activeWorktreePath: thread.worktreePath,
    activeThreadBranch: thread.branch,
    currentGitBranch: visibleGitStatus?.refName ?? null,
  });

  const modelInstanceId = thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
  const providerEntry = props.providerEntryByInstanceId.get(modelInstanceId) ?? null;
  const showInstanceBadge =
    providerEntry !== null &&
    shouldShowInstanceBadge(providerEntry, props.providerEntryByInstanceId.values());
  const selectedModel = providerEntry?.models.find(
    (model) => model.slug === thread.modelSelection.model,
  );
  const modelLabel = selectedModel
    ? getTriggerDisplayModelName(selectedModel, providerEntry?.driverKind)
    : thread.modelSelection.model;

  const detailsTooltip = (
    <SidebarThreadTooltip
      thread={checkoutThread}
      project={props.project}
      projectDisplayName={props.projectDisplayName}
      environmentLabel={props.environmentLabel}
      environmentMachine={props.environmentMachine}
      providerEntry={providerEntry}
      providerEntryByInstanceId={props.providerEntryByInstanceId}
      showInstanceBadge={showInstanceBadge}
      modelInstanceId={modelInstanceId}
      modelLabel={modelLabel}
      branchMismatch={branchMismatch}
      terminalStatus={terminalStatus}
      terminalProcessCount={terminalProcessCount}
    />
  );

  const handleClick = (event: ReactMouseEvent) => {
    onThreadClick(event, threadRef);
  };
  const handleContextMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    onContextMenu(threadRef, { x: event.clientX, y: event.clientY }, contextMenuSourceOf(event));
  };
  const handleKeyDown = (event: ReactKeyboardEvent) => {
    if (event.target !== event.currentTarget) return;
    if (
      event.key === "F2" &&
      !isRenaming &&
      readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)
    ) {
      event.preventDefault();
      onStartRename(threadRef, thread.title);
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onThreadActivate(threadRef);
  };
  const handleDoubleClick = (event: ReactMouseEvent) => {
    if (
      !readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope) ||
      isRenaming ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    if ((event.target as HTMLElement).closest("button, a, input")) return;
    event.preventDefault();
    onStartRename(threadRef, thread.title);
  };
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  const fileDropHandlers = onFileDropThreads
    ? makeWorkspaceFileDropHandlers({
        setDragActive: (active) => setFileDragActive(setIsFileDragOver, active),
        addFiles: (files) => {
          onFileDropThreads(threadRef, files);
        },
        addFolders: () => {},
      })
    : null;
  const handleSettleClick = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onSettle(threadRef);
  };
  const handleActionPointerDown = (event: ReactPointerEvent) => {
    if (!event.isPrimary || event.button !== 0) return;
    event.stopPropagation();
    onActionSweepStart(threadRef, variantAction, event.nativeEvent);
  };
  const handleUnsettleClick = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onUnsettle(threadRef);
  };
  const handleUnsnoozeClick = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onUnsnooze(threadRef);
  };
  const jumpHintLabel = props.jumpLabel;

  const rowSurfaceClassName = cn(
    "group/sidebar-row relative w-full cursor-pointer overflow-hidden rounded-md text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
    variantAction === "unsettle" &&
      !props.isActive &&
      "[&:not(:hover):not(:focus-within)_*:not(.live-activity-focus_*)]:text-secondary-label",
    props.isActive
      ? "bg-sidebar-row-active text-sidebar-foreground light:ring-1 light:ring-inset light:ring-sidebar-border/70"
      : isSelected || props.sweepAction !== null
        ? "bg-sidebar-row-selected text-sidebar-foreground light:ring-1 light:ring-inset light:ring-sidebar-border/70"
        : "bg-transparent text-sidebar-foreground hover:bg-sidebar-row-hover",
    isFileDragOver && "ring-1 ring-inset ring-primary/70",
    isFileDragOver && !props.isActive && !isSelected && "bg-sidebar-row-hover",
    props.sortable?.isDragging &&
      "bg-sidebar bg-linear-to-b from-sidebar-row-active to-sidebar-row-active text-sidebar-foreground opacity-100 shadow-lg",
  );
  const sortable = props.sortable;
  const sortableRootProps = sortable
    ? {
        ref: sortable.setNodeRef,
        style: {
          transform: CSS.Translate.toString(sortable.transform),
          transition: sortable.transition,
          // A zero-height boundary also makes dnd-kit scale the source to
          // zero. Only projected peers use scaleY as a visibility sentinel.
          visibility:
            !sortable.isDragging && sortable.transform?.scaleY === 0
              ? ("hidden" as const)
              : undefined,
        },
      }
    : {};
  const destinationVerb = sortable?.isDragging
    ? props.dropVerb
    : props.sweepAction === "unsnooze"
      ? "wake"
      : props.sweepAction;
  const dragDestination =
    destinationVerb !== null ? (
      <span
        role="status"
        className="pointer-events-none ml-auto inline-flex h-5 shrink-0 items-center gap-1 rounded-sm border border-primary/40 bg-primary/10 px-1.5 text-2xs font-medium text-primary"
      >
        {dropVerbBadge[destinationVerb]}
      </span>
    ) : null;

  const accessibility = resolveSidebarRowAccessibility({
    title: thread.title,
    statusLabel,
    projectDisplayName: props.projectDisplayName,
    isActive: props.isActive,
  });

  const title = isRenaming ? (
    <ThreadRenameInput
      title={renamingTitle}
      onTitleChange={onRenameTitleChange}
      onCommit={() => onCommitRename(threadRef, renamingTitle)}
      onCancel={onCancelRename}
    />
  ) : (
    <span
      ref={isRegeneratingTitle ? observeVisibleAnimation : undefined}
      className={cn(
        "min-w-0 flex-1 text-start text-sm transition-opacity motion-reduce:transition-none",
        "font-medium",
        isRegeneratingTitle
          ? "relative truncate text-muted-foreground"
          : variant !== "slim"
            ? cn(
                "truncate",
                props.isActive
                  ? "text-foreground"
                  : "text-foreground/75 group-hover/sidebar-row:text-foreground group-focus-visible/sidebar-row:text-foreground",
              )
            : cn(
                "truncate group-focus-within/sidebar-row:text-foreground group-hover/sidebar-row:text-foreground",
                props.isActive ? "text-foreground" : "text-secondary-label",
              ),
      )}
      dir={textDirection(thread.title)}
    >
      {thread.title}
      {isRegeneratingTitle ? (
        <ActivityShimmerOverlay className="truncate">{thread.title}</ActivityShimmerOverlay>
      ) : null}
    </span>
  );

  const draftIndicator = hasUnsentDraft ? (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={gt("Unsent draft")}
            data-testid={`sidebar-draft-indicator-${thread.id}`}
            className="inline-flex shrink-0 items-center"
          />
        }
      >
        <SquarePenIcon aria-hidden className={draftPenClassName} />
      </TooltipTrigger>
      <TooltipPopup side="top">
        <T>Unsent draft</T>
      </TooltipPopup>
    </Tooltip>
  ) : null;

  const inFolder = variant === "folder";
  const { branch } = props;
  // Hover actions sit out of flow until shown, so an idle row is only its title.
  const hoverActionClassName =
    "pointer-events-none absolute inset-y-0 right-0 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:static focus-visible:opacity-100 group-any-hover/sidebar-row:pointer-events-auto group-any-hover/sidebar-row:static group-any-hover/sidebar-row:opacity-100";
  const leading =
    pixelKind !== null ? (
      <PixelStatus kind={pixelKind} />
    ) : draftIndicator !== null ? (
      draftIndicator
    ) : branch || inFolder || !props.project ? null : (
      <span
        className={cn(
          "flex items-center transition-opacity",
          (!props.isActive || variantAction === "unsettle") &&
            "opacity-40 grayscale group-focus-within/sidebar-row:opacity-100 group-focus-within/sidebar-row:grayscale-0 group-hover/sidebar-row:opacity-100 group-hover/sidebar-row:grayscale-0",
        )}
      >
        <ProjectFavicon project={props.project} className="size-4" />
      </span>
    );

  return (
    <li
      data-thread-item={branch ? undefined : threadKey}
      style={
        branch
          ? { paddingInlineStart: `calc(var(--spacing) * ${2.5 + branch.depth * 3.5})` }
          : undefined
      }
      {...sortableRootProps}
      {...(!props.children && fileDropHandlers)}
      className={cn(
        "list-none",
        !props.children && "[content-visibility:auto] [contain-intrinsic-size:auto_--spacing(8)]",
        branch && "flex",
        sortable?.isDragging && "relative z-20",
      )}
    >
      <Tooltip disabled={isRenaming || sortable?.isDragging}>
        <TooltipTrigger
          render={
            <div
              ref={rowRef}
              role="button"
              tabIndex={0}
              data-sidebar-row={threadKey}
              data-sidebar-parent={branch?.parentKey ?? props.navigationParent}
              aria-label={accessibility.label}
              aria-current={accessibility.current}
              data-testid={
                branch ? "sidebar-row-child" : inFolder ? "sidebar-row-folder" : "sidebar-row-slim"
              }
              aria-busy={isRegeneratingTitle || undefined}
              className={cn(
                rowSurfaceClassName,
                "flex h-8 items-center gap-2.5 px-2.5",
                branch && "min-w-0",
              )}
              {...sortable?.listeners}
              {...(props.children && fileDropHandlers)}
              onClick={handleClick}
              onDoubleClick={handleDoubleClick}
              onKeyDown={handleKeyDown}
              onContextMenu={handleContextMenu}
            />
          }
        >
          {/* Always held open, so a status coming or going never shifts the title. */}
          <span className="flex size-4 shrink-0 items-center justify-center">{leading}</span>
          {title}
          {isRegeneratingTitle ? (
            <span role="status" className="sr-only">
              <T>Regenerating title</T>
            </span>
          ) : null}
          {sortable?.isDragging ? (
            dragDestination
          ) : (
            <span
              className={cn(
                "relative ml-auto flex h-6 shrink-0 items-center justify-end",
                props.sweepAction !== null && "hidden",
                jumpHintLabel && JUMP_HINT_SLOT_CLASS_NAME,
              )}
            >
              {variantAction === "unsnooze" && props.snoozeWakeLabelText !== null ? (
                <span className="inline-flex items-center gap-1 text-xs text-secondary-label tabular-nums transition-opacity group-any-hover/sidebar-row:opacity-0">
                  {/* The clock tells a wake time from an age at a glance. */}
                  <AlarmClockIcon aria-hidden className="size-3" />
                  {props.snoozeWakeLabelText}
                </span>
              ) : null}
              {variantAction === "unsnooze" ? (
                !props.snoozeSupported ? null : (
                  <button
                    type="button"
                    aria-label={gt("Wake thread now")}
                    onClick={handleUnsnoozeClick}
                    onPointerDown={handleActionPointerDown}
                    className={cn(hoverActionClassName, "-mr-1")}
                  >
                    <AlarmClockOffIcon className="mb-px size-3" />
                  </button>
                )
              ) : !props.settlementSupported ? null : variantAction === "unsettle" ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        aria-label={gt("Un-settle thread")}
                        onClick={handleUnsettleClick}
                        onPointerDown={handleActionPointerDown}
                        className={cn(hoverActionClassName, "-mr-1")}
                      />
                    }
                  >
                    <Undo2Icon className="mb-px size-3.5" />
                  </TooltipTrigger>
                  <TooltipPopup side="top">
                    <T>Un-settle thread</T>
                  </TooltipPopup>
                </Tooltip>
              ) : (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        aria-label={gt("Settle thread")}
                        onClick={handleSettleClick}
                        onPointerDown={handleActionPointerDown}
                        className={cn(hoverActionClassName, "-mr-2 px-2")}
                      />
                    }
                  >
                    <CheckIcon className="size-3" />
                  </TooltipTrigger>
                  <TooltipPopup side="top">
                    <T>Settle thread</T>
                  </TooltipPopup>
                </Tooltip>
              )}
              {jumpHintLabel ? <JumpHintBadge label={jumpHintLabel} /> : null}
            </span>
          )}
          {props.sweepAction !== null ? dragDestination : null}
        </TooltipTrigger>
        {detailsTooltip}
      </Tooltip>
      {props.children}
    </li>
  );
});

// Attached only to the highlighted result, so React calls it each time the
// highlight lands on a different row: a new query, late rows replacing the first
// result, or arrow keys moving past the scrolled edge.
const scrollHighlightedResultIntoView = (node: HTMLLIElement | null) => {
  node?.scrollIntoView({ block: "nearest" });
};

export const SidebarSearchResultRow = memo(function SidebarSearchResultRow(props: {
  isSettled: boolean;
  thread: SidebarThreadSummary;
  project: EnvironmentProject | null;
  projectDisplayName: string | null;
  environmentLabel: string | null;
  environmentMachine: EnvironmentMachineKind;
  providerEntryByInstanceId: ReadonlyMap<string, SidebarProviderEntry>;
  isHighlighted: boolean;
  isRouteActive: boolean;
  resultId: string;
  searchMatch: EnvironmentThreadSearchMatch | null;
  searchQuery: string;
  /** The query `searchMatch` was found for, which lags `searchQuery` while a search runs. */
  searchMatchQuery?: string;
  onHighlight: () => void;
  onSelect: () => void;
  onContextMenu: (
    threadRef: ScopedThreadRef,
    position: { x: number; y: number },
    source: ContextMenuSource,
  ) => void;
  onFileDropThreads: (threadRef: ScopedThreadRef, files: File[]) => void;
}) {
  const messages = useMessages();
  const thread =
    useThreadShell(scopeThreadRef(props.thread.environmentId, props.thread.id)) ?? props.thread;
  const accessibility = resolveSidebarRowAccessibility({
    title: thread.title,
    statusLabel: null,
    projectDisplayName: props.projectDisplayName,
    isActive: props.isRouteActive,
  });
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  // Results only drag out as chat context; the row keeps its own listbox attributes.
  const { listeners: dragListeners, setNodeRef: setDragNodeRef } = useDraggable({
    id: scopedThreadKey(threadRef),
  });
  const { leaseLiveStatus, rowRef: leaseRowRef } = useSidebarRowSubscriptionLease(
    props.isHighlighted || props.isRouteActive,
  );
  const isRegeneratingTitle = thread.titleRegeneration != null;
  const rowRef = (row: HTMLElement | null) => {
    setDragNodeRef(row);
    return leaseRowRef(row);
  };
  const gitCwd = thread.worktreePath ?? props.project?.workspaceRoot ?? null;
  const branchTarget =
    leaseLiveStatus && (thread.branch != null || thread.worktreePath !== null) && gitCwd !== null
      ? { environmentId: thread.environmentId, cwd: gitCwd }
      : null;
  const gitStatus = useEnvironmentQuery(
    branchTarget === null
      ? null
      : vcsEnvironment.branch({
          environmentId: branchTarget.environmentId,
          input: { cwd: branchTarget.cwd },
        }),
  );
  useAtomMount(vcsBranchRevalidation(branchTarget));
  const visibleGitStatus = useRetainedValue(
    JSON.stringify([thread.environmentId, gitCwd]),
    gitStatus.data,
  );
  const checkoutThread = withoutRemovedCheckout(thread, visibleGitStatus, props.project);
  const branchMismatch = resolveLocalCheckoutBranchMismatch({
    effectiveEnvMode: thread.worktreePath === null ? "local" : "worktree",
    activeWorktreePath: thread.worktreePath,
    activeThreadBranch: thread.branch,
    currentGitBranch: visibleGitStatus?.refName ?? null,
  });
  const modelInstanceId = thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
  const providerEntry = props.providerEntryByInstanceId.get(modelInstanceId) ?? null;
  const showInstanceBadge =
    providerEntry !== null &&
    shouldShowInstanceBadge(providerEntry, props.providerEntryByInstanceId.values());
  const selectedModel = providerEntry?.models.find(
    (model) => model.slug === thread.modelSelection.model,
  );
  const modelLabel = selectedModel
    ? getTriggerDisplayModelName(selectedModel, providerEntry?.driverKind)
    : thread.modelSelection.model;
  const runningTerminalIds = useThreadRunningTerminalIds({
    environmentId: thread.environmentId,
    threadId: thread.id,
  });
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds, messages);
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  const onFileDropThreads = props.onFileDropThreads;
  const fileDropHandlers = makeWorkspaceFileDropHandlers({
    setDragActive: (active) => setFileDragActive(setIsFileDragOver, active),
    addFiles: (files) => {
      onFileDropThreads(threadRef, files);
    },
    addFolders: () => {},
  });
  return (
    <li
      ref={props.isHighlighted ? scrollHighlightedResultIntoView : undefined}
      role="presentation"
      className="list-none"
      {...fileDropHandlers}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              ref={rowRef}
              id={props.resultId}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={props.isHighlighted}
              aria-current={accessibility.current}
              aria-describedby={`${props.resultId}-pr`}
              aria-label={accessibility.label}
              {...dragListeners}
              onMouseMove={props.onHighlight}
              // Focus stays in the search box, as for Enter. A focused result would lose focus as
              // the results close, and its recovery scrolls the list away from the opened thread.
              // dnd-kit ignores a prevented press, so the drag listener runs first.
              onPointerDown={(event) => {
                dragListeners?.onPointerDown?.(event);
                event.preventDefault();
              }}
              onClick={props.onSelect}
              onContextMenu={(event) => {
                event.preventDefault();
                props.onContextMenu(
                  threadRef,
                  { x: event.clientX, y: event.clientY },
                  contextMenuSourceOf(event),
                );
              }}
              className={cn(
                "group/sidebar-row group/v2-row flex min-h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1 text-left text-sm outline-none",
                props.isHighlighted || props.isRouteActive
                  ? "bg-sidebar-row-active text-sidebar-foreground"
                  : "text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
                isFileDragOver && "ring-1 ring-inset ring-primary/70",
                isFileDragOver && !props.isRouteActive && "bg-sidebar-row-hover",
              )}
            />
          }
        >
          {props.project ? (
            <ProjectFavicon
              project={props.project}
              className={cn(
                "size-4 shrink-0 transition-opacity",
                props.isSettled &&
                  !props.isRouteActive &&
                  !props.isHighlighted &&
                  "opacity-40 grayscale group-hover/sidebar-row:opacity-100 group-hover/sidebar-row:grayscale-0",
              )}
            />
          ) : null}
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-center gap-2.5">
              <span
                ref={isRegeneratingTitle ? observeVisibleAnimation : undefined}
                className={cn(
                  "min-w-0 flex-1 truncate",
                  props.isSettled ? "font-normal" : "font-medium",
                  isRegeneratingTitle
                    ? "relative text-muted-foreground"
                    : props.isSettled && !props.isHighlighted && !props.isRouteActive
                      ? "text-secondary-label/70 group-hover/sidebar-row:text-foreground"
                      : "text-foreground",
                )}
              >
                {thread.title}
                {isRegeneratingTitle ? (
                  <ActivityShimmerOverlay className="truncate">
                    {thread.title}
                  </ActivityShimmerOverlay>
                ) : null}
              </span>
              <span id={`${props.resultId}-pr`} className="contents">
                <ThreadSearchPullRequestNumber
                  thread={thread}
                  query={props.searchQuery}
                  enabled={leaseLiveStatus}
                  settled={props.isSettled}
                />
              </span>
              <span className="min-w-8 shrink-0 text-right text-xs text-muted-foreground/55 tabular-nums">
                <RelativeTimeLabel timestamp={resolveThreadActivityTimestamp(thread)} />
              </span>
            </span>
            {props.searchMatch ? (
              <ThreadSearchMatchExcerpt
                match={{
                  source: props.searchMatch.source,
                  snippet: props.searchMatch.snippet,
                  query: props.searchMatchQuery ?? props.searchQuery,
                }}
              />
            ) : null}
          </span>
        </TooltipTrigger>
        <SidebarThreadTooltip
          thread={checkoutThread}
          project={props.project}
          projectDisplayName={props.projectDisplayName}
          environmentLabel={props.environmentLabel}
          environmentMachine={props.environmentMachine}
          providerEntry={providerEntry}
          providerEntryByInstanceId={props.providerEntryByInstanceId}
          showInstanceBadge={showInstanceBadge}
          modelInstanceId={modelInstanceId}
          modelLabel={modelLabel}
          branchMismatch={branchMismatch}
          terminalStatus={terminalStatus}
          terminalProcessCount={runningTerminalIds.length}
        />
      </Tooltip>
    </li>
  );
});
