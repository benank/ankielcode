import { scopedThreadKey, scopeThreadRef } from "@ankielcode/client-runtime/environment";
import { useStableCallback } from "~/hooks/useStableCallback";
import { resolveEnvironmentMachineKind } from "@ankielcode/contracts";
import { msg, useGT, useMessages } from "gt-react";
import { TerminalIcon } from "lucide-react";
import { type AnimationEvent } from "react";
import { m, type MessageResolver } from "../i18n/messages";
import { useEnvironment, usePrimaryEnvironmentId } from "../state/environments";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { STATUS_TONE_DOT_CLASS } from "./PixelStatus";
import { cn } from "../lib/utils";
import { useThreadRunningTerminalIds } from "../state/terminalSessions";
import { useUiStateStore } from "../uiStateStore";
import {
  resolveThreadLastVisitedAt,
  resolveThreadStatusPill,
  type ThreadStatusPill,
  useSidebarRowSubscriptionLease,
} from "./Sidebar.logic";
import type { SidebarThreadSummary } from "../types";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export interface TerminalStatusIndicator {
  label: string;
  colorClass: string;
  pulse: boolean;
}

export function terminalStatusFromRunningIds(
  runningTerminalIds: ReadonlyArray<string>,
  resolve: MessageResolver = m,
): TerminalStatusIndicator | null {
  if (runningTerminalIds.length === 0) {
    return null;
  }
  return {
    label: resolve(msg("Terminal process running")),
    colorClass: "text-muted-foreground",
    pulse: true,
  };
}

function synchronizeTerminalPulse(event: AnimationEvent<SVGSVGElement>) {
  if (event.animationName !== "status-pulse") return;

  for (const animation of event.currentTarget.getAnimations()) {
    if ("animationName" in animation && animation.animationName === "status-pulse") {
      animation.startTime = 0;
    }
  }
}

function ThreadStatusLabel({ status }: { status: ThreadStatusPill }) {
  const m = useMessages();
  const label = m(status.label);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={label}
            className="inline-flex items-center gap-1 text-3xs text-muted-foreground"
          />
        }
      >
        <span
          className={cn(
            "h-1.5 w-1.5 rounded-full",
            STATUS_TONE_DOT_CLASS[status.tone],
            status.pulse && "motion-safe:animate-status-pulse",
          )}
        />
        <span className="hidden md:inline">{label}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

export function ThreadRowLeadingStatus({ thread }: { thread: SidebarThreadSummary }) {
  const { rowRef } = useSidebarRowSubscriptionLease(false);
  // A new ref callback would detach and reattach the row, and each reattach sets lease state.
  const statusRef = useStableCallback((node: HTMLSpanElement | null) =>
    rowRef(node?.parentElement ?? null),
  );
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const localLastVisitedAt = useUiStateStore(
    (state) => state.threadLastVisitedAtById[scopedThreadKey(threadRef)],
  );
  const lastVisitedAt = resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt);
  const threadStatus = resolveThreadStatusPill({
    thread: {
      ...thread,
      lastVisitedAt,
    },
  });

  return (
    <span
      ref={statusRef}
      className={threadStatus ? "inline-flex shrink-0 items-center" : "contents"}
    >
      {threadStatus ? <ThreadStatusLabel status={threadStatus} /> : null}
    </span>
  );
}

export function ThreadRowTrailingStatus({ thread }: { thread: SidebarThreadSummary }) {
  const gt = useGT();
  const m = useMessages();
  const runningTerminalIds = useThreadRunningTerminalIds({
    environmentId: thread.environmentId,
    threadId: thread.id,
  });
  const environment = useEnvironment(thread.environmentId);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const isRemoteThread = thread.environmentId !== primaryEnvironmentId;
  const remoteEnvLabel = environment?.label ?? null;
  const threadEnvironmentLabel = isRemoteThread
    ? (remoteEnvLabel ?? gt("Remote", { $context: "machine location" }))
    : null;
  const remoteMachine = resolveEnvironmentMachineKind(environment?.serverConfig ?? null);
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds, m);

  if (!terminalStatus && !isRemoteThread) {
    return null;
  }

  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      {terminalStatus ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                role="img"
                aria-label={terminalStatus.label}
                className={`inline-flex items-center justify-center ${terminalStatus.colorClass}`}
              />
            }
          >
            <TerminalIcon
              className={`size-3 ${terminalStatus.pulse ? "motion-safe:animate-status-pulse" : ""}`}
              onAnimationStart={synchronizeTerminalPulse}
            />
          </TooltipTrigger>
          <TooltipPopup side="top">{terminalStatus.label}</TooltipPopup>
        </Tooltip>
      ) : null}
      {isRemoteThread ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                aria-label={
                  threadEnvironmentLabel ?? gt("Remote", { $context: "machine location" })
                }
                className="inline-flex items-center justify-center"
              />
            }
          >
            <EnvironmentMachineIcon
              kind={remoteMachine}
              className="size-3 text-muted-foreground/60"
            />
          </TooltipTrigger>
          <TooltipPopup side="top">{threadEnvironmentLabel}</TooltipPopup>
        </Tooltip>
      ) : null}
    </span>
  );
}
