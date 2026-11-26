import * as HostProcess from "@ankielcode/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const Config = Schema.Struct({
  oauthAccount: Schema.optional(
    Schema.Struct({
      organizationUuid: Schema.optional(Schema.String),
      accountUuid: Schema.optional(Schema.Unknown),
    }),
  ),
});

const readConfig = Effect.fn("claudeAccountConfig.readConfig")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(file).pipe(
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed("{}") : Effect.fail(error),
    }),
    Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Config))),
  );
});

export const readClaudeOauthAccount = (accountConfigPath: string) =>
  readConfig(accountConfigPath).pipe(
    Effect.map((config) => config.oauthAccount),
    Effect.orElseSucceed(() => undefined),
  );

export const readClaudeOrganizationId = (accountConfigPath: string) =>
  readClaudeOauthAccount(accountConfigPath).pipe(
    Effect.map((account) => account?.organizationUuid?.trim() || undefined),
  );

export const claudeAccountConfigPath = Effect.fn("claudeAccountConfigPath")(function* (
  configDir: string | undefined,
) {
  const path = yield* Path.Path;
  return configDir
    ? path.join(configDir, ".claude.json")
    : path.join(yield* HostProcess.HomeDirectory, ".claude.json");
});
