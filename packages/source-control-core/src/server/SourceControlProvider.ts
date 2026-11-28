import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type {
  RepositoryIdentity,
  SourceControlProviderError,
  SourceControlProviderInfo,
  SourceControlProviderKind,
  SourceControlRepositoryCloneUrls,
  SourceControlRepositoryVisibility,
} from "@ankielcode/contracts";

export interface SourceControlLinkSubject {
  readonly title: string;
  readonly body: string | null;
}

/** Return undefined synchronously for unsupported URLs, without starting a lookup. */
export type ResolveSourceControlLink = (input: {
  readonly cwd: string;
  readonly url: URL;
}) => Effect.Effect<SourceControlLinkSubject, SourceControlProviderError> | undefined;

export interface SourceControlProviderContext {
  readonly provider: SourceControlProviderInfo;
  readonly remoteName: string;
  readonly remoteUrl: string;
  readonly requestedHost?: string;
}

const MAX_ERROR_TRANSPORT_VALUE_LENGTH = 256;

/**
 * The fixed product text a provider failure carries for the user, if it has one. Any other
 * detail may be upstream response text, so callers show a generic message instead.
 */
export function userFacingSourceControlDetail(cause: unknown): string | undefined {
  return typeof cause === "object" &&
    cause !== null &&
    "userFacingDetail" in cause &&
    typeof cause.userFacingDetail === "string"
    ? cause.userFacingDetail
    : undefined;
}

export function repositoryNotFoundDetail(repository: string): string {
  return `Repository ${transportSafeSourceControlErrorValue(repository)} was not found. Check the owner and name and try again.`;
}

export function transportSafeSourceControlErrorValue(value: string): string {
  let printable = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    printable += codePoint !== undefined && (codePoint < 32 || codePoint === 127) ? " " : character;
  }
  const normalized = printable.trim().replace(/\s+/gu, " ");

  let safe = normalized;
  try {
    const url = new URL(normalized);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    safe = url.toString();
  } catch {}

  return safe.slice(0, MAX_ERROR_TRANSPORT_VALUE_LENGTH);
}

export function repositoryPathFromRemoteUrl(url: string | null): string | null {
  const remote = url?.trim() ?? "";
  const trimmed = /^(?:ssh|https?|git):\/\//iu.test(remote) ? remote.split(/[?#]/u, 1)[0]! : remote;
  if (trimmed.length === 0) {
    return null;
  }

  const match =
    /^(?:[^@/\s]+@[^:/\s]+:|[^@:/\\\s]{2,}:(?!:)|(?:ssh|https?|git):\/\/[^/]+\/)((?:[^/\s]+\/)+[^/\s]+?)(?:\.git)?\/?$/iu.exec(
      trimmed,
    );
  const path = match?.[1]?.trim() ?? "";
  return path.length > 0 ? path : null;
}

export class SourceControlProvider extends Context.Service<
  SourceControlProvider,
  {
    readonly kind: SourceControlProviderKind;
    /** Strip installation mounts from remote paths; absent means use the whole path. */
    readonly repositoryNameFromRemoteUrl?: (url: string) => string | null;
    readonly refineRepositoryIdentity?: (input: {
      readonly identity: RepositoryIdentity;
      readonly resolveContext: (input: {
        readonly cwd: string;
        readonly context: SourceControlProviderContext;
      }) => Effect.Effect<SourceControlProviderContext | null, SourceControlProviderError>;
    }) => Effect.Effect<RepositoryIdentity, SourceControlProviderError>;
    /**
     * The web host serving a remote, for a host whose remote URL may not name it (an SSH alias
     * for one of several servers). It answers for the context's `requestedHost` when the caller
     * narrows to one. Absent, or null, means the remote's own host is the web host.
     */
    readonly resolveRemoteWebHost?: (input: {
      readonly cwd: string;
      readonly context: SourceControlProviderContext;
      readonly resolveContext: (input: {
        readonly cwd: string;
        readonly context: SourceControlProviderContext;
      }) => Effect.Effect<SourceControlProviderContext | null, SourceControlProviderError>;
    }) => Effect.Effect<string | null, SourceControlProviderError>;
    readonly resolveLink?: ResolveSourceControlLink;
    /**
     * Told when Ankiel records `baseBranch`, a branch name on the host, as the base `branch` was cut
     * from, for a host whose own tools keep that in git config of their own.
     */
    readonly recordBranchBase?: (input: {
      readonly cwd: string;
      readonly branch: string;
      readonly baseBranch: string;
    }) => Effect.Effect<void>;
    readonly getRepositoryCloneUrls: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProviderContext;
      readonly repository: string;
      /** The host the repository is on. Without it, the checkout's host. */
      readonly host?: string;
    }) => Effect.Effect<SourceControlRepositoryCloneUrls, SourceControlProviderError>;
    readonly createRepository: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly visibility: SourceControlRepositoryVisibility;
    }) => Effect.Effect<SourceControlRepositoryCloneUrls, SourceControlProviderError>;
    readonly getDefaultBranch: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProviderContext;
    }) => Effect.Effect<string | null, SourceControlProviderError>;
  }
>()("@ankielcode/source-control-core/server/SourceControlProvider") {}
