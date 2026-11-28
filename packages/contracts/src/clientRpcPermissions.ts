import {
  AuthAccessWriteScope,
  AuthEnvironmentMaintainScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  AuthTerminalOperateScope,
  type AuthEnvironmentScope,
} from "./auth.ts";
import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { WS_METHODS } from "./rpc.ts";

/** Incremental client enforcement; the server still authorizes every request. */
export const CLIENT_GUARDED_RPC_SCOPES = {
  [WS_METHODS.providerAuthRemoveMethod]: AuthProvidersManageScope,
  // An MCP sign-in stores a credential for the agent, as an account sign-in does.
  [WS_METHODS.providerMcpSignInStart]: AuthProvidersManageScope,
  [WS_METHODS.providerMcpSignInComplete]: AuthProvidersManageScope,
  [WS_METHODS.previewClose]: AuthPreviewOperateScope,
  // Stopping a server signals its processes, as closing a terminal does.
  [WS_METHODS.previewStopLocalServer]: AuthTerminalOperateScope,
  [WS_METHODS.serverRunStorageCleanup]: AuthSettingsWriteScope,
  // Restarts the server, as an update does.
  [WS_METHODS.serverReclaimDatabaseSpace]: AuthEnvironmentMaintainScope,
  // Listing models spends the stored API key, so only those who can choose a model may.
  [WS_METHODS.serverListTextGeneratorModels]: AuthSettingsWriteScope,
  [WS_METHODS.serverRefreshProviders]: AuthOrchestrationReadScope,
  [WS_METHODS.issuesCreate]: AuthSourceControlWriteScope,
  [WS_METHODS.issuesComment]: AuthSourceControlWriteScope,
  [WS_METHODS.issuesUpdate]: AuthSourceControlWriteScope,
  [WS_METHODS.issuesSetState]: AuthSourceControlWriteScope,
  [WS_METHODS.issuesReact]: AuthSourceControlWriteScope,
  [WS_METHODS.projectsCreateFromThread]: AuthOrchestrationOperateScope,
  [WS_METHODS.sourceControlCloneRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.sourceControlPublishRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.sourceControlStar]: AuthSourceControlWriteScope,
  // Signing in replaces the server's GitHub credential, as saving a token in Settings does.
  [WS_METHODS.sourceControlSignInStart]: AuthSettingsWriteScope,
  [WS_METHODS.sourceControlSignInWait]: AuthSettingsWriteScope,
  [WS_METHODS.sourceControlSignInCancel]: AuthSettingsWriteScope,
  [WS_METHODS.projectCloneStart]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneCancel]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneRetry]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPull]: AuthSourceControlWriteScope,
  [WS_METHODS.gitRunStackedAction]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsRemoveWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.workspaceAddTaskFolderRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsSwitchRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsInit]: AuthSourceControlWriteScope,

  // Starts an agent session on this environment that can read its logs and database.
  [WS_METHODS.serverPrepareTriage]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksUpsert]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksSetEnabled]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRunNow]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRotateWebhookToken]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_V2_WS_METHODS.stopWorkflow]: AuthOrchestrationOperateScope,
  // An answer, a resume and a cancel each decide what a run's agents do next.
  [WS_METHODS.workflowsAnswer]: AuthOrchestrationOperateScope,
  [WS_METHODS.workflowsResume]: AuthOrchestrationOperateScope,
  [WS_METHODS.workflowsCancel]: AuthOrchestrationOperateScope,
  // The server runs this file: saving it is running code there, as a terminal does.
  [WS_METHODS.workflowsSaveDefinition]: AuthTerminalOperateScope,
  [WS_METHODS.workflowsDeleteDefinition]: AuthTerminalOperateScope,
  // Force stop kills agent processes, as Stop on a terminal does.
  [ORCHESTRATION_V2_WS_METHODS.forceStopThread]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverConfigureRelay]: AuthAccessWriteScope,
  [WS_METHODS.serverDisconnectRelay]: AuthAccessWriteScope,
  // A device manages only its own session's registration, and the alerts carry thread titles.
  [WS_METHODS.serverRegisterPush]: AuthOrchestrationReadScope,
  [WS_METHODS.serverUnregisterPush]: AuthOrchestrationReadScope,
} as const;
export type ClientGuardedRpcTag = keyof typeof CLIENT_GUARDED_RPC_SCOPES;

export function clientRpcRequiredScopes(method: string): readonly AuthEnvironmentScope[] {
  return Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, method)
    ? [CLIENT_GUARDED_RPC_SCOPES[method as ClientGuardedRpcTag]]
    : [];
}
