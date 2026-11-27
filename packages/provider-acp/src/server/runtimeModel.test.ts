import { describe, expect, it } from "vite-plus/test";

import type * as EffectAcpSchema from "effect-acp/compat";

import {
  decideToolCallUpdateEmission,
  mergeToolCallState,
  parsePermissionRequest,
  parseSessionModeState,
  parseSessionUpdateEvent,
  sessionModelStateFromInitialize,
  sessionUpdateCountsAsLoadReplayActivity,
  sessionUpdateIsReplay,
  syntheticLoadSessionResponseFromInitialize,
  toolCallVisibleOutputChanged,
  withTrackedPermissionToolCall,
  type AcpToolCallState,
} from "./runtimeModel.ts";

describe("AcpRuntimeModel", () => {
  it("parses session mode state from typed ACP session setup responses", () => {
    const modeState = parseSessionModeState({
      sessionId: "session-1",
      modes: {
        currentModeId: " code ",
        availableModes: [
          { id: " ask ", name: " Ask ", description: " Request approval " },
          { id: " code ", name: " Code " },
        ],
      },
      configOptions: [],
    } satisfies EffectAcpSchema.NewSessionResponse);

    expect(modeState).toEqual({
      currentModeId: "code",
      availableModes: [
        { id: "ask", name: "Ask", description: "Request approval" },
        { id: "code", name: "Code" },
      ],
    });
  });

  it("detects Grok session replay updates from _meta.isReplay", () => {
    expect(
      sessionUpdateIsReplay({
        _meta: { isReplay: true },
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "replayed" },
        },
      } satisfies EffectAcpSchema.SessionNotification),
    ).toBe(true);
    expect(
      sessionUpdateIsReplay({
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "live" },
        },
      } satisfies EffectAcpSchema.SessionNotification),
    ).toBe(false);
  });

  it("ignores Grok keepalive chunks when tracking session/load replay activity", () => {
    expect(
      sessionUpdateCountsAsLoadReplayActivity({
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "" },
        },
      } satisfies EffectAcpSchema.SessionNotification),
    ).toBe(false);
    expect(
      sessionUpdateCountsAsLoadReplayActivity({
        _meta: { isReplay: true },
        sessionId: "session-1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "replay-tool",
          title: "Replay",
          kind: "search",
          status: "completed",
        },
      } satisfies EffectAcpSchema.SessionNotification),
    ).toBe(true);
  });

  it("ignores load-replay activity from other sessions while a load gate is active", () => {
    expect(
      sessionUpdateCountsAsLoadReplayActivity(
        {
          sessionId: "session-other",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "unrelated" },
          },
        } satisfies EffectAcpSchema.SessionNotification,
        "session-loading",
      ),
    ).toBe(false);
    expect(
      sessionUpdateCountsAsLoadReplayActivity(
        {
          sessionId: "session-loading",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "replay" },
          },
        } satisfies EffectAcpSchema.SessionNotification,
        "session-loading",
      ),
    ).toBe(true);
  });

  it("ignores malformed initialize mode state in synthetic load responses", () => {
    const response = syntheticLoadSessionResponseFromInitialize({
      protocolVersion: 1,
      _meta: {
        modeState: {
          currentModeId: "code",
          availableModes: [{ id: "code", name: 12 }],
        },
      },
    } as EffectAcpSchema.InitializeResponse);

    expect(response.modes).toBeUndefined();
    expect(response._meta).toMatchObject({ ankielSessionLoadReady: "replay_idle" });
  });

  it("keeps initialize mode state whose modes have null descriptions", () => {
    const response = syntheticLoadSessionResponseFromInitialize({
      protocolVersion: 1,
      _meta: {
        modeState: {
          currentModeId: "code",
          availableModes: [
            { id: "ask", name: "Ask", description: null },
            { id: "code", name: "Code", description: "Edit files", _meta: null },
          ],
          _meta: null,
        },
      },
    } satisfies EffectAcpSchema.InitializeResponse);

    expect(parseSessionModeState(response)).toEqual({
      currentModeId: "code",
      availableModes: [
        { id: "ask", name: "Ask" },
        { id: "code", name: "Code", description: "Edit files" },
      ],
    });
  });

  it("reads initialize model state and ignores malformed model state", () => {
    const modelState = {
      currentModelId: "grok-4.7",
      availableModels: [
        {
          modelId: "grok-4.7",
          name: "Grok 4.7",
          description: null,
          _meta: { reasoningEfforts: [{ id: "high", default: true }] },
        },
        { modelId: "grok-4.6", name: "Grok 4.6" },
      ],
    };

    expect(sessionModelStateFromInitialize({ protocolVersion: 1, _meta: { modelState } })).toEqual(
      modelState,
    );
    expect(
      sessionModelStateFromInitialize({
        protocolVersion: 1,
        _meta: {
          modelState: { currentModelId: "grok-4.7", availableModels: [{ modelId: "grok-4.7" }] },
        },
      }),
    ).toBeUndefined();
    expect(
      sessionModelStateFromInitialize({
        protocolVersion: 1,
        _meta: { modelState: { ...modelState, _meta: "not an object" } },
      }),
    ).toBeUndefined();
  });

  it("projects typed ACP tool call updates into runtime events", () => {
    const created = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "Terminal",
        kind: "execute",
        status: "pending",
        rawInput: {
          executable: "bun",
          args: ["run", "typecheck"],
        },
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "Running checks",
            },
          },
        ],
      },
    } satisfies EffectAcpSchema.SessionNotification);

    expect(created.events).toEqual([
      {
        _tag: "ToolCallUpdated",
        toolCall: {
          toolCallId: "tool-1",
          kind: "execute",
          title: "Ran command",
          status: "pending",
          command: "bun run typecheck",
          detail: "bun run typecheck",
          data: {
            toolCallId: "tool-1",
            kind: "execute",
            title: "Terminal",
            command: "bun run typecheck",
            rawInput: {
              executable: "bun",
              args: ["run", "typecheck"],
            },
            content: [
              {
                type: "content",
                content: {
                  type: "text",
                  text: "Running checks",
                },
              },
            ],
          },
        },
        rawPayload: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tool-1",
            title: "Terminal",
            kind: "execute",
            status: "pending",
            rawInput: {
              executable: "bun",
              args: ["run", "typecheck"],
            },
            content: [
              {
                type: "content",
                content: {
                  type: "text",
                  text: "Running checks",
                },
              },
            ],
          },
        },
      },
    ]);

    const updated = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "completed",
        rawOutput: { exitCode: 0 },
      },
    } satisfies EffectAcpSchema.SessionNotification);

    expect(updated.events).toHaveLength(1);
    expect(updated.events[0]?._tag).toBe("ToolCallUpdated");
    const createdEvent = created.events[0];
    const updatedEvent = updated.events[0];
    if (createdEvent?._tag === "ToolCallUpdated" && updatedEvent?._tag === "ToolCallUpdated") {
      expect(mergeToolCallState(createdEvent.toolCall, updatedEvent.toolCall)).toMatchObject({
        toolCallId: "tool-1",
        status: "completed",
        title: "Ran command",
        detail: "bun run typecheck",
        command: "bun run typecheck",
      });
    }
  });

  it("ends a tool call that ACP reports as cancelled", () => {
    const toolCall = (status: EffectAcpSchema.ToolCallStatus) => {
      const parsed = parseSessionUpdateEvent({
        sessionId: "session-1",
        update: {
          sessionUpdate: status === "in_progress" ? "tool_call" : "tool_call_update",
          toolCallId: "tool-1",
          title: "Run `sleep 60`",
          kind: "execute",
          status,
        },
      } as EffectAcpSchema.SessionNotification);
      const event = parsed.events[0];
      if (event?._tag !== "ToolCallUpdated") {
        throw new Error("expected a tool call update");
      }
      return event.toolCall;
    };

    const running = toolCall("in_progress");
    const cancelled = mergeToolCallState(running, toolCall("cancelled"));
    expect(cancelled.status).toBe("failed");
    expect(
      decideToolCallUpdateEmission({
        previous: running,
        next: cancelled,
        lastEmittedDetailLength: 0,
        skippedSinceEmit: 0,
      }).emit,
    ).toBe(true);
  });

  it("clears prior ACP locations when an update explicitly replaces them", () => {
    const toolCall = (locations?: EffectAcpSchema.ToolCallLocation[] | null) => {
      const parsed = parseSessionUpdateEvent({
        sessionId: "session-1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "read-1",
          ...(locations === undefined ? {} : { locations }),
        },
      } satisfies EffectAcpSchema.SessionNotification);
      const event = parsed.events.find((candidate) => candidate._tag === "ToolCallUpdated");
      if (!event || event._tag !== "ToolCallUpdated") {
        throw new Error("expected a tool call update");
      }
      return event.toolCall;
    };

    const created = toolCall([{ path: "README" }]);
    expect(mergeToolCallState(created, toolCall()).data.locations).toEqual([{ path: "README" }]);
    const cleared = mergeToolCallState(created, toolCall([]));
    expect(cleared.data.locations).toEqual([]);
    expect(mergeToolCallState(created, toolCall(null)).data.locations).toEqual([]);
    const emits = (previous: AcpToolCallState, next: AcpToolCallState) =>
      decideToolCallUpdateEmission({
        previous,
        next,
        lastEmittedDetailLength: 0,
        skippedSinceEmit: 0,
      }).emit;
    expect(emits(created, cleared)).toBe(true);
    expect(toolCallVisibleOutputChanged(created, cleared)).toBe(true);
    const relocated = mergeToolCallState(cleared, toolCall([{ path: "/workspace/src/app.ts" }]));
    expect(emits(cleared, relocated)).toBe(true);
    expect(toolCallVisibleOutputChanged(cleared, relocated)).toBe(true);
    const repeated = mergeToolCallState(relocated, toolCall([{ path: "/workspace/src/app.ts" }]));
    expect(emits(relocated, repeated)).toBe(false);
    expect(toolCallVisibleOutputChanged(relocated, repeated)).toBe(false);
  });

  it("clears explicitly nulled ACP v2 tool call fields and replaces raw input", () => {
    const toolCall = (update: Omit<EffectAcpSchema.ToolCallUpdate, "toolCallId">) => {
      const parsed = parseSessionUpdateEvent({
        sessionId: "session-1",
        update: { sessionUpdate: "tool_call_update", toolCallId: "call-1", ...update },
      } satisfies EffectAcpSchema.SessionNotification);
      const event = parsed.events.find((candidate) => candidate._tag === "ToolCallUpdated");
      if (!event || event._tag !== "ToolCallUpdated") {
        throw new Error("expected a tool call update");
      }
      return event.toolCall;
    };

    const created = toolCall({
      name: "old-name",
      title: "Old title",
      kind: "read",
      status: "in_progress",
      content: [{ type: "content", content: { type: "text", text: "old output" } }],
      rawInput: { path: "old.txt", obsolete: true },
      _meta: { old: true },
    });

    expect(
      mergeToolCallState(created, toolCall({ rawInput: { path: "new.txt" } })).data.rawInput,
    ).toEqual({ path: "new.txt" });

    const cleared = mergeToolCallState(
      created,
      toolCall({
        name: null,
        title: null,
        kind: null,
        status: null,
        content: null,
        rawInput: null,
        _meta: null,
      }),
    );
    const { name, title, kind, content, rawInput, meta } = cleared.data;
    expect({ name, title, kind, content, rawInput, meta }).toEqual({});
    expect({ kind: cleared.kind, title: cleared.title, status: cleared.status }).toEqual({});
  });

  it("forwards an empty ACP v1 plan to clear previous entries", () => {
    const entries = [
      [{ content: "Inspect state", priority: "high", status: "pending" }],
      [],
    ] as const;
    const updates = entries.flatMap(
      (plan) =>
        parseSessionUpdateEvent({
          sessionId: "session-1",
          update: { sessionUpdate: "plan", entries: plan },
        }).events,
    );

    expect(updates).toMatchObject([
      {
        _tag: "PlanUpdated",
        payload: {
          nativePlanId: "legacy",
          kind: "items",
          plan: [{ step: "Inspect state", status: "pending" }],
        },
      },
      {
        _tag: "PlanUpdated",
        payload: { nativePlanId: "legacy", kind: "items", plan: [] },
      },
    ]);
  });

  it("projects typed ACP plan and content updates", () => {
    const planResult = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "plan",
        entries: [
          { content: " Inspect state ", priority: "high", status: "completed" },
          { content: "", priority: "medium", status: "in_progress" },
        ],
      },
    } satisfies EffectAcpSchema.SessionNotification);

    expect(planResult.events).toEqual([
      {
        _tag: "PlanUpdated",
        payload: {
          nativePlanId: "legacy",
          kind: "items",
          plan: [
            { step: "Inspect state", status: "completed" },
            { step: "Step 2", status: "inProgress" },
          ],
        },
        rawPayload: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "plan",
            entries: [
              { content: " Inspect state ", priority: "high", status: "completed" },
              { content: "", priority: "medium", status: "in_progress" },
            ],
          },
        },
      },
    ]);

    const contentResult = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "hello from acp",
        },
      },
    } satisfies EffectAcpSchema.SessionNotification);

    expect(contentResult.events).toEqual([
      {
        _tag: "ContentDelta",
        text: "hello from acp",
        rawPayload: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "hello from acp",
            },
          },
        },
      },
    ]);
  });

  it("keeps permission request parsing compatible with loose extension payloads", () => {
    const request = parsePermissionRequest({
      sessionId: "session-1",
      options: [
        {
          optionId: "allow-once",
          name: "Allow once",
          kind: "allow_once",
        },
      ],
      toolCall: {
        toolCallId: "tool-1",
        title: "`cat package.json`",
        kind: "execute",
        status: "pending",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "Not in allowlist",
            },
          },
        ],
      },
    });

    expect(request).toMatchObject({
      kind: "execute",
      detail: "cat package.json",
      toolCall: {
        toolCallId: "tool-1",
        kind: "execute",
        status: "pending",
        command: "cat package.json",
      },
    });
  });

  it("keeps an explicit permission request kind over the tracked tool call's kind", () => {
    const request = withTrackedPermissionToolCall(
      {
        sessionId: "session-1",
        options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
        toolCall: { toolCallId: "tool-1", kind: "read" },
      },
      {
        toolCallId: "tool-1",
        kind: "execute",
        data: { toolCallId: "tool-1", title: "git status", rawInput: { command: "git status" } },
      },
    );

    expect(parsePermissionRequest(request)).toMatchObject({ kind: "read", detail: "git status" });
  });

  it("keeps explicitly cleared permission request fields over the tracked tool call", () => {
    const request = withTrackedPermissionToolCall(
      {
        sessionId: "session-1",
        options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
        toolCall: { toolCallId: "tool-1", kind: null, title: null, rawInput: null },
      },
      {
        toolCallId: "tool-1",
        kind: "execute",
        data: { toolCallId: "tool-1", title: "git status", rawInput: { command: "git status" } },
      },
    );

    expect(parsePermissionRequest(request).kind).toBe("unknown");
  });
});
