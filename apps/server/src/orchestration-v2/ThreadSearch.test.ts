import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
} from "@ankielcode/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadSearch from "./ThreadSearch.ts";

const layerTest = Layer.mergeAll(
  ThreadSearch.layer,
  ProjectionStore.layer,
  ProjectStore.layer,
).pipe(Layer.provideMerge(SqlitePersistence.layerMemory));

const providerInstanceId = ProviderInstanceId.make("codex");
const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 8, 27, 0, minute));

const createProject = (projectId: ProjectId) =>
  Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
    projects.apply({
      sequence: 0,
      eventId: EventId.make(`created:${projectId}`),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: DateTime.formatIso(at(0)),
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId,
        title: projectId,
        workspaceRoot: `/work/${projectId}`,
        defaultModelSelection: null,
        scripts: [],
        createdAt: DateTime.formatIso(at(0)),
        updatedAt: DateTime.formatIso(at(0)),
      },
    }),
  );

const thread = (
  threadId: ThreadId,
  projectId: ProjectId,
  overrides: {
    readonly archivedAt?: DateTime.Utc;
    readonly deletedAt?: DateTime.Utc;
    readonly subagentOf?: ThreadId;
    readonly sideChatOf?: ThreadId;
    readonly title?: string;
    readonly settledAt?: DateTime.Utc;
  } = {},
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`created:${threadId}`),
  type: "thread.created",
  threadId,
  providerInstanceId,
  occurredAt: at(0),
  payload: {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: overrides.title ?? threadId,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: overrides.subagentOf
      ? {
          parentThreadId: overrides.subagentOf,
          relationshipToParent: "subagent",
          rootThreadId: overrides.subagentOf,
        }
      : overrides.sideChatOf
        ? {
            parentThreadId: overrides.sideChatOf,
            relationshipToParent: "fork",
            rootThreadId: overrides.sideChatOf,
            sideChat: true,
          }
        : { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: at(0),
    updatedAt: at(0),
    archivedAt: overrides.archivedAt ?? null,
    settledOverride: overrides.settledAt === undefined ? null : "settled",
    settledAt: overrides.settledAt ?? null,
    lastVisitedAt: null,
    deletedAt: overrides.deletedAt ?? null,
  },
});

const message = (
  threadId: ThreadId,
  id: string,
  role: "user" | "assistant" | "system",
  text: string,
  options: {
    readonly minute?: number;
    readonly streaming?: boolean;
    readonly createdBy?: "user" | "agent";
    readonly runId?: RunId;
  } = {},
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`message:${id}`),
  type: "message.updated",
  threadId,
  providerInstanceId,
  occurredAt: at(options.minute ?? 1),
  payload: {
    createdBy: options.createdBy ?? (role === "user" ? "user" : "agent"),
    creationSource: role === "user" ? "web" : "provider",
    id: MessageId.make(id),
    threadId,
    runId: options.runId ?? null,
    nodeId: null,
    role,
    text,
    attachments: [],
    streaming: options.streaming ?? false,
    createdAt: at(options.minute ?? 1),
    updatedAt: at(options.minute ?? 1),
  },
});

it.layer(layerTest)("ThreadSearch", (it) => {
  it.effect("returns one finished user or assistant match per active thread", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const project = ProjectId.make("project:search");
      const deletedProject = ProjectId.make("project:search-deleted");
      yield* createProject(project);
      yield* createProject(deletedProject);
      yield* Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
        projects.apply({
          sequence: 0,
          eventId: EventId.make("deleted:project"),
          aggregateKind: "project",
          aggregateId: deletedProject,
          occurredAt: DateTime.formatIso(at(2)),
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "project.deleted",
          payload: { projectId: deletedProject, deletedAt: DateTime.formatIso(at(2)) },
        }),
      );

      const both = ThreadId.make("thread:both");
      const assistantOnly = ThreadId.make("thread:assistant");
      const events: ReadonlyArray<OrchestrationV2DomainEvent> = [
        thread(both, project),
        message(both, "both-assistant", "assistant", "needle from the answer", { minute: 3 }),
        message(both, "both-user-old", "user", "older needle question", { minute: 1 }),
        message(both, "both-user-new", "user", "newer needle question", { minute: 2 }),
        thread(assistantOnly, project),
        message(assistantOnly, "assistant-only", "assistant", "needle in an answer"),
        message(assistantOnly, "assistant-streaming", "user", "needle still typing", {
          streaming: true,
        }),
        message(assistantOnly, "assistant-system", "system", "needle system prompt"),
        thread(ThreadId.make("thread:archived"), project, { archivedAt: at(1) }),
        message(ThreadId.make("thread:archived"), "archived", "user", "needle archived"),
        thread(ThreadId.make("thread:deleted"), project, { deletedAt: at(1) }),
        message(ThreadId.make("thread:deleted"), "deleted", "user", "needle deleted"),
        thread(ThreadId.make("thread:orphaned"), deletedProject),
        message(ThreadId.make("thread:orphaned"), "orphaned", "user", "needle orphaned"),
      ];
      yield* Effect.forEach(events, projections.apply, { discard: true });

      const result = yield* search.search({ query: "NEEDLE", limit: 20 });
      assert.deepEqual(
        result.matches
          .map((match) => [match.threadId, match.source, match.snippet, match.messageId])
          .toSorted(([left], [right]) => String(left).localeCompare(String(right))),
        [
          [assistantOnly, "assistant", "needle in an answer", "assistant-only"],
          [both, "user", "newer needle question", "both-user-new"],
        ],
      );
      assert.lengthOf((yield* search.search({ query: "needle", limit: 1 })).matches, 1);
      assert.deepEqual((yield* search.search({ query: "ne%le" })).matches, []);
    }),
  );

  it.effect("indexes a message when it finishes streaming and follows later edits", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const project = ProjectId.make("project:search-sync");
      const threadId = ThreadId.make("thread:sync");
      yield* createProject(project);
      yield* projections.apply(thread(threadId, project));
      const threadIds = (query: string) =>
        search.search({ query }).pipe(Effect.map(({ matches }) => matches.map((m) => m.threadId)));

      yield* projections.apply(
        message(threadId, "sync", "assistant", "streaming draft", { streaming: true }),
      );
      assert.deepEqual(yield* threadIds("draft"), []);

      yield* projections.apply(message(threadId, "sync", "assistant", "finished answer"));
      assert.deepEqual(yield* threadIds("finished"), [threadId]);

      yield* projections.apply(message(threadId, "sync", "assistant", "edited reply"));
      assert.deepEqual(yield* threadIds("finished"), []);
      assert.deepEqual(yield* threadIds("edited"), [threadId]);
    }),
  );

  it.effect("matches inside identifiers and skips hidden threads and short tokens", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const project = ProjectId.make("project:search-tokens");
      const parent = ThreadId.make("thread:tokens-parent");
      const subagent = ThreadId.make("thread:tokens-subagent");
      const sideChat = ThreadId.make("thread:tokens-side-chat");
      yield* createProject(project);
      yield* Effect.forEach(
        [
          thread(parent, project),
          message(parent, "parent", "user", "Rename ThreadSearchService before shipping"),
          message(
            parent,
            "webhook",
            "assistant",
            "Run it with https://relay.test/v1/hooks/0123456789abcdef/scheduled-task:7f3a9c1e/whk_secretvalue",
          ),
          thread(subagent, project, { subagentOf: parent }),
          message(subagent, "subagent", "assistant", "ThreadSearchService renamed"),
          thread(sideChat, project, { sideChatOf: parent, title: "ThreadSearchService question" }),
          message(sideChat, "side-chat", "user", "Why rename ThreadSearchService?"),
        ],
        projections.apply,
        { discard: true },
      );

      const result = yield* search.search({ query: "search servi" });
      assert.deepEqual(
        result.matches.map((match) => [match.threadId, match.snippet]),
        [[parent, "Rename ThreadSearchService before shipping"]],
      );
      // A snippet cut inside a webhook URL shows its token as withheld, and the token is not searchable.
      assert.deepEqual(
        (yield* search.search({ query: "7f3a9c1e" })).matches.map((match) => match.snippet),
        ["…89abcdef/scheduled-task:7f3a9c1e/[withheld]"],
      );
      assert.deepEqual((yield* search.search({ query: "whk_secretvalue" })).matches, []);
      // "ab" alone cannot use the index; with a longer token it narrows the hits.
      assert.deepEqual((yield* search.search({ query: "ab" })).matches, []);
      assert.lengthOf((yield* search.search({ query: "renam be" })).matches, 1);
      assert.lengthOf((yield* search.search({ query: "renam ab" })).matches, 0);
    }),
  );

  it.effect("indexes neither subagent messages nor rewrites that keep the text", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const project = ProjectId.make("project:search-index-writes");
      const parent = ThreadId.make("thread:index-parent");
      const subagent = ThreadId.make("thread:index-subagent");
      yield* createProject(project);
      yield* Effect.forEach(
        [
          thread(parent, project),
          message(parent, "index-parent", "assistant", "parent answer"),
          thread(subagent, project, { subagentOf: parent }),
          message(subagent, "index-subagent", "assistant", "subagent answer"),
        ],
        projections.apply,
        { discard: true },
      );
      const indexedThreads = sql<{ readonly threadId: string }>`
        SELECT messages.thread_id AS "threadId"
        FROM orchestration_v2_message_search AS search
        INNER JOIN orchestration_v2_projection_messages AS messages
          ON messages.rowid = search.rowid
        WHERE messages.thread_id IN (${parent}, ${subagent})
      `.pipe(Effect.map((rows) => rows.map((row) => row.threadId)));
      assert.deepEqual(yield* indexedThreads, [parent]);

      // total_changes counts trigger writes, so 1 means the index was untouched.
      const changes = sql<{ readonly n: number }>`SELECT total_changes() AS n`.pipe(
        Effect.map(([row]) => row?.n ?? 0),
      );
      const before = yield* changes;
      yield* sql`
        UPDATE orchestration_v2_projection_messages
        SET payload_json = json_set(payload_json, '$.updatedAt', '2026-09-27T01:00:00.000Z')
        WHERE message_id = 'index-parent'
      `;
      assert.strictEqual((yield* changes) - before, 1);
      assert.deepEqual(yield* indexedThreads, [parent]);
    }),
  );
});

it.layer(layerTest)("ThreadSearch filters before it ranks", (it) => {
  it.effect("leaves out answers in their question card and turns the thread hides", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const project = ProjectId.make("project:answers");
      const asked = ThreadId.make("thread:answers");
      const rewound = ThreadId.make("thread:rewound");
      const queued = ThreadId.make("thread:queued");
      const stopped = ThreadId.make("thread:stopped");
      const recovered = ThreadId.make("thread:recovered");
      const restarted = ThreadId.make("thread:restarted");
      const run = (owner: ThreadId, status: "rolled_back" | "cancelled", started = true) =>
        ({
          id: EventId.make(`run:${owner}`),
          type: "run.created",
          threadId: owner,
          runId: RunId.make(`run:${owner}`),
          nodeId: NodeId.make(`node:${owner}`),
          providerInstanceId,
          occurredAt: at(2),
          payload: {
            id: RunId.make(`run:${owner}`),
            threadId: owner,
            ordinal: 1,
            providerInstanceId,
            modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
            providerThreadId: null,
            userMessageId: MessageId.make(`${owner}:prompt`),
            rootNodeId: NodeId.make(`node:${owner}`),
            activeAttemptId: null,
            status,
            requestedAt: at(1),
            startedAt: started ? at(1) : null,
            completedAt: at(2),
            checkpointId: null,
            contextHandoffId: null,
          },
        }) satisfies OrchestrationV2DomainEvent;
      const shown = (owner: ThreadId, id: string, as: "turn_start" | "queued_turn" | "reply") =>
        ({
          id: EventId.make(`item:${id}`),
          type: "turn-item.updated",
          threadId: owner,
          occurredAt: at(2),
          payload: {
            id: TurnItemId.make(id),
            threadId: owner,
            runId: RunId.make(`run:${owner}`),
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            status: "completed",
            title: null,
            startedAt: at(1),
            completedAt: at(1),
            updatedAt: at(1),
            messageId: MessageId.make(id),
            text: "",
            ...(as === "reply"
              ? { type: "assistant_message", streaming: false }
              : {
                  type: "user_message",
                  inputIntent: as,
                  attachments: [],
                  createdBy: "user",
                  creationSource: "web",
                }),
          },
        }) satisfies OrchestrationV2DomainEvent;
      yield* createProject(project);
      yield* Effect.forEach(
        [
          thread(asked, project),
          message(asked, "async-answer:request-1", "user", "use the albatross drive"),
          thread(rewound, project),
          run(rewound, "rolled_back"),
          message(rewound, "rewound-reply", "assistant", "the albatross drive is ready", {
            runId: RunId.make(`run:${rewound}`),
          }),
          thread(queued, project),
          run(queued, "cancelled", false),
          message(queued, "queued-prompt", "user", "then mount the albatross drive", {
            runId: RunId.make(`run:${queued}`),
          }),
          // A queued prompt usually has no item; an edited one has a queued item.
          message(queued, "requeued-prompt", "user", "then eject the albatross drive", {
            runId: RunId.make(`run:${queued}`),
          }),
          shown(queued, "requeued-prompt", "queued_turn"),
          // A stopped turn keeps its prompt and whatever the agent already said.
          thread(stopped, project),
          run(stopped, "cancelled"),
          message(stopped, "stopped-prompt", "user", "format the albatross drive", {
            runId: RunId.make(`run:${stopped}`),
          }),
          shown(stopped, "stopped-prompt", "turn_start"),
          thread(recovered, project),
          run(recovered, "cancelled"),
          message(recovered, "recovered-reply", "assistant", "the albatross drive is formatted", {
            runId: RunId.make(`run:${recovered}`),
          }),
          shown(recovered, "recovered-reply", "reply"),
          // A restart cancels a turn that already took its queued prompt.
          thread(restarted, project),
          run(restarted, "cancelled"),
          message(restarted, "delivered-prompt", "user", "then label the albatross drive", {
            runId: RunId.make(`run:${restarted}`),
          }),
          shown(restarted, "delivered-prompt", "queued_turn"),
        ],
        projections.apply,
        { discard: true },
      );
      assert.deepEqual(
        (yield* search.search({ query: "albatross" })).matches
          .map((match) => match.messageId)
          .sort(),
        [
          MessageId.make("delivered-prompt"),
          MessageId.make("recovered-reply"),
          MessageId.make("stopped-prompt"),
        ],
      );
    }),
  );
});

it.effect("searches on the reader worker while the writer is busy", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "ankiel-thread-search-",
    });
    const layerFile = Layer.mergeAll(
      ThreadSearch.layer,
      ProjectionStore.layer,
      ProjectStore.layer,
    ).pipe(
      Layer.provideMerge(SqlitePersistence.layerFromPath(path.join(directory, "state.sqlite"))),
      Layer.provide(NodeServices.layer),
    );

    yield* Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const sql = yield* SqlClient.SqlClient;
      const project = ProjectId.make("project:search-reader");
      const threadId = ThreadId.make("thread:reader");
      yield* createProject(project);
      yield* Effect.forEach(
        [thread(threadId, project), message(threadId, "reader", "user", "needle on the reader")],
        projections.apply,
        { discard: true },
      );

      const writerHeld = yield* Deferred.make<void>();
      const releaseWriter = yield* Deferred.make<void>();
      const writer = yield* Effect.forkChild(
        sql.withTransaction(
          Deferred.succeed(writerHeld, undefined).pipe(
            Effect.andThen(Deferred.await(releaseWriter)),
          ),
        ),
      );
      yield* Deferred.await(writerHeld);
      const result = yield* search.search({ query: "needle" });
      yield* Deferred.succeed(releaseWriter, undefined);
      yield* Fiber.join(writer);

      assert.deepEqual(
        result.matches.map((match) => match.threadId),
        [threadId],
      );
    }).pipe(Effect.provide(layerFile));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
