import {
  EnvironmentId,
  OrchestrationV2ThreadShell,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@ankielcode/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { presentThreadShell, type EnvironmentThreadShell } from "./models.ts";
import { v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import {
  resolveThreadPixelKind,
  resolveThreadReadToggle,
  resolveThreadRowStatus,
  resolveThreadStatus,
  resolveThreadWokeAt,
  threadHasUnseenCompletion,
} from "./threadReadState.ts";

const environmentId = EnvironmentId.make("environment-1");
const decodeThreadShell = Schema.decodeUnknownSync(OrchestrationV2ThreadShell);
const NOW = "2026-06-02T00:00:00.000Z";
const BASE_MS = Date.parse(NOW);
const isoAt = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const MINUTE_MS = 60_000;

// An older server's shell: it leaves lastVisitedAt out.
function makeRawThreadShell(
  input: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell {
  const { lastVisitedAt: _lastVisitedAt, ...shell } = v2ThreadShell;
  return { ...shell, ...input };
}

function makeThread(
  input: Partial<EnvironmentThreadShell> & Pick<EnvironmentThreadShell, "id" | "title">,
): EnvironmentThreadShell {
  return { ...presentThreadShell(environmentId, makeRawThreadShell({ id: input.id })), ...input };
}

describe("resolveThreadStatus", () => {
  it("presents decoded thread waits as Waiting while preserving requests and older servers", () => {
    const raw = makeRawThreadShell({
      status: "running",
      activeRunId: RunId.make("run-wait"),
      latestRunId: RunId.make("run-wait"),
    });
    const present = (shell: unknown) => presentThreadShell(environmentId, decodeThreadShell(shell));

    expect(resolveThreadStatus(present(raw))).toBe("working");
    const blocked = present({ ...raw, blockedOnThreadWait: true });
    expect(
      resolveThreadStatus({
        ...blocked,
        hasPendingApprovals: true,
        hasPendingUserInput: true,
      }),
    ).toBe("approval");
    expect(resolveThreadStatus({ ...blocked, hasPendingUserInput: true })).toBe("input");
    expect(resolveThreadStatus(blocked)).toBe("waiting");
    expect(resolveThreadStatus(present({ ...raw, blockedOnThreadWait: false }))).toBe("working");
  });

  it("lights a provider-native subagent's row while its own turn runs", () => {
    const present = (shell: unknown) => presentThreadShell(environmentId, decodeThreadShell(shell));
    const child = makeRawThreadShell({ latestRunId: null, status: "idle" });

    const working = present({ ...child, subagentTurnActive: true });
    expect(working.runtime).toBeNull();
    expect(resolveThreadPixelKind(working, null)).toBe("working");
    expect(resolveThreadPixelKind(present({ ...child, subagentTurnActive: false }), null)).toBe(
      null,
    );
  });

  it("settles a failure the user opened to ready in the row, keeping the raw status", () => {
    const failed = presentThreadShell(
      environmentId,
      makeRawThreadShell({
        status: "failed",
        latestRunId: RunId.make("run-failed"),
        latestRunCompletedAt: DateTime.makeUnsafe("2026-06-01T23:59:00.000Z"),
        lastVisitedAt: DateTime.makeUnsafe(NOW),
      }),
    );

    expect(resolveThreadStatus(failed)).toBe("failed");
    expect(resolveThreadRowStatus(failed)).toBe("ready");
    expect(resolveThreadRowStatus({ ...failed, lastVisitedAt: null })).toBe("failed");
  });

  it.each([
    { roster: "dev server", task: { kind: "command" }, status: "ready" },
    { roster: "dev server watchdog", task: { kind: "monitor" }, status: "ready" },
    { roster: "awaited command", task: { kind: "command", awaited: true }, status: "waiting" },
  ] as const)(
    "presents an unseen completion with a $roster roster as $status",
    ({ task, status }) => {
      const thread = presentThreadShell(
        environmentId,
        makeRawThreadShell({
          latestRunId: RunId.make("run-background-completion"),
          status: "completed",
          latestRunCompletedAt: DateTime.makeUnsafe(NOW),
          lastVisitedAt: DateTime.makeUnsafe("2026-06-01T23:59:00.000Z"),
          pendingBackgroundTasks: [{ taskId: "background-work", ...task }],
        }),
      );

      expect(resolveThreadStatus(thread)).toBe(status);
      expect(threadHasUnseenCompletion(thread)).toBe(true);
    },
  );

  it.each(["interrupted", "cancelled"] as const)(
    "does not present a %s run as an unseen completion",
    (status) => {
      const thread = presentThreadShell(
        environmentId,
        makeRawThreadShell({
          latestRunId: RunId.make("run-stopped"),
          status,
          latestRunCompletedAt: DateTime.makeUnsafe(NOW),
          lastVisitedAt: DateTime.makeUnsafe("2026-06-01T23:59:00.000Z"),
        }),
      );

      expect(threadHasUnseenCompletion(thread)).toBe(false);
    },
  );
});

describe("resolveThreadReadToggle", () => {
  const COMPLETED_AT = "2026-06-01T23:00:00.000Z";
  const present = (input: Parameters<typeof makeRawThreadShell>[0]) =>
    presentThreadShell(
      environmentId,
      makeRawThreadShell({
        latestRunId: RunId.make("run-read-toggle"),
        latestRunCompletedAt: DateTime.makeUnsafe(COMPLETED_AT),
        ...input,
      }),
    );
  // What the server stores after each toggle, so a test can take the next one from there.
  const afterToggle = (thread: EnvironmentThreadShell): EnvironmentThreadShell => {
    const toggle = resolveThreadReadToggle(thread, null);
    if (toggle === null) throw new Error("no toggle");
    return {
      ...thread,
      lastVisitedAt:
        toggle.kind === "mark-read" ? toggle.visitedAt : isoAt(Date.parse(COMPLETED_AT) - 1),
    };
  };

  it.each(["completed", "failed"] as const)(
    "flips a %s run between read and unread and back",
    (status) => {
      const unread = present({
        status,
        lastVisitedAt: DateTime.makeUnsafe("2026-06-01T22:00:00Z"),
      });
      expect(resolveThreadReadToggle(unread, null)).toEqual({
        kind: "mark-read",
        visitedAt: COMPLETED_AT,
      });

      const read = afterToggle(unread);
      expect(resolveThreadPixelKind(read, null)).toBeNull();
      expect(resolveThreadReadToggle(read, null)).toEqual({ kind: "mark-unread" });

      const unreadAgain = afterToggle(read);
      expect(resolveThreadPixelKind(unreadAgain, null)).not.toBeNull();
      expect(resolveThreadReadToggle(unreadAgain, null)?.kind).toBe("mark-read");
    },
  );

  it.each(["interrupted", "cancelled"] as const)(
    "offers nothing for a %s run, which never shows as unread",
    (status) => {
      const thread = present({ status, lastVisitedAt: DateTime.makeUnsafe(NOW) });
      expect(resolveThreadReadToggle(thread, null)).toBeNull();
    },
  );

  it("marks a woken thread read at its wake time", () => {
    const wokeAt = "2026-06-01T23:30:00.000Z";
    const thread = present({
      status: "completed",
      lastVisitedAt: DateTime.makeUnsafe(COMPLETED_AT),
    });
    expect(resolveThreadReadToggle(thread, wokeAt)).toEqual({
      kind: "mark-read",
      visitedAt: wokeAt,
    });
  });

  it("offers nothing while the thread is running", () => {
    const thread = present({
      status: "running",
      activeRunId: RunId.make("run-read-toggle"),
      lastVisitedAt: DateTime.makeUnsafe(NOW),
    });
    expect(resolveThreadReadToggle(thread, null)).toBeNull();
  });

  it("offers nothing on a server that cannot record visits", () => {
    const thread = present({ status: "completed" });
    expect(thread.lastVisitedAt).toBeUndefined();
    expect(resolveThreadReadToggle(thread, null)).toBeNull();
  });
});

describe("resolveThreadWokeAt", () => {
  const wokeAt = isoAt(BASE_MS - MINUTE_MS);
  const thread = makeThread({
    id: ThreadId.make("woke"),
    title: "Woke",
    latestUserMessageAt: isoAt(BASE_MS - 90 * MINUTE_MS),
    snoozedAt: isoAt(BASE_MS - 60 * MINUTE_MS),
    snoozedUntil: wokeAt,
    lastVisitedAt: null,
  });

  it("keeps a timer wake through a plain visit until acknowledgement reaches its timestamp", () => {
    expect(resolveThreadWokeAt(thread, { now: NOW })).toBe(wokeAt);
    expect(
      resolveThreadWokeAt(
        { ...thread, lastVisitedAt: isoAt(BASE_MS - 30 * MINUTE_MS) },
        { now: NOW },
      ),
    ).toBe(wokeAt);
    expect(resolveThreadWokeAt({ ...thread, lastVisitedAt: wokeAt }, { now: NOW })).toBeNull();
    expect(resolveThreadWokeAt({ ...thread, lastVisitedAt: "invalid" }, { now: NOW })).toBe(wokeAt);
  });

  it("stays hidden while snoozed, after settling, and on servers without visited tracking", () => {
    expect(resolveThreadWokeAt(thread, { now: isoAt(BASE_MS - 2 * MINUTE_MS) })).toBeNull();
    expect(resolveThreadWokeAt({ ...thread, settledOverride: "settled" }, { now: NOW })).toBeNull();
    const { lastVisitedAt: _lastVisitedAt, ...olderServerThread } = thread;
    expect(resolveThreadWokeAt(olderServerThread, { now: NOW })).toBeNull();
    expect(resolveThreadWokeAt({ ...thread, snoozedUntil: null }, { now: NOW })).toBeNull();
  });

  it("keeps an early failure wake acknowledged after the scheduled time passes", () => {
    const completedAt = isoAt(BASE_MS - 2 * MINUTE_MS);
    const failed = makeThread({
      ...thread,
      snoozedUntil: isoAt(BASE_MS + MINUTE_MS),
      runtime: {
        status: "failed",
        activeRunId: null,
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerName: "Codex",
        lastError: "Run failed",
        updatedAt: completedAt,
      },
      latestRun: {
        runId: RunId.make("woke-run"),
        status: "failed",
        requestedAt: isoAt(BASE_MS - 3 * MINUTE_MS),
        startedAt: isoAt(BASE_MS - 3 * MINUTE_MS),
        completedAt,
        assistantMessageId: null,
      },
    });
    expect(resolveThreadWokeAt(failed, { now: NOW })).toBe(completedAt);
    expect(
      resolveThreadWokeAt(
        { ...failed, lastVisitedAt: completedAt },
        { now: isoAt(BASE_MS + 2 * MINUTE_MS) },
      ),
    ).toBeNull();
  });
});
