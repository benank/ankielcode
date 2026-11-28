/**
 * Deletes secrets that removed features left in the secret store. Some names carry ids from
 * dropped tables, so the secrets directory is listed instead.
 *
 * @module removedFeatureSecrets
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "./config.ts";
import { forkParked } from "./serverActivation.ts";
import { sourceControlDefinitions } from "./sourceControl/sourceControlDefinitions.ts";

const keptSourceControlPrefixes = sourceControlDefinitions.definitions.map(
  (definition) => `source-control-${Buffer.from(definition.kind, "utf8").toString("base64url")}-`,
);

const isRemovedFeatureSecret = (fileName: string) =>
  // Linear: issue-tracker-<kind>-token and issue-tracker-<kind>-account-<id>-token.
  /^issue-tracker-[A-Za-z0-9_-]+?(-account-[a-z0-9][a-z0-9-]*)?-token\.bin$/.test(fileName) ||
  /^bitbucket-(access|api)-token\.bin$/.test(fileName) ||
  fileName.startsWith("usage-limit-source-") ||
  (fileName.startsWith("source-control-") &&
    !keptSourceControlPrefixes.some((prefix) => fileName.startsWith(prefix)));

export const removeRemovedFeatureSecrets = Effect.fn("removedFeatureSecrets.remove")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { secretsDir } = yield* ServerConfig.ServerConfig;
  const removed = (yield* fileSystem.readDirectory(secretsDir)).filter(isRemovedFeatureSecret);
  yield* Effect.forEach(removed, (name) => fileSystem.remove(path.join(secretsDir, name)), {
    discard: true,
  });
  yield* Effect.annotateCurrentSpan({ "removed_feature_secrets.removed": removed.length });
});

export const layer = Layer.effectDiscard(
  forkParked(
    removeRemovedFeatureSecrets().pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Failed to remove secrets of removed features", { cause }),
      ),
    ),
  ),
);
