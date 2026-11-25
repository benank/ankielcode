import type { LimitAccount, LimitPresentations } from "@ankielcode/shared/usageLimits";

export function connectedLimitPresentations<
  T extends (LimitPresentations extends ReadonlyMap<infer K, infer V>
    ? ReadonlyMap<K, V & { readonly connection: { readonly phase: string } }>
    : never),
>(allPresentations: T): LimitPresentations {
  return new Map(
    [...allPresentations].filter(
      ([, presentation]) => presentation.connection.phase === "connected",
    ),
  );
}

export function highestUsagePercent(accounts: readonly LimitAccount[]): number | undefined {
  let highest: number | undefined;
  for (const { limits } of accounts) {
    for (const window of limits.windows) {
      highest = Math.max(highest ?? 0, window.usedPercent);
    }
  }
  return highest;
}

// Plan labels repeat the product the provider name already shows, e.g. "ChatGPT Pro 200 Subscription".
export function shortPlanLabel(plan: string): string {
  return plan.replace(/^(ChatGPT|Claude|Google AI)\s+/i, "").replace(/\s+Subscription$/i, "");
}
