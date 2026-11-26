import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ReleaseLookup from "./releaseLookup.ts";

const lookup = (assets: Record<string, Response>) => {
  const requested: string[] = [];
  const httpClient = HttpClient.make((request) => {
    const url = new URL(request.url);
    requested.push(url.pathname);
    if (url.origin === "https://api.github.com") {
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json([
            { tag_name: "v1.3.0-nightly.20261101.7" },
            { tag_name: "v1.2.3" },
            { tag_name: "v1.2.2" },
          ]),
        ),
      );
    }
    const asset = assets[url.pathname] ?? new Response(null, { status: 404 });
    return Effect.succeed(HttpClientResponse.fromWeb(request, asset));
  });
  return {
    requested,
    get: (channel: "latest" | "nightly") =>
      Effect.gen(function* () {
        const service = yield* ReleaseLookup.make();
        return yield* service.get({ channel });
      }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient)),
  };
};

it.effect("reads the newest release on a track and the migration it publishes", () =>
  Effect.gen(function* () {
    const releases = lookup({
      "/benank/ankielcode/releases/download/v1.2.3/ankiel-release.json": Response.json({
        databaseMigration: 111,
      }),
    });
    assert.deepStrictEqual(yield* releases.get("latest"), {
      version: "1.2.3",
      databaseMigration: 111,
    });
    // A release from before the metadata asset has no known migration.
    assert.deepStrictEqual(yield* releases.get("nightly"), {
      version: "1.3.0-nightly.20261101.7",
    });
  }),
);

it.effect("fails instead of guessing when the release details cannot be read", () =>
  Effect.gen(function* () {
    const releases = lookup({
      "/benank/ankielcode/releases/download/v1.2.3/ankiel-release.json": new Response(null, {
        status: 500,
      }),
    });
    const error = yield* releases.get("latest").pipe(Effect.flip);
    assert.equal(error._tag, "ServerReleaseError");
  }),
);
