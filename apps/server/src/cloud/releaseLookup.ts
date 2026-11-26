import { ServerReleaseError, ServerReleaseInput, type ServerRelease } from "@ankielcode/contracts";
import * as HostProcess from "@ankielcode/shared/HostProcess";
import {
  CLI_RELEASE_BASE_URL_ENV,
  CLI_RELEASE_METADATA_FILE,
  cliReleaseAssetUrl,
  cliReleaseDatabaseMigration,
  cliReleaseIndexPageUrl,
  newestCliReleaseVersion,
  type CliReleaseChannel,
} from "@ankielcode/shared/cliRelease";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

const ReleaseIndex = Schema.Array(
  Schema.Struct({
    tag_name: Schema.String,
    draft: Schema.optional(Schema.Boolean),
  }),
);
const decodeReleaseIndex = Schema.decodeUnknownEffect(Schema.fromJsonString(ReleaseIndex));
const decodeInput = Schema.decodeUnknownEffect(ServerReleaseInput);

const RELEASE_INDEX_TIMEOUT = Duration.seconds(30);
const RELEASE_INDEX_MAX_PAGES = 10;

/** Newest published release on `channel` from GitHub, or undefined when there is none. */
export const resolveNewestCliRelease = Effect.fn("cloud.release_lookup.newest")(function* (
  channel: CliReleaseChannel,
) {
  const httpClient = yield* HttpClient.HttpClient;
  const environment = yield* HostProcess.Environment;
  const githubToken = environment.GH_TOKEN?.trim() || environment.GITHUB_TOKEN?.trim() || undefined;
  for (let page = 1; page <= RELEASE_INDEX_MAX_PAGES; page += 1) {
    const request = HttpClientRequest.get(cliReleaseIndexPageUrl(page)).pipe(
      HttpClientRequest.setHeader("Accept", "application/vnd.github+json"),
    );
    const authenticatedRequest =
      githubToken === undefined
        ? request
        : HttpClientRequest.setHeader(request, "Authorization", `Bearer ${githubToken}`);
    const body = yield* httpClient.execute(authenticatedRequest).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.text),
      Effect.mapError(() => new ServerReleaseError({ reason: "Could not list ankiel releases." })),
      Effect.timeoutOrElse({
        duration: RELEASE_INDEX_TIMEOUT,
        orElse: () =>
          Effect.fail(new ServerReleaseError({ reason: "Timed out listing ankiel releases." })),
      }),
    );
    const releases = yield* decodeReleaseIndex(body).pipe(
      Effect.mapError(
        () =>
          new ServerReleaseError({ reason: "The ankiel release index had an unexpected shape." }),
      ),
    );
    const version = newestCliReleaseVersion(releases, channel);
    if (version !== undefined) return version;
    if (releases.length === 0) break;
  }
  return undefined;
});

/** Releases before the metadata asset existed have no known migration, so a track switch refuses them. */
const readDatabaseMigration = Effect.fn("cloud.release_lookup.database_migration")(function* (
  version: string,
) {
  const httpClient = yield* HttpClient.HttpClient;
  const baseUrl = (yield* HostProcess.Environment)[CLI_RELEASE_BASE_URL_ENV]?.trim() || undefined;
  const unreachable = new ServerReleaseError({
    reason: `Could not read the release details for ${version}.`,
  });
  return yield* httpClient
    .get(cliReleaseAssetUrl(version, CLI_RELEASE_METADATA_FILE, baseUrl))
    .pipe(
      Effect.flatMap((response) =>
        response.status === 404
          ? Effect.undefined
          : HttpClientResponse.filterStatusOk(response).pipe(
              Effect.flatMap((ok) => ok.text),
              Effect.map(cliReleaseDatabaseMigration),
            ),
      ),
      Effect.timeout(Duration.seconds(15)),
      Effect.mapError(() => unreachable),
    );
});

export class ReleaseLookup extends Context.Service<
  ReleaseLookup,
  {
    readonly get: (
      input: ServerReleaseInput,
    ) => Effect.Effect<ServerRelease | null, ServerReleaseError>;
  }
>()("@ankielcode/cli/cloud/releaseLookup") {}

export const make = Effect.fn("ReleaseLookup.make")(function* () {
  // Unauthenticated GitHub API calls are rate limited per address, so repeated opens share a lookup.
  const cache = yield* Cache.make({
    capacity: 4,
    timeToLive: Duration.minutes(1),
    lookup: Effect.fn("ReleaseLookup.lookup")(function* (channel: ServerReleaseInput["channel"]) {
      const version = yield* resolveNewestCliRelease(channel === "nightly" ? "nightly" : "stable");
      if (version === undefined) return null;
      const databaseMigration = yield* readDatabaseMigration(version);
      return {
        version,
        ...(databaseMigration === undefined ? {} : { databaseMigration }),
      } satisfies ServerRelease;
    }),
  });
  return ReleaseLookup.of({
    get: Effect.fn("ReleaseLookup.get")(function* (input) {
      const { channel } = yield* decodeInput(input).pipe(
        Effect.mapError(() => new ServerReleaseError({ reason: "Invalid release track." })),
      );
      return yield* Cache.get(cache, channel);
    }),
  });
});

export const layer = Layer.effect(ReleaseLookup, make()).pipe(Layer.provide(FetchHttpClient.layer));
