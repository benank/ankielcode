import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSetupError,
  ThreadId,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ThreadShell,
  type ProviderAuthState,
} from "@ankielcode/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import type { ProviderInstance } from "@ankielcode/provider-core/server/driver";
import * as ProviderAuthService from "./ProviderAuthService.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";

const instanceId = ProviderInstanceId.make("antigravity-personal");
const otherInstanceId = ProviderInstanceId.make("antigravity-work");
const unsupportedInstanceId = ProviderInstanceId.make("codex");
const driverKind = ProviderDriverKind.make("antigravity");
const owner = "paired-client-owner";
const otherOwner = "paired-client-other";
const flowId = "test-sign-in-flow";
const callbackUrl = "http://127.0.0.1:48123/?state=test-state&code=test-code";
const idleAuthState: ProviderAuthState = {
  instanceId,
  phase: "idle",
  flowId: null,
  authorizationUrl: null,
  expiresAt: null,
  message: null,
};
const waitingAuthState: ProviderAuthState = {
  ...idleAuthState,
  phase: "waiting",
  flowId,
  authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=test-state",
  expiresAt: "2026-09-02T00:05:00.000Z",
};

function makeInstance(input: {
  instanceId: ProviderInstanceId;
  enabled: boolean;
  auth?: ProviderAuthService.ProviderAuthController;
}): ProviderInstance {
  return {
    ...input,
    driverKind,
    displayName: undefined,
    continuationIdentity: { driverKind, continuationKey: input.instanceId },
    get snapshot(): never {
      throw new Error("Auth routing must not refresh the provider snapshot.");
    },
    get orchestrationAdapter(): never {
      throw new Error("Auth routing must not start an adapter session.");
    },
    get textGeneration(): never {
      throw new Error("Auth routing must not generate text.");
    },
  };
}

const makeHarness = Effect.fn("ProviderAuthService.test.makeHarness")(function* (
  input: {
    enabled?: boolean;
    threads?: ReadonlyArray<OrchestrationV2ThreadShell>;
    sessions?: ReadonlyMap<ThreadId, ReadonlyArray<OrchestrationV2ProviderSession>>;
    shellError?: boolean;
    stopError?: boolean;
    logoutError?: ProviderSetupError;
    sharedCredentials?: boolean;
    sharedBusy?: boolean;
    sharedBusyEffect?: Effect.Effect<boolean>;
    responds?: boolean;
    beforeLogout?: Effect.Effect<void>;
    beforeStop?: Effect.Effect<void>;
    beforeListSessions?: Effect.Effect<void>;
    onLookup?: Effect.Effect<void>;
    onListThreads?: (instances: ProviderInstance[]) => void;
  } = {},
) {
  const actions: string[] = [];
  const registryChanges = yield* PubSub.unbounded<void>();
  const threads = input.threads ?? [];
  const sessions = new Map(
    [...(input.sessions?.entries() ?? [])].map(([threadId, list]) => [threadId, [...list]]),
  );
  const released: string[] = [];
  const idle = idleAuthState;
  let state = idle;
  let flowOwner: string | undefined;
  let gateClosed = false;

  const checkOwner = Effect.fn("ProviderAuthService.test.checkOwner")(function* (
    ownerSessionId: string,
    requestedFlowId: string,
    operation: string,
  ) {
    if (ownerSessionId !== flowOwner || requestedFlowId !== state.flowId) {
      return yield* new ProviderSetupError({
        instanceId,
        operation,
        detail: "This sign-in belongs to another client or has expired.",
      });
    }
  });

  const auth: ProviderAuthService.ProviderAuthController = {
    ...(input.sharedCredentials
      ? { credentialBinding: { owner: "provider" as const, key: "shared" } }
      : {}),
    ...(input.responds
      ? {
          respond: Effect.fn(function* (ownerSessionId, request) {
            yield* checkOwner(ownerSessionId, request.flowId, "respond");
            actions.push(`respond:${request.response.type}`);
            return state;
          }),
        }
      : {}),
    start: Effect.fn(function* (ownerSessionId, stopSessions) {
      gateClosed = true;
      actions.push("close-gate");
      yield* stopSessions ?? Effect.void;
      flowOwner = ownerSessionId;
      state = waitingAuthState;
      actions.push("start-sign-in");
      return state;
    }),
    complete: Effect.fn(function* (ownerSessionId, request) {
      yield* checkOwner(ownerSessionId, request.flowId, "complete");
      if (request.callbackUrl !== callbackUrl) {
        return yield* new ProviderSetupError({
          instanceId,
          operation: "complete",
          detail: "The redirect URL does not match this sign-in.",
        });
      }
      state = { ...idle, flowId, phase: "succeeded" };
      return state;
    }),
    cancel: Effect.fn(function* (ownerSessionId, requestedFlowId) {
      yield* checkOwner(ownerSessionId, requestedFlowId, "cancel");
      state = { ...idle, flowId, phase: "cancelled" };
      return state;
    }),
    logout: Effect.fn(function* (stopSessions) {
      gateClosed = true;
      actions.push("close-gate");
      yield* stopSessions;
      if (input.logoutError) return yield* input.logoutError;
      yield* input.beforeLogout ?? Effect.void;
      actions.push("native-logout");
      state = idle;
      flowOwner = undefined;
      return state;
    }),
    subscribe: (ownerSessionId) =>
      Stream.fromEffect(Effect.sync(() => (ownerSessionId === flowOwner ? state : idle))),
    isLogoutPrompt: (text, hasAttachments) => !hasAttachments && text.trim() === "/logout",
  };
  const instances = [
    makeInstance({ instanceId, enabled: input.enabled ?? true, auth }),
    makeInstance({ instanceId: unsupportedInstanceId, enabled: true }),
    ...(input.sharedCredentials
      ? [
          makeInstance({
            instanceId: otherInstanceId,
            enabled: true,
            auth: {
              ...auth,
              isChangingCredentials:
                input.sharedBusyEffect ?? Effect.succeed(input.sharedBusy ?? false),
              invalidate: Effect.sync(() => {
                actions.push("invalidate-shared");
              }),
            },
          }),
        ]
      : []),
  ];
  const service = yield* ProviderAuthService.makeProviderAuthService.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
          getInstance: (id) =>
            Effect.gen(function* () {
              const found = instances.find((instance) => instance.instanceId === id);
              yield* input.onLookup ?? Effect.void;
              return found;
            }),
          listInstances: Effect.succeed(instances),
          subscribeChanges: PubSub.subscribe(registryChanges),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRecoveryThreadIds: () =>
            Effect.gen(function* () {
              assert.isTrue(gateClosed);
              actions.push("list-threads");
              input.onListThreads?.(instances);
              yield* input.beforeListSessions ?? Effect.void;
              return yield* input.shellError
                ? Effect.fail(
                    new ProjectionStore.ProjectionStoreReadError({
                      threadId: ThreadId.make("shell"),
                      cause: new Error("private database diagnostics"),
                    }),
                  )
                : Effect.succeed(threads.map((thread) => thread.id));
            }),
          getThreadRecords: (threadId) =>
            Effect.sync(() => {
              actions.push(`sessions:${threadId}`);
              return {
                providerSessions: sessions.get(threadId) ?? [],
              } as never;
            }),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          release: ({ providerSessionId, reason }) =>
            Effect.gen(function* () {
              assert.isTrue(gateClosed);
              actions.push(`stop:${providerSessionId}`);
              yield* input.beforeStop ?? Effect.void;
              if (input.stopError) {
                return yield* new ProviderSessionManager.ProviderSessionReleaseError({
                  providerSessionId,
                  reason,
                  cause: new Error("private process diagnostics"),
                });
              }
              released.push(providerSessionId);
              for (const [threadId, list] of sessions) {
                const remaining = list.filter((session) => session.id !== providerSessionId);
                if (remaining.length === 0) sessions.delete(threadId);
                else sessions.set(threadId, remaining);
              }
            }),
        }),
      ),
    ),
  );
  return {
    service,
    actions,
    released,
    sessions,
    auth,
    addInstance: (instance: ProviderInstance) => instances.push(instance),
    replaceInstance: (replacement: ProviderInstance) => {
      const index = instances.findIndex(
        (instance) => instance.instanceId === replacement.instanceId,
      );
      assert.isAtLeast(index, 0);
      instances[index] = replacement;
    },
    replaceAuth: (next: ProviderAuthService.ProviderAuthController) => {
      instances[0] = makeInstance({ instanceId, enabled: input.enabled ?? true, auth: next });
    },
  };
});

describe("ProviderAuthService", () => {
  it.effect("keeps sign-in state private and accepts the owner's redirect URL", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const waiting = yield* service.start({ instanceId }, owner);
      const ownerStates = yield* service
        .subscribe({ instanceId }, owner)
        .pipe(Stream.take(1), Stream.runCollect);
      const otherStates = yield* service
        .subscribe({ instanceId }, otherOwner)
        .pipe(Stream.take(1), Stream.runCollect);

      assert.deepStrictEqual(ownerStates, [waiting]);
      assert.strictEqual(otherStates[0]?.authorizationUrl, null);
      assert.strictEqual(otherStates[0]?.flowId, null);

      const otherError = yield* Effect.flip(
        service.complete({ instanceId, flowId, callbackUrl }, otherOwner),
      );
      assert.strictEqual(otherError.operation, "complete");
      const complete = yield* service.complete({ instanceId, flowId, callbackUrl }, owner);
      assert.strictEqual(complete.phase, "succeeded");
      assert.strictEqual(complete.authorizationUrl, null);
    }),
  );

  it.effect("lets only the flow owner cancel sign-in", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      yield* service.start({ instanceId }, owner);
      const error = yield* Effect.flip(service.cancel({ instanceId, flowId }, otherOwner));
      assert.strictEqual(error.operation, "cancel");

      const cancelled = yield* service.cancel({ instanceId, flowId }, owner);
      assert.strictEqual(cancelled.phase, "cancelled");
      assert.strictEqual(cancelled.authorizationUrl, null);
    }),
  );

  it.effect("refuses a chat sign-out that no person sent", () =>
    Effect.gen(function* () {
      const { service, actions } = yield* makeHarness({});
      const error = yield* Effect.flip(
        service.tryHandlePromptCommand({
          instanceId,
          text: "/logout",
          hasAttachments: false,
          sentByPerson: false,
        }),
      );

      assert.strictEqual(error.operation, "logout");
      assert.deepStrictEqual(actions, []);
      // Any other prompt still goes to the provider.
      assert.isFalse(
        yield* service.tryHandlePromptCommand({
          instanceId,
          text: "hello",
          hasAttachments: false,
          sentByPerson: false,
        }),
      );
    }),
  );
});
