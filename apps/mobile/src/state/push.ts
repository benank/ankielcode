import { createPushEnvironmentAtoms } from "@ankielcode/client-runtime/state/push";

import { connectionAtomRuntime } from "../connection/runtime";

export const pushEnvironment = createPushEnvironmentAtoms(connectionAtomRuntime);
