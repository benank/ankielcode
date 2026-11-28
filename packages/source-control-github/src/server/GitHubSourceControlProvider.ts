import { requireSettingsSecretLiteral, SourceControlProviderKind } from "@ankielcode/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  SourceControlProviderError,
  TrimmedNonEmptyString,
  type SourceControlProviderDiscoveryItem,
  type SourceControlRepositoryCloneUrls,
} from "@ankielcode/contracts";
import { normalizeGitRemoteUrl } from "@ankielcode/shared/git";
import * as HostProcess from "@ankielcode/shared/HostProcess";
import { decodeJsonResult } from "@ankielcode/shared/schemaJson";

import { GH_PROCESS_CONCURRENCY } from "./GitHubCredentials.ts";
import * as GitHubAppSignIn from "./GitHubAppSignIn.ts";
import * as GitHubRest from "./GitHubRest.ts";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";
import {
  gitHubApiHostForRemote,
  parseGitHubRepositorySelector,
  resolveGitHubRepository,
  type GitHubRepositoryLocator,
} from "./gitHubRepositoryResolution.ts";
import {
  effectiveGitHubAccount,
  findAuthenticatedGitHubAccount,
  parseGitHubAuthStatus,
  type GitHubAuthStatusAccount,
} from "./gitHubAuthStatus.ts";
import * as SourceControlProvider from "@ankielcode/source-control-core/server/SourceControlProvider";
import {
  combinedAuthOutput,
  firstSafeAuthLine,
  probeSourceControlProvider,
  providerAuth,
  type SourceControlAuthProbeInput,
  type SourceControlCliDiscoverySpec,
  type SourceControlManagedCliDiscoverySpec,
} from "@ankielcode/source-control-core/server/discovery";
import * as SourceControlHost from "@ankielcode/source-control-core/server/SourceControlHost";
import {
  parseGitRemoteHost,
  readSourceControlHostSettings,
  unknownRemoteProvider,
} from "@ankielcode/source-control-core/shared/definition";

import * as GitHubClient from "../shared/definition.ts";
import { makeGhProcess } from "./gitHubCliProcess.ts";

const decodeLinkSubject = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({ title: Schema.String, body: Schema.optional(Schema.NullOr(Schema.String)) }),
  ),
);

function authAccounts(accounts: ReadonlyArray<GitHubAuthStatusAccount>) {
  return accounts.map((entry) => ({
    host: entry.host,
    account: entry.account,
    active: entry.active,
    authenticated: entry.authenticated,
    ...(entry.error === null ? {} : { error: entry.error }),
    ...(entry.environmentVariable === null
      ? {}
      : { environmentVariable: entry.environmentVariable }),
  }));
}

function parseGitHubAuth(
  input: SourceControlAuthProbeInput,
  settings: GitHubClient.GitHubSettings = readSourceControlHostSettings(GitHubClient.settings, {}),
) {
  const output = combinedAuthOutput(input);
  const authStatus = parseGitHubAuthStatus(input.stdout);
  const hosts = [...new Set(authStatus.accounts.map((entry) => entry.host))];
  const fallback = findAuthenticatedGitHubAccount(authStatus.accounts);
  const orderedHosts = fallback
    ? [fallback.host, ...hosts.filter((host) => host !== fallback.host)]
    : hosts;
  const chosen = orderedHosts
    .map((host) => effectiveGitHubAccount(host, authStatus.accounts, settings))
    .find((entry) => entry !== undefined);
  const accounts = authStatus.parsed ? { accounts: authAccounts(authStatus.accounts) } : {};

  if (chosen) {
    return {
      ...providerAuth({
        status: "authenticated",
        account: chosen.account,
        host: chosen.host,
        detail:
          chosen.environmentVariable === null
            ? undefined
            : `Using ${chosen.environmentVariable} from the server environment; it overrides the account chosen in Settings.`,
      }),
      ...accounts,
    };
  }

  if (fallback) {
    return {
      ...providerAuth({
        status: "unauthenticated",
        host: fallback.host,
        detail:
          "Every GitHub host gh is signed in to is turned off in Settings → Source control & issues.",
      }),
      ...accounts,
    };
  }

  const failedAccount = authStatus.accounts.find((entry) => entry.active) ?? authStatus.accounts[0];
  if (authStatus.parsed) {
    return {
      ...providerAuth({
        status: "unauthenticated",
        host: failedAccount?.host,
        detail:
          failedAccount?.error ??
          "Run `gh auth login` to authenticate GitHub CLI with an active account.",
      }),
      ...accounts,
    };
  }

  // gh before 2.81.0 rejects --json with a nonzero exit that resembles a signed-out CLI.
  if (input.exitCode !== 0 && output.includes("unknown flag: --json")) {
    return providerAuth({
      status: "unknown",
      detail:
        "GitHub CLI is too old to report sign-in status. Update `gh` to 2.81.0 or newer (for example `brew upgrade gh`) and rescan.",
    });
  }

  if (input.exitCode !== 0) {
    return providerAuth({
      status: "unauthenticated",
      detail: firstSafeAuthLine(output) ?? "Run `gh auth login` to authenticate GitHub CLI.",
    });
  }

  return providerAuth({
    status: "unknown",
    detail: firstSafeAuthLine(output) ?? "GitHub CLI auth status could not be parsed.",
  });
}

const discovery = {
  type: "cli",
  kind: SourceControlProviderKind.make("github"),
  label: "GitHub",
  executable: "gh",
  versionArgs: ["--version"],
  authArgs: ["auth", "status", "--json", "hosts"],
  parseAuth: parseGitHubAuth,
  installHint:
    "Install the GitHub command-line tool (`gh`) via https://cli.github.com/ or your package manager (for example `brew install gh`).",
} satisfies SourceControlCliDiscoverySpec;

const decodeViewer = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ login: Schema.String })),
);

function environmentTokenVariable(environment: NodeJS.ProcessEnv): string | null {
  return ["GH_TOKEN", "GITHUB_TOKEN"].find((name) => environment[name]?.trim()) ?? null;
}

// `gh auth status` may not know environment tokens; check the API.
export const makeDiscovery = Effect.gen(function* () {
  const api = yield* GitHubRest.GitHubRest;
  const sourceControlHost = yield* SourceControlHost.SourceControlHost;
  const process = yield* makeGhProcess;
  const environment = yield* HostProcess.Environment;
  const appSignIn = yield* GitHubAppSignIn.GitHubAppSignIn;
  const offerAppSignIn = <A extends SourceControlProviderDiscoveryItem>(item: A): A =>
    appSignIn.enabled ? { ...item, appSignIn: true } : item;

  return {
    type: "managed-cli",
    kind: discovery.kind,
    label: discovery.label,
    installHint: discovery.installHint,
    probe: Effect.fn("GitHubSourceControlProvider.discovery")(function* (cwd: string) {
      const current = yield* sourceControlHost.settings.get.pipe(
        Effect.orElseSucceed(() => undefined),
      );
      const settings = readSourceControlHostSettings(
        GitHubClient.settings,
        current?.sourceControlHosts[GitHubClient.definition.kind],
      );
      const cli = yield* probeSourceControlProvider({
        cwd,
        process: {
          run: (input) => process.run({ ...input, concurrency: GH_PROCESS_CONCURRENCY }),
        },
        spec: { ...discovery, parseAuth: (input) => parseGitHubAuth(input, settings) },
      });
      const saved = yield* Effect.result(
        requireSettingsSecretLiteral(settings.tokens["github.com"]),
      );
      if (Result.isFailure(saved) && settings.hosts["github.com"]?.enabled !== false) {
        return offerAppSignIn({
          ...cli,
          status: "available" as const,
          auth: providerAuth({
            status: "unauthenticated",
            host: "github.com",
            detail: saved.failure.message,
          }),
        });
      }
      const savedToken = Result.isSuccess(saved) && saved.success.trim() !== "";
      const signedIn =
        appSignIn.enabled && !savedToken && (settings.signIns["github.com"] ?? "").trim() !== "";
      const variable = environmentTokenVariable(environment);
      const appName = GitHubClient.APP_SIGN_IN.appName;
      const tokenSource = savedToken
        ? "the token saved in Settings"
        : signedIn
          ? `the ${appName} sign-in`
          : variable;
      if (tokenSource === null || settings.hosts["github.com"]?.enabled === false) {
        return offerAppSignIn(cli);
      }
      const viewer = yield* api
        .rest({ host: "github.com", operation: "discovery", path: "user" })
        .pipe(Effect.result);
      const login = Result.isSuccess(viewer)
        ? Option.getOrUndefined(decodeViewer(viewer.success.body))?.login
        : undefined;
      const accounts = cli.auth.accounts === undefined ? {} : { accounts: cli.auth.accounts };
      return offerAppSignIn({
        ...cli,
        status: "available" as const,
        auth: {
          ...(login !== undefined
            ? providerAuth({
                status: "authenticated",
                account: login,
                host: "github.com",
                detail: savedToken
                  ? "Using the token saved in Settings; it overrides GH_TOKEN and the gh login."
                  : signedIn
                    ? `Signed in with ${appName}.`
                    : `Using ${variable} from the server environment; it overrides the account chosen in Settings.`,
              })
            : Result.isFailure(viewer) && viewer.failure._tag !== "GitHubApiAuthenticationError"
              ? providerAuth({
                  status: "unknown",
                  host: "github.com",
                  detail: `Could not check ${savedToken || signedIn ? tokenSource : `the token in ${tokenSource}`}: ${viewer.failure.message}`,
                })
              : providerAuth({
                  status: "unauthenticated",
                  host: "github.com",
                  detail: savedToken
                    ? "GitHub refused the token saved in Settings. Replace or remove it in Settings → Source control & issues."
                    : signedIn
                      ? `GitHub refused the ${appName} sign-in. Sign in again in Settings → Source control & issues.`
                      : `GitHub refused the token in ${tokenSource}. Replace it, or unset it to use \`gh auth login\`.`,
                })),
          ...accounts,
        },
      } satisfies SourceControlProviderDiscoveryItem);
    }),
    // Claim disabled hosts so errors identify the setting.
    refineUnknownRemote: ({ context }) => {
      const url = URL.parse(context.provider.baseUrl);
      if (!url?.host) return Effect.succeed(null);
      const host = gitHubApiHostForRemote(context.remoteUrl) ?? url.host;
      // A timeout or keyring failure propagates: the registry does not keep that answer.
      return api.credential(host).pipe(
        Effect.as(true),
        Effect.catchTags({
          GitHubCliMissingError: () => Effect.succeed(false),
          GitHubHostDisabledError: () => Effect.succeed(true),
          GitHubNotSignedInError: () => Effect.succeed(false),
        }),
        Effect.map((known) =>
          known
            ? ({
                kind: SourceControlProviderKind.make("github"),
                name: host === "github.com" ? "GitHub" : "GitHub Self-Hosted",
                baseUrl: host === url.host ? context.provider.baseUrl : `https://${host}`,
              } as const)
            : null,
        ),
      );
    },
  } satisfies SourceControlManagedCliDiscoverySpec;
});

class GitHubFailure extends Schema.TaggedError<GitHubFailure>()("GitHubFailure", {
  detail: Schema.String,
  cause: Schema.Defect(),
}) {}

class GitHubRepositoryLookupError extends Schema.TaggedError<GitHubRepositoryLookupError>()(
  "GitHubRepositoryLookupError",
  {
    userFacingDetail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const failure = (detail: string, cause?: unknown) => new GitHubFailure({ detail, cause });

// A gh login confirms a GitHub Enterprise Server whose hostname does not identify its provider.
const refineRepositoryIdentity: NonNullable<
  SourceControlProvider.SourceControlProvider["Service"]["refineRepositoryIdentity"]
> = Effect.fn("GitHubSourceControlProvider.refineRepositoryIdentity")(function* ({
  identity,
  resolveContext,
}) {
  if (!identity.rootPath || (identity.provider !== undefined && identity.provider !== "unknown"))
    return identity;
  const remote = parseGitRemoteHost(identity.locator.remoteUrl);
  if (remote === null) return identity;
  const context = yield* resolveContext({
    cwd: identity.rootPath,
    context: {
      provider: unknownRemoteProvider(remote),
      remoteName: identity.locator.remoteName,
      remoteUrl: identity.locator.remoteUrl,
    },
  });
  return context?.provider.kind === "github"
    ? { ...identity, provider: SourceControlProviderKind.make("github") }
    : identity;
});

const NOT_FOUND = "GitHub could not find it. Check the URL and try again.";
const REPOSITORY_NOT_FOUND = "Repository not found. Check the owner and name and try again.";
const isGitHubApiNotFoundError = Schema.is(GitHubRequestPolicy.GitHubApiNotFoundError);

function fromGitHubApiError(
  error: GitHubRequestPolicy.GitHubApiError,
  notFound = NOT_FOUND,
): GitHubFailure {
  switch (error._tag) {
    case "GitHubCliMissingError":
      return failure(
        "No GitHub credential on the server. Set GH_TOKEN, or install the GitHub CLI and run `gh auth login`.",
        error,
      );
    case "GitHubNotSignedInError":
    case "GitHubHostDisabledError":
    case "SettingsSecretUnresolvedError":
      return failure(error.message, error);
    case "GitHubApiAuthenticationError":
      return failure(
        "GitHub is not authenticated. Run `gh auth login` (or set GH_TOKEN) and retry.",
        error,
      );
    case "GitHubApiRateLimitError":
    case "SourceControlRateLimitPausedError":
      return failure(
        "GitHub API rate limit exceeded. Requests resume when the limit resets.",
        error,
      );
    case "GitHubApiNotFoundError":
      return failure(notFound, error);
    case "GitHubCliFailedError":
    case "GitHubCliTimeoutError":
    case "GitHubAppSessionError":
    case "GitHubApiResponseError":
    case "GitHubApiRequestError":
      return failure(error.message.trim() || "GitHub request failed.", error);
  }
}

const RawRepositorySchema = Schema.Struct({
  full_name: TrimmedNonEmptyString,
  html_url: TrimmedNonEmptyString,
  ssh_url: TrimmedNonEmptyString,
  default_branch: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeRawRepository = decodeJsonResult(RawRepositorySchema);

function repositoryCloneUrls(
  raw: Schema.Schema.Type<typeof RawRepositorySchema>,
): SourceControlRepositoryCloneUrls {
  return { nameWithOwner: raw.full_name, url: raw.html_url, sshUrl: raw.ssh_url };
}

const decodeViewerLogin = decodeJsonResult(Schema.Struct({ login: TrimmedNonEmptyString }));

const contextHost = (context: SourceControlProvider.SourceControlProviderContext | undefined) =>
  context === undefined ? undefined : new URL(context.provider.baseUrl).host;

export const make = Effect.gen(function* () {
  const api = yield* GitHubRest.GitHubRest;
  const sourceControlHost = yield* SourceControlHost.SourceControlHost;
  const process = sourceControlHost.process;
  const environment = yield* HostProcess.Environment;
  const git = sourceControlHost.git;

  const gitRead = (cwd: string, args: ReadonlyArray<string>) =>
    process.run({
      operation: "GitHubSourceControlProvider.resolveRepository",
      command: "git",
      args,
      cwd,
      allowNonZeroExit: true,
      timeoutMs: 5_000,
    });

  const readRemotes = (cwd: string) =>
    Effect.all([
      gitRead(cwd, ["remote", "-v"]),
      gitRead(cwd, ["config", "--get-regexp", "^remote\\..*\\.gh-resolved$"]),
    ]).pipe(
      Effect.orElseSucceed(() => [null, null] as const),
      Effect.map(([remotes, resolved]) => ({
        remotes: remotes?.exitCode === 0 ? remotes.stdout : "",
        resolved: resolved?.exitCode === 0 ? resolved.stdout : "",
      })),
    );

  const resolveRepository = Effect.fn("GitHubSourceControlProvider.resolveRepository")(
    function* (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly context?: SourceControlProvider.SourceControlProviderContext | undefined;
    }) {
      const envRepository = environment.GH_REPO?.trim();
      const hostHint = input.host ?? contextHost(input.context);
      const defaultHost = (hostHint ?? environment.GH_HOST ?? "github.com").toLowerCase();
      if (envRepository) {
        const locator = parseGitHubRepositorySelector(envRepository, defaultHost);
        if (locator !== null) return locator;
      }
      const { host, locator } = resolveGitHubRepository({
        ...(yield* readRemotes(input.cwd)),
        hostHint,
        defaultHost,
      });
      if (locator !== null) return locator;
      if (input.context) {
        const remote = normalizeGitRemoteUrl(input.context.remoteUrl);
        const fallback = parseGitHubRepositorySelector(
          `${host}/${remote.slice(remote.indexOf("/") + 1)}`,
          host,
        );
        if (fallback !== null) return fallback;
      }
      return yield* failure(
        `No GitHub repository on ${host} was found among this checkout's git remotes.`,
      );
    },
  );

  const rest = (input: GitHubRest.GitHubRestInput, notFoundDetail?: string) =>
    api.rest(input).pipe(Effect.mapError((error) => fromGitHubApiError(error, notFoundDetail)));

  const readRepository = Effect.fn("GitHubSourceControlProvider.readRepository")(function* (
    locator: GitHubRepositoryLocator,
  ) {
    const response = yield* rest(
      {
        host: locator.host,
        operation: "getRepository",
        path: `repos/${encodeURIComponent(locator.owner)}/${encodeURIComponent(locator.name)}`,
        allowReserve: true,
      },
      REPOSITORY_NOT_FOUND,
    );
    const decoded = decodeRawRepository(response.body);
    if (Result.isFailure(decoded)) {
      return yield* failure("GitHub returned an invalid repository.", decoded.failure);
    }
    return decoded.success;
  });

  const readViewerLogin = Effect.fn("GitHubSourceControlProvider.readViewerLogin")(function* (
    host: string,
  ) {
    const response = yield* rest({
      host,
      operation: "getViewer",
      path: "user",
      allowReserve: true,
    });
    const decoded = decodeViewerLogin(response.body);
    if (Result.isFailure(decoded)) {
      return yield* failure("GitHub request failed.", decoded.failure);
    }
    return decoded.success.login;
  });

  const providerError =
    (
      operation: string,
      cwd: string,
      context?: { readonly reference?: string; readonly repository?: string },
    ) =>
    (error: GitHubFailure) =>
      new SourceControlProviderError({
        provider: SourceControlProviderKind.make("github"),
        operation,
        cwd,
        ...(context?.reference === undefined
          ? {}
          : {
              reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                context.reference,
              ),
            }),
        ...(context?.repository === undefined
          ? {}
          : {
              repository: SourceControlProvider.transportSafeSourceControlErrorValue(
                context.repository,
              ),
            }),
        detail: error.detail,
        cause: error.cause,
      });

  const readLinkSubject = Effect.fn("GitHubSourceControlProvider.readLinkSubject")(function* (
    input: { readonly cwd: string; readonly url: URL },
    endpoint: string,
  ) {
    const result = yield* api
      .rest({
        host: input.url.host,
        operation: "resolveLink",
        path: endpoint,
        maxResponseBytes: 1_000_000,
      })
      .pipe(
        Effect.timeout("3 seconds"),
        Effect.mapError(
          (cause) =>
            new SourceControlProviderError({
              provider: SourceControlProviderKind.make("github"),
              operation: "resolveLink",
              cwd: input.cwd,
              detail: "The linked subject could not be read.",
              cause,
            }),
        ),
      );
    const subject = yield* decodeLinkSubject(result.body).pipe(
      Effect.mapError(
        (cause) =>
          new SourceControlProviderError({
            provider: SourceControlProviderKind.make("github"),
            operation: "resolveLink.decode",
            cwd: input.cwd,
            detail: "The linked subject could not be read.",
            cause,
          }),
      ),
    );
    return { title: subject.title, body: subject.body ?? null };
  });

  return SourceControlProvider.SourceControlProvider.of({
    kind: SourceControlProviderKind.make("github"),
    refineRepositoryIdentity,
    resolveRemoteWebHost: Effect.fn("GitHubSourceControlProvider.resolveRemoteWebHost")(
      ({ context }) => Effect.succeed(gitHubApiHostForRemote(context.remoteUrl)),
    ),
    // `gh pr create` run in the checkout, as an agent in an Ankiel worktree often does, takes its base
    // from this key.
    recordBranchBase: Effect.fn("GitHubSourceControlProvider.recordBranchBase")(function ({
      cwd,
      branch,
      baseBranch,
    }) {
      return git
        .writeConfigValue({ cwd, key: `branch.${branch}.gh-merge-base`, value: baseBranch })
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not record the branch base for gh", { cause }),
          ),
        );
    }),
    resolveLink: (input) => {
      // Automatic enrichment must not send ambient CLI credentials to a host from message text.
      if (input.url.host !== "github.com") return undefined;
      const match = /^\/([\w.-]+)\/([\w.-]+)\/(?:pull|issues)\/([1-9]\d*)(?:\/.*)?$/.exec(
        input.url.pathname,
      );
      if (!match) return undefined;
      return readLinkSubject(input, `repos/${match[1]}/${match[2]}/issues/${match[3]}`);
    },
    getRepositoryCloneUrls: Effect.fn("GitHubSourceControlProvider.getRepositoryCloneUrls")(
      function* (input) {
        const fallbackHost = (
          input.host ??
          (yield* resolveRepository(input).pipe(
            Effect.map((locator) => locator.host),
            Effect.orElseSucceed(() => environment.GH_HOST ?? "github.com"),
          ))
        ).toLowerCase();
        const bareName = input.repository.trim().replace(/\.git$/i, "");
        const locator =
          parseGitHubRepositorySelector(input.repository, fallbackHost) ??
          (/^[^/\s]+$/.test(bareName)
            ? {
                host: fallbackHost,
                owner: yield* readViewerLogin(fallbackHost),
                name: bareName,
              }
            : null);
        if (locator === null) {
          const detail = "Repositories are named owner/name.";
          return yield* failure(
            detail,
            new GitHubRepositoryLookupError({ userFacingDetail: detail }),
          );
        }
        return repositoryCloneUrls(
          yield* readRepository(locator).pipe(
            Effect.mapError((error) => {
              if (!isGitHubApiNotFoundError(error.cause)) return error;
              const detail = SourceControlProvider.repositoryNotFoundDetail(
                `${locator.owner}/${locator.name}`,
              );
              return failure(
                detail,
                new GitHubRepositoryLookupError({ userFacingDetail: detail, cause: error.cause }),
              );
            }),
          ),
        );
      },
      (effect, input) =>
        effect.pipe(
          Effect.mapError(
            providerError("getRepositoryCloneUrls", input.cwd, {
              repository: input.repository,
            }),
          ),
        ),
    ),
    createRepository: Effect.fn("GitHubSourceControlProvider.createRepository")(
      function* (input) {
        const locator = parseGitHubRepositorySelector(
          input.repository,
          (environment.GH_HOST ?? "github.com").toLowerCase(),
        );
        const viewer = locator === null ? null : yield* readViewerLogin(locator.host);
        const owner = locator?.owner ?? viewer;
        const name = locator?.name ?? input.repository.trim();
        const host = locator?.host ?? (environment.GH_HOST?.trim().toLowerCase() || "github.com");
        const isViewer = viewer !== null && owner?.toLowerCase() === viewer.toLowerCase();
        const response = yield* rest(
          {
            host,
            operation: "createRepository",
            method: "POST",
            allowReserve: true,
            path:
              isViewer || owner === null ? "user/repos" : `orgs/${encodeURIComponent(owner)}/repos`,
            body: { name, private: input.visibility === "private" },
          },
          `No organization named ${owner ?? "that"} that this account can create repositories in.`,
        );
        const decoded = decodeRawRepository(response.body);
        if (Result.isFailure(decoded)) {
          return yield* failure("GitHub returned an invalid repository.", decoded.failure);
        }
        return repositoryCloneUrls(decoded.success);
      },
      (effect, input) =>
        effect.pipe(
          Effect.mapError(
            providerError("createRepository", input.cwd, { repository: input.repository }),
          ),
        ),
    ),
    getDefaultBranch: Effect.fn("GitHubSourceControlProvider.getDefaultBranch")(
      function* (input) {
        const locator = yield* resolveRepository({
          cwd: input.cwd,
          host: contextHost(input.context),
          context: input.context,
        });
        const repository = yield* readRepository(locator);
        const branch = repository.default_branch?.trim() ?? "";
        return branch.length > 0 ? branch : null;
      },
      (effect, input) => effect.pipe(Effect.mapError(providerError("getDefaultBranch", input.cwd))),
    ),
  });
});
