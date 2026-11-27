import { ThreadId } from "@ankielcode/contracts";
import { TurnItemId } from "@ankielcode/contracts";
import { type TimelineEntry } from "../../session-logic";
import { describe, expect, it } from "vite-plus/test";
import { MessageId, RunId } from "@ankielcode/contracts";
import {
  deriveMessagesTimelineRows,
  resolveAssistantMessageCopyState,
} from "./MessagesTimeline.logic";

describe("resolveAssistantMessageCopyState", () => {
  it("copies the rendered representation of Codex directives", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: true,
        text: [
          'Created :codex-file-citation{path="outputs/report.xlsx" purpose="output"}.',
          "",
          '::artifact-template{skill_name="artifact-template-hello-world" skill_directory="/Users/test/.codex/skills/artifact-template-hello-world" display_name="Hello World" artifact_kind="document"}',
        ].join("\n"),
        streaming: false,
      }),
    ).toEqual({
      text: "Created [report.xlsx](<outputs/report.xlsx>).\n\nHello World (Document template)",
      visible: true,
    });
  });
});

describe("deriveMessagesTimelineRows", () => {
  it.each([
    ["html-render", "reply-run", true],
    ["mcp-app", "reply-run", true],
    ["html-render", "other-run", false],
    ["html-render", null, false],
    [null, null, false],
  ] as const)("suppresses the empty fallback for %s in %s: %s", (kind, renderRun, expected) => {
    const at = "2026-11-06T00:00:00Z";
    const runId = RunId.make("reply-run");
    const renderBase = {
      id: "render",
      createdAt: at,
      runId: renderRun ? RunId.make(renderRun) : null,
    };
    const embedded: TimelineEntry[] =
      kind === "html-render"
        ? [
            {
              ...renderBase,
              kind,
              htmlRender: { attachmentId: "preview", title: "Preview", height: 420 },
            },
          ]
        : kind === "mcp-app"
          ? [
              {
                ...renderBase,
                kind,
                sourceThreadId: ThreadId.make("thread"),
                itemId: TurnItemId.make("app"),
                revision: "1",
                mcpApp: {
                  attachmentId: "app",
                  server: "weather",
                  tool: "weather",
                  resourceUri: "ui://weather",
                },
              },
            ]
          : [];
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        ...embedded,
        {
          kind: "message",
          id: "reply",
          createdAt: at,
          message: {
            id: MessageId.make("reply"),
            role: "assistant",
            runId,
            text: "",
            streaming: false,
            createdAt: at,
            updatedAt: at,
          },
        },
      ],
      latestRun: null,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    const reply = rows.find((row) => row.kind === "message" && row.id === "reply");
    expect(reply).toMatchObject({ suppressEmptyResponse: expected });
  });

  it.each(["alone", "before tool", "before commentary and tool"])(
    "keeps an unfinished task update static %s",
    (placement) => {
      const runId = RunId.make("task-update-run");
      const at = "2026-11-06T00:00:00Z";
      const tasks: TimelineEntry = {
        kind: "work",
        id: "tasks",
        createdAt: at,
        entry: {
          id: "tasks",
          runId,
          createdAt: at,
          itemType: "todo_list",
          tone: "info",
          label: "Tasks 0/1 · Inspect the captures",
          toolLifecycleStatus: "inProgress",
        },
      };
      const commentary: TimelineEntry = {
        kind: "message",
        id: "commentary",
        createdAt: at,
        message: {
          id: MessageId.make("commentary"),
          role: "assistant",
          text: "Checking the rendering.",
          runId,
          streaming: false,
          createdAt: at,
          updatedAt: at,
        },
      };
      const tool: TimelineEntry = {
        kind: "work",
        id: "tool",
        createdAt: at,
        entry: {
          id: "tool",
          runId,
          createdAt: at,
          label: "Running sed",
          command: "sed",
          tone: "tool",
          toolLifecycleStatus: "inProgress",
        },
      };
      const rows = deriveMessagesTimelineRows({
        timelineEntries: [
          tasks,
          ...(placement === "before commentary and tool" ? [commentary] : []),
          ...(placement === "alone" ? [] : [tool]),
        ],
        runningRunId: runId,
        isWorking: true,
        activeTurnStartedAt: at,
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });
      expect(rows.find((row) => row.id === "tasks")).toMatchObject({
        kind: "work",
        groupedEntries: [tasks.entry],
      });
      expect(rows.filter((row) => row.kind === "work-live" && row.active)).toEqual(
        placement === "alone" ? [] : [expect.objectContaining({ entry: tool.entry })],
      );
    },
  );
});

describe("v2 run and attempt history", () => {
  it("folds settled-turn commentary and work behind a Worked-for row", () => {
    const timelineEntries = [
      {
        id: "user-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:00Z",
        message: {
          id: "user-1" as never,
          role: "user" as const,
          text: "Build it",
          runId: null,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          streaming: false,
        },
      },
      {
        id: "assistant-thought-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:05Z",
        message: {
          id: "assistant-thought" as never,
          role: "assistant" as const,
          text: "Looking around first.",
          runId: "turn-1" as never,
          createdAt: "2026-01-01T00:00:05Z",
          updatedAt: "2026-01-01T00:00:06Z",
          streaming: false,
        },
      },
      {
        id: "work-entry-1",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:08Z",
        entry: {
          id: "work-1",
          createdAt: "2026-01-01T00:00:08Z",
          runId: "turn-1" as never,
          label: "Ran command",
          tone: "tool" as const,
        },
      },
      {
        id: "provider-recovered-entry",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:09Z",
        entry: {
          id: "provider-recovered",
          createdAt: "2026-01-01T00:00:09Z",
          runId: "turn-1" as never,
          label: "Provider recovered (2/5 retries)",
          tone: "info" as const,
          itemType: "error" as const,
          toolLifecycleStatus: "completed" as const,
        },
      },
      {
        id: "thread-created-entry",
        kind: "event" as const,
        createdAt: "2026-01-01T00:00:10Z",
        projectedItem: {
          item: {
            type: "thread_created",
          },
        } as never,
      },
      {
        id: "assistant-final-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:20Z",
        message: {
          id: "assistant-final" as never,
          role: "assistant" as const,
          text: "Done",
          runId: "turn-1" as never,
          createdAt: "2026-01-01T00:00:20Z",
          updatedAt: "2026-01-01T00:00:22Z",
          streaming: false,
        },
      },
    ];

    const collapsedRows = deriveMessagesTimelineRows({
      timelineEntries,
      isWorking: false,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    const foldRow = collapsedRows.find(
      (row): row is Extract<(typeof collapsedRows)[number], { kind: "turn-fold" }> =>
        row.kind === "turn-fold",
    );
    expect(foldRow?.runId).toBe("turn-1");
    expect(foldRow?.expanded).toBe(false);
    expect(foldRow?.label).toBe("Worked for 22s");
    expect(collapsedRows.map((row) => row.id)).toEqual([
      "user-entry",
      "turn-fold:turn-1",
      "thread-created-entry",
      "assistant-final-entry",
    ]);

    const expandedRows = deriveMessagesTimelineRows({
      timelineEntries,
      expandedRunIds: new Set(["turn-1" as never]),
      isWorking: false,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    expect(expandedRows.map((row) => row.id)).toEqual([
      "user-entry",
      "turn-fold:turn-1",
      "assistant-thought-entry",
      "work-toggle:work-entry-1",
      "thread-created-entry",
      "assistant-final-entry",
    ]);
    expect(
      expandedRows.find((row) => row.kind === "turn-fold" && row.expanded === true),
    ).toBeDefined();
    const openedActivity = deriveMessagesTimelineRows({
      timelineEntries,
      expandedRunIds: new Set(["turn-1" as never]),
      expandedWorkGroupIds: new Set(["work-group:work-entry-1"]),
      isWorking: false,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    const expandedWork = openedActivity.find((row) => row.kind === "work");
    expect(expandedWork?.kind === "work" ? expandedWork.groupedEntries : []).toEqual([
      expect.objectContaining({ id: "work-1" }),
      expect.objectContaining({ id: "provider-recovered" }),
    ]);
  });
});
