import { EnvironmentId } from "@ankielcode/contracts";
import type { LimitAccount } from "@ankielcode/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import {
  connectedLimitPresentations,
  highestUsagePercent,
  shortPlanLabel,
} from "./headerUsageLimits.logic";

describe("headerUsageLimits", () => {
  it("filters presentations to connected environments only", () => {
    const connectedId = EnvironmentId.make("env-connected");
    const offlineId = EnvironmentId.make("env-offline");
    const presentations = new Map([
      [
        connectedId,
        {
          connection: { phase: "connected" },
          entry: { target: { label: "Connected" } },
          serverConfig: null,
        },
      ],
      [
        offlineId,
        {
          connection: { phase: "offline" },
          entry: { target: { label: "Offline" } },
          serverConfig: null,
        },
      ],
    ]);

    const result = connectedLimitPresentations(presentations);
    expect([...result.keys()]).toEqual([connectedId]);
  });

  it("computes the highest usage percentage across all accounts and windows", () => {
    expect(highestUsagePercent([])).toBeUndefined();

    const accounts = [
      {
        limits: {
          windows: [{ usedPercent: 18 }, { usedPercent: 64 }],
        },
      },
      {
        limits: {
          windows: [{ usedPercent: 92.4 }, { usedPercent: 40 }],
        },
      },
    ] as unknown as LimitAccount[];

    expect(highestUsagePercent(accounts)).toBe(92.4);
  });

  it("strips redundant product prefixes and Subscription suffixes from plan labels", () => {
    expect(shortPlanLabel("ChatGPT Pro 200 Subscription")).toBe("Pro 200");
    expect(shortPlanLabel("Claude Max Subscription")).toBe("Max");
    expect(shortPlanLabel("Google AI Pro")).toBe("Pro");
    expect(shortPlanLabel("Team")).toBe("Team");
  });
});
