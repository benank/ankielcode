/**
 * Deletes the tokens the removed Linear tracker kept in the secret store. Their per-account names
 * carry ids from a table migration 112 dropped, so the secrets directory is listed instead.
 *
 * @module issue/removedLinearTokens
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import { forkParked } from "../serverActivation.ts";

// issue-tracker-<base64url kind>-token and issue-tracker-<base64url kind>-account-<id>-token.
const LINEAR_TOKEN_FILE =
  /^issue-tracker-[A-Za-z0-9_-]+?(-account-[a-z0-9][a-z0-9-]*)?-token\.bin$/;

export const removeLinearTokens = Effect.fn("removedLinearTokens.remove")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { secretsDir } = yield* ServerConfig.ServerConfig;
  const tokens = (yield* fileSystem.readDirectory(secretsDir)).filter((name) =>
    LINEAR_TOKEN_FILE.test(name),
  );
  yield* Effect.forEach(tokens, (name) => fileSystem.remove(path.join(secretsDir, name)), {
    discard: true,
  });
  yield* Effect.annotateCurrentSpan({ "linear_tokens.removed": tokens.length });
});

export const layer = Layer.effectDiscard(
  forkParked(
    removeLinearTokens().pipe(
      Effect.catch((cause) => Effect.logWarning("Failed to remove Linear tokens", { cause })),
    ),
  ),
);
