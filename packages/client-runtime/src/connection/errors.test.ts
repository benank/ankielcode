import { EnvironmentAuthInvalidError } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  DPOP_UNKNOWN_HINT,
  isHostCredentialRefusal,
  mapRemoteDpopEnvironmentError,
} from "./errors.ts";

describe("mapRemoteDpopEnvironmentError", () => {
  it("presents clock skew as one possible cause for a generic DPoP error", () => {
    const mapped = mapRemoteDpopEnvironmentError(
      new EnvironmentAuthInvalidError({
        code: "auth_invalid",
        reason: "invalid_credential",
        traceId: "trace-1",
      }),
    );

    expect(mapped).toMatchObject({
      _tag: "ConnectionBlockedError",
      reason: "authentication",
      detail: `The environment credential is invalid. ${DPOP_UNKNOWN_HINT}`,
      traceId: "trace-1",
    });
  });

  it("keeps a direct host's clock refusal apart from a refused pairing", () => {
    const mapped = mapRemoteDpopEnvironmentError(
      new EnvironmentAuthInvalidError({
        code: "auth_invalid",
        reason: "invalid_credential",
        dpopFailureReason: "time_window",
        traceId: "trace-clock",
      }),
    );
    expect(mapped).toMatchObject({ failureCause: "clock_skew" });
    expect(isHostCredentialRefusal(mapped)).toBe(false);
  });
});
