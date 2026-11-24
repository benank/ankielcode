import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const RelayTunnelRoutingMode = Schema.Literals(["path", "subdomain"]);
export type RelayTunnelRoutingMode = typeof RelayTunnelRoutingMode.Type;

export const RelayTunnelSource = Schema.Literals(["none", "env", "file"]);
export type RelayTunnelSource = typeof RelayTunnelSource.Type;

export const RelayTunnelStatus = Schema.Struct({
  configured: Schema.Boolean,
  connected: Schema.Boolean,
  relayOrigin: Schema.NullOr(Schema.String),
  routingMode: Schema.NullOr(RelayTunnelRoutingMode),
  hostId: Schema.NullOr(Schema.String),
  publicBaseUrl: Schema.NullOr(Schema.String),
  hasSecret: Schema.Boolean,
  source: RelayTunnelSource,
  lastError: Schema.NullOr(Schema.String),
});
export type RelayTunnelStatus = typeof RelayTunnelStatus.Type;

export const RelayTunnelConfigureInput = Schema.Struct({
  setup: TrimmedNonEmptyString,
});
export type RelayTunnelConfigureInput = typeof RelayTunnelConfigureInput.Type;

export class RelayTunnelError extends Schema.TaggedError<RelayTunnelError>()("RelayTunnelError", {
  message: Schema.String,
}) {}
