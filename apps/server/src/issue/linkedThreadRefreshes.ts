import {
  threadIssueKeyOf,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type ThreadId,
} from "@ankielcode/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../serverActivation.ts";

// Mirrors the rows and filters of `listLinkedIssueThreads`.
function linkedKeys(thread: OrchestrationV2AppThread): ReadonlyArray<string> {
  if (thread.deletedAt !== null || thread.lineage.sideChat === true) return [];
  return (thread.issues ?? []).map(threadIssueKeyOf).toSorted();
}

function linkedThreadsView(
  thread: OrchestrationV2AppThread,
  keys: ReadonlyArray<string>,
): string | null {
  if (keys.length === 0) return null;
  const settled = thread.settledAt !== null || thread.settledOverride === "settled";
  return JSON.stringify([
    keys,
    thread.title,
    thread.projectId,
    thread.archivedAt !== null,
    settled,
  ]);
}

/**
 * Tells how a domain event changed `issues.linkedThreads` answers, so readers can refresh on
 * change instead of polling. `reordered` means activity on a linked thread, or on one whose links
 * are unknown since a restart, which can reorder answers. A thread's first full event after a
 * restart counts as a change, since its earlier links are unknown.
 */
function makeLinkedThreadsChangeDetector() {
  const views = new Map<ThreadId, string | null>();
  // Last activity of each thread with visible links.
  const activeAt = new Map<ThreadId, number>();
  const active = (threadId: ThreadId, at: DateTime.Utc): boolean => {
    const previous = activeAt.get(threadId);
    if (previous === undefined) return false;
    const millis = DateTime.toEpochMillis(at);
    if (millis <= previous) return false;
    activeAt.set(threadId, millis);
    return true;
  };
  return (event: OrchestrationV2DomainEvent): "changed" | "reordered" | null => {
    // The projection stamps every non-thread event as the thread's activity. A thread not seen
    // since startup may be linked already, since history is not replayed.
    if (!event.type.startsWith("thread.")) {
      if (!views.has(event.threadId)) return "reordered";
      return active(event.threadId, event.occurredAt) ? "reordered" : null;
    }
    if (!("lineage" in event.payload)) return null;
    const thread = event.payload;
    const view = linkedThreadsView(thread, linkedKeys(thread));
    const known = views.has(event.threadId) || event.type === "thread.created";
    const previous = views.get(event.threadId) ?? null;
    if (event.type === "thread.deleted") views.delete(event.threadId);
    else views.set(event.threadId, view);
    if (view === null) activeAt.delete(event.threadId);
    if (!known || view !== previous) {
      if (view !== null) activeAt.set(event.threadId, DateTime.toEpochMillis(thread.updatedAt));
      return "changed";
    }
    return active(event.threadId, thread.updatedAt) ? "reordered" : null;
  };
}

export class LinkedThreadRefreshes extends Context.Service<
  LinkedThreadRefreshes,
  { readonly changes: Stream.Stream<number> }
>()("@ankielcode/server/issue/linkedThreadRefreshes") {}

export const layer = Layer.effect(
  LinkedThreadRefreshes,
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const revision = yield* SubscriptionRef.make(0);
    const notify = SubscriptionRef.update(revision, (value) => value + 1);
    const detect = makeLinkedThreadsChangeDetector();
    // A running linked thread can reorder its answers on every event, so reorders refresh readers
    // at most once per 10s, the cadence clients used to poll at.
    const reorders = yield* Queue.dropping<void>(1);
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) => {
        switch (detect(event)) {
          case "changed":
            return notify;
          case "reordered":
            return Queue.offer(reorders, undefined).pipe(Effect.asVoid);
          case null:
            return Effect.void;
        }
      }),
    );
    yield* forkParked(
      Queue.take(reorders).pipe(
        Effect.andThen(notify),
        Effect.andThen(Effect.sleep("10 seconds")),
        Effect.forever,
      ),
    );
    return LinkedThreadRefreshes.of({
      changes: SubscriptionRef.changes(revision).pipe(Stream.filter((value) => value > 0)),
    });
  }),
);
