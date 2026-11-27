import { useNavigation, useRoute, StackActions } from "@react-navigation/native";
import { resolveIssueLinkTarget } from "@ankielcode/client-runtime/issue-links";
import { EnvironmentId, ThreadId } from "@ankielcode/contracts";
import { useProjects, useThreadShell } from "../state/entities";
import { tryOpenWebLink } from "../lib/openExternalUrl";
import { appAtomRegistry } from "../state/atom-registry";
import { environmentServerConfigsAtom } from "../state/server";

type IssueLinkContext = { readonly environmentId: string; readonly projectId: string };

/** Opens an issue link in the app when the environment tracks it; anything else leaves for the browser. */
export function useOpenIssueLink(options?: {
  readonly replace?: boolean;
  readonly context?: IssueLinkContext;
}) {
  const navigation = useNavigation();
  const projects = useProjects();
  const route = useRoute();
  const routeContext = route.params as
    | {
        environmentId?: string | string[];
        projectId?: string | string[];
        threadId?: string | string[];
      }
    | undefined;
  const first = (value: string | string[] | undefined) => {
    const text = Array.isArray(value) ? value[0] : value;
    return text?.trim() ? text : undefined;
  };
  const routeEnvironmentId = options?.context?.environmentId ?? first(routeContext?.environmentId);
  const threadId = first(routeContext?.threadId);
  const thread = useThreadShell(
    routeEnvironmentId && threadId
      ? {
          environmentId: EnvironmentId.make(routeEnvironmentId),
          threadId: ThreadId.make(threadId),
        }
      : null,
  );
  const projectId =
    options?.context?.projectId ?? first(routeContext?.projectId) ?? thread?.projectId;
  const replace = options?.replace;
  return async (url: string) => {
    const environmentId = routeEnvironmentId ? EnvironmentId.make(routeEnvironmentId) : null;
    // Read at press time so a config push does not hand every link a new handler.
    const serverConfigs = appAtomRegistry.get(environmentServerConfigsAtom);
    const issuesEnabled =
      environmentId !== null &&
      serverConfigs.get(environmentId)?.environment.capabilities.issues === true;
    const issue =
      issuesEnabled && projectId
        ? resolveIssueLinkTarget({
            url,
            projects: projects.filter((project) => project.environmentId === environmentId),
            preferredProjectId: projectId,
          })
        : null;
    if (!issue || !environmentId) return tryOpenWebLink(url, "markdown-link");
    const issueParams = {
      environmentId,
      projectId: issue.ref.projectId,
      tracker: issue.ref.tracker,
      ...(issue.ref.host === undefined ? {} : { host: issue.ref.host }),
      scope: issue.ref.scope,
      issueKey: issue.ref.key,
    };
    if (replace) navigation.dispatch(StackActions.replace("Issue", issueParams));
    else navigation.dispatch(StackActions.push("Issue", issueParams));
    return true;
  };
}
