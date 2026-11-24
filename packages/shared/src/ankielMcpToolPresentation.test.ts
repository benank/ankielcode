import { describe, expect, it } from "vite-plus/test";

import {
  ANKIEL_MCP_TOOL_NAMES,
  resolveAnkielMcpSummaryAction,
  resolveAnkielMcpToolDefinition,
  resolveAnkielMcpToolPresentation,
} from "./ankielMcpToolPresentation.ts";

describe("resolveAnkielMcpToolPresentation", () => {
  it("recognizes every Ankiel tool across provider prefixes and completion suffixes", () => {
    for (const tool of ANKIEL_MCP_TOOL_NAMES) {
      const presentation = resolveAnkielMcpToolPresentation(tool);
      for (const prefix of [
        "mcp__ankiel-code__",
        "mcp__ankiel_code__",
        "mcp__ankielcode__",
        "Ankiel-code.",
        "ankielcode.",
        "ankiel-code-direct.",
        "mcp__ankiel_code_direct__",
        "ankiel_code/",
        "ankielcode:",
        "mcp_ankiel-code_",
        "Ankiel Code ",
        "ankiel-code · ",
      ]) {
        expect(resolveAnkielMcpToolPresentation(`${prefix}${tool} completed`), tool).toEqual(
          presentation,
        );
      }
      expect(resolveAnkielMcpToolPresentation(`mcp__another-server__${tool}`), tool).toBeNull();
    }
  });

  it("matches OpenCode 2's per-thread server names, whose thread ids hold underscores", () => {
    expect(
      resolveAnkielMcpToolPresentation("ankiel-code-thread_opencode2-adapter_delegate_task")
        ?.displayName,
    ).toBe("Delegate a child task");
    expect(
      resolveAnkielMcpToolPresentation("ankiel-code-thread_opencode2-adapter_not_a_tool"),
    ).toBeNull();
  });
});

describe("resolveAnkielMcpToolDefinition", () => {
  it("labels an action tool call as the action it ran", () => {
    expect(
      resolveAnkielMcpToolDefinition("mcp__ankiel-code__preview_act", { action: "type" })?.labels,
    ).toEqual(resolveAnkielMcpToolDefinition("preview_type")?.labels);
    expect(
      resolveAnkielMcpToolDefinition("ankiel_thread_transfer", { action: "fork" })?.displayName,
    ).toBe(resolveAnkielMcpToolDefinition("ankiel_thread_fork")?.displayName);
    expect(resolveAnkielMcpToolDefinition("preview_act", { action: "unknown" })?.labels[2]).toBe(
      "Used",
    );
  });
});

describe("resolveAnkielMcpSummaryAction", () => {
  it("summarizes an action tool by the action each call ran", () => {
    expect(
      resolveAnkielMcpSummaryAction("mcp__ankiel-code__ankiel_queue", { action: "list" }),
    ).toBe("queue-list");
    expect(resolveAnkielMcpSummaryAction("ankiel_queue", { action: "edit" })).toBe("queue-edit");
    expect(resolveAnkielMcpSummaryAction("ankiel_thread_transfer", { action: "status" })).toBe(
      "thread-transfers",
    );
    expect(resolveAnkielMcpSummaryAction("ankiel_thread_configure", {})).toBe(
      "thread-configuration",
    );
    expect(resolveAnkielMcpSummaryAction("schedule_task", { scheduledTaskId: "task-1" })).toBe(
      "schedule-update",
    );
    expect(resolveAnkielMcpSummaryAction("delegate_task", { task: "x" })).toBe("delegate");
  });
});
