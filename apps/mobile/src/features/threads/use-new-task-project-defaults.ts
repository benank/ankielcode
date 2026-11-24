import { resolveFilesystemReadAccess } from "@ankielcode/client-runtime/state/filesystem";
import { isScratchProject } from "@ankielcode/client-runtime/state/projects";
import type { EnvironmentProject } from "@ankielcode/client-runtime/state/shell";
import type { ProjectReadFileResult } from "@ankielcode/contracts";
import { DEFAULT_SERVER_SETTINGS, ANKIEL_PROJECT_FILE_NAME } from "@ankielcode/contracts";
import {
  resolveNewThreadEnvMode,
  resolveProjectSettings,
} from "@ankielcode/shared/projectSettings";
import { parseAnkielProjectFile } from "@ankielcode/shared/ankielProjectFile";

import { m } from "../../i18n/messages";
import { useEnvironmentServerConfig } from "../../state/entities";
import { useEnvironmentPresentation } from "../../state/presentation";
import { useProjectHasThreads } from "../../state/project-has-threads";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { environmentSession } from "../../state/session";

/**
 * A project's new-task defaults: server settings merged with its ankiel.json. The
 * new-task flow and the home pending-drafts list both read the default
 * workspace mode here, so a draft that never picked one shows what it sends.
 * Every read is a shared per-environment or per-project atom.
 */
export function useNewTaskProjectDefaults(project: EnvironmentProject | null) {
  const serverConfig = useEnvironmentServerConfig(project?.environmentId ?? null);
  const isScratch =
    project !== null && isScratchProject(project, serverConfig?.scratchWorkspaceRoot);
  const hasWorkspace = project !== null && project.workspaceRoot !== "";
  const fileAccessSession = useEnvironmentQuery(
    hasWorkspace ? environmentSession.sessionStateAtom(project.environmentId) : null,
  );
  const fileEnvironment = useEnvironmentPresentation(project?.environmentId ?? null);
  const fileAccess = resolveFilesystemReadAccess(
    {
      isCatalogReady: fileEnvironment.isReady,
      connection: fileEnvironment.presentation?.connection ?? null,
      session: fileAccessSession.data,
      sessionError: fileAccessSession.error,
    },
    m,
  );
  const fileAccessPending = hasWorkspace && fileAccess.isPending;
  const ankielProjectFileQuery = useEnvironmentQuery(
    fileAccess.canReadFiles && hasWorkspace
      ? projectEnvironment.readFile({
          environmentId: project.environmentId,
          input: {
            cwd: project.workspaceRoot,
            relativePath: ANKIEL_PROJECT_FILE_NAME,
            allowMissing: true,
          },
        })
      : null,
  );
  const ankielProjectFileData = ankielProjectFileQuery.data as ProjectReadFileResult | null;
  const ankielProjectFile =
    ankielProjectFileData === null ||
    ankielProjectFileData.exists === false ||
    ankielProjectFileData.truncated
      ? null
      : parseAnkielProjectFile(ankielProjectFileData.contents);
  const projectSettings = resolveProjectSettings(
    serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS,
    project?.id ?? null,
    project,
    ankielProjectFile,
  );
  const projectHasThreads = useProjectHasThreads(project);
  const defaultWorkspaceMode = isScratch
    ? "local"
    : resolveNewThreadEnvMode({
        projectSettings,
        workspaceRoot: project?.workspaceRoot ?? null,
        newProjectsRoot: serverConfig?.newProjectsRoot,
        projectHasThreads,
      });
  // While ankiel.json loads, the environment default is provisional; ankiel.json may replace it.
  const defaultWorkspaceModeSettled =
    projectSettings.sources.defaultThreadEnvMode !== "environment" ||
    (!ankielProjectFileQuery.isPending && !fileAccessPending);
  return {
    serverConfig,
    isScratch,
    projectSettings,
    defaultWorkspaceMode,
    defaultWorkspaceModeSettled,
  };
}
