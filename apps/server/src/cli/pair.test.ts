// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises Node HTTP and filesystem boundaries.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@ankielcode/shared/Net";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command, CliError } from "effect/cli";

import { cli } from "../binCli.ts";

const layerCliRuntime = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer);

const runCli = (args: ReadonlyArray<string>) => Command.runWith(cli, { version: "0.0.0" })(args);

const provideCliTestLayers = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provide(effect, Layer.mergeAll(layerCliRuntime, TestConsole.layer));

const captureStdout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  provideCliTestLayers(
    Effect.gen(function* () {
      yield* effect;
      return (
        (yield* TestConsole.logLines).findLast(
          (line): line is string => typeof line === "string",
        ) ?? ""
      );
    }),
  );

describe("auth scope options", () => {
  it.effect.each([
    { group: "pairing", action: "create" },
    { group: "session", action: "issue" },
  ] as const)(
    "issues and persists only the selected scopes for auth $group $action",
    ({ group, action }) =>
      Effect.gen(function* () {
        const baseDir = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "ankiel-cli-auth-scopes-test-"),
        );
        const output = yield* captureStdout(
          runCli([
            "auth",
            group,
            action,
            "--base-dir",
            baseDir,
            "--json",
            "--scope",
            "orchestration:read",
            "--scope",
            "access:read",
            "--scope",
            "orchestration:read",
          ]),
        );
        const issued = JSON.parse(output) as { readonly scopes: ReadonlyArray<string> };
        const listOutput = yield* captureStdout(
          runCli(["auth", group, "list", "--base-dir", baseDir, "--json"]),
        );
        const listed = JSON.parse(listOutput) as ReadonlyArray<{
          readonly scopes: ReadonlyArray<string>;
        }>;

        assert.deepEqual(issued.scopes, ["orchestration:read", "access:read"]);
        assert.lengthOf(listed, 1);
        assert.deepEqual(listed[0]?.scopes, issued.scopes);
      }),
  );

  it.effect.each(
    [["pair"], ["auth", "pairing", "create"], ["auth", "session", "issue"]].map((command) => ({
      command,
      label: command.join(" "),
    })),
  )("rejects invalid scopes before running $label", ({ command }) =>
    Effect.gen(function* () {
      const error = yield* runCli([
        ...command,
        "--scope",
        "orchestration:read",
        "--scope",
        "admin",
      ]).pipe(Effect.provide(layerCliRuntime), Effect.flip);

      if (!CliError.isCliError(error) || error._tag !== "ShowHelp") {
        assert.fail(`Expected ShowHelp, got ${String(error)}`);
      }
      assert.deepEqual(error.commandPath, ["ankiel", ...command]);
      const scopeError = error.errors[0];
      if (scopeError?._tag !== "InvalidValue") {
        assert.fail(`Expected InvalidValue, got ${String(scopeError?._tag)}`);
      }
      assert.equal(scopeError.option, "scope");
      assert.equal(scopeError.value, "admin");
    }),
  );
});

describe("auth pairing create --base-url", () => {
  it.effect.each(["192.168.1.5:3773", "localhost:3773", "ftp://localhost:3773"])(
    "rejects %s before issuing a token",
    (baseUrl) =>
      Effect.gen(function* () {
        const baseDir = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "ankiel-cli-base-url-test-"),
        );
        const error = yield* runCli([
          "auth",
          "pairing",
          "create",
          "--base-dir",
          baseDir,
          "--base-url",
          baseUrl,
        ]).pipe(Effect.provide(layerCliRuntime), Effect.flip);

        if (!CliError.isCliError(error) || error._tag !== "ShowHelp") {
          assert.fail(`Expected ShowHelp, got ${String(error)}`);
        }
        const flagError = error.errors[0];
        if (flagError?._tag !== "InvalidValue") {
          assert.fail(`Expected InvalidValue, got ${String(flagError?._tag)}`);
        }
        assert.equal(flagError.option, "base-url");
        assert.equal(flagError.value, baseUrl);

        const listOutput = yield* captureStdout(
          runCli(["auth", "pairing", "list", "--base-dir", baseDir, "--json"]),
        );
        assert.deepEqual(JSON.parse(listOutput), []);
      }),
  );
});
