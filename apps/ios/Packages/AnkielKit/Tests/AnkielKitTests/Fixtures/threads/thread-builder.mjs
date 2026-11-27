// Builds orchestration-v2 thread snapshots and stream events in the server's wire shape from short
// item specs, so each fixture is a few lines of conversation instead of a hand-written projection.
// Used by `make-thread-fixtures.mjs`.

const MODEL = { instanceId: "claudeAgent", model: "claude-opus-5-5", options: [{ id: "effort", value: "high" }] };

export class ThreadBuilder {
  /** `start`: a Date; every timestamp is an offset from it, so the files are deterministic. */
  constructor({ slug, title, start, model = MODEL, projectId = "project-tidewise" }) {
    this.slug = slug;
    this.threadId = `thread-${slug}`;
    this.projectId = projectId;
    this.title = title;
    this.start = start;
    this.model = model;
    this.providerThreadId = `provider-thread:${slug}`;
    this.clock = 0;
    this.runs = [];
    this.attempts = [];
    this.nodes = [];
    this.subagents = [];
    this.providerTurns = [];
    this.messages = [];
    this.turnItems = [];
    this.runtimeRequests = [];
    this.events = [];
    this.sequence = 100;
  }

  at(seconds) {
    return new Date(this.start.getTime() + Math.round(seconds * 1000)).toISOString();
  }

  /**
   * One run: the user's message, then `items` in order. Each spec advances the clock by its `s`
   * (seconds, default 2). `status` other than completed leaves the run open (no checkpoint).
   */
  run({ user, items = [], status = "completed", gap = 40, intent = "turn_start", attachments = [] }) {
    const n = this.runs.length + 1;
    const runId = `run:${this.slug}:${n}`;
    const rootNodeId = `node:${this.slug}:${n}:root`;
    const attemptId = `attempt:${this.slug}:${n}:1`;
    const turnId = `provider-turn:${this.slug}:${n}`;
    const messageId = `message:${this.slug}:user:${n}`;
    if (this.runs.length > 0) this.clock += gap;
    const requestedAt = this.at(this.clock);
    const ctx = { n, runId, rootNodeId, turnId, ordinal: n * 1_000_000, open: ["preparing", "queued", "starting", "running", "waiting"].includes(status) };

    // `user: null`: a run the server woke on its own (a background task finishing), with no bubble.
    if (user !== null) {
    this.messages.push(this.message({ id: messageId, role: "user", text: user, runId, nodeId: rootNodeId, at: requestedAt, attachments }));
    this.push(ctx, {
      id: `turn-item:message:${messageId}`,
      type: "user_message",
      status: "completed",
      startedAt: requestedAt,
      completedAt: requestedAt,
      createdBy: "user",
      creationSource: "mobile",
      messageId,
      inputIntent: intent,
      text: user,
      attachments,
    });
    }
    this.clock += 0.4;
    const startedAt = this.at(this.clock);
    for (const spec of items) this.item(ctx, spec);
    const completedAt = ctx.open ? null : this.at(this.clock);
    if (status === "completed") {
      this.push(ctx, {
        id: `turn-item:checkpoint:${this.slug}:${n}`,
        type: "checkpoint",
        status: "completed",
        startedAt: completedAt,
        completedAt,
        checkpointId: `checkpoint:${this.slug}:${n}`,
        scopeId: `checkpoint-scope:${this.slug}:root`,
        files: [],
      });
    }
    const attemptStatus = { completed: "completed", failed: "failed", interrupted: "interrupted" }[status] ?? "running";
    this.runs.push({
      id: runId,
      threadId: this.threadId,
      ordinal: n,
      providerInstanceId: this.model.instanceId,
      modelSelection: this.model,
      providerThreadId: this.providerThreadId,
      userMessageId: messageId,
      rootNodeId,
      activeAttemptId: attemptId,
      status,
      queuePosition: null,
      requestedAt,
      startedAt,
      completedAt,
      checkpointId: status !== "completed" ? null : `checkpoint:${this.slug}:${n}`,
      contextHandoffId: null,
    });
    this.attempts.push({
      id: attemptId,
      runId,
      attemptOrdinal: 1,
      rootNodeId,
      providerInstanceId: this.model.instanceId,
      providerThreadId: this.providerThreadId,
      providerTurnId: turnId,
      reason: "initial",
      status: attemptStatus,
      startedAt,
      completedAt,
    });
    this.nodes.push({
      id: rootNodeId,
      threadId: this.threadId,
      runId,
      parentNodeId: null,
      rootNodeId,
      kind: "root_turn",
      status: status === "completed" ? "completed" : status === "failed" ? "failed" : status === "waiting" ? "waiting" : "running",
      countsForRun: true,
      providerThreadId: this.providerThreadId,
      providerTurnId: turnId,
      nativeItemRef: null,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt,
      completedAt,
    });
    const used = 18_000 + n * 7_400;
    this.providerTurns.push({
      id: turnId,
      providerThreadId: this.providerThreadId,
      nodeId: rootNodeId,
      runAttemptId: attemptId,
      nativeTurnRef: null,
      ordinal: n,
      status: attemptStatus === "running" ? "running" : attemptStatus,
      startedAt,
      completedAt,
      tokenUsage: { usedTokens: used, maxTokens: 1_000_000, inputTokens: used - 900, outputTokens: 900, updatedAt: completedAt ?? startedAt },
      model: this.model.model,
    });
    return ctx;
  }

  message({ id, role, text, runId, nodeId, at, attachments = [], streaming = false }) {
    return {
      createdBy: role === "user" ? "user" : "agent",
      creationSource: "mobile",
      id,
      threadId: this.threadId,
      runId,
      nodeId,
      role,
      text,
      attachments,
      streaming,
      createdAt: at,
      updatedAt: at,
    };
  }

  push(ctx, fields) {
    ctx.ordinal += 1;
    const item = {
      id: fields.id ?? `turn-item:${this.slug}:${ctx.ordinal}`,
      threadId: this.threadId,
      runId: ctx.runId,
      nodeId: ctx.rootNodeId,
      providerThreadId: this.providerThreadId,
      providerTurnId: ctx.turnId,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: ctx.ordinal,
      status: "completed",
      title: null,
      startedAt: null,
      completedAt: null,
      updatedAt: fields.completedAt ?? fields.startedAt ?? this.at(this.clock),
      ...fields,
    };
    delete item.s;
    this.turnItems.push(item);
    return item;
  }

  /** Turns a spec (`think`, `cmd`, `tool`, `edit`, `say`, `subagent`, `notify` or a raw `type`) into an item. */
  item(ctx, spec) {
    const seconds = spec.s ?? 2;
    const startedAt = this.at(this.clock);
    this.clock += seconds;
    const done = spec.status === "running" || spec.status === "waiting" ? null : this.at(this.clock);
    const base = { status: spec.status ?? "completed", startedAt, completedAt: done, updatedAt: done ?? startedAt };
    if (spec.think !== undefined) {
      return this.push(ctx, { ...base, title: "Thinking", type: "reasoning", text: spec.think, streaming: false });
    }
    if (spec.cmd !== undefined) {
      const fields = { ...base, title: spec.title ?? null, type: "command_execution", input: spec.cmd };
      if (spec.out !== undefined) fields.output = spec.out;
      else if (spec.status !== "running") fields.outputOmitted = true;
      if (spec.exit !== undefined) fields.exitCode = spec.exit;
      return this.push(ctx, fields);
    }
    if (spec.tool !== undefined) {
      return this.push(ctx, { ...base, type: "dynamic_tool", toolName: spec.tool, input: spec.input ?? {}, outputOmitted: true });
    }
    if (spec.edit !== undefined) {
      const name = spec.edit.split("/").pop();
      return this.push(ctx, {
        ...base,
        type: "file_change",
        fileName: name,
        additions: spec.add ?? 0,
        deletions: spec.del ?? 0,
        changes: [{ operation: spec.op ?? "update", path: spec.edit }],
      });
    }
    if (spec.say !== undefined) {
      const messageId = `message:${this.slug}:assistant:${ctx.n}:${ctx.ordinal + 1}`;
      this.messages.push(this.message({ id: messageId, role: "assistant", text: spec.say, runId: ctx.runId, nodeId: ctx.rootNodeId, at: done ?? startedAt }));
      return this.push(ctx, {
        ...base,
        type: "assistant_message",
        phase: spec.phase ?? "final_answer",
        messageId,
        text: spec.say,
        streaming: false,
      });
    }
    if (spec.subagent !== undefined) {
      const { key, title, prompt, result } = spec.subagent;
      const nodeId = `node:${this.slug}:task:${key}`;
      const childThreadId = `thread:subagent:${key}`;
      this.subagents.push({
        id: nodeId,
        threadId: this.threadId,
        runId: ctx.runId,
        parentNodeId: ctx.rootNodeId,
        origin: "provider_native",
        createdBy: "agent",
        driver: "claudeAgent",
        providerInstanceId: "claudeAgent",
        providerThreadId: null,
        childThreadId,
        nativeTaskRef: null,
        prompt,
        title,
        model: "claude-sonnet-5-5",
        status: "completed",
        result,
        startedAt,
        completedAt: done,
        updatedAt: done ?? startedAt,
      });
      return this.push(ctx, {
        ...base,
        title,
        type: "subagent",
        subagentId: nodeId,
        origin: "provider_native",
        driver: "claudeAgent",
        providerInstanceId: "claudeAgent",
        childThreadId,
        prompt,
        result,
      });
    }
    if (spec.notify !== undefined) {
      return this.push(ctx, { ...base, type: "notification", ...spec.notify });
    }
    const { s: _s, ...raw } = spec;
    return this.push(ctx, { ...base, ...raw });
  }

  /** A stream event; `payload` is the full record the server would send. */
  event(type, payload, at) {
    this.sequence += 1;
    this.events.push({
      kind: "event",
      sequence: this.sequence,
      event: { id: `event:${this.slug}:${this.sequence}`, type, threadId: this.threadId, occurredAt: at, payload },
    });
  }

  thread() {
    return {
      createdBy: "user",
      creationSource: "mobile",
      id: this.threadId,
      projectId: this.projectId,
      title: this.title,
      providerInstanceId: this.model.instanceId,
      modelSelection: this.model,
      runtimeMode: "auto",
      interactionMode: "default",
      branch: "main",
      worktreePath: "/srv/dev/tidewise",
      pullRequests: [],
      activeProviderThreadId: this.providerThreadId,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: this.threadId },
      forkedFrom: null,
      createdAt: this.at(0),
      updatedAt: this.at(this.clock),
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: this.at(this.clock),
      deletedAt: null,
    };
  }

  projection() {
    const visible = this.turnItems
      .slice()
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((item, position) => ({ position, visibility: "local", sourceThreadId: this.threadId, sourceItemId: item.id, item }));
    return {
      thread: this.thread(),
      runs: this.runs,
      attempts: this.attempts,
      nodes: this.nodes,
      subagents: this.subagents,
      providerSessions: [],
      providerThreads: [],
      providerTurns: this.providerTurns,
      runtimeRequests: this.runtimeRequests,
      messages: this.messages,
      plans: [],
      turnItems: this.turnItems,
      checkpointScopes: [],
      checkpoints: [],
      contextHandoffs: [],
      contextTransfers: [],
      visibleTurnItems: visible,
      updatedAt: this.at(this.clock),
    };
  }

  /** The file: `{"synthetic": true, "items": [snapshot, synchronized, …events]}`. */
  document(extra = {}) {
    return {
      synthetic: true,
      ...extra,
      items: [{ kind: "snapshot", snapshotSequence: 100, projection: this.projection() }, { kind: "synchronized" }, ...this.events],
    };
  }
}
