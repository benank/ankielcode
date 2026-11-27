import { msg } from "gt-react";
import { m } from "../i18n/messages";
import {
  type EnvironmentThreadShell,
  type PendingSubagentRequest,
  presentThreadShell,
} from "@ankielcode/client-runtime/state/models";
import { isShownUnderParent } from "@ankielcode/client-runtime/state/threads";
import type { AnyRouter } from "@tanstack/react-router";
import { parseThreadKey, threadKey } from "@ankielcode/client-runtime/state/entities";
import {
  type DesktopBridge,
  type DesktopNotificationEvent,
  type DesktopNotificationInput,
  type EnvironmentId,
  type OrchestrationV2ThreadShell,
  RuntimeRequestId,
  type ThreadId,
} from "@ankielcode/contracts";
import type { AgentNotificationButtons } from "@ankielcode/shared/agentNotificationButtons";
import { monitorHoldsWakeCompletion } from "@ankielcode/shared/orchestrationV2PendingBackgroundWork";
import type { ClientSettings } from "@ankielcode/contracts/settings";
import * as Option from "effect/Option";
import type { AtomRegistry } from "effect/reactivity";
import { PixelStatus } from "./PixelStatus";

import { getClientSettings, subscribeClientSettings } from "../hooks/useSettings";
import { isWindowsPlatform } from "../lib/utils";
import { environmentSummaries } from "../state/presentation";
import { environmentShell } from "../state/shell";
import { environmentThreadShells } from "../state/threads";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
  setNotificationBadge,
  threadNotificationTag,
  unlockNotificationAudio,
} from "../threadNotifications";
import { resolveBackgroundThreadRequest } from "./backgroundThreadAnnouncement";
import { answerFromNotification, resolveNotificationButtons } from "./notificationActionRunner";
import { resolveSidebarThreadStatus, type SidebarThreadStatus } from "./Sidebar.logic";
import {
  createThreadNotificationGate,
  isSnoozedForNotification,
  type ThreadNotificationKind,
  type ThreadNotificationObservation,
} from "./ThreadNotificationCoordinator.logic";
import { toastManager } from "./ui/toast";

interface NotificationState extends ThreadNotificationObservation {
  readonly raw: OrchestrationV2ThreadShell;
  readonly subagentRequest: PendingSubagentRequest | null;
  readonly thread: EnvironmentThreadShell;
  readonly status: SidebarThreadStatus;
}

type ToastId = ReturnType<typeof toastManager.add>;

interface WatchedEnvironment {
  unsubscribe: () => void;
  previous: Map<ThreadId, NotificationState>;
  reconnecting: boolean;
  readonly gate: ReturnType<typeof createThreadNotificationGate<ThreadId>>;
}

/** An OS notification on screen, by its per-thread tag. */
interface ShownNotification {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** The attention it announced, which closes it once the thread moves on; null for a completion. */
  readonly attention: string | null;
  /** The thread's own request its buttons answer. */
  readonly requestId: string | null;
  readonly kind: ThreadNotificationKind;
  readonly status: SidebarThreadStatus;
  readonly title: string;
  readonly body: string;
  readonly close: () => void;
}

const needsYou = (status: SidebarThreadStatus) => status === "approval" || status === "input";

function desktopButtons(
  buttons: AgentNotificationButtons | null,
): DesktopNotificationInput["buttons"] {
  if (buttons === "approval") {
    return {
      type: "approval",
      approve: m(msg("Approve", { $context: "verb, notification button" })),
      deny: m(msg("Deny", { $context: "verb, notification button" })),
    };
  }
  return buttons === "reply" ? { type: "reply", placeholder: m(msg("Type your answer")) } : null;
}

/**
 * Turns thread status transitions in every connected environment into in-app toasts and OS
 * notifications, with a sound for whichever shows, and keeps the dock badge counting the
 * threads that need you. The desktop app shows OS notifications from its main process, so
 * approvals and questions can carry buttons.
 */
export function startThreadNotifications(
  registry: AtomRegistry.AtomRegistry,
  router: AnyRouter,
): () => void {
  const pending = new Map<string, ShownNotification>();
  // Presentations still looking up buttons, so a slower lookup never shows over a newer alert.
  const presentations = new Map<string, number>();
  let presentationSequence = 0;
  const watched = new Map<EnvironmentId, WatchedEnvironment>();
  let badgeCount = -1;

  const closePending = (tag: string) => {
    pending.get(tag)?.close();
    pending.delete(tag);
  };
  // Toast ids by thread key, so hiding or opening a thread, or removing its environment, closes them.
  const openToasts = new Map<string, Array<ToastId>>();
  const forgetToast = (key: string, toastId: ToastId) => {
    const remaining = (openToasts.get(key) ?? []).filter((id) => id !== toastId);
    if (remaining.length === 0) openToasts.delete(key);
    else openToasts.set(key, remaining);
  };
  const closeToasts = (shouldClose: (key: string) => boolean) => {
    for (const [key, toastIds] of openToasts) {
      if (!shouldClose(key)) continue;
      for (const toastId of toastIds) toastManager.close(toastId);
      openToasts.delete(key);
    }
  };
  const activeThread = () =>
    (router.state.matches.at(-1)?.params ?? {}) as {
      environmentId?: EnvironmentId;
      threadId?: ThreadId;
    };
  const closeOpenedThreadToasts = () => {
    const { environmentId, threadId } = activeThread();
    if (environmentId === undefined || threadId === undefined) return;
    const opened = threadKey({ environmentId, threadId });
    closeToasts((key) => key === opened);
    closePending(threadNotificationTag(environmentId, threadId));
  };
  const updateBadge = () => {
    let count = 0;
    if (hasDesktopNotifications(getClientSettings().notificationMode)) {
      const hidden = registry.get(environmentThreadShells.hiddenThreadKeysAtom);
      const now = Date.now();
      for (const [environmentId, entry] of watched) {
        for (const { thread, status } of entry.previous.values()) {
          if (
            needsYou(status) &&
            thread.archivedAt === null &&
            !hidden.has(threadKey({ environmentId, threadId: thread.id })) &&
            !isSnoozedForNotification(thread, null, now)
          ) {
            count += 1;
          }
        }
      }
    }
    if (count === badgeCount) return;
    badgeCount = count;
    setNotificationBadge(count);
  };
  // A notification shown before the tag filter turned on must not stay on screen. While hiding,
  // one whose thread left the live list (archived) cannot be judged, so it closes too.
  const closeHiddenPending = () => {
    const hidden = registry.get(environmentThreadShells.hiddenThreadKeysAtom);
    const live = registry.get(environmentThreadShells.anyEnvironmentHidingAtom)
      ? new Set(registry.get(environmentThreadShells.threadRefsAtom).map(threadKey))
      : null;
    const shouldClose = (key: string) => hidden.has(key) || (live !== null && !live.has(key));
    closeToasts(shouldClose);
    for (const [tag, entry] of pending) {
      if (shouldClose(threadKey(entry))) closePending(tag);
    }
    updateBadge();
  };
  const clearPending = () => {
    for (const tag of pending.keys()) closePending(tag);
    presentations.clear();
  };

  const playSound = (kind: ThreadNotificationKind) => {
    if (!hasNotificationSound(getClientSettings().notificationMode)) return;
    void playNotificationSound(kind, () =>
      hasNotificationSound(getClientSettings().notificationMode),
    );
  };
  const openThread = (environmentId: EnvironmentId, threadId: ThreadId) => {
    window.focus();
    void window.desktopBridge?.revealWindow().catch(() => undefined);
    void router.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId },
    });
  };
  const showToast = (
    environmentId: EnvironmentId,
    input: Pick<ShownNotification, "threadId" | "kind" | "status" | "title" | "body">,
    options: { readonly persistent: boolean },
  ) => {
    const { threadId, kind, status } = input;
    const toastKey = threadKey({ environmentId, threadId });
    const toastId: ToastId = toastManager.add({
      onRemove: (): void => forgetToast(toastKey, toastId),
      type: kind === "completion" ? "success" : status === "failed" ? "error" : "warning",
      title: input.title,
      description: input.body,
      ...(options.persistent ? { timeout: 0 } : {}),
      data: {
        hideCopyButton: true,
        leadingIcon: (
          <PixelStatus
            kind={kind === "completion" ? "done" : status === "failed" ? "failed" : "attention"}
          />
        ),
      },
      actionProps: {
        children: m(msg("Open thread")),
        onClick: () => {
          toastManager.close(toastId);
          void router.navigate({
            to: "/$environmentId/$threadId",
            params: { environmentId, threadId },
          });
        },
      },
    });
    openToasts.set(toastKey, [...(openToasts.get(toastKey) ?? []), toastId]);
  };

  // The main process could not show it, as in unsigned macOS builds: the app shows it instead.
  const fallBackToToast = (tag: string) => {
    const entry = pending.get(tag);
    if (entry === undefined) return;
    pending.delete(tag);
    showToast(entry.environmentId, entry, { persistent: true });
    playSound(entry.kind);
  };

  const onDesktopNotificationEvent = (event: DesktopNotificationEvent) => {
    const entry = pending.get(event.id);
    if (entry === undefined) return;
    if (event.type === "failed") return fallBackToToast(event.id);
    pending.delete(event.id);
    const { environmentId, threadId, requestId } = entry;
    const text = event.text.trim();
    if (event.type === "click" || requestId === null || (event.type === "reply" && !text)) {
      return openThread(environmentId, threadId);
    }
    const action = {
      type: event.type,
      environmentId,
      threadId,
      requestId: RuntimeRequestId.make(requestId),
      text: event.type === "reply" ? text : "",
    };
    void answerFromNotification(registry, action).then((outcome) => {
      if (outcome !== "unsent") return;
      openThread(environmentId, threadId);
      toastManager.add({
        type: "error",
        title: m(msg("Couldn't send your answer")),
        description: m(msg("Try again from the thread.")),
      });
    });
  };

  /** Whether the OS notification on its way brings the system sound, so the app plays none. */
  const showDesktopNotification = (
    bridge: DesktopBridge,
    entry: Omit<ShownNotification, "close">,
  ): boolean => {
    // Most Linux notification daemons play no sound of their own.
    const systemSound = bridge.getClientPlatform() !== "linux";
    const tag = threadNotificationTag(entry.environmentId, entry.threadId);
    const presentation = ++presentationSequence;
    presentations.set(tag, presentation);
    const show = (buttons: AgentNotificationButtons | null) => {
      if (presentations.get(tag) !== presentation) return;
      presentations.delete(tag);
      const current = watched.get(entry.environmentId)?.previous.get(entry.threadId);
      // Answered, or notifications turned off, while the buttons were looked up.
      if (
        (entry.attention !== null && current?.attention !== entry.attention) ||
        !hasDesktopNotifications(getClientSettings().notificationMode)
      ) {
        return;
      }
      pending.set(tag, {
        ...entry,
        close: () => void bridge.closeNotification(tag).catch(() => undefined),
      });
      void bridge
        .showNotification({
          id: tag,
          groupId: tag,
          title: entry.title,
          body: entry.body,
          sound: systemSound && hasNotificationSound(getClientSettings().notificationMode),
          attention: needsYou(entry.status),
          buttons: desktopButtons(buttons),
        })
        .catch(() => fallBackToToast(tag));
    };
    if (entry.requestId === null) show(null);
    else {
      void resolveNotificationButtons(registry, {
        environmentId: entry.environmentId,
        threadId: entry.threadId,
        requestId: RuntimeRequestId.make(entry.requestId),
      }).then(show);
    }
    return systemSound;
  };

  const showBrowserNotification = (entry: Omit<ShownNotification, "close">): boolean => {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return false;
    const { environmentId, threadId } = entry;
    const tag = threadNotificationTag(environmentId, threadId);
    try {
      const notification = new Notification(entry.title, {
        body: entry.body,
        tag,
        silent: !hasNotificationSound(getClientSettings().notificationMode),
        // Windows drops clicks after a toast moves into Notification Center.
        requireInteraction: entry.kind === "completion" && isWindowsPlatform(navigator.platform),
      });
      closePending(tag);
      const shown = { ...entry, close: () => notification.close() };
      pending.set(tag, shown);
      notification.addEventListener("click", () => {
        notification.close();
        if (pending.get(tag) === shown) pending.delete(tag);
        openThread(environmentId, threadId);
      });
      return true;
    } catch {
      // Some browsers expose Notification but reject desktop presentation.
      return false;
    }
  };

  const present = (
    environmentId: EnvironmentId,
    state: NotificationState,
    kind: ThreadNotificationKind,
  ) => {
    const { thread, status } = state;
    if (
      registry
        .get(environmentThreadShells.hiddenThreadKeysAtom)
        .has(threadKey({ environmentId, threadId: thread.id }))
    )
      return;
    const { notificationMode: mode, inAppNotificationsEnabled } = getClientSettings();
    const active = activeThread();
    const title =
      kind === "completion"
        ? m(msg("Thread completed"))
        : status === "approval"
          ? m(msg("Approval needed"))
          : status === "limited"
            ? m(msg("Usage limit reached"))
            : status === "failed"
              ? m(msg("Thread failed"))
              : m(msg("Input needed"));
    const entry = {
      environmentId,
      threadId: thread.id,
      attention: kind === "input" ? state.attention : null,
      requestId: kind === "input" && needsYou(status) ? state.requestId : null,
      kind,
      status,
      title,
      body: thread.title,
    };
    const focused = document.visibilityState === "visible" && document.hasFocus();
    if (
      inAppNotificationsEnabled &&
      focused &&
      (active.environmentId !== environmentId || active.threadId !== thread.id)
    ) {
      showToast(environmentId, entry, { persistent: false });
      playSound(kind);
      return;
    }
    const bridge = window.desktopBridge;
    const systemSound =
      hasDesktopNotifications(mode) &&
      !focused &&
      (bridge ? showDesktopNotification(bridge, entry) : showBrowserNotification(entry));
    if (!systemSound) playSound(kind);
  };

  const observeThreads = (
    environmentId: EnvironmentId,
    entry: WatchedEnvironment,
    threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  ) => {
    const previous = entry.previous;
    const next = new Map<ThreadId, NotificationState>();
    const subagentRequests = registry.get(
      environmentThreadShells.pendingSubagentRequestsAtom(environmentId),
    );
    const changed: Array<[NotificationState | undefined, NotificationState]> = [];
    for (const rawThread of threads) {
      if (isShownUnderParent(rawThread.lineage)) continue;
      const prior = previous.get(rawThread.id);
      const subagentRequest = subagentRequests.get(rawThread.id) ?? null;
      if (
        !entry.reconnecting &&
        prior?.raw === rawThread &&
        prior.subagentRequest === subagentRequest
      ) {
        next.set(rawThread.id, prior);
        continue;
      }
      const thread = presentThreadShell(environmentId, rawThread, subagentRequest);
      let status = resolveSidebarThreadStatus(thread);
      if (status === "ready" && thread.latestRun?.status === "failed") status = "failed";
      const needsAttention =
        status === "input" || status === "approval" || status === "failed" || status === "limited";
      const requestId = needsAttention ? resolveBackgroundThreadRequest(thread).requestId : null;
      // Queued messages become the latest run while a request stays pending, so a request
      // with an id is keyed by that id alone and announces once.
      const attention = !needsAttention
        ? null
        : requestId !== null
          ? `${status}:${requestId}`
          : `${thread.latestRun?.runId ?? ""}:${status}`;
      const completed = status === "ready" && thread.latestRun?.status === "completed";
      const settled = completed && !monitorHoldsWakeCompletion(rawThread);
      const parsedCompletedAt = Date.parse(thread.latestRun?.completedAt ?? "");
      const completedAt = Number.isFinite(parsedCompletedAt) ? parsedCompletedAt : null;
      const state = {
        raw: rawThread,
        subagentRequest,
        thread,
        status,
        attention,
        requestId,
        settled,
        completedAt: settled ? completedAt : null,
        backgroundWake: rawThread.latestRunBackgroundWake === true,
      };
      next.set(thread.id, state);
      changed.push([prior, state]);
    }
    entry.reconnecting = false;
    entry.previous = next;
    entry.gate.retain(new Set(next.keys()));
    // A handled request, or a thread that left the list, takes its notification with it.
    for (const [tag, shown] of pending) {
      if (shown.environmentId !== environmentId) continue;
      const current = next.get(shown.threadId);
      if (
        current === undefined ||
        (shown.attention !== null && current.attention !== shown.attention)
      )
        closePending(tag);
    }
    updateBadge();
    const now = Date.now();
    for (const [prior, state] of changed) {
      entry.gate.observe(state.thread.id, prior, state, {
        archived: state.thread.archivedAt !== null,
        quiet: state.raw.latestRunStopRequested === true,
        snoozed: isSnoozedForNotification(state.thread, state.completedAt, now),
      });
    }
  };

  const watchEnvironment = (environmentId: EnvironmentId): WatchedEnvironment => {
    const entry: WatchedEnvironment = {
      previous: new Map(),
      reconnecting: false,
      unsubscribe: () => {},
      gate: createThreadNotificationGate<ThreadId>((threadId, kind) => {
        const state = entry.previous.get(threadId);
        if (state) present(environmentId, state, kind);
      }),
    };
    let threads: ReadonlyArray<OrchestrationV2ThreadShell> | null = null;
    const unsubscribeShell = registry.subscribe(
      environmentShell.stateValueAtom(environmentId),
      (shell) => {
        threads =
          shell.status === "live" && Option.isSome(shell.snapshot)
            ? shell.snapshot.value.threads
            : null;
        if (threads !== null) {
          observeThreads(environmentId, entry, threads);
          return;
        }
        entry.reconnecting = true;
        entry.gate.pause();
      },
      { immediate: true },
    );
    const reobserve = () => {
      if (threads !== null) observeThreads(environmentId, entry, threads);
    };
    const unsubscribeRequests = registry.subscribe(
      environmentThreadShells.pendingSubagentRequestsAtom(environmentId),
      reobserve,
    );
    entry.unsubscribe = () => {
      unsubscribeShell();
      unsubscribeRequests();
      entry.gate.clear();
    };
    return entry;
  };

  const syncEnvironments = () => {
    const { notificationMode, inAppNotificationsEnabled } = getClientSettings();
    const enabled = notificationMode !== "off" || inAppNotificationsEnabled;
    if (!enabled) closeToasts(() => true);
    const environmentIds = enabled ? registry.get(environmentSummaries.environmentIdsAtom) : [];
    const activeIds = new Set(environmentIds);
    for (const [environmentId, entry] of watched) {
      if (activeIds.has(environmentId)) continue;
      entry.unsubscribe();
      watched.delete(environmentId);
    }
    for (const environmentId of environmentIds) {
      if (!watched.has(environmentId)) watched.set(environmentId, watchEnvironment(environmentId));
    }
  };

  const pruneRemovedEnvironments = () => {
    const activeIds = new Set(registry.get(environmentSummaries.environmentIdsAtom));
    closeToasts((key) => !activeIds.has(parseThreadKey(key).environmentId));
    for (const [tag, entry] of pending) {
      if (!activeIds.has(entry.environmentId)) closePending(tag);
    }
  };

  // Listeners that only exist for some notification modes, rebuilt when the mode changes.
  let appliedMode: ClientSettings["notificationMode"] | null = null;
  let stopModeListeners = () => {};
  const applyMode = () => {
    const nextMode = getClientSettings().notificationMode;
    if (nextMode === appliedMode) return;
    appliedMode = nextMode;
    stopModeListeners();
    clearPending();
    const stops: Array<() => void> = [];
    if (hasDesktopNotifications(nextMode)) {
      const unsubscribeEvents = window.desktopBridge?.onNotificationEvent(
        onDesktopNotificationEvent,
      );
      // Coming back to the thread a notification is about handles it.
      window.addEventListener("focus", closeOpenedThreadToasts);
      stops.push(() => {
        unsubscribeEvents?.();
        window.removeEventListener("focus", closeOpenedThreadToasts);
        clearPending();
      });
    }
    if (hasNotificationSound(nextMode)) {
      // Electron's default autoplay policy needs no gesture, unlike browsers.
      if (window.desktopBridge) unlockNotificationAudio();
      document.addEventListener("pointerdown", unlockNotificationAudio);
      document.addEventListener("keydown", unlockNotificationAudio);
      stops.push(() => {
        document.removeEventListener("pointerdown", unlockNotificationAudio);
        document.removeEventListener("keydown", unlockNotificationAudio);
      });
    }
    stopModeListeners = () => {
      for (const stop of stops) stop();
    };
  };

  const onSettings = () => {
    applyMode();
    syncEnvironments();
    updateBadge();
  };
  const unsubscribeSettings = subscribeClientSettings(onSettings);
  const unsubscribeEnvironmentIds = registry.subscribe(
    environmentSummaries.environmentIdsAtom,
    () => {
      pruneRemovedEnvironments();
      syncEnvironments();
      updateBadge();
    },
  );
  const unsubscribeHidden = [
    registry.subscribe(environmentThreadShells.hiddenThreadKeysAtom, closeHiddenPending),
    registry.subscribe(environmentThreadShells.anyEnvironmentHidingAtom, closeHiddenPending),
    registry.subscribe(environmentThreadShells.threadRefsAtom, closeHiddenPending),
  ];
  const unsubscribeRoute = router.subscribe("onResolved", closeOpenedThreadToasts);
  onSettings();

  return () => {
    unsubscribeSettings();
    unsubscribeEnvironmentIds();
    for (const unsubscribe of unsubscribeHidden) unsubscribe();
    unsubscribeRoute();
    for (const entry of watched.values()) entry.unsubscribe();
    watched.clear();
    stopModeListeners();
    closeToasts(() => true);
    if (badgeCount > 0) setNotificationBadge(0);
  };
}
