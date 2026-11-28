import {
  MessageId,
  NodeId,
  PlanId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2PlanArtifact,
  type OrchestrationV2TurnItem,
} from "@ankielcode/contracts";
import type { ThreadRuntimeSummary } from "@ankielcode/client-runtime/state/shell";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveCanInterruptRunningThread,
  deriveTimelineEntriesFromVisibleTurnItems,
  deriveTimelineEntriesFromVisibleTurnItemsWithState,
  deriveRevertTurnCountByUserMessageId,
  derivePhase,
  isLatestRunSettled,
  providerErrorPresentation,
  type TimelineEntry,
  workEntryDisplayIndicatesToolFailure,
} from "./session-logic";
import {
  makeStreamingTimelineFixture,
  makeStreamingWorkTimelineFixture,
  withStreamedText,
} from "./test-fixtures";
import type { ChatMessage } from "./types";

function streamingPlanArtifact(
  fixture: ReturnType<typeof makeStreamingWorkTimelineFixture>,
  markdown: string,
  status: "active" | "superseded",
): OrchestrationV2PlanArtifact {
  return {
    id: PlanId.make("live-plan"),
    threadId: fixture.threadId,
    runId: fixture.runId,
    nodeId: NodeId.make("live-node"),
    kind: "proposed_plan",
    markdown,
    status,
  };
}

describe("V2 session presentation", () => {
  it("uses run status as the settlement boundary", () => {
    const runId = RunId.make("run-1");
    expect(
      isLatestRunSettled(
        {
          runId,
          status: "completed",
          startedAt: "2026-06-20T00:00:00.000Z",
          completedAt: "2026-06-20T00:01:00.000Z",
        },
        null,
      ),
    ).toBe(true);
    expect(
      isLatestRunSettled(
        { runId, status: "running", startedAt: null, completedAt: null },
        { status: "running", activeRunId: runId },
      ),
    ).toBe(false);
    expect(
      isLatestRunSettled(
        { runId, status: "queued", startedAt: null, completedAt: null },
        { status: "running", activeRunId: RunId.make("run-active") },
      ),
    ).toBe(false);
  });

  it("offers Stop while a run is preparing/starting, not just once it's running (#13392)", () => {
    const runtimeWithStatus = (
      status: ThreadRuntimeSummary["status"],
      activeRunId: RunId | null = null,
    ): ThreadRuntimeSummary => ({
      status,
      activeRunId,
      providerInstanceId: ProviderInstanceId.make("claude-default"),
      providerName: null,
      lastError: null,
      updatedAt: "2026-09-29T00:00:00.000Z",
    });
    const runId = RunId.make("run-stop-while-starting");

    for (const status of ["preparing", "starting", "running"] as const) {
      const runtime = runtimeWithStatus(status, runId);
      expect(deriveCanInterruptRunningThread(true, runtime)).toBe(true);
    }

    expect(deriveCanInterruptRunningThread(false, runtimeWithStatus("running", runId))).toBe(false);

    expect(derivePhase(runtimeWithStatus("queued"))).toBe("connecting");
    expect(deriveCanInterruptRunningThread(true, runtimeWithStatus("queued"))).toBe(false);
    expect(deriveCanInterruptRunningThread(true, runtimeWithStatus("queued", runId))).toBe(true);

    expect(derivePhase(runtimeWithStatus("waiting"))).toBe("running");
    expect(deriveCanInterruptRunningThread(true, runtimeWithStatus("waiting"))).toBe(true);

    expect(deriveCanInterruptRunningThread(true, null)).toBe(false);
  });

  it("labels provider retry progress, delay, recovery, and exhaustion", () => {
    const now = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
    const retryItem = {
      id: TurnItemId.make("item-provider-retry"),
      threadId: ThreadId.make("thread-provider-retry"),
      runId: RunId.make("run-provider-retry"),
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "running" as const,
      title: "Provider retry",
      startedAt: now,
      completedAt: null,
      updatedAt: now,
      type: "error" as const,
      failure: {
        class: "provider_error" as const,
        message: "Claude API overloaded.",
        code: "api_error_529",
        retryable: true,
      },
      retry: {
        attempt: 2,
        maxAttempts: 10,
        retryDelayMs: 1_500,
      },
    } satisfies Extract<OrchestrationV2TurnItem, { readonly type: "error" }>;

    expect(
      providerErrorPresentation({
        ...retryItem,
        status: "failed",
        failure: { ...retryItem.failure, class: "usage_limit" },
      }),
    ).toMatchObject({ label: "Usage limit reached after 2/10 retries" });
    const recoveredLimit = {
      ...retryItem,
      status: "completed" as const,
      completedAt: now,
      failure: { ...retryItem.failure, class: "usage_limit" as const },
    };
    const [recoveredEntry] = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [
        {
          item: recoveredLimit,
          position: 0,
          visibility: "local",
          sourceThreadId: recoveredLimit.threadId,
          sourceItemId: recoveredLimit.id,
        },
      ],
      optimisticMessages: [],
    });
    if (recoveredEntry?.kind !== "work") throw new Error("Expected recovered provider work");
    expect(recoveredEntry.entry.label).toBe("Provider recovered (2/10 retries)");
    expect(recoveredEntry.entry.sourceActivityKind).not.toBe("runtime.warning");
    expect(workEntryDisplayIndicatesToolFailure(recoveredEntry.entry)).toBe(false);
    expect(providerErrorPresentation(retryItem)).toEqual({
      label: "Retrying provider (2/10)",
      detail: "Claude API overloaded. Retrying in 1.5s.",
    });
    expect(
      providerErrorPresentation({
        ...retryItem,
        status: "completed",
        completedAt: now,
      }),
    ).toMatchObject({ label: "Provider recovered (2/10 retries)" });
    expect(
      providerErrorPresentation({
        ...retryItem,
        status: "failed",
        retry: { ...retryItem.retry, attempt: 10 },
        completedAt: now,
      }),
    ).toMatchObject({ label: "Provider error after 10/10 retries" });
  });

  it("assigns run rollback to the turn-start message instead of a later steer", () => {
    const runId = RunId.make("run-steered");
    const turnStartMessageId = MessageId.make("message-turn-start");
    const steerMessageId = MessageId.make("message-steer");
    const assistantMessageId = MessageId.make("message-assistant");
    const messages: ChatMessage[] = [
      {
        id: turnStartMessageId,
        role: "user",
        text: "Start",
        runId,
        inputIntent: "turn_start",
        streaming: false,
        createdAt: "2026-06-20T00:00:00.000Z",
        updatedAt: "2026-06-20T00:00:00.000Z",
      },
      {
        id: steerMessageId,
        role: "user",
        text: "Steer",
        runId,
        inputIntent: "steer",
        streaming: false,
        createdAt: "2026-06-20T00:00:01.000Z",
        updatedAt: "2026-06-20T00:00:01.000Z",
      },
      {
        id: assistantMessageId,
        role: "assistant",
        text: "Done",
        runId,
        streaming: false,
        createdAt: "2026-06-20T00:00:02.000Z",
        updatedAt: "2026-06-20T00:00:02.000Z",
      },
    ];
    const timelineEntries: TimelineEntry[] = messages.map((message): TimelineEntry => ({
      id: message.id,
      kind: "message",
      createdAt: message.createdAt,
      message,
    }));

    const targets = deriveRevertTurnCountByUserMessageId({
      timelineEntries,
      threadStartCheckpointAvailable: true,
      checkpoints: [
        {
          runId,
          checkpointTurnCount: 1,
          checkpointRef: "checkpoint-run-1" as never,
          status: "ready",
          files: [],
          assistantMessageId,
          completedAt: "2026-06-20T00:00:03.000Z",
        },
      ],
    });

    expect([...targets]).toEqual([[turnStartMessageId, 0]]);
    expect(targets.has(steerMessageId)).toBe(false);
  });
});

describe("incremental v2 timeline entries", () => {
  it("retains history and attachment previews through decoded streaming updates", () => {
    const fixture = makeStreamingTimelineFixture("Partial");
    const attachment = {
      type: "image" as const,
      id: "stream-image",
      name: "image.png",
      mimeType: "image/png",
      sizeBytes: 42,
    };
    const visibleTurnItems = fixture.visibleTurnItems.map((row) =>
      row.item.type === "assistant_message"
        ? { ...row, item: { ...row.item, attachments: [attachment] } }
        : row,
    );
    const input = {
      visibleTurnItems,
      optimisticMessages: [],
      attachmentUrlById: new Map([[attachment.id, "https://server.test/image"]]),
    };
    const previous = deriveTimelineEntriesFromVisibleTurnItemsWithState(input);
    Object.freeze(previous.entries);
    for (const entry of previous.entries) Object.freeze(entry);
    const last = visibleTurnItems.at(-1)!;
    if (last.item.type !== "assistant_message") throw new Error("Expected assistant fixture");
    const nextItem = {
      ...last,
      item: {
        ...last.item,
        text: "Next token",
        attachments: [{ ...attachment }],
        startedAt: DateTime.makeUnsafe(fixture.time(7)),
        updatedAt: DateTime.makeUnsafe(fixture.time(8)),
      },
    };
    const nextInput = {
      ...input,
      visibleTurnItems: [...visibleTurnItems.slice(0, -1), nextItem],
      attachmentUrlById: new Map(input.attachmentUrlById),
    };
    const next = deriveTimelineEntriesFromVisibleTurnItemsWithState(nextInput, previous);
    expect(next.entries).toEqual(deriveTimelineEntriesFromVisibleTurnItems(nextInput));
    for (const [index, entry] of previous.entries.slice(0, -1).entries()) {
      expect(next.entries[index]).toBe(entry);
    }
    const beforeMessage = previous.entries.at(-1)!;
    const nextMessage = next.entries.at(-1)!;
    if (beforeMessage.kind !== "message" || nextMessage.kind !== "message") {
      throw new Error("Expected assistant entries");
    }
    expect(nextMessage.message.attachments).toBe(beforeMessage.message.attachments);
    expect(nextMessage.projectedItem).toBe(nextItem);
    expect(nextMessage.message.text).toBe("Next token");
    expect(beforeMessage.message.text).toBe("Partial");

    const renewedInput = {
      ...nextInput,
      attachmentUrlById: new Map([[attachment.id, "https://renewed.test/image"]]),
    };
    const renewed = deriveTimelineEntriesFromVisibleTurnItemsWithState(renewedInput, next);
    expect(renewed.entries).toEqual(deriveTimelineEntriesFromVisibleTurnItems(renewedInput));
    expect(renewed.entries.at(-1)).toMatchObject({
      message: { attachments: [{ previewUrl: "https://renewed.test/image" }] },
    });
    expect(nextMessage.message.attachments?.[0]).toMatchObject({
      previewUrl: "https://server.test/image",
    });
    const restoredInput = { ...renewedInput, attachmentUrlById: new Map<string, string>() };
    const restored = deriveTimelineEntriesFromVisibleTurnItemsWithState(restoredInput, renewed);
    expect(restored.entries.at(-1)).toMatchObject({ message: { attachments: [attachment] } });
    const restoredMessage = restored.entries.at(-1)!;
    if (restoredMessage.kind !== "message") throw new Error("Expected assistant entry");
    expect(restoredMessage.message.attachments?.[0]).not.toHaveProperty("previewUrl");
  });

  it("appends committed items in canonical order even when their timestamps go backwards", () => {
    const fixture = makeStreamingTimelineFixture("Partial");
    const input = { visibleTurnItems: fixture.visibleTurnItems, optimisticMessages: [] };
    const previous = deriveTimelineEntriesFromVisibleTurnItemsWithState(input);
    const last = fixture.visibleTurnItems.at(-1)!;
    const appended = {
      ...last,
      position: last.position + 1,
      sourceItemId: TurnItemId.make("late-item"),
      item: {
        ...last.item,
        id: TurnItemId.make("late-item"),
        messageId: MessageId.make("late-message"),
        startedAt: DateTime.makeUnsafe(fixture.time(0)),
      },
    };
    const nextInput = { ...input, visibleTurnItems: [...input.visibleTurnItems, appended] };
    const next = deriveTimelineEntriesFromVisibleTurnItemsWithState(nextInput, previous);
    expect(next.entries).toEqual(deriveTimelineEntriesFromVisibleTurnItems(nextInput));
    expect(next.entries.at(-1)).toMatchObject({ id: "late-message" });
    for (const [index, entry] of previous.entries.entries())
      expect(next.entries[index]).toBe(entry);
  });

  it("re-derives only the work entry whose tool item changed", () => {
    const fixture = makeStreamingTimelineFixture("Partial");
    const visibleTurnItems = fixture.visibleTurnItems.map((row) =>
      row.item.id === "live-work"
        ? { ...row, item: { ...row.item, status: "running" as const, completedAt: null } }
        : row,
    );
    const input = { visibleTurnItems, optimisticMessages: [] };
    const previous = deriveTimelineEntriesFromVisibleTurnItemsWithState(input);
    const nextInput = { ...input, visibleTurnItems: fixture.visibleTurnItems };
    const next = deriveTimelineEntriesFromVisibleTurnItemsWithState(nextInput, previous);
    expect(next.entries).toEqual(deriveTimelineEntriesFromVisibleTurnItems(nextInput));
    for (const [index, entry] of previous.entries.entries()) {
      if (entry.id === "live-work") expect(next.entries[index]).not.toBe(entry);
      else expect(next.entries[index]).toBe(entry);
    }

    const anchoredInput = {
      ...nextInput,
      anchoredMessages: [
        {
          id: MessageId.make("feedback"),
          runId: null,
          role: "assistant" as const,
          text: "Feedback received",
          streaming: false,
          createdAt: fixture.time(6),
          updatedAt: fixture.time(6),
        },
      ],
    };
    const anchored = deriveTimelineEntriesFromVisibleTurnItemsWithState(anchoredInput);
    const movedInput = {
      ...anchoredInput,
      visibleTurnItems: anchoredInput.visibleTurnItems.map((row) =>
        row.item.id === "live-work"
          ? { ...row, item: { ...row.item, startedAt: DateTime.makeUnsafe(fixture.time(8)) } }
          : row,
      ),
    };
    expect(
      deriveTimelineEntriesFromVisibleTurnItemsWithState(movedInput, anchored).entries,
    ).toEqual(deriveTimelineEntriesFromVisibleTurnItems(movedInput));
  });

  it.each(["completion", "provenance", "ordering", "attachment", "run"] as const)(
    "rebuilds entries for a %s change instead of retaining stale v2 metadata",
    (change) => {
      const fixture = makeStreamingTimelineFixture("Partial");
      const input = { visibleTurnItems: fixture.visibleTurnItems, optimisticMessages: [] };
      const previous = deriveTimelineEntriesFromVisibleTurnItemsWithState(input);
      const last = fixture.visibleTurnItems.at(-1)!;
      if (last.item.type !== "assistant_message") throw new Error("Expected assistant fixture");
      const changed =
        change === "provenance"
          ? { ...last, sourceThreadId: ThreadId.make("inherited-thread") }
          : {
              ...last,
              item:
                change === "completion"
                  ? { ...last.item, streaming: false, status: "completed" as const }
                  : change === "ordering"
                    ? { ...last.item, startedAt: DateTime.makeUnsafe(fixture.time(0)) }
                    : change === "run"
                      ? { ...last.item, runId: fixture.historyRunId }
                      : {
                          ...last.item,
                          attachments: [
                            {
                              type: "image",
                              id: "new-image",
                              name: "new.png",
                              mimeType: "image/png",
                              sizeBytes: 42,
                            },
                          ],
                        },
            };
      const nextInput = {
        ...input,
        visibleTurnItems: [...input.visibleTurnItems.slice(0, -1), changed],
      };
      const next = deriveTimelineEntriesFromVisibleTurnItemsWithState(nextInput, previous);
      expect(next.entries).toEqual(deriveTimelineEntriesFromVisibleTurnItems(nextInput));
      expect(next.entries.at(-1)).not.toBe(previous.entries.at(-1));
    },
  );

  it("deduplicates optimistic sends when committed items arrive and retains anchored ordering", () => {
    const fixture = makeStreamingTimelineFixture();
    const input = {
      visibleTurnItems: fixture.visibleTurnItems.slice(0, 3),
      optimisticMessages: [
        {
          id: MessageId.make("live-user"),
          runId: null,
          role: "user" as const,
          text: "Continue",
          streaming: false,
          createdAt: fixture.time(5),
          updatedAt: fixture.time(5),
        },
      ],
      anchoredMessages: [
        {
          id: MessageId.make("feedback"),
          runId: null,
          role: "assistant" as const,
          text: "Feedback received",
          streaming: false,
          createdAt: fixture.time(4),
          updatedAt: fixture.time(4),
        },
      ],
    };
    const previous = deriveTimelineEntriesFromVisibleTurnItemsWithState(input);
    const nextInput = { ...input, visibleTurnItems: fixture.visibleTurnItems };
    const next = deriveTimelineEntriesFromVisibleTurnItemsWithState(nextInput, previous);
    expect(next.entries).toEqual(deriveTimelineEntriesFromVisibleTurnItems(nextInput));
    expect(next.entries.filter((entry) => entry.id === "live-user")).toHaveLength(1);
    expect(next.entries.map((entry) => entry.id)).toEqual([
      "history-user",
      "history-work",
      "history-assistant",
      "feedback",
      "live-user",
      "live-work",
      "live-assistant",
    ]);
  });

  it("keeps every other entry when streaming plan text changes", () => {
    const fixture = makeStreamingWorkTimelineFixture("proposed_plan");
    // Codex emits `plan.updated` with each delta, so the artifact array is rebuilt too.
    const plans = (markdown: string) => [streamingPlanArtifact(fixture, markdown, "active")];
    let input = {
      visibleTurnItems: withStreamedText(
        fixture.visibleTurnItems,
        fixture.streamingItemId,
        "Let",
        fixture.time(20),
      ),
      optimisticMessages: [],
      plans: plans("Let"),
    };
    let projection = deriveTimelineEntriesFromVisibleTurnItemsWithState(input);
    for (const [step, text] of ["Let me", "Let me check the tests"].entries()) {
      input = {
        visibleTurnItems: withStreamedText(
          input.visibleTurnItems,
          fixture.streamingItemId,
          text,
          fixture.time(21 + step),
        ),
        optimisticMessages: [],
        plans: plans(text),
      };
      const previous = projection;
      projection = deriveTimelineEntriesFromVisibleTurnItemsWithState(input, previous);
      expect(projection.entries).toEqual(deriveTimelineEntriesFromVisibleTurnItems(input));
      for (const [index, entry] of previous.entries.entries()) {
        if (entry.id !== fixture.streamingItemId) expect(projection.entries[index]).toBe(entry);
      }
    }
  });

  it("rebuilds the plan entry when only its artifact status changes", () => {
    const fixture = makeStreamingWorkTimelineFixture("proposed_plan");
    const visibleTurnItems = withStreamedText(
      fixture.visibleTurnItems,
      fixture.streamingItemId,
      "Plan",
      fixture.time(20),
    );
    const previous = deriveTimelineEntriesFromVisibleTurnItemsWithState({
      visibleTurnItems,
      optimisticMessages: [],
      plans: [streamingPlanArtifact(fixture, "Plan", "active")],
    });
    const input = {
      visibleTurnItems,
      optimisticMessages: [],
      plans: [streamingPlanArtifact(fixture, "Plan", "superseded")],
    };
    const next = deriveTimelineEntriesFromVisibleTurnItemsWithState(input, previous);
    expect(next.entries).toEqual(deriveTimelineEntriesFromVisibleTurnItems(input));
    expect(next.entries.find((entry) => entry.kind === "proposed-plan")).toMatchObject({
      proposedPlan: { status: "superseded" },
    });
  });
});
