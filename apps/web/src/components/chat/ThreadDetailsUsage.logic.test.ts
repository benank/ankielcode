import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
} from "@ankielcode/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveThreadDetailsLimits } from "./ThreadDetailsUsage.logic";

const now = Date.parse("2026-10-30T12:00:00.000Z");
const checkedAt = "2026-10-30T11:59:00.000Z";
const instanceId = ProviderInstanceId.make("claudeAgent");

function claudeInstance(usageLimits: ServerProviderUsageLimits): ServerProvider {
  return {
    instanceId,
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits,
  };
}

describe("resolveThreadDetailsLimits", () => {
  it("shows the selected instance's own reading, even a failed one", () => {
    const failed: ServerProviderUsageLimits = {
      checkedAt,
      windows: [],
      unavailable: { reason: "probeFailed" },
    };
    expect(resolveThreadDetailsLimits(instanceId, [claudeInstance(failed)], now)).toEqual(failed);
    expect(
      resolveThreadDetailsLimits(ProviderInstanceId.make("missing"), [claudeInstance(failed)], now),
    ).toBeNull();
  });
});
