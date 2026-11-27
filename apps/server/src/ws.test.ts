import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AuthAccessReadScope,
  type AuthEnvironmentScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type WorkflowRun,
  type WorkflowStep,
  AuthSessionId,
  AuthSourceControlWriteScope,
  AuthTerminalOperateScope,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnItemId,
  WS_METHODS,
  WsRpcGroup,
  type AuthAccessStreamEvent,
  type OrchestrationV2StoredEvent,
  type OrchestrationProjectShell,
} from "@ankielcode/contracts";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { Headers } from "effect/http";
import { RpcMessage, RpcServer } from "effect/rpc";
import * as RpcTest from "effect/rpc/RpcTest";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import { vi } from "vite-plus/test";

import * as AssetSigner from "./assets/AssetSigner.ts";
import * as WorkspacePreviewRevisions from "./assets/WorkspacePreviewRevisions.ts";
import * as PreviewAutomationBroker from "./mcp/PreviewAutomationBroker.ts";
import * as ServerBrowser from "./preview/ServerBrowser.ts";
import * as AcpRegistryRuntimeCoordinator from "@ankielcode/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import * as AcpRegistrySupport from "@ankielcode/provider-acp-registry/server/AcpRegistrySupport";
import * as AgentSessionImporter from "./project/AgentSessionImporter.ts";
import * as AgentSessionScanner from "./project/AgentSessionScanner.ts";
import * as AntigravityInstallation from "./provider/AntigravityInstallation.ts";
import * as ProviderInstallation from "./provider/providerInstallation.ts";
import * as BackgroundPolicy from "./background/BackgroundPolicy.ts";
import * as CheckpointDiffQuery from "./checkpointing/CheckpointDiffQuery.ts";
import * as NativeChildWorkQuery from "./orchestration-v2/NativeChildWorkQuery.ts";
import * as CommandOutputHub from "./orchestration-v2/CommandOutputHub.ts";
import * as ThreadViewers from "./orchestration-v2/ThreadViewers.ts";
import * as CodexInstallation from "./provider/CodexInstallation.ts";
import * as DeviceService from "./device/DeviceService.ts";
import * as DocumentText from "./provider/DocumentText.ts";
import * as DirectEndpoints from "./environment/DirectEndpoints.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as EnvironmentTheme from "./environmentTheme.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import * as HostResources from "./resourceTelemetry/HostResources.ts";
import * as ManagedProjectFolders from "./project/ManagedProjectFolders.ts";
import * as ScratchThreadPromotion from "./project/ScratchThreadPromotion.ts";
import * as McpAppRequests from "./mcpApps/McpAppRequests.ts";
import * as McpSignIn from "./mcpApps/McpSignIn.ts";
import * as ModelManifest from "./provider/ModelManifest.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as PairingGrantStore from "./auth/PairingGrantStore.ts";
import * as RpcAuthorization from "./auth/RpcAuthorization.ts";
import * as PortScanner from "./preview/PortScanner.ts";
import * as PreviewManager from "./preview/Manager.ts";
import * as ProcessDiagnostics from "./diagnostics/ProcessDiagnostics.ts";
import * as ProcessResourceMonitor from "./diagnostics/ProcessResourceMonitor.ts";
import * as ProjectCloneTracker from "./project/ProjectCloneTracker.ts";
import * as ProjectSetupScriptRunner from "./project/ProjectSetupScriptRunner.ts";
import * as ProviderAuthService from "./provider/ProviderAuthService.ts";
import * as AcpRegistrySessions from "./provider/AcpRegistrySessions.ts";
import * as ProviderInstanceRegistry from "./provider/ProviderInstanceRegistry.ts";
import * as ProviderLatestVersions from "@ankielcode/provider-core/server/ProviderLatestVersions";
import * as ProviderMaintenanceRunner from "./provider/providerMaintenanceRunner.ts";
import * as ProviderRegistry from "./provider/ProviderRegistry.ts";
import * as ProviderSessionManager from "./orchestration-v2/ProviderSessionManager.ts";
import * as PullRequestReviewGuideService from "./pullRequest/PullRequestReviewGuideService.ts";
import * as IssueService from "./issue/IssueService.ts";
import * as ThreadIssueService from "./orchestration-v2/ThreadIssueService.ts";
import * as PullRequestService from "./pullRequest/PullRequestService.ts";
import * as PullRequestSyncReactor from "./orchestration-v2/PullRequestSyncReactor.ts";
import * as RemoteOpenTargets from "./environment/RemoteOpenTargets.ts";
import * as RepositoryIdentityResolver from "./project/RepositoryIdentityResolver.ts";
import * as ResourceTelemetry from "./resourceTelemetry/ResourceTelemetry.ts";
import * as ReviewService from "./review/ReviewService.ts";
import * as ScheduledTasks from "./scheduledTasks/ScheduledTaskService.ts";
import * as Workflows from "./workflows/Workflows.ts";
import * as WorkflowRuntime from "./workflows/WorkflowRuntime.ts";
import * as SecretRequests from "./secrets/SecretRequests.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as ServerSelfUpdate from "./cloud/selfUpdate.ts";
import * as ReleaseLookup from "./cloud/releaseLookup.ts";
import * as SessionStore from "./auth/SessionStore.ts";
import * as SourceControlDiscovery from "./sourceControl/SourceControlDiscovery.ts";
import * as SourceControlRepositoryService from "./sourceControl/SourceControlRepositoryService.ts";
import * as SourceControlSignIn from "./sourceControl/SourceControlSignIn.ts";
import * as StorageCleanup from "./storageCleanup.ts";
import * as DatabaseStorage from "./persistence/DatabaseStorage.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as ThreadLaunchService from "./orchestration-v2/ThreadLaunchService.ts";
import * as ThreadSearch from "./orchestration-v2/ThreadSearch.ts";
import * as UsageService from "./usage/UsageService.ts";
import * as VcsProvisioningService from "./vcs/VcsProvisioningService.ts";
import * as VcsStatusBroadcaster from "./vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";
import * as WorkspaceFolders from "./workspace/WorkspaceFolders.ts";
import * as TaskFolders from "./workspace/TaskFolders.ts";
import * as WorkspaceFileSystem from "./workspace/WorkspaceFileSystem.ts";
import * as WorktreeSetupTracker from "./project/WorktreeSetupTracker.ts";
import * as ProjectFaviconResolver from "./project/ProjectFaviconResolver.ts";
import * as TraceDiagnostics from "./diagnostics/TraceDiagnostics.ts";
import * as TriageService from "./triage/TriageService.ts";
import * as TextGenerators from "./textGeneration/TextGenerators.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfigModule from "./config.ts";
import * as Keybindings from "./keybindings.ts";
import * as FeatureFlags from "@ankielcode/shared/FeatureFlags";
import * as ServerSettings from "./serverSettings.ts";
import * as ThreadManagement from "./orchestration-v2/ThreadManagementService.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import { projectIdentitiesDigest } from "./orchestration-v2/ShellStream.ts";
import * as OrchestrationEventStore from "./persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as ProjectEnrichment from "./project/ProjectEnrichmentService.ts";
import * as ProjectService from "./project/ProjectService.ts";
import {
  layerWsRpc,
  subscribeOrchestrationV2Shell,
  subscribeOrchestrationV2Thread,
  WS_RPC_SERVER_OPTIONS,
} from "./ws.ts";

const ReplayTestLayer = OrchestrationEventStore.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

it.effect("coalesces streaming replay before synchronization and the live tail", () =>
  Effect.gen(function* () {
    const store = yield* OrchestrationEventStore.OrchestrationEventStore;
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make("thread:streaming-replay");
    const now = "2026-10-27T00:00:00.000Z";
    const insert = (version: number, text: string, streaming: boolean) => sql<{
      sequence: number;
    }>`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, actor_kind, payload_json, metadata_json, application_event_version
      ) VALUES (
        ${`streaming-replay:${version}`}, 'thread', ${threadId}, ${version}, 'message.updated',
        ${now}, 'server', ${JSON.stringify({
          createdBy: "agent",
          creationSource: "web",
          id: "message:streaming-replay",
          threadId,
          runId: null,
          nodeId: null,
          role: "assistant",
          text,
          attachments: [],
          streaming,
          createdAt: now,
          updatedAt: now,
        })}, '{}', 2
      ) RETURNING sequence
    `;
    yield* insert(0, "H", true);
    yield* insert(1, "He", true);
    const [latest] = yield* insert(2, "Hello", true);
    const [completed] = yield* insert(3, "Hello!", false);
    const items = yield* subscribeOrchestrationV2Thread({
      threadId,
      afterSequence: 0,
      requestCompletionMarker: true,
    }).pipe(
      Effect.flatMap(Stream.runCollect),
      Effect.provideService(ThreadManagement.ThreadManagementService, {
        ensureLegacyTranscript: () => Effect.void,
        streamStoredEventsFrom: () =>
          Stream.unwrap(
            insert(4, "Next", false).pipe(
              Effect.map(() =>
                store.readAgentEvents({ threadId, afterSequence: completed!.sequence }),
              ),
            ),
          ),
      } as unknown as ThreadManagement.ThreadManagementService["Service"]),
    );
    assert.deepEqual(
      items.map((item) =>
        item.kind === "event"
          ? [item.sequence, item.event.type === "message.updated" ? item.event.payload.text : null]
          : [item.kind],
      ),
      [
        [latest!.sequence, "Hello"],
        [completed!.sequence, "Hello!"],
        ["synchronized"],
        [completed!.sequence + 1, "Next"],
      ],
    );
  }).pipe(Effect.scoped, Effect.provide(ReplayTestLayer)),
);

it.effect("shares each live event item across subscribers and dedupes bodies per subscriber", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:shared-live");
    const messageId = MessageId.make("message:shared-live");
    const at = DateTime.makeUnsafe("2026-10-31T00:00:00.000Z");
    const owner = { threadId, runId: null, nodeId: null, createdAt: at, updatedAt: at };
    // DateTime memoizes its formatted parts, so only the plain records are frozen.
    const freeze = <A>(value: A): A => {
      if (typeof value === "object" && value !== null && !DateTime.isDateTime(value)) {
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
      }
      return value;
    };
    const live: ReadonlyArray<OrchestrationV2StoredEvent> = freeze([
      {
        sequence: 1,
        commandId: null,
        event: {
          id: EventId.make("event:shared-live:message"),
          type: "message.updated",
          threadId,
          occurredAt: at,
          payload: {
            ...owner,
            id: messageId,
            role: "assistant",
            text: "Done",
            attachments: [],
            streaming: false,
            createdBy: "agent",
            creationSource: "provider",
          },
        },
      },
      {
        sequence: 2,
        commandId: null,
        event: {
          id: EventId.make("event:shared-live:reply"),
          type: "turn-item.updated",
          threadId,
          occurredAt: at,
          payload: {
            ...owner,
            id: TurnItemId.make("item:shared-live:reply"),
            type: "assistant_message",
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            title: null,
            status: "completed",
            messageId,
            text: "Done",
            streaming: false,
            startedAt: at,
            completedAt: at,
          },
        },
      },
    ] as ReadonlyArray<OrchestrationV2StoredEvent>);
    const stringify = yield* Effect.acquireRelease(
      Effect.sync(() => vi.spyOn(JSON, "stringify")),
      (spy) => Effect.sync(() => spy.mockRestore()),
    );
    // The EventSink hands every subscriber the same projected objects.
    const subscribe = (acceptDedupedBodies: boolean) =>
      subscribeOrchestrationV2Thread({ threadId, afterSequence: 0, acceptDedupedBodies }).pipe(
        Effect.flatMap(Stream.runCollect),
        Effect.map((items) => Array.from(items)),
        Effect.provideService(ThreadManagement.ThreadManagementService, {
          ensureLegacyTranscript: () => Effect.void,
          streamStoredEventsFrom: () => Stream.fromIterable(live),
        } as unknown as ThreadManagement.ThreadManagementService["Service"]),
      );
    const [deduped, first, second] = yield* Effect.forEach([true, false, false], subscribe);

    assert.lengthOf(first!, live.length);
    first!.forEach((item, index) => {
      assert.strictEqual(item, second![index]);
      assert.strictEqual(item.kind === "event" && item.event, live[index]!.event);
    });
    assert.strictEqual(deduped![0], first![0]);
    const reply = deduped![1];
    assert.deepInclude(reply?.kind === "event" ? reply.event.payload : undefined, {
      text: "",
      textOmitted: true,
    });
    // The live buffer sizes each shared item once, not once per subscriber.
    assert.lengthOf(
      stringify.mock.calls.filter(([value]) => value?.kind === "event"),
      live.length,
    );
  }).pipe(Effect.scoped, Effect.provide(ReplayTestLayer)),
);

// Build the production RPC layer; unrelated capabilities fail if this test calls them.
const layerUnusedConfigRpcServices = Layer.mergeAll(
  Layer.mock(DocumentText.DocumentText)({}),
  Layer.mock(ServerSecretStore.ServerSecretStore)({}),
  Layer.mock(WorkspacePaths.WorkspacePaths)({}),
  Layer.mock(TraceDiagnostics.TraceDiagnostics)({}),
  Layer.mock(TriageService.TriageService)({}),
  Layer.mock(TextGenerators.TextGenerators)({}),
  Layer.mock(ProjectFaviconResolver.ProjectFaviconResolver)({}),
  Layer.mock(ProjectEnrichment.ProjectEnrichmentService)({}),
  Layer.mock(AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator)({}),
  Layer.mock(AcpRegistrySupport.AcpRegistryCatalog)({}),
  Layer.mock(AcpRegistrySessions.AcpRegistrySessions)({}),
  Layer.mock(AgentSessionImporter.AgentSessionImporter)({}),
  Layer.mock(AgentSessionScanner.AgentSessionScanner)({}),
  Layer.mock(AntigravityInstallation.AntigravityInstallation)({ managedDirectory: "/unused" }),
  Layer.mock(BackgroundPolicy.BackgroundPolicy)({}),
  Layer.mock(CheckpointDiffQuery.CheckpointDiffQuery)({}),
  Layer.mock(NativeChildWorkQuery.NativeChildWorkQuery)({}),
  Layer.mock(CommandOutputHub.CommandOutputHub)({}),
  ThreadViewers.layer,
  Layer.mock(CodexInstallation.CodexInstallation)({ managedDirectory: "/unused" }),
  Layer.mock(DeviceService.DeviceService)({}),
  Layer.mock(EnvironmentTheme.EnvironmentThemeService)({}),
  Layer.mock(GitWorkflowService.GitWorkflowService)({}),
  Layer.mock(HostResources.HostResources)({}),
  Layer.mock(McpAppRequests.McpAppRequests)({}),
  Layer.mock(McpSignIn.McpSignIn)({}),
  Layer.mock(ModelManifest.ModelManifest)({}),
  Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({}),
  Layer.mock(Orchestrator.OrchestratorV2)({}),
  Layer.mock(PairingGrantStore.PairingGrantStore)({}),
  Layer.mock(PortScanner.PortDiscovery)({ trackAgent: () => () => undefined }),
  Layer.mock(PreviewManager.PreviewManager)({}),
  Layer.mock(ProcessDiagnostics.ProcessDiagnostics)({}),
  Layer.mock(ProcessResourceMonitor.ProcessResourceMonitor)({}),
  Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({}),
  Layer.mock(ProjectService.ProjectService)({}),
  Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
  Layer.mock(ProjectStore.ProjectStoreV2)({}),
  Layer.mock(ProviderAuthService.ProviderAuthService)({}),
  Layer.mock(ProviderInstallation.ProviderInstallation)({}),
  Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({}),
  Layer.mock(ProviderLatestVersions.ProviderLatestVersions)({}),
  Layer.mock(ProviderMaintenanceRunner.ProviderMaintenanceRunner)({}),
  Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
  Layer.mock(PullRequestReviewGuideService.PullRequestReviewGuideService)({}),
  Layer.mock(PullRequestService.PullRequestService)({}),
  Layer.mock(IssueService.IssueService)({}),
  Layer.mock(ThreadIssueService.ThreadIssueService)({}),
  Layer.mock(PullRequestSyncReactor.PullRequestSyncReactor)({}),
  Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({}),
  Layer.mock(ResourceTelemetry.ResourceTelemetry)({}),
  Layer.mock(ReviewService.ReviewService)({}),
  Layer.mock(ScheduledTasks.ScheduledTaskService)({}),
  Workflows.layerDisabled,
  Layer.mock(WorkflowRuntime.WorkflowDefinitions)({}),
  Layer.mock(SecretRequests.SecretRequests)({}),
  Layer.mock(ServerLifecycleEvents.ServerLifecycleEvents)({}),
  Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({}),
  Layer.mock(ServerSelfUpdate.ServerSelfUpdate)({}),
  Layer.mock(ReleaseLookup.ReleaseLookup)({}),
  Layer.mock(SessionStore.SessionStore)({ cookieName: "config-test" }),
  Layer.mock(SourceControlDiscovery.SourceControlDiscovery)({}),
  Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({}),
  Layer.mock(SourceControlSignIn.SourceControlSignIn)({}),
  Layer.mock(StorageCleanup.StorageCleanup)({}),
  Layer.mock(DatabaseStorage.DatabaseStorage)({}),
  Layer.mock(TerminalManager.TerminalManager)({}),
  Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
  Layer.mock(ThreadManagement.ThreadManagementService)({}),
  Layer.mock(ThreadSearch.ThreadSearch)({}),
  Layer.mock(UsageService.UsageService)({}),
  Layer.mock(VcsProvisioningService.VcsProvisioningService)({}),
  Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({}),
  Layer.mock(WorkspaceEntries.WorkspaceEntries)({}),
  Layer.mock(WorkspaceFolders.WorkspaceFolders)({}),
  Layer.mock(TaskFolders.TaskFolders)({}),
  Layer.mock(WorkspaceFileSystem.WorkspaceFileSystem)({}),
  Layer.mock(WorktreeSetupTracker.WorktreeSetupTracker)({}),
  FeatureFlags.layerTest(),
);

const layerConfigSources = Layer.mergeAll(
  Keybindings.layer,
  AssetSigner.layer.pipe(Layer.provide(ServerSecretStore.layer)),
  WorkspacePreviewRevisions.layer,
  ServerSettings.layer.pipe(Layer.provide(ServerSecretStore.layer)),
).pipe(
  Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
  Layer.provideMerge(
    Layer.fresh(
      ServerConfigModule.layerTest(process.cwd(), { prefix: "ankiel-config-subscription-test-" }),
    ),
  ),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

it.effect("access changes made while the snapshot loads reach the client after it", () =>
  Effect.gen(function* () {
    const pairingChanges = yield* PubSub.unbounded<PairingGrantStore.BootstrapCredentialChange>();
    const sessionChanges = yield* PubSub.unbounded<SessionStore.SessionCredentialChange>();
    const subscribed = yield* Queue.unbounded<void>();
    const subscribe = <A>(changes: PubSub.PubSub<A>) =>
      Stream.unwrap(
        PubSub.subscribe(changes).pipe(
          Effect.tap(() => Queue.offer(subscribed, undefined)),
          Effect.map(Stream.fromSubscription),
        ),
      );
    const revokedElsewhere = AuthSessionId.make("revoked-elsewhere");
    const responses = yield* Queue.unbounded<AuthAccessStreamEvent>();
    const server = yield* RpcServer.makeNoSerialization(WsRpcGroup, {
      ...WS_RPC_SERVER_OPTIONS,
      onFromServer: (response) =>
        response._tag === "Chunk"
          ? Effect.forEach(
              response.values,
              (event) => Queue.offer(responses, event as AuthAccessStreamEvent),
              {
                discard: true,
              },
            )
          : Effect.void,
    }).pipe(
      Effect.provide(
        layerWsRpc(
          {
            sessionId: AuthSessionId.make("current"),
            subject: "current",
            method: "browser-session-cookie",
            scopes: [],
          },
          yield* ServerBrowser.ServerBrowser,
          () => Effect.void,
          { secretReferences: true },
        ).pipe(
          Layer.merge(RpcAuthorization.layer([AuthAccessReadScope])),
          Layer.provide(
            Layer.mergeAll(
              layerUnusedConfigRpcServices,
              Layer.mock(ExternalLauncher.ExternalLauncher)({}),
              Layer.mock(ProviderRegistry.ProviderRegistry)({}),
              Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({}),
              Layer.mock(DirectEndpoints.DirectEndpoints)({}),
              Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
                namedProjectsRoot: "/unused",
              }),
              Layer.mock(ScratchThreadPromotion.ScratchThreadPromotion)({}),
              Layer.mock(ServerEnvironment.ServerEnvironment)({}),
              Layer.mock(EnvironmentAuth.EnvironmentAuth)({
                listPairingLinks: () => Effect.succeed([]),
                // Another client revokes a session after the snapshot read it.
                listClientSessions: () =>
                  PubSub.publish(sessionChanges, {
                    type: "clientRemoved",
                    sessionId: revokedElsewhere,
                  }).pipe(Effect.as([])),
              }),
              Layer.mock(PairingGrantStore.PairingGrantStore)({
                streamChanges: subscribe(pairingChanges),
              }),
              Layer.mock(SessionStore.SessionStore)({
                cookieName: "auth-access-test",
                streamChanges: subscribe(sessionChanges),
              }),
            ),
          ),
        ),
      ),
    );
    const requestId = RpcMessage.RequestId("auth-access");
    yield* server.write(0, {
      _tag: "Request",
      id: requestId,
      tag: WS_METHODS.subscribeAuthAccess,
      payload: {},
      headers: Headers.empty,
    });
    const snapshot = yield* Queue.take(responses);
    assert.equal(snapshot.type, "snapshot");
    yield* server.write(0, { _tag: "Ack", requestId });
    yield* Queue.take(subscribed);
    yield* Queue.take(subscribed);

    // A later change arrives either way, so a dropped revocation fails as a mismatch.
    yield* PubSub.publish(pairingChanges, { type: "pairingLinkRemoved", id: "later" });
    const next = yield* Queue.take(responses);
    assert.deepEqual(next, {
      version: 1,
      revision: 2,
      type: "clientRemoved",
      payload: { sessionId: revokedElsewhere },
    });
    yield* server.write(0, { _tag: "Ack", requestId });
    assert.equal((yield* Queue.take(responses)).type, "pairingLinkRemoved");
    yield* server.write(0, { _tag: "Ack", requestId });
    yield* server.write(0, { _tag: "Interrupt", requestId, interruptors: [] });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.fresh(layerConfigSources),
        Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
        Layer.mock(ServerBrowser.ServerBrowser)({}),
      ),
    ),
  ),
);

it.effect(
  "worktree requests run a project's layout commands only for a session that may run commands",
  () =>
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const requested = Effect.fnUntraced(function* (scopes: ReadonlyArray<AuthEnvironmentScope>) {
        const seen: boolean[] = [];
        const exits = yield* Queue.unbounded<string>();
        const services = Layer.mergeAll(
          layerUnusedConfigRpcServices,
          Layer.mock(TaskFolders.TaskFolders)({
            createForProjectFolder: (_input, options) =>
              Effect.sync(() => seen.push(options.projectCommands)).pipe(
                Effect.as({ worktree: { path: "/repo-worktrees/feature", refName: "feature" } }),
              ),
            removeIfTaskFolder: (input) =>
              Effect.sync(() => seen.push(input.projectCommands)).pipe(Effect.as(true)),
          }),
          Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
            refreshStatus: () => Effect.die("unused"),
          }),
          Layer.mock(ExternalLauncher.ExternalLauncher)({}),
          Layer.mock(ProviderRegistry.ProviderRegistry)({}),
          Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({}),
          Layer.mock(DirectEndpoints.DirectEndpoints)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/unused" }),
          Layer.mock(ScratchThreadPromotion.ScratchThreadPromotion)({}),
          Layer.mock(ServerEnvironment.ServerEnvironment)({}),
          Layer.mock(EnvironmentAuth.EnvironmentAuth)({}),
        );
        const server = yield* RpcServer.makeNoSerialization(WsRpcGroup, {
          ...WS_RPC_SERVER_OPTIONS,
          onFromServer: (response) =>
            response._tag === "Exit" ? Queue.offer(exits, response.exit._tag) : Effect.void,
        }).pipe(
          Effect.provide(
            layerWsRpc(
              {
                sessionId: AuthSessionId.make("worktree-test"),
                subject: "worktree-test",
                method: "browser-session-cookie",
                scopes: [...scopes],
              },
              browser,
              () => Effect.void,
              { secretReferences: true },
            ).pipe(Layer.provide(services), Layer.merge(RpcAuthorization.layer(scopes))),
          ),
        );
        yield* server.write(0, {
          _tag: "Request",
          id: RpcMessage.RequestId("create"),
          tag: WS_METHODS.vcsCreateWorktree,
          payload: { cwd: "/repo", refName: "main", newRefName: "feature", path: null },
          headers: Headers.empty,
        });
        assert.equal(yield* Queue.take(exits), "Success");
        yield* server.write(0, {
          _tag: "Request",
          id: RpcMessage.RequestId("remove"),
          tag: WS_METHODS.vcsRemoveWorktree,
          payload: { cwd: "/repo", path: "/repo-worktrees/feature" },
          headers: Headers.empty,
        });
        assert.equal(yield* Queue.take(exits), "Success");
        return seen;
      }, Effect.scoped);

      assert.deepEqual(yield* requested([AuthSourceControlWriteScope]), [false, false]);
      assert.deepEqual(
        yield* requested([AuthSourceControlWriteScope, AuthOrchestrationOperateScope]),
        [true, true],
      );
      assert.deepEqual(yield* requested([AuthSourceControlWriteScope, AuthTerminalOperateScope]), [
        true,
        true,
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.fresh(layerConfigSources),
          Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
          Layer.mock(ServerBrowser.ServerBrowser)({}),
        ),
      ),
    ),
);

// Pruned history cannot be replayed: a cursor below the boundary must resync from a snapshot,
// or, for a shell client that loads it over HTTP, be told to without the server building one.
it.effect.each([
  { scope: "thread", httpSnapshotFallback: false },
  { scope: "shell", httpSnapshotFallback: false },
  { scope: "shell", httpSnapshotFallback: true },
] as const)(
  "$scope resume from a cursor below the pruned boundary (HTTP fallback: $httpSnapshotFallback)",
  ({ scope, httpSnapshotFallback }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-10-13T00:00:00.000Z";
      const threadId = ThreadId.make("thread:pruned");
      const insert = (version: number) => sql<{ sequence: number }>`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json, application_event_version
        ) VALUES (
          ${`pruned:${version}`}, 'thread', ${threadId}, ${version}, 'provider-session.detached',
          ${now}, 'server', ${JSON.stringify({ providerSessionId: "session:pruned", detachedAt: now })},
          '{}', 2
        ) RETURNING sequence
      `;
      const [first] = yield* insert(0);
      const [second] = yield* insert(1);
      yield* insert(2);
      yield* sql`
        INSERT INTO orchestration_v2_projection_metadata (
          projection_name, schema_version, last_sequence, updated_at
        ) VALUES (${OrchestrationEventStore.EVENT_LOG_PRUNED_THROUGH}, 2, ${second!.sequence}, ${now})
      `;
      const subscription = Effect.gen(function* () {
        const items: ReadonlyArray<unknown> =
          scope === "thread"
            ? yield* Stream.runCollect(
                yield* subscribeOrchestrationV2Thread({ threadId, afterSequence: first!.sequence }),
              )
            : yield* Stream.runCollect(
                yield* subscribeOrchestrationV2Shell({
                  afterSequence: first!.sequence,
                  ...(httpSnapshotFallback ? { httpSnapshotFallback: true as const } : {}),
                }),
              );
        return items;
      });
      const exit = yield* subscription.pipe(
        Effect.provideService(ThreadManagement.ThreadManagementService, {
          ensureLegacyTranscript: () => Effect.void,
          getThreadSnapshot: () => Effect.die("snapshot"),
          listActiveShellIndex: () => Effect.die("snapshot"),
          readShellSnapshot: () => Effect.die("snapshot"),
          listActiveSubagentThreadIds: () => Effect.die("replay"),
        } as unknown as ThreadManagement.ThreadManagementService["Service"]),
        Effect.provideService(ProjectStore.ProjectStoreV2, {
          listShells: () => Effect.succeed([]),
        } as unknown as ProjectStore.ProjectStoreV2["Service"]),
        Effect.provideService(
          ProjectService.ProjectService,
          {} as ProjectService.ProjectService["Service"],
        ),
        Effect.provideService(ProjectEnrichment.ProjectEnrichmentService, {
          subscribeChanges: PubSub.subscribe(yield* PubSub.unbounded()),
        } as ProjectEnrichment.ProjectEnrichmentService["Service"]),
        Effect.exit,
      );
      assert.deepEqual(
        Exit.isFailure(exit) ? Cause.squash(exit.cause) : Array.from(exit.value),
        httpSnapshotFallback ? [{ kind: "snapshot-required" }] : "snapshot",
      );
    }).pipe(Effect.scoped, Effect.provide(ReplayTestLayer)),
);

it.effect("thread resume replays a deleted thread's deletion and nothing recorded before it", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = "2026-10-13T00:00:00.000Z";
    const threadId = ThreadId.make("thread:deleted-resume");
    const insert = (version: number, type: string, payload: object) => sql`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, actor_kind, payload_json, metadata_json, application_event_version
      ) VALUES (
        ${`deleted-resume:${version}`}, 'thread', ${threadId}, ${version}, ${type},
        ${now}, 'server', ${JSON.stringify(payload)}, '{}', 2
      )
    `;
    const detached = { providerSessionId: "session:deleted-resume", detachedAt: now };
    yield* insert(0, "provider-session.detached", detached);
    yield* insert(1, "provider-session.detached", detached);
    yield* insert(2, "thread.deleted", {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: "project:deleted-resume",
      title: "Deleted",
      providerInstanceId: "codex",
      modelSelection: { instanceId: "codex", model: "default" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      deletedAt: now,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
    });

    const items = yield* subscribeOrchestrationV2Thread({ threadId, afterSequence: 0 }).pipe(
      Effect.flatMap(Stream.runCollect),
      Effect.provideService(ThreadManagement.ThreadManagementService, {
        ensureLegacyTranscript: () => Effect.void,
        streamStoredEventsFrom: () => Stream.empty,
      } as unknown as ThreadManagement.ThreadManagementService["Service"]),
    );
    assert.deepEqual(
      Array.from(items).map((item) => item.kind === "event" && item.event.type),
      ["thread.deleted"],
    );
  }).pipe(Effect.scoped, Effect.provide(ReplayTestLayer)),
);

// A prune pass can delete replayed rows after the boundary check; the read must not be trusted.
it.effect.each(["thread", "shell"] as const)(
  "%s resume loads a snapshot when pruning advances during the replay read",
  (scope) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-10-13T00:00:00.000Z";
      const threadId = ThreadId.make("thread:prune-race");
      const insert = (version: number) => sql<{ sequence: number }>`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json, application_event_version
        ) VALUES (
          ${`prune-race:${version}`}, 'thread', ${threadId}, ${version}, 'provider-session.detached',
          ${now}, 'server', ${JSON.stringify({ providerSessionId: "session:race", detachedAt: now })},
          '{}', 2
        ) RETURNING sequence
      `;
      const [first] = yield* insert(0);
      const [second] = yield* insert(1);
      yield* insert(2);

      const readStarted = yield* Deferred.make<void>();
      const releaseRead = yield* Deferred.make<void>();
      let gated = false;
      const gateReplayRead: Statement.Transformer = (statement) => {
        const [query] = statement.compile();
        // The paged replay read (readApplicationRows), not the stats or high-water queries.
        if (!gated && /^\s*SELECT\s+sequence,\s+event_id,/.test(query)) {
          gated = true;
          return Deferred.succeed(readStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseRead)),
            Effect.as(statement),
          );
        }
        return Effect.succeed(statement);
      };
      const subscription = Effect.gen(function* () {
        const stream =
          scope === "thread"
            ? yield* subscribeOrchestrationV2Thread({ threadId, afterSequence: first!.sequence })
            : yield* subscribeOrchestrationV2Shell({ afterSequence: first!.sequence });
        return stream;
      }).pipe(
        Effect.provideService(Statement.CurrentTransformer, gateReplayRead),
        Effect.provideService(ThreadManagement.ThreadManagementService, {
          ensureLegacyTranscript: () => Effect.void,
          getThreadSnapshot: () => Effect.die("snapshot"),
          listActiveShellIndex: () => Effect.die("snapshot"),
          readShellSnapshot: () => Effect.die("snapshot"),
          listActiveSubagentThreadIds: () => Effect.succeed([]),
        } as unknown as ThreadManagement.ThreadManagementService["Service"]),
        Effect.provideService(ProjectStore.ProjectStoreV2, {
          listShells: () => Effect.succeed([]),
        } as unknown as ProjectStore.ProjectStoreV2["Service"]),
        Effect.provideService(
          ProjectService.ProjectService,
          {} as ProjectService.ProjectService["Service"],
        ),
        Effect.provideService(ProjectEnrichment.ProjectEnrichmentService, {
          subscribeChanges: PubSub.subscribe(yield* PubSub.unbounded()),
        } as ProjectEnrichment.ProjectEnrichmentService["Service"]),
        Effect.exit,
        Effect.forkChild,
      );
      const fiber = yield* subscription;
      yield* Deferred.await(readStarted);
      // A pass publishes its boundary, then deletes the rows it covers.
      yield* sql`
        INSERT INTO orchestration_v2_projection_metadata (
          projection_name, schema_version, last_sequence, updated_at
        ) VALUES (${OrchestrationEventStore.EVENT_LOG_PRUNED_THROUGH}, 2, ${second!.sequence}, ${now})
      `;
      yield* sql`DELETE FROM orchestration_events WHERE sequence = ${second!.sequence}`;
      yield* Deferred.succeed(releaseRead, undefined);
      const exit = yield* Fiber.join(fiber);
      assert.deepEqual(Exit.isFailure(exit) ? Cause.squash(exit.cause) : exit, "snapshot");
    }).pipe(Effect.scoped, Effect.provide(ReplayTestLayer)),
);

// A cursor at the high-water missed nothing, even below the boundary; resuming must not resend
// a snapshot. The shell cases are a client that just loaded the HTTP snapshot of a pruned
// database: it gets the marker, and the project identities only when it does not name them.
it.effect.each([
  { scope: "thread", knowsIdentities: false, isRepository: true, kinds: [] },
  {
    scope: "shell",
    knowsIdentities: false,
    isRepository: true,
    kinds: ["snapshot", "synchronized"],
  },
  { scope: "shell", knowsIdentities: true, isRepository: true, kinds: ["synchronized"] },
  // The client keeps a cached identity over an absent one, so "resolved to none" still goes out.
  {
    scope: "shell",
    knowsIdentities: true,
    isRepository: false,
    kinds: ["snapshot", "synchronized"],
  },
] as const)(
  "$scope resume at its own high-water below the pruned boundary skips the snapshot (knows identities: $knowsIdentities, repository: $isRepository)",
  ({ scope, knowsIdentities, isRepository, kinds }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-10-13T00:00:00.000Z";
      const threadId = ThreadId.make("thread:idle");
      const [last] = yield* sql<{ sequence: number }>`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json, application_event_version
        ) VALUES (
          'idle:0', 'thread', ${threadId}, 0, 'provider-session.detached',
          ${now}, 'server', ${JSON.stringify({ providerSessionId: "session:idle", detachedAt: now })},
          '{}', 2
        ) RETURNING sequence
      `;
      yield* sql`
        INSERT INTO orchestration_v2_projection_metadata (
          projection_name, schema_version, last_sequence, updated_at
        ) VALUES (${OrchestrationEventStore.EVENT_LOG_PRUNED_THROUGH}, 2, ${last!.sequence + 10}, ${now})
      `;
      const identity = isRepository
        ? ({
            canonicalKey: "github.com/ankiel/idle",
            locator: {
              source: "git-remote",
              remoteName: "origin",
              remoteUrl: "git@github.com:ankiel/idle",
            },
          } as const)
        : null;
      const project = {
        id: ProjectId.make("project:idle"),
        title: "Idle",
        workspaceRoot: "/tmp/idle",
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      } satisfies OrchestrationProjectShell;
      const subscription = Effect.gen(function* () {
        if (scope === "thread") {
          return yield* subscribeOrchestrationV2Thread({
            threadId,
            afterSequence: last!.sequence,
          }).pipe(Effect.as([]));
        }
        const stream = yield* subscribeOrchestrationV2Shell({
          afterSequence: last!.sequence,
          requestCompletionMarker: true,
          ...(knowsIdentities
            ? {
                knownProjectIdentities: projectIdentitiesDigest([
                  { ...project, repositoryIdentity: identity },
                ]),
              }
            : {}),
        });
        return yield* stream.pipe(
          Stream.takeUntil((item) => item.kind === "synchronized"),
          Stream.map((item) => item.kind),
          Stream.runCollect,
        );
      });
      const exit = yield* subscription.pipe(
        Effect.provideService(ThreadManagement.ThreadManagementService, {
          ensureLegacyTranscript: () => Effect.void,
          getThreadSnapshot: () => Effect.die("snapshot"),
          listActiveShellIndex: () => Effect.die("snapshot"),
          readShellSnapshot: () => Effect.die("snapshot"),
          listActiveSubagentThreadIds: () => Effect.succeed([]),
          streamStoredEventsFrom: () => Stream.empty,
        } as unknown as ThreadManagement.ThreadManagementService["Service"]),
        Effect.provideService(ProjectStore.ProjectStoreV2, {
          listShells: () => Effect.succeed([project]),
        } as unknown as ProjectStore.ProjectStoreV2["Service"]),
        Effect.provideService(
          ProjectService.ProjectService,
          {} as ProjectService.ProjectService["Service"],
        ),
        Effect.provideService(ProjectEnrichment.ProjectEnrichmentService, {
          subscribeChanges: PubSub.subscribe(yield* PubSub.unbounded()),
          getAvailable: () =>
            Effect.succeed({
              repositoryIdentity: identity,
              faviconPath: null,
              repositoryIdentityResolved: true,
            }),
        } as unknown as ProjectEnrichment.ProjectEnrichmentService["Service"]),
        Effect.exit,
      );
      // A snapshot load dies with "snapshot", so success means the resume replayed nothing.
      assert.deepEqual(
        Exit.isFailure(exit) ? Cause.squash(exit.cause) : Array.from(exit.value),
        kinds,
      );
    }).pipe(Effect.scoped, Effect.provide(ReplayTestLayer)),
);

const workflowTags = [
  WS_METHODS.workflowsGet,
  WS_METHODS.workflowsAnswer,
  WS_METHODS.workflowsResume,
  WS_METHODS.workflowsCancel,
] as const;
const workflowRpcs = WsRpcGroup.omit(
  ...[...WsRpcGroup.requests.keys()].filter(
    (
      tag,
    ): tag is Exclude<
      keyof typeof RpcAuthorization.RPC_REQUIRED_SCOPES,
      (typeof workflowTags)[number]
    > => !(workflowTags as ReadonlyArray<string>).includes(tag),
  ),
);
const workflowRun: WorkflowRun = {
  runId: "run-1",
  workflow: "release",
  version: 1,
  title: "Release 1.2",
  status: "paused",
  detail: "build failed: exit 1",
  result: null,
  pauses: 1,
  retired: false,
  resumesAt: null,
  parentRunId: null,
  parentStep: null,
  startedAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:01:00.000Z",
  endedAt: null,
};
const workflowStep: WorkflowStep = {
  name: "build",
  kind: "step",
  status: "failed",
  attempts: 2,
  detail: "exit 1",
  threadId: null,
  environmentId: null,
  result: null,
  said: null,
  startedAt: "2026-11-01T00:00:10.000Z",
  endedAt: "2026-11-01T00:01:00.000Z",
};

/** A client for the workflow RPCs whose session holds `scopes`; `calls` records what reached the service. */
const makeWorkflowClient = Effect.fn("test.makeWorkflowClient")(function* (
  scopes: ReadonlyArray<AuthEnvironmentScope>,
  calls: Array<unknown>,
) {
  const services = Layer.mergeAll(
    layerUnusedConfigRpcServices,
    Layer.mock(ExternalLauncher.ExternalLauncher)({}),
    Layer.mock(ProviderRegistry.ProviderRegistry)({}),
    Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({}),
    Layer.mock(DirectEndpoints.DirectEndpoints)({}),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/unused" }),
    Layer.mock(ScratchThreadPromotion.ScratchThreadPromotion)({}),
    Layer.mock(ServerEnvironment.ServerEnvironment)({}),
    Layer.mock(EnvironmentAuth.EnvironmentAuth)({}),
    Layer.mock(Workflows.Workflows)({
      get: (runId) =>
        runId === workflowRun.runId
          ? Effect.succeed({ run: workflowRun, steps: [workflowStep], references: [] })
          : Effect.fail(new Workflows.WorkflowRunNotFoundError({ runId })),
      answer: (runId, name, value) =>
        Effect.sync(() => calls.push({ answer: [runId, name], value })),
      resume: (runId) => Effect.sync(() => calls.push({ resume: runId })),
      cancel: (runId, reason) => Effect.sync(() => calls.push({ cancel: runId, reason })),
    }),
  );
  return yield* RpcTest.makeClient(workflowRpcs).pipe(
    Effect.provide(
      layerWsRpc(
        {
          sessionId: AuthSessionId.make("workflow-test"),
          subject: "workflow-test",
          method: "browser-session-cookie",
          scopes: [...scopes],
        },
        yield* ServerBrowser.ServerBrowser,
        () => Effect.void,
        { secretReferences: true },
      ).pipe(Layer.provide(services), Layer.merge(RpcAuthorization.layer(scopes))),
    ),
  );
});
const layerWorkflowRpcTest = Layer.mergeAll(
  Layer.fresh(layerConfigSources),
  Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
  Layer.mock(ServerBrowser.ServerBrowser)({}),
);

it.effect("a session that can only read sees a workflow run but cannot steer it", () =>
  Effect.gen(function* () {
    const calls: Array<unknown> = [];
    const client = yield* makeWorkflowClient([AuthOrchestrationReadScope], calls);

    assert.equal((yield* client[WS_METHODS.workflowsGet]({ runId: "run-1" })).run.runId, "run-1");
    const refused = yield* Effect.all([
      client[WS_METHODS.workflowsAnswer]({ runId: "run-1", name: "approve", choice: "yes" }).pipe(
        Effect.flip,
      ),
      client[WS_METHODS.workflowsResume]({ runId: "run-1" }).pipe(Effect.flip),
      client[WS_METHODS.workflowsCancel]({ runId: "run-1" }).pipe(Effect.flip),
    ]);
    assert.deepEqual(
      refused.map((error) => error._tag),
      Array.from({ length: 3 }, () => "EnvironmentAuthorizationError"),
    );
    assert.deepEqual(calls, []);
  }).pipe(Effect.provide(layerWorkflowRpcTest), Effect.scoped),
);
