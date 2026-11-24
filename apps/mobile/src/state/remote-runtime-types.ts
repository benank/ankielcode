import { type EnvironmentConnectionPhase } from "@ankielcode/client-runtime/connection";
import type { MarkedText } from "@ankielcode/client-runtime/errors";
import { EnvironmentId, ThreadId, type ServerConfig } from "@ankielcode/contracts";

export interface EnvironmentRuntimeState {
  readonly connectionState: EnvironmentConnectionPhase;
  readonly connectionError: string | null;
  readonly i18nConnectionError?: MarkedText;
  readonly connectionErrorTraceId: string | null;
  readonly serverConfig: ServerConfig | null;
}

export interface ConnectedEnvironmentSummary {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly displayUrl: string;
  readonly isEnabled: boolean;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly connectionError: string | null;
  readonly i18nConnectionError?: MarkedText;
  readonly connectionErrorTraceId: string | null;
}

export interface SelectedThreadRef {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}
