import {
  AC_PROJECT_FILE_NAME,
  type EnvironmentId,
  type ProjectReadFileResult,
  type AnkielProjectFile,
} from "@ankielcode/contracts";
import { parseAnkielProjectFile } from "@ankielcode/shared/ankielProjectFile";
import { executeAtomQuery } from "@ankielcode/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";

import {
  getProjectFileQueryAtom,
  resolveProjectFileQueryData,
} from "~/components/files/projectFilesQueryState";
import { appAtomRegistry } from "~/rpc/atomRegistry";

function toAnkielProjectFile(
  environmentId: EnvironmentId,
  workspaceRoot: string,
  result: ProjectReadFileResult | null,
): AnkielProjectFile | null {
  const data = resolveProjectFileQueryData(
    environmentId,
    workspaceRoot,
    AC_PROJECT_FILE_NAME,
    result,
  );
  if (data === null || data.exists === false || data.truncated) return null;
  return parseAnkielProjectFile(data.contents);
}

export async function readAnkielProjectFile(
  environmentId: EnvironmentId,
  workspaceRoot: string,
): Promise<AnkielProjectFile | null> {
  const result = await executeAtomQuery(
    appAtomRegistry,
    getProjectFileQueryAtom(environmentId, workspaceRoot, AC_PROJECT_FILE_NAME),
    { reportDefect: false, reportFailure: false },
  );
  return toAnkielProjectFile(
    environmentId,
    workspaceRoot,
    result._tag === "Success" ? result.value : null,
  );
}

/** The project's ac.json from an earlier read, or `undefined` when none has loaded yet. */
export function peekAnkielProjectFile(
  environmentId: EnvironmentId,
  workspaceRoot: string,
): AnkielProjectFile | null | undefined {
  const result = appAtomRegistry.get(
    getProjectFileQueryAtom(environmentId, workspaceRoot, AC_PROJECT_FILE_NAME),
  );
  return AsyncResult.isSuccess(result)
    ? toAnkielProjectFile(environmentId, workspaceRoot, result.value)
    : undefined;
}
