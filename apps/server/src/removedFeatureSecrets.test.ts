import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfig from "./config.ts";
import { removeRemovedFeatureSecrets } from "./removedFeatureSecrets.ts";

const KEPT = [
  "server-signing-key",
  "provider-env-Y29kZXg-T1BFTkFJX0FQSV9LRVk",
  "usage-limit-source-aHVi",
  "source-control-Z2l0aHVi-dG9rZW5z-Z2l0aHViLmNvbQ",
  "github-token-Z2l0aHViLmNvbQ",
];

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("removedFeatureSecrets", (it) => {
  it.effect("removes removed features' secrets and nothing else", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;
      const { secretsDir } = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      for (const name of [
        "issue-tracker-bGluZWFy-token",
        "issue-tracker-bGluZWFy-account-work-2-token",
        "bitbucket-access-token",
        "bitbucket-api-token",
        "source-control-Yml0YnVja2V0-YXBpVG9rZW4",
        "source-control-Z2l0bGFi-dG9rZW5z-Z2l0bGFiLmNvbQ",
        ...KEPT,
      ])
        yield* secretStore.create(name, Uint8Array.from([1]));

      yield* removeRemovedFeatureSecrets();

      const remaining = yield* fileSystem.readDirectory(secretsDir);
      assert.deepStrictEqual(remaining.toSorted(), KEPT.map((name) => `${name}.bin`).toSorted());
    }).pipe(
      Effect.provide(
        ServerSecretStore.layer.pipe(
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "ankiel-removed-feature-secrets-test-" }),
          ),
        ),
      ),
    ),
  );
});
