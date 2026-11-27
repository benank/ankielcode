import type { PixelStatusKind } from "@ankielcode/shared/pixelStatus";
import * as DateTime from "effect/DateTime";

import { threadRuntimeCanArchive, type EnvironmentThreadShell } from "./models.ts";
import { hasUnseenRunFailure, threadWokeAt } from "./threadSettled.ts";

export type ThreadRowStatus =
  | "approval"
  | "input"
  | "working"
  | "waiting"
  | "failed"
  | "limited"
  | "ready";

export function threadHasUnseenCompletion(
  thread: Pick<EnvironmentThreadShell, "latestRun" | "lastVisitedAt">,
): boolean {
  const completedAt = thread.latestRun?.completedAt;
  if (!completedAt) return false;
  const status = thread.latestRun?.status;
  if (status === "interrupted" || status === "cancelled") return false;
  const completedAtMs = Date.parse(completedAt);
  if (Number.isNaN(completedAtMs)) return false;
  if (!thread.lastVisitedAt) return false;
  const lastVisitedAtMs = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(lastVisitedAtMs)) return true;
  return completedAtMs > lastVisitedAtMs;
}

/** The wake a row shows as Woke until a visit reaches it. */
export function resolveThreadWokeAt(
  thread: EnvironmentThreadShell,
  options: { readonly now: string },
): string | null {
  // Older servers cannot persist an acknowledgement.
  if (thread.lastVisitedAt === undefined || thread.settledOverride === "settled") return null;
  const wokeAt = threadWokeAt(thread, options);
  const wokeAtMs = Date.parse(wokeAt ?? "");
  const lastVisitedAtMs = Date.parse(thread.lastVisitedAt ?? "");
  return !Number.isNaN(wokeAtMs) && (Number.isNaN(lastVisitedAtMs) || lastVisitedAtMs < wokeAtMs)
    ? wokeAt
    : null;
}

export function resolveThreadStatus(
  thread: Pick<
    EnvironmentThreadShell,
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "pendingSubagentRequest"
    | "runtime"
    | "blockedOnThreadWait"
    | "subagentTurnActive"
  >,
): ThreadRowStatus {
  if (thread.hasPendingApprovals || thread.pendingSubagentRequest === "approval") {
    return "approval";
  }
  if (thread.hasPendingUserInput || thread.pendingSubagentRequest === "user_input") {
    return "input";
  }
  if (thread.runtime?.status === "running" && thread.blockedOnThreadWait === true) {
    return "waiting";
  }
  if (
    thread.subagentTurnActive === true ||
    (thread.runtime !== null &&
      ["preparing", "queued", "starting", "running", "waiting"].includes(thread.runtime.status))
  ) {
    return "working";
  }
  if (thread.runtime?.status === "idle") {
    return "waiting";
  }
  if (thread.runtime?.status === "failed") {
    return thread.runtime.lastErrorClass === "usage_limit" ? "limited" : "failed";
  }
  return "ready";
}

/** Row status: a failure the user has already opened settles to ready, like Done. */
export function resolveThreadRowStatus(
  thread: Parameters<typeof resolveThreadStatus>[0] &
    Pick<EnvironmentThreadShell, "latestRun" | "lastVisitedAt">,
): ThreadRowStatus {
  const status = resolveThreadStatus(thread);
  // A runtime failure without a failed run has nothing to date it, so it stays.
  if (status !== "failed" || thread.latestRun?.status !== "failed") return status;
  return hasUnseenRunFailure(thread) ? status : "ready";
}

/** The pixel light a thread row shows; none while nothing needs a look. */
export function resolveThreadPixelKind(
  thread: Parameters<typeof resolveThreadRowStatus>[0],
  wokeAt: string | null,
): PixelStatusKind | null {
  switch (resolveThreadRowStatus(thread)) {
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
      return wokeAt !== null ? "attention" : threadHasUnseenCompletion(thread) ? "done" : null;
  }
}

export type ThreadReadToggle =
  | { readonly kind: "mark-read"; readonly visitedAt: string }
  | { readonly kind: "mark-unread" };

/**
 * What a thread's read toggle does: clear the light a visit clears, or bring back the one
 * mark-unread brings back. Null when neither would change the row, so a toggle always shows.
 * Pass `wokeAt` only while the row shows Woke.
 */
export function resolveThreadReadToggle(
  thread: Parameters<typeof resolveThreadPixelKind>[0] & Pick<EnvironmentThreadShell, "runtime">,
  wokeAt: string | null,
): ThreadReadToggle | null {
  // Older servers cannot persist a visit.
  if (thread.lastVisitedAt === undefined) return null;
  const light = resolveThreadPixelKind(thread, wokeAt);
  const run = thread.latestRun;
  // The thread's own times, not this device's clock: the server keeps the later visit.
  const visitedAt = [wokeAt, run?.completedAt ?? run?.startedAt ?? run?.requestedAt]
    .filter((value): value is string => value != null && !Number.isNaN(Date.parse(value)))
    .reduce<string | null>(
      (latest, value) =>
        latest === null || Date.parse(value) > Date.parse(latest) ? value : latest,
      null,
    );
  if (visitedAt !== null) {
    const seen =
      thread.lastVisitedAt !== null && Date.parse(thread.lastVisitedAt) >= Date.parse(visitedAt)
        ? thread.lastVisitedAt
        : visitedAt;
    if (resolveThreadPixelKind({ ...thread, lastVisitedAt: seen }, null) !== light) {
      return { kind: "mark-read", visitedAt };
    }
  }
  const completedAtMs = Date.parse(run?.completedAt ?? "");
  if (Number.isNaN(completedAtMs) || !threadRuntimeCanArchive(thread.runtime)) return null;
  // The server marks a thread unread by moving its visit to just before the run completed.
  const unseen = DateTime.formatIso(DateTime.makeUnsafe(completedAtMs - 1));
  return resolveThreadPixelKind({ ...thread, lastVisitedAt: unseen }, null) !== light
    ? { kind: "mark-unread" }
    : null;
}
