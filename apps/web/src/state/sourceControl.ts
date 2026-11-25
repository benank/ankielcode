import { createSourceControlEnvironmentAtoms } from "@ankielcode/client-runtime/state/source-control";

import { connectionAtomRuntime } from "../connection/runtime";

import { serverEnvironment } from "./server";

export const sourceControlEnvironment = createSourceControlEnvironmentAtoms(
  connectionAtomRuntime,
  serverEnvironment.configValueAtom,
);
