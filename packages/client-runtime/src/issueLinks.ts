import { IssueTrackerKind, type IssueRef, type RepositoryIdentity } from "@ankielcode/contracts";

import { sourceControlClients } from "./sourceControlClients.ts";
import type { EnvironmentProject } from "./state/shell.ts";

type LinkProject = Pick<EnvironmentProject, "id" | "environmentId" | "repositoryIdentity">;

const issueBindingsByRepository = new WeakMap<
  RepositoryIdentity,
  ReturnType<typeof sourceControlClients.issueBindings>
>();

/** The hosts and scopes a project's git-host tracker is bound to, the way the server resolves them. */
function projectIssueBindings(project: LinkProject) {
  const identity = project.repositoryIdentity;
  if (identity == null) return [];
  const cached = issueBindingsByRepository.get(identity);
  if (cached !== undefined) return cached;
  const bindings = sourceControlClients
    .issueBindings(identity)
    .map((binding) => ({ ...binding, scope: binding.scope.toLowerCase() }));
  issueBindingsByRepository.set(identity, bindings);
  return bindings;
}

function linkAuthority(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/** A host whose hostname does not name it, such as GitHub Enterprise Server, is vouched for by a project on it. */
function parseIssueLink(
  url: string,
  authority: string | null,
  projects: ReadonlyArray<LinkProject>,
) {
  const parsed = sourceControlClients.parseIssueUrl(url);
  if (parsed !== null || authority === null) return parsed;
  const hostname = new URL(url).hostname.toLowerCase();
  for (const project of projects) {
    const bindings = projectIssueBindings(project);
    if (!bindings.some((binding) => binding.host === hostname || binding.host === authority))
      continue;
    const known = sourceControlClients.parseIssueUrl(url, project.repositoryIdentity?.provider);
    if (known !== null) return known;
  }
  return null;
}

/**
 * The reference an issue link resolves to, and the project it is read through: the project whose
 * tracker binding is that host and scope, else any project on the same tracker and host lending
 * its credentials for a read-only view. The same rule as the server's `IssueService.resolveUrl`,
 * applied on the client so a lookalike hostname matches no project and stays an ordinary link.
 */
export function resolveIssueLinkTarget<Project extends LinkProject>(input: {
  readonly url: string;
  /** The projects of the environment the link is read in. */
  readonly projects: ReadonlyArray<Project>;
  readonly preferredProjectId?: string | undefined;
}): { readonly project: Project; readonly ref: IssueRef } | null {
  // A link names its server's port; a binding does only when its remote or web URL did.
  const authority = linkAuthority(input.url);
  const parsed = parseIssueLink(input.url, authority, input.projects);
  if (parsed === null) return null;
  const { definition, link } = parsed;
  const onHost = input.projects.flatMap((project) =>
    projectIssueBindings(project)
      .filter(
        (binding) =>
          binding.tracker === definition.kind &&
          (binding.host === link.host || binding.host === authority),
      )
      .map((binding) => ({ project, binding })),
  );
  const onAuthority = onHost.filter((candidate) => candidate.binding.host === authority);
  const bound = onAuthority.length > 0 ? onAuthority : onHost;
  const preferFirst = (candidates: typeof bound) =>
    candidates.find((candidate) => candidate.project.id === input.preferredProjectId) ??
    candidates[0];
  const own =
    preferFirst(bound.filter((candidate) => candidate.binding.scope === link.scope)) ??
    preferFirst(bound.filter((candidate) => candidate.binding.scope === link.scopeAlias));
  const lender = own ?? preferFirst(bound);
  if (lender === undefined) return null;
  return {
    project: lender.project,
    ref: {
      projectId: lender.project.id,
      tracker: IssueTrackerKind.make(lender.binding.tracker),
      host: lender.binding.host,
      scope: own === undefined ? link.scope : lender.binding.scope,
      key: link.key,
    },
  };
}
