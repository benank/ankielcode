import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as FeatureFlags from "./FeatureFlags.ts";

it.effect("resolves ANKIEL_FEATURE_FLAGS lists", () =>
  Effect.gen(function* () {
    const cases: ReadonlyArray<
      readonly [string | undefined, Partial<FeatureFlags.FeatureFlagValues>]
    > = [
      [undefined, {}],
      [" tanstack_source , unknown_flag=1 ", { tanstackSource: true }],
      [
        "tanstack_source=0,github_app_client_id=Iv23=x",
        { githubAppClientId: Option.some("Iv23=x") },
      ],
      ["tanstack_source,typo_flag", { tanstackSource: true }],
      // One bad value turns every flag off rather than failing startup.
      ["tanstack_source=maybe,github_app_client_id=Iv23", {}],
    ];
    for (const [list, expected] of cases) {
      assert.deepStrictEqual(yield* FeatureFlags.resolve(list), {
        tanstackSource: false,
        githubAppClientId: Option.none(),
        ...expected,
      });
    }
  }),
);
