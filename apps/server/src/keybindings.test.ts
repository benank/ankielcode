import { KeybindingCommand, KeybindingRule, KeybindingsConfig } from "@ankielcode/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { assertFailure } from "@effect/vitest/utils";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ServerConfig from "./config.ts";
import * as Keybindings from "./keybindings.ts";
import * as SharedKeybindings from "@ankielcode/shared/keybindings";
import { KeybindingsConfigError } from "@ankielcode/contracts";

const KeybindingsConfigJson = Schema.fromJsonString(KeybindingsConfig);
const encodeKeybindingsConfigJson = Schema.encodeEffect(KeybindingsConfigJson);
const decodeKeybindingsConfigJson = Schema.decodeUnknownEffect(KeybindingsConfigJson);
const layerKeybindings = () => {
  return Keybindings.layer.pipe(
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "ankielcode-keybindings-test-",
        }),
      ),
    ),
  );
};

const toDetailResult = <A, R>(effect: Effect.Effect<A, KeybindingsConfigError, R>) =>
  effect.pipe(
    Effect.mapError((error) => error.detail),
    Effect.result,
  );

const writeKeybindingsConfig = (configPath: string, rules: readonly KeybindingRule[]) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const encoded = yield* encodeKeybindingsConfigJson(rules);
    yield* fileSystem.makeDirectory(path.dirname(configPath), { recursive: true });
    yield* fileSystem.writeFileString(configPath, encoded);
  });

const readKeybindingsConfig = (configPath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const rawConfig = yield* fileSystem.readFileString(configPath);
    return yield* decodeKeybindingsConfigJson(rawConfig);
  });

it.layer(NodeServices.layer)("keybindings", (it) => {
  it.effect("uses defaults in runtime when config is malformed without overriding file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* fs.writeFileString(keybindingsConfigPath, "{ not-json");

      const configState = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        return yield* keybindings.loadConfigState;
      });

      assert.deepEqual(
        configState.keybindings,
        SharedKeybindings.compileResolvedKeybindingsConfig(SharedKeybindings.DEFAULT_KEYBINDINGS),
      );
      assert.deepEqual(configState.issues, [
        {
          kind: "keybindings.malformed-config",
          message: configState.issues[0]?.message ?? "",
        },
      ]);
      assert.equal(yield* fs.readFileString(keybindingsConfigPath), "{ not-json");
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("keeps entries it cannot decode when editing other keybindings", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      const futureCommand = { key: "mod+shift+k", command: "command.from-a-newer-build" };
      const badShortcut = { key: "mod+shift+d+o", command: "terminal.new" };
      yield* fs.writeFileString(
        keybindingsConfigPath,
        JSON.stringify([
          { key: "mod+r", command: "script.run-tests.run" },
          futureCommand,
          badShortcut,
        ]),
      );
      const keybindings = yield* Keybindings.Keybindings;
      const persisted = Effect.map(fs.readFileString(keybindingsConfigPath), JSON.parse);

      const saved = yield* keybindings.upsertKeybindingRule({
        key: "mod+shift+r",
        command: "script.run-tests.run",
      });
      assert.equal(saved.issues.length, 2);
      assert.deepEqual(yield* persisted, [
        { key: "mod+r", command: "script.run-tests.run" },
        futureCommand,
        badShortcut,
        { key: "mod+shift+r", command: "script.run-tests.run" },
      ]);

      const removed = yield* keybindings.removeKeybindingRule({
        key: "mod+r",
        command: "script.run-tests.run",
      });
      assert.deepEqual(yield* persisted, [
        futureCommand,
        badShortcut,
        { key: "mod+shift+r", command: "script.run-tests.run" },
      ]);
      const { issues } = yield* keybindings.loadConfigState;
      assert.deepEqual(removed.issues, issues);
      assert.deepEqual(
        issues.map((issue) => issue.kind === "keybindings.invalid-entry" && issue.index),
        [0, 1],
      );
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("refuses to overwrite malformed keybindings config", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* fs.writeFileString(keybindingsConfigPath, "{ not-json");

      const result = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        return yield* keybindings.upsertKeybindingRule({
          key: "mod+shift+r",
          command: "script.run-tests.run",
        });
      }).pipe(toDetailResult);
      assertFailure(result, "expected JSON array");

      const persistedRaw = yield* fs.readFileString(keybindingsConfigPath);
      assert.equal(persistedRaw, "{ not-json");
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("serializes concurrent upserts to avoid lost updates", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, []);

      const commands = Array.from(
        { length: 20 },
        (_, index): KeybindingCommand => `script.concurrent-${index}.run`,
      );
      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        yield* Effect.forEach(
          commands,
          (command, index) =>
            keybindings.upsertKeybindingRule({
              key: `mod+${String.fromCharCode(97 + index)}`,
              command,
            }),
          { concurrency: "unbounded", discard: true },
        );
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      const persistedCommands = new Set(persisted.map((entry) => entry.command));
      for (const command of commands) {
        assert.isTrue(persistedCommands.has(command), `expected persisted command ${command}`);
      }
    }).pipe(Effect.provide(layerKeybindings())),
  );
});
