import type { EnvironmentThreadShell } from "@ankielcode/client-runtime/state/models";
import type { DesktopRecentThread } from "@ankielcode/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createRecentThreadsPublisher, selectRecentThreads } from "./desktopRecentThreads";

const shell = (id: string, title: string, usedAt: string, extra: object = {}) =>
  ({
    environmentId: "env",
    id,
    title,
    branch: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: usedAt,
    latestUserMessageAt: usedAt,
    latestUserAuthoredMessageAt: usedAt,
    archivedAt: null,
    opens: null,
    lineage: {},
    ...extra,
  }) as unknown as EnvironmentThreadShell;

describe("selectRecentThreads", () => {
  it("orders by last use, skips archived, untitled and child threads, and caps the list", () => {
    const shells = [
      shell("old", "Old", "2026-01-02T00:00:00.000Z"),
      shell("new", "  New  ", "2026-01-04T00:00:00.000Z"),
      shell("archived", "Archived", "2026-01-05T00:00:00.000Z", {
        archivedAt: "2026-01-05T00:00:00.000Z",
      }),
      shell("untitled", " ", "2026-01-06T00:00:00.000Z"),
      shell("subagent", "Subagent", "2026-01-07T00:00:00.000Z", {
        lineage: { relationshipToParent: "subagent" },
      }),
      shell("side", "Side chat", "2026-01-07T00:00:00.000Z", { lineage: { sideChat: true } }),
      shell("opened", "Opened", "2026-01-01T00:00:00.000Z", {
        opens: { score: 1, picks: [], openedAt: Date.parse("2026-01-03T12:00:00.000Z") },
      }),
      shell("mid", "Mid", "2026-01-03T00:00:00.000Z"),
    ];
    expect(selectRecentThreads(shells, 3)).toEqual([
      { environmentId: "env", threadId: "new", title: "New" },
      { environmentId: "env", threadId: "opened", title: "Opened" },
      { environmentId: "env", threadId: "mid", title: "Mid" },
    ]);
  });
});

describe("createRecentThreadsPublisher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const thread = (title: string): DesktopRecentThread => ({
    environmentId: "env",
    threadId: "thread",
    title,
  });

  it("coalesces a burst of changes into one send after the delay", () => {
    let current = [thread("First")];
    const send = vi.fn(async () => undefined);
    const publisher = createRecentThreadsPublisher({ read: () => current, send, delayMs: 1000 });

    publisher.schedule();
    vi.advanceTimersByTime(600);
    current = [thread("Second")];
    publisher.schedule();
    expect(send).not.toHaveBeenCalled();

    // A later change does not push the send back, so constant changes still publish.
    vi.advanceTimersByTime(400);
    expect(send).toHaveBeenCalledExactlyOnceWith([thread("Second")]);
  });

  it("sends only when the list changed since the last send", () => {
    let current = [thread("Same")];
    const send = vi.fn(async () => undefined);
    const publisher = createRecentThreadsPublisher({ read: () => current, send, delayMs: 10 });

    publisher.schedule();
    vi.advanceTimersByTime(10);
    current = [thread("Same")];
    publisher.schedule();
    vi.advanceTimersByTime(10);
    expect(send).toHaveBeenCalledTimes(1);

    current = [thread("Renamed")];
    publisher.schedule();
    vi.advanceTimersByTime(10);
    expect(send).toHaveBeenLastCalledWith([thread("Renamed")]);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("sends nothing after dispose", () => {
    const send = vi.fn(async () => undefined);
    const publisher = createRecentThreadsPublisher({
      read: () => [thread("A")],
      send,
      delayMs: 10,
    });
    publisher.schedule();
    publisher.dispose();
    vi.advanceTimersByTime(10);
    expect(send).not.toHaveBeenCalled();
  });
});
