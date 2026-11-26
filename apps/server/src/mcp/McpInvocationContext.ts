import {
  type AuthMcpClientAccess,
  type EnvironmentId,
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
  PreviewAutomationUnavailableError,
  type ProviderInstanceId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@ankielcode/contracts";
import { formatThreadLink } from "@ankielcode/shared/threadLinks";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

const ALL_MCP_CAPABILITIES = [
  "preview",
  "orchestration",
  "worktree",
  "device",
  "pull-requests",
  "background-wait",
] as const;
export type McpCapability = (typeof ALL_MCP_CAPABILITIES)[number];

export interface McpThreadCaller {
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  /** A delegated child task; its parent owns the work it hands back. */
  readonly subagent?: boolean;
}

/** A caller outside any thread: the local CLI (`ankiel thread`, `ankiel workflow`). */
export interface McpClientCaller {
  readonly sessionId: string;
  readonly label: string;
  readonly access: AuthMcpClientAccess;
}

export interface ClientModes {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

/**
 * The modes a client caller's writes are capped at. A read-only client never
 * reaches a write (`McpToolAccess` refuses it first), so it maps to the lowest
 * runtime mode rather than to nothing.
 */
export const clientModeCeiling = (client: McpClientCaller | undefined): ClientModes => ({
  runtimeMode:
    client === undefined || client.access === "read-only" ? "approval-required" : client.access,
  interactionMode: "default",
});

/** Thread callers default to their own thread; client callers need thread for tools that act as the caller. */
export interface McpInvocationScope {
  readonly environmentId: EnvironmentId;
  readonly capabilities: ReadonlySet<McpCapability>;
  readonly issuedAt: number;
  readonly requestNamespace: string;
  readonly thread: McpThreadCaller | undefined;
  readonly client: McpClientCaller | undefined;
  /** True while Labs → Workflows is on here; `/mcp` reads it per request. Unset is off. */
  readonly workflows?: boolean;
  /**
   * The origin this `/mcp` request reached, e.g. a tunnel. Hosted clients cannot
   * see the URL they were configured with, so links they must fetch carry it. Unset in-process.
   */
  readonly origin?: string | undefined;
  /** False when the calling thread's project is on no forge Ankiel reads; `/mcp` reads it per request. */
  readonly forge?: boolean;
}

export const threadLinkFor = (
  scope: Pick<McpInvocationScope, "environmentId">,
  threadId: ThreadId,
  title?: string,
): string => formatThreadLink({ environmentId: scope.environmentId, threadId }, title);

export class McpInvocationContext extends Context.Service<
  McpInvocationContext,
  McpInvocationScope
>()("@ankielcode/cli/mcp/McpInvocationContext") {}

/**
 * `McpSchema.EnabledWhen` for tools a delegated child must not see or call.
 * EnabledWhen only receives the MCP client profile, so read the Ankiel caller from the request fiber.
 */
export const hiddenFromSubagents = (): boolean => {
  const fiber = Fiber.getCurrent();
  const scope = fiber && Context.getOrUndefined(fiber.context, McpInvocationContext);
  return scope?.thread?.subagent !== true;
};

/**
 * `McpSchema.EnabledWhen` for tools that act as the calling thread: a client
 * from outside has none. Discovery only; `McpToolAccess` still refuses the
 * call, and `toLayer` requires this on every thread-bound declaration.
 */
export const hiddenFromOutsideClients = (): boolean => {
  const fiber = Fiber.getCurrent();
  const scope = fiber && Context.getOrUndefined(fiber.context, McpInvocationContext);
  return scope === undefined || scope.thread !== undefined;
};

/** `hiddenFromOutsideClients`, and hidden from a thread whose provider cannot hold for background work. */
export const hiddenWithoutBackgroundWait = (): boolean => {
  const fiber = Fiber.getCurrent();
  const scope = fiber && Context.getOrUndefined(fiber.context, McpInvocationContext);
  return (
    scope === undefined || (scope.thread !== undefined && scope.capabilities.has("background-wait"))
  );
};

/** `McpSchema.EnabledWhen` for tools only a client outside a thread drives, such as the CLI. */
export const hiddenFromThreads = (): boolean => {
  const fiber = Fiber.getCurrent();
  const scope = fiber && Context.getOrUndefined(fiber.context, McpInvocationContext);
  return scope?.thread === undefined;
};

/** `McpSchema.EnabledWhen` for workflow event types: outside clients only, while Workflows is on. */
export const hiddenUnlessWorkflowEvents = (): boolean => {
  const fiber = Fiber.getCurrent();
  const scope = fiber && Context.getOrUndefined(fiber.context, McpInvocationContext);
  return scope !== undefined && scope.thread === undefined && scope.workflows === true;
};

/** `McpSchema.EnabledWhen` for tools that act on the thread's forge, hidden where it has none. */
export const hiddenWithoutForge = (): boolean => {
  const fiber = Fiber.getCurrent();
  const scope = fiber && Context.getOrUndefined(fiber.context, McpInvocationContext);
  return scope?.forge !== false;
};

export type McpCapabilityError<C extends McpCapability> = C extends "preview"
  ? PreviewAutomationUnavailableError
  : McpCapabilityUnavailableError;

const missingCapability = (
  invocation: McpInvocationScope,
  capability: McpCapability,
): PreviewAutomationUnavailableError | McpCapabilityUnavailableError => {
  const fields = {
    environmentId: invocation.environmentId,
    ...(invocation.thread === undefined
      ? {}
      : {
          threadId: invocation.thread.threadId,
          providerSessionId: invocation.thread.providerSessionId,
          providerInstanceId: invocation.thread.providerInstanceId,
        }),
  };
  return capability === "preview"
    ? new PreviewAutomationUnavailableError({ capability, ...fields })
    : new McpCapabilityUnavailableError({ capability, ...fields });
};

export const requireMcpCapability = <const C extends McpCapability>(
  capability: C,
): Effect.Effect<McpInvocationScope, McpCapabilityError<C>, McpInvocationContext> =>
  McpInvocationContext.pipe(
    Effect.filterOrFail(
      (invocation) => invocation.capabilities.has(capability),
      (invocation) => missingCapability(invocation, capability) as McpCapabilityError<C>,
    ),
    Effect.withSpan("mcp.requireCapability"),
  );

export const requireThreadMcpCapability = <const C extends "preview" | "device">(
  capability: C,
): Effect.Effect<McpThreadInvocationScope, McpCapabilityError<C>, McpInvocationContext> =>
  McpInvocationContext.pipe(
    Effect.filterOrFail(
      (invocation): invocation is McpThreadInvocationScope =>
        invocation.capabilities.has(capability) && invocation.thread !== undefined,
      (invocation) => missingCapability(invocation, capability) as McpCapabilityError<C>,
    ),
    Effect.withSpan("mcp.requireCapability"),
  );

const threadCallerRequired = (operation: string) =>
  new OrchestratorMcpFailure({
    code: "thread_credential_required",
    message: `${operation} acts as the calling Ankiel thread, so it needs an agent running inside Ankiel Code. This MCP client signed in from outside a thread.`,
  });

export type McpThreadInvocationScope = McpInvocationScope & { readonly thread: McpThreadCaller };

export const requireThreadScope = (scope: McpInvocationScope, operation: string) =>
  scope.thread === undefined
    ? Effect.fail(threadCallerRequired(operation))
    : Effect.succeed(scope as McpThreadInvocationScope);
