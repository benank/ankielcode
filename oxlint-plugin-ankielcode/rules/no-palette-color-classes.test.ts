import { describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("ankielcode/no-palette-color-classes", {
  filename: "apps/web/src/components/Example.tsx",
});

describe("ankielcode/no-palette-color-classes", () => {
  rule.valid(
    "allows theme tokens",
    `const el = <span className="text-destructive bg-muted text-signal-active dark:text-warning" />;`,
  );

  rule.valid(
    "allows neutral palettes",
    `const el = <span className="text-zinc-500 bg-neutral-900" />;`,
  );

  rule.valid("allows words that only look like hues", `const label = "redirect-to-200";`);

  rule.invalid(
    "reports a palette class",
    `const el = <span className="text-emerald-600 dark:text-emerald-300" />;`,
  );

  rule.invalid("reports a variant-prefixed class", "const cls = `hover:bg-sky-500/10`;");

  rule.invalid("reports a mobile adaptive class", `const cls = "text-adaptive-rose-600-400";`);
});
