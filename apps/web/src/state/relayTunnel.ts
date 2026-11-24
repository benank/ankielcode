import { createRelayTunnelEnvironmentAtoms } from "@ankielcode/client-runtime/state/relayTunnel";

import { connectionAtomRuntime } from "../connection/runtime";

export const relayTunnelEnvironment = createRelayTunnelEnvironmentAtoms(connectionAtomRuntime);
