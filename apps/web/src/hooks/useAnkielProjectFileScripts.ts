import {
  AC_PROJECT_FILE_NAME,
  type EnvironmentId,
  type AnkielProjectFile,
  type AnkielProjectFileScript,
} from "@ankielcode/contracts";
import { parseAnkielProjectFile } from "@ankielcode/shared/ankielProjectFile";

import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";

const NO_SCRIPTS: ReadonlyArray<AnkielProjectFileScript> = [];

export interface AnkielProjectFileState {
  status: "loading" | "missing" | "invalid" | "valid";
  file: AnkielProjectFile | null;
  scripts: ReadonlyArray<AnkielProjectFileScript>;
}

export function useAnkielProjectFileState(
  environmentId: EnvironmentId,
  cwd: string | null,
): AnkielProjectFileState {
  const query = useProjectFileQuery(environmentId, cwd ?? "", AC_PROJECT_FILE_NAME, cwd !== null);
  const contents = query.data && !query.data.truncated ? query.data.contents : null;
  const isPending = query.isPending;
  if (contents === null) {
    return {
      status: isPending ? "loading" : "missing",
      file: null,
      scripts: NO_SCRIPTS,
    } as const;
  }
  const file = parseAnkielProjectFile(contents);
  if (file === null) {
    return { status: "invalid", file: null, scripts: NO_SCRIPTS } as const;
  }
  return { status: "valid", file, scripts: file.scripts ?? NO_SCRIPTS } as const;
}

export function useAnkielProjectFileScripts(
  environmentId: EnvironmentId,
  cwd: string | null,
): ReadonlyArray<AnkielProjectFileScript> {
  return useAnkielProjectFileState(environmentId, cwd).scripts;
}
