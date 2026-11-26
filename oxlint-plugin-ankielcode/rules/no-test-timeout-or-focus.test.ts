import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const RULE = "ankielcode/no-test-timeout-or-focus";
const rule = createOxlintRuleHarness(RULE, { filename: "fixture.test.ts" });

const assertTimeoutMessage = (output: string) =>
  assert.match(output, /project timeout is the ceiling/);
const assertFocusMessage = (output: string) => assert.match(output, /focused test/);

describe(RULE, () => {
  rule.valid(
    "allows tests without overrides, conditional skips, and waitFor timeouts",
    `
      import { describe, it, vi } from "vitest";

      describe.skipIf(process.env.CI)("suite", () => {
        it.runIf(true)("runs", async () => {
          await vi.waitFor(() => {}, { timeout: 10_000 });
        });
        it.each([1, 2])("handles %s", (value) => {});
      });
      vi.setConfig({ restoreMocks: true });
    `,
  );

  rule.valid(
    "allows skips, todos, and the x aliases",
    `
      import { describe, it, suite, test } from "vitest";
      import { it as effectIt } from "@effect/vitest";
      import * as Effect from "effect/Effect";

      it.skip("pending", () => {});
      effectIt.effect.skip("pending", () => Effect.void);
      test.todo("later");
      xit("disabled", () => {});
      suite.skip("later", () => {});
      test("later", { skip: true }, () => {});
      it["skip"]("later", () => {});
    `,
  );

  rule.invalid(
    "reports a numeric timeout on it.effect",
    `
      import { it } from "@effect/vitest";
      import * as Effect from "effect/Effect";

      it.effect("slow", () => Effect.void, 20_000);
    `,
    assertTimeoutMessage,
  );

  rule.invalid(
    "reports a timeout through .each and .skipIf chains",
    `
      import { it } from "@effect/vitest";
      import * as Effect from "effect/Effect";

      it.live.skipIf(false)("slow", () => Effect.void, 5_000);
      it.effect.each([1])("case %s", () => Effect.void, { timeout: 1_000 });
    `,
    (output) => {
      assertTimeoutMessage(output);
      assert.equal(output.match(/no-test-timeout-or-focus/g)?.length, 2);
    },
  );

  rule.invalid(
    "reports retry options, options-first timeouts, and hook timeouts",
    `
      import { beforeAll, describe, it } from "vitest";

      describe("suite", () => {
        beforeAll(() => {}, 60_000);
        it("flaky", () => {}, { retry: 3 });
        it("slow", { timeout: 30_000 }, () => {});
      });
    `,
    (output) => {
      assertTimeoutMessage(output);
      assert.equal(output.match(/no-test-timeout-or-focus/g)?.length, 3);
    },
  );

  rule.invalid(
    "reports vi.setConfig timeouts",
    `
      import { vi } from "vitest";

      vi.setConfig({ testTimeout: 30_000 });
    `,
    assertTimeoutMessage,
  );

  rule.invalid(
    "reports only and the f aliases, even with a comment",
    `
      import { describe, it } from "vitest";

      // https://github.com/benank/ankielcode/issues/42
      describe.only("focused", () => {});
      it.only("focused", () => {});
      fdescribe("focused", () => {});
      fit("focused", () => {});
    `,
    (output) => {
      assertFocusMessage(output);
      assert.equal(output.match(/no-test-timeout-or-focus/g)?.length, 4);
    },
  );
  rule.invalid(
    "flags an options-object timeout when the callback is a reference",
    `
      import { it } from "vitest";
      const run = async () => {};
      it("slow", { timeout: 30_000 }, run);
    `,
    assertTimeoutMessage,
  );

  rule.valid(
    "allows a computed skip option, which is a platform gate like skipIf",
    `
      import { it } from "vitest";
      const windowsHost = process.platform === "win32";
      it.each([{ name: "a" }])("x $name", { skip: windowsHost }, () => {});
    `,
  );

  rule.invalid(
    "flags the suite alias and option-object focus",
    `
      import { suite, test } from "vitest";
      suite.only("focused", () => {});
    `,
    assertFocusMessage,
  );

  rule.invalid(
    "flags an only option",
    `
      import { test } from "vitest";
      test("focused", { only: true }, () => {});
    `,
    assertFocusMessage,
  );

  rule.invalid(
    "flags a bracket-access only",
    `
      import { it } from "vitest";
      it["only"]("focused", () => {});
    `,
    assertFocusMessage,
  );
});

createOxlintRuleHarness(RULE, { filename: "Provider.live.test.ts" }).invalid(
  "still flags an option-object focus in a live file",
  `
    import { it } from "vitest";
    it("focused", { only: true }, () => {});
  `,
  assertFocusMessage,
);

createOxlintRuleHarness(RULE, { filename: "Provider.live.test.ts" }).valid(
  "allows timeouts in opt-in live provider suites",
  `
    import { it } from "@effect/vitest";
    import * as Effect from "effect/Effect";

    it.live("real turn", () => Effect.void, 360_000);
  `,
);

createOxlintRuleHarness(RULE).valid(
  "ignores non-test files",
  `
    const it = (_name: string, _fn: () => void, _ms: number) => {};
    it("x", () => {}, 1_000);
  `,
);
