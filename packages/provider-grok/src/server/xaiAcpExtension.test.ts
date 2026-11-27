import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";

import {
  extractXAiAcpSubagentUpdate,
  extractXAiBackgroundTaskCompletion,
  extractXAiMonitorTaskId,
  isXAiMonitorTool,
  normalizeXAiAcpToolCallState,
  xAiBackgroundTaskLifecycleMutation,
  xAiPromptCompleteFromSessionUpdate,
} from "./xaiAcpExtension.ts";
import {
  type AcpToolCallState,
  extractMcpToolCallIdentity,
  mergeToolCallState,
  parseSessionUpdateEvent,
} from "@ankielcode/provider-acp/server/runtimeModel";
import { compactDynamicToolOutput, htmlRenderFromToolItem } from "@ankielcode/shared/toolOutput";

describe("xAiPromptCompleteFromSessionUpdate", () => {
  it("ignores non-turn updates and task-completed prompt ids", () => {
    expect(
      xAiPromptCompleteFromSessionUpdate({
        sessionId: "root",
        update: { sessionUpdate: "hook_execution", prompt_id: "ankiel-xai-prompt-1" },
      }),
    ).toBeNull();
    expect(
      xAiPromptCompleteFromSessionUpdate({
        sessionId: "root",
        update: {
          sessionUpdate: "turn_completed",
          prompt_id: "task-completed-call-abc",
          stop_reason: "end_turn",
        },
      }),
    ).toBeNull();
    expect(
      xAiPromptCompleteFromSessionUpdate({
        sessionId: "root",
        update: { sessionUpdate: "turn_completed", stop_reason: "end_turn" },
      }),
    ).toBeNull();
  });
});

function parseRecordedToolCallUpdate(update: Record<string, unknown>): AcpToolCallState {
  const [event] = parseSessionUpdateEvent({
    sessionId: "01a0d660-c1bb-7842-91a3-02d91dc8b0d2",
    update,
  } as Parameters<typeof parseSessionUpdateEvent>[0]).events;
  if (event?._tag !== "ToolCallUpdated") throw new Error("expected a tool call update");
  return event.toolCall;
}

describe("XAiAcpExtension", () => {
  it("recognizes Grok Task starts as native subagents", () => {
    expect(
      extractXAiAcpSubagentUpdate({
        toolCallId: "task-1",
        title: "Task",
        status: "inProgress",
        data: {
          rawInput: {
            description: "Explore server architecture",
            prompt: "Audit apps/server.",
            subagent_type: "generalPurpose",
            model: "composer-2.5-fast",
          },
        },
      }),
    ).toEqual({
      nativeTaskId: "task-1",
      prompt: "Audit apps/server.",
      title: "Explore server architecture",
      model: "composer-2.5-fast",
      status: "running",
      childSessionId: null,
      result: null,
      suppressNormalTool: true,
    });
  });

  it("extracts Grok child session lineage from completed Task output", () => {
    expect(
      extractXAiAcpSubagentUpdate({
        toolCallId: "task-1",
        title: "Task",
        status: "completed",
        data: {
          rawInput: {
            description: "Explore server architecture",
            prompt: "Audit apps/server.",
            subagent_type: "generalPurpose",
          },
          rawOutput: {
            type: "Text",
            text: [
              "Server audit complete.",
              "",
              "Agent ID: 019f0220-e192-7c41-9e9d-b406bc3459c8 (resume supported)",
            ].join("\n"),
          },
        },
      }),
    ).toEqual({
      nativeTaskId: "task-1",
      prompt: "Audit apps/server.",
      title: "Explore server architecture",
      model: null,
      status: "completed",
      childSessionId: "019f0220-e192-7c41-9e9d-b406bc3459c8",
      result: "Server audit complete.",
      suppressNormalTool: true,
    });
  });

  it("keeps async spawn_subagent ACKs running and binds subagent_id", () => {
    expect(
      extractXAiAcpSubagentUpdate({
        toolCallId: "call-spawn-1",
        title: "spawn_subagent",
        status: "completed",
        data: {
          rawInput: {
            description: "Demo subagent wait and ls",
            prompt: "Wait then ls.",
            subagent_type: "general-purpose",
          },
          rawOutput: {
            type: "Text",
            text: [
              "Subagent started in background.",
              "subagent_id: 019f44a6-4820-7402-925d-bc862ee711dd",
              "type: general-purpose",
              "description: Demo subagent wait and ls",
              "",
              'Use get_command_or_subagent_output with task_ids=["019f44a6-4820-7402-925d-bc862ee711dd"] and timeout_ms to wait for results.',
            ].join("\n"),
          },
        },
      }),
    ).toEqual({
      nativeTaskId: "call-spawn-1",
      prompt: "Wait then ls.",
      title: "Demo subagent wait and ls",
      model: null,
      status: "running",
      childSessionId: "019f44a6-4820-7402-925d-bc862ee711dd",
      result: null,
      suppressNormalTool: true,
    });
  });

  it("hydrates subagent completion from get_command_or_subagent_output", () => {
    expect(
      extractXAiAcpSubagentUpdate({
        toolCallId: "call-get-1",
        title: "get_command_or_subagent_output",
        status: "completed",
        data: {
          rawInput: {
            task_ids: ["019f44a6-4820-7402-925d-bc862ee711dd"],
            timeout_ms: 30000,
          },
          rawOutput: {
            type: "Text",
            text: [
              "=== Task 019f44a6-4820-7402-925d-bc862ee711dd ===",
              "Status: completed",
              "Exit Code: 0",
              "",
              "=== Output ===",
              "SUBAGENT_MARKER: 35 entries",
            ].join("\n"),
          },
        },
      }),
    ).toEqual({
      nativeTaskId: "call-get-1",
      prompt: "",
      title: null,
      model: null,
      status: "completed",
      childSessionId: "019f44a6-4820-7402-925d-bc862ee711dd",
      result: "SUBAGENT_MARKER: 35 entries",
      suppressNormalTool: true,
    });
  });

  it("attributes multi-task get_output envelopes to the result task_id", () => {
    expect(
      extractXAiAcpSubagentUpdate({
        toolCallId: "call-get-multi",
        title: "get_command_or_subagent_output",
        status: "completed",
        data: {
          rawInput: {
            task_ids: [
              "019f44a6-4820-7402-925d-bc862ee711dd",
              "019f44b0-1b73-7f32-bb1b-1ff696f536e3",
            ],
            timeout_ms: 30000,
          },
          rawOutput: {
            type: "TaskOutput",
            Result: {
              task_id: "019f44b0-1b73-7f32-bb1b-1ff696f536e3",
              status: "completed",
              exit_code: 0,
              output: "SECOND_SUB_DONE\n",
            },
          },
        },
      }),
    ).toMatchObject({
      childSessionId: "019f44b0-1b73-7f32-bb1b-1ff696f536e3",
      status: "completed",
      result: "SECOND_SUB_DONE",
    });
  });

  it("does not treat a subagent_id mentioned in result text as the completed identity", () => {
    const requestedTaskId = "019f44a6-4820-7402-925d-bc862ee711dd";
    const mentionedTaskId = "019f44b0-1b73-7f32-bb1b-1ff696f536e3";
    const toolCall = {
      toolCallId: "call-get-mentioned-id",
      title: "get_command_or_subagent_output",
      status: "completed" as const,
      data: {
        rawInput: {
          variant: "TaskOutput",
          task_ids: [requestedTaskId],
        },
        rawOutput: {
          type: "TaskOutput",
          Result: {
            status: "completed",
            exit_code: 0,
            output: `Audited subagent_id: ${mentionedTaskId}; no issues found.`,
          },
        },
      },
    };

    expect(extractXAiAcpSubagentUpdate(toolCall)).toMatchObject({
      childSessionId: requestedTaskId,
      status: "completed",
    });
    expect(extractXAiBackgroundTaskCompletion(toolCall)).toEqual([
      {
        taskId: requestedTaskId,
        status: "completed",
        appendOutput: `Audited subagent_id: ${mentionedTaskId}; no issues found.`,
      },
    ]);
  });

  it("does not leak raw machine tags when get_output is only meta/result blocks", () => {
    const metaOnlyToolCall = {
      toolCallId: "call-get-meta-only",
      title: "get_command_or_subagent_output",
      status: "completed" as const,
      data: {
        rawInput: {
          variant: "TaskOutput",
          task_ids: ["019f44b0-1b73-7f32-bb1b-1ff696f536e3"],
          timeout_ms: 20000,
        },
        rawOutput: {
          type: "TaskOutput",
          Result: {
            task_id: "019f44b0-1b73-7f32-bb1b-1ff696f536e3",
            status: "completed",
            exit_code: 0,
            output:
              "<subagent_meta>id=019f44b0-1b73-7f32-bb1b-1ff696f536e3</subagent_meta>\n<subagent_result>done</subagent_result>\n",
          },
        },
      },
    };
    expect(extractXAiAcpSubagentUpdate(metaOnlyToolCall)).toEqual({
      nativeTaskId: "call-get-meta-only",
      prompt: "",
      title: null,
      model: null,
      status: "completed",
      childSessionId: "019f44b0-1b73-7f32-bb1b-1ff696f536e3",
      result: null,
      suppressNormalTool: true,
    });
    expect(extractXAiBackgroundTaskCompletion(metaOnlyToolCall)).toEqual([
      {
        taskId: "019f44b0-1b73-7f32-bb1b-1ff696f536e3",
        status: "completed",
        appendOutput: "",
      },
    ]);
  });

  it("tracks text Monitor ACKs with generic titles and description-only input", () => {
    const toolCall = {
      toolCallId: "call-mon-generic-text",
      title: "Tool",
      status: "completed" as const,
      data: {
        rawInput: {
          command: "echo mon_line_1",
          description: "Demo monitor without variant",
        },
        rawOutput: {
          type: "Text",
          text: "Monitor started (task 019f44a5-87d1-7640-8e35-6a4667ffc873, timeout 36000000ms).\nYou will be notified on each event.",
        },
      },
    };

    const normalized = normalizeXAiAcpToolCallState(toolCall);
    expect(isXAiMonitorTool(normalized)).toBe(true);
    expect(normalized.status).toBe("inProgress");
    expect(extractXAiMonitorTaskId(normalized)).toBe("019f44a5-87d1-7640-8e35-6a4667ffc873");
  });

  // regression: #23714 Recorded from Grok 1.0.77 calling stdio MCP tools through `use_tool`.
  it("rewrites use_tool MCP calls and results into the generic ACP MCP shapes", () => {
    const meta = { "x.ai/tool": { version: 1, name: "use_tool", kind: "use_tool" } };
    const grokCall = (
      toolCallId: string,
      tool: string,
      toolInput: Record<string, unknown>,
      completion: Record<string, unknown>,
    ) => {
      const rawInput = { tool_name: tool, tool_input: toolInput };
      const updates = [
        { sessionUpdate: "tool_call", toolCallId, title: "use_tool", rawInput, _meta: meta },
        {
          sessionUpdate: "tool_call_update",
          toolCallId,
          kind: "other",
          title: tool,
          rawInput: { variant: "UseTool", ...rawInput },
          _meta: meta,
        },
        { sessionUpdate: "tool_call_update", toolCallId, ...completion },
      ];
      let state: AcpToolCallState | undefined;
      for (const update of updates) {
        state = normalizeXAiAcpToolCallState(
          mergeToolCallState(state, parseRecordedToolCallUpdate(update)),
        );
      }
      return state!;
    };
    const page = { attachmentId: "abc-html", title: "T", height: 300 };

    const rendered = grokCall(
      "call-85597c6c-6fb8-4c9c-a6a8-12c4a74ebc96-1",
      "ankiel-code__html_render",
      { path: "a.html" },
      {
        status: "completed",
        rawOutput: {
          type: "MCP",
          tool_name: "html_render",
          server_name: "ankiel-code",
          output: { OkayOutput: JSON.stringify({ htmlRender: page, message: "Shown" }) },
        },
      },
    );
    expect(extractMcpToolCallIdentity(rendered)).toEqual({
      server: "ankiel-code",
      tool: "html_render",
    });
    expect(rendered.data.rawInput).toMatchObject({ arguments: { path: "a.html" } });
    expect(
      htmlRenderFromToolItem({
        toolName: "ankiel-code.html_render",
        output: rendered.data.rawOutput,
      }),
    ).toEqual(page);

    const failed = grokCall(
      "call-2baebdc5-2446-4ac2-9652-85f97a76a05b-2",
      "pencil__browser",
      { action: "load-page" },
      {
        status: "failed",
        rawOutput: {
          type: "MCP",
          tool_name: "browser",
          server_name: "pencil",
          output: { Error: "Page not found" },
          is_error: true,
        },
      },
    );
    expect(extractMcpToolCallIdentity(failed)).toEqual({ server: "pencil", tool: "browser" });
    expect(compactDynamicToolOutput(failed.data.rawOutput)?.isError).toBe(true);
  });

  it("keeps Monitor ticks running while Grok reports them in progress", () => {
    // Grok 1.0.41 ticks report in_progress with exit_code 0; only _x.ai/task_completed ends the monitor.
    const command = "for i in 1 2 3; do sleep 8; echo tick $i; done";
    const started = parseRecordedToolCallUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-6b025a4e-621c-4526-a579-ba86ada2669c-0",
      kind: "other",
      title: "Start monitor: Watch three ticks eight seconds apart",
      locations: [],
      rawInput: {
        variant: "Monitor",
        command,
        description: "Watch three ticks eight seconds apart",
        timeout_ms: 36000000,
        persistent: false,
      },
    });
    const tick = parseRecordedToolCallUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-6b025a4e-621c-4526-a579-ba86ada2669c-0",
      status: "in_progress",
      content: [{ type: "content", content: { type: "text", text: "tick 1\n" } }],
      rawOutput: {
        type: "Bash",
        output: [116, 105, 99, 107, 32, 49, 10],
        output_for_prompt: "tick 1\n",
        exit_code: 0,
        command,
        truncated: false,
        signal: null,
        timed_out: false,
        description: null,
        current_dir: "<workspace>",
        output_file: "",
        total_bytes: 7,
      },
    });
    const toolCall = normalizeXAiAcpToolCallState(mergeToolCallState(started, tick));
    expect(isXAiMonitorTool(toolCall)).toBe(true);
    expect(toolCall.status).toBe("inProgress");
  });

  it("finishes monitors from the recorded task_completed snapshot", () => {
    const completed = {
      sessionId: "01a0d660-c1bb-7842-91a3-02d91dc8b0d2",
      update: {
        sessionUpdate: "task_completed",
        task_snapshot: {
          task_id: "01a0d660-f98d-7ef3-a291-97af1c2b6455",
          command: "for i in 1 2 3; do sleep 8; echo tick $i; done",
          display_command: "[monitor] Watch three tick echoes",
          output: "tick 1\ntick 2\ntick 3\n",
          exit_code: 0,
          kind: "monitor",
          description: "Watch three tick echoes",
        },
      },
    };
    expect(xAiBackgroundTaskLifecycleMutation(completed, "completed")).toEqual({
      sessionId: "01a0d660-c1bb-7842-91a3-02d91dc8b0d2",
      taskId: "01a0d660-f98d-7ef3-a291-97af1c2b6455",
      status: "completed",
      output: "tick 1\ntick 2\ntick 3\n",
      report: { kind: "monitor", label: "Watch three tick echoes" },
    });
    expect(
      xAiBackgroundTaskLifecycleMutation(
        {
          ...completed,
          update: { ...completed.update, task_snapshot: { task_id: "t", exit_code: 2 } },
        },
        "completed",
      )?.status,
    ).toBe("failed");
  });

  it("detects Monitor start ACKs from structured rawOutput when title is generic", () => {
    const toolCall = {
      toolCallId: "call-mon-generic-title",
      title: "Tool",
      status: "completed" as const,
      data: {
        rawInput: {
          command: "echo mon_line",
          description: "Demo monitor without variant",
        },
        rawOutput: {
          type: "Monitor",
          taskId: "019f44a5-87d1-7640-8e35-6a4667ffc873",
          timeoutMs: 36000000,
          persistent: false,
        },
      },
    };
    expect(isXAiMonitorTool(toolCall)).toBe(true);
    expect(normalizeXAiAcpToolCallState(toolCall).status).toBe("inProgress");
    expect(extractXAiMonitorTaskId(toolCall)).toBe("019f44a5-87d1-7640-8e35-6a4667ffc873");
  });

  it("completes status-less Bash results despite generic titles", () => {
    const toolCall = {
      toolCallId: "call-wake-1",
      title: "Tool",
      data: {
        rawInput: {},
        rawOutput: {
          type: "Bash",
          output: Array.from(new TextEncoder().encode("STREAM_1\nSTREAM_DONE\n")),
          output_for_prompt: "STREAM_1\nSTREAM_DONE\n",
          exit_code: 0,
          command: "for i in 1 2; do echo STREAM_$i; done; echo STREAM_DONE",
        },
      },
    };
    expect(isXAiMonitorTool(toolCall)).toBe(false);
    const normalized = normalizeXAiAcpToolCallState(toolCall);
    expect(normalized.status).toBe("completed");
    expect(normalized.title).toBe("for i in 1 2; do echo STREAM_$i; done; echo STREAM_DONE");
    expect(
      normalizeXAiAcpToolCallState({
        ...toolCall,
        data: {
          ...toolCall.data,
          rawOutput: {
            ...toolCall.data.rawOutput,
            command: `git commit -m "${"x".repeat(61)}🎉 ship it"`,
          },
        },
      }).title,
    ).toBe(`git commit -m "${"x".repeat(61)}...`);
    expect(
      normalizeXAiAcpToolCallState({
        ...toolCall,
        data: {
          ...toolCall.data,
          rawOutput: { ...toolCall.data.rawOutput, exit_code: 2 },
        },
      }).status,
    ).toBe("failed");
  });

  it("keeps empty successful Bash updates running until native output or turn settlement", () => {
    const normalized = normalizeXAiAcpToolCallState({
      toolCallId: "call-bash-permission-ack",
      title: "Ran command",
      status: "completed",
      data: {
        rawInput: { command: "sleep 40" },
        rawOutput: { type: "Bash", exit_code: 0 },
      },
    });
    expect(normalized.status).toBe("inProgress");
  });
});
