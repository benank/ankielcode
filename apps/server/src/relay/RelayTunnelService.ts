// @effect-diagnostics nodeBuiltinImport:off - Relay identity paths live alongside stateDir files.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  type RelayTunnelConfigureInput,
  RelayTunnelError,
  type RelayTunnelStatus,
} from "@ankielcode/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpServer } from "effect/http";

import * as ServerConfig from "../config.ts";
import {
  buildPublicRelayBaseUrl,
  parseRelaySetupString,
  removeRelaySetupFromStateDir,
  resolveRelaySetupSourceFromEnvOrFile,
  saveRelaySetupToStateDir,
  type RelayPushMessage,
  type RelayPushResultMessage,
  type RelaySetupConfig,
} from "./relayProtocol.ts";
import {
  loadOrCreateRelayHostIdentity,
  startRelayTunnelClient,
  type RelayPushState,
  type RelayTunnelHandle,
} from "./RelayTunnelClient.ts";

export interface RelayTunnelServiceShape {
  readonly getStatus: Effect.Effect<RelayTunnelStatus>;
  readonly statusChanges: Stream.Stream<RelayTunnelStatus>;
  readonly configure: (
    input: RelayTunnelConfigureInput,
  ) => Effect.Effect<RelayTunnelStatus, RelayTunnelError>;
  readonly disconnect: Effect.Effect<RelayTunnelStatus, RelayTunnelError>;
  /** Null while the tunnel is not connected. */
  readonly pushState: Effect.Effect<RelayPushState | null>;
  /** Null when the tunnel is down or drops before the relay answers; nothing retries. */
  readonly sendPush: (message: RelayPushMessage) => Effect.Effect<RelayPushResultMessage | null>;
}

export class RelayTunnelService extends Context.Service<
  RelayTunnelService,
  RelayTunnelServiceShape
>()("@ankielcode/server/relay/RelayTunnelService") {}

interface ActiveState {
  setup: RelaySetupConfig | null;
  source: "none" | "env" | "file";
  handle: RelayTunnelHandle | null;
  lastError: string | null;
}

const CONNECT_WAIT_MS = 5_000;

function resolveIdentityPath(stateDir: string): string {
  const legacyPath = NodePath.join(stateDir, "relay-host-identity.json");
  return NodeFS.existsSync(legacyPath)
    ? legacyPath
    : NodePath.join(stateDir, "secrets", "relay-host-identity.json");
}

function buildStatus(state: ActiveState): RelayTunnelStatus {
  if (!state.setup) {
    return {
      configured: false,
      connected: false,
      relayOrigin: null,
      routingMode: null,
      hostId: null,
      publicBaseUrl: null,
      hasSecret: false,
      source: "none",
      lastError: state.lastError,
    };
  }
  const hostId = state.handle?.hostId ?? null;
  const publicBaseUrl =
    state.handle?.publicBaseUrl ?? (hostId ? buildPublicRelayBaseUrl(state.setup, hostId) : null);
  return {
    configured: true,
    connected: state.handle?.isConnected() ?? false,
    relayOrigin: state.setup.relayOrigin,
    routingMode: state.setup.routingMode,
    hostId,
    publicBaseUrl,
    hasSecret: Boolean(state.setup.secret),
    source: state.source,
    lastError: state.lastError,
  };
}

export const makeRelayTunnelServiceLayer = (awaitActivation: Effect.Effect<void>) =>
  Layer.effect(
    RelayTunnelService,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const server = yield* HttpServer.HttpServer;
      const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());

      const state: ActiveState = {
        setup: null,
        source: "none",
        handle: null,
        lastError: null,
      };
      const statusRef = yield* SubscriptionRef.make<RelayTunnelStatus>(buildStatus(state));
      const publishStatus = () => {
        void runPromise(SubscriptionRef.set(statusRef, buildStatus(state)));
      };

      const resolveLocalEndpoint = (): { readonly host: string; readonly port: number } | null => {
        const address = server.address;
        if (address._tag === "UnixPathAddress") return null;
        const rawHost = String(address.address);
        const host =
          rawHost === "0.0.0.0" || rawHost === "::" || rawHost === "" ? "127.0.0.1" : rawHost;
        return { host, port: address.port };
      };

      const stopActive = async () => {
        const current = state.handle;
        state.handle = null;
        if (current) {
          await current.stop();
        }
      };

      const startWithSetup = async (
        setup: RelaySetupConfig,
        source: "env" | "file",
        waitForReady: boolean,
      ) => {
        await stopActive();
        state.setup = setup;
        state.source = source;
        state.lastError = null;

        const endpoint = resolveLocalEndpoint();
        if (!endpoint) {
          state.lastError = "Local HTTP server address is unavailable.";
          return;
        }
        const identity = await loadOrCreateRelayHostIdentity(resolveIdentityPath(config.stateDir));
        const handle = startRelayTunnelClient({
          setup,
          identity,
          localHost: endpoint.host,
          localPort: endpoint.port,
          onReady: (publicBaseUrl) => {
            state.lastError = null;
            publishStatus();
            void runPromise(
              Effect.logInfo("Cloudflare relay tunnel connected", {
                hostId: identity.hostId,
                publicBaseUrl,
                routingMode: setup.routingMode,
              }),
            );
          },
          onClose: () => {
            publishStatus();
          },
          onError: (message, cause) => {
            state.lastError = message;
            publishStatus();
            void runPromise(Effect.logWarning(message, { cause }));
          },
        });
        state.handle = handle;

        if (waitForReady) {
          try {
            await handle.waitUntilReady(CONNECT_WAIT_MS);
          } catch (error) {
            if (!state.lastError) {
              state.lastError = error instanceof Error ? error.message : String(error);
            }
          }
        }
      };

      yield* Effect.addFinalizer(() => Effect.promise(stopActive));

      // Boot existing relay configuration once HTTP listening activates.
      const initial = resolveRelaySetupSourceFromEnvOrFile(config.stateDir);
      if (initial) {
        yield* awaitActivation.pipe(
          Effect.andThen(
            Effect.promise(() => startWithSetup(initial.config, initial.source, false)),
          ),
          Effect.forkScoped,
        );
      }

      const getStatus = Effect.fn("RelayTunnelService.getStatus")(() =>
        Effect.sync(() => buildStatus(state)),
      );

      const configure = Effect.fn("RelayTunnelService.configure")(function* (
        input: RelayTunnelConfigureInput,
      ) {
        if (state.source === "env") {
          return yield* new RelayTunnelError({
            message:
              "Relay is configured via environment variables (ANKIEL_RELAY_SETUP / ANKIEL_RELAY_URL). Unset them and restart the server to change it here.",
          });
        }
        const parsed = yield* Effect.try({
          try: () => parseRelaySetupString(input.setup),
          catch: (error) =>
            new RelayTunnelError({
              message: error instanceof Error ? error.message : "Invalid relay setup string.",
            }),
        });
        yield* Effect.try({
          try: () => saveRelaySetupToStateDir(config.stateDir, input.setup),
          catch: (error) =>
            new RelayTunnelError({
              message:
                error instanceof Error ? error.message : "Failed to save relay configuration.",
            }),
        });
        yield* Effect.promise(() => startWithSetup(parsed, "file", true));
        const nextStatus = buildStatus(state);
        yield* SubscriptionRef.set(statusRef, nextStatus);
        return nextStatus;
      });

      const disconnect = Effect.fn("RelayTunnelService.disconnect")(function* () {
        if (state.source === "env") {
          return yield* new RelayTunnelError({
            message:
              "Relay is configured via environment variables (ANKIEL_RELAY_SETUP / ANKIEL_RELAY_URL). Unset them and restart the server to disconnect.",
          });
        }
        yield* Effect.promise(stopActive);
        yield* Effect.try({
          try: () => removeRelaySetupFromStateDir(config.stateDir),
          catch: (error) =>
            new RelayTunnelError({
              message:
                error instanceof Error ? error.message : "Failed to remove saved relay config.",
            }),
        });
        state.setup = null;
        state.source = "none";
        state.lastError = null;
        const nextStatus = buildStatus(state);
        yield* SubscriptionRef.set(statusRef, nextStatus);
        return nextStatus;
      });

      return RelayTunnelService.of({
        getStatus: getStatus(),
        statusChanges: SubscriptionRef.changes(statusRef),
        configure,
        disconnect: disconnect(),
        pushState: Effect.sync(() => state.handle?.pushState() ?? null),
        sendPush: Effect.fn("RelayTunnelService.sendPush")((message: RelayPushMessage) =>
          Effect.promise(() => state.handle?.sendPush(message) ?? Promise.resolve(null)),
        ),
      });
    }),
  );
