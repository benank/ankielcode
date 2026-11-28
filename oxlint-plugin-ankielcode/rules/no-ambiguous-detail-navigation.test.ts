import { describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("ankielcode/no-ambiguous-detail-navigation", {
  filename: "apps/mobile/src/features/threads/ThreadFeed.tsx",
});

describe("ankielcode/no-ambiguous-detail-navigation", () => {
  rule.valid(
    "allows selections, explicit pushes, and other routes",
    `
      selectDetail({ name: "Thread", params });
      navigation.dispatch(StackActions.push("Thread", params));
      navigation.navigate("ThreadFiles", params);
    `,
  );

  rule.invalid("reports navigating to a thread", `navigation.navigate("Thread", params);`);

  rule.invalid(
    "reports a navigate action to a thread",
    `navigation.dispatch(CommonActions.navigate("Thread", params));`,
  );
});
