import { describe, expect, it } from "vite-plus/test";

import { parseRelayPushAvailability, parseRelayPushResult } from "./relayProtocol.ts";

describe("relay push protocol", () => {
  it("treats relays without ready.push as having no push", () => {
    expect(parseRelayPushAvailability(undefined)).toEqual({ apns: false, fcm: false });
    expect(parseRelayPushAvailability({ apns: true, fcm: "yes" })).toEqual({
      apns: true,
      fcm: false,
    });
  });

  it("parses push results and drops unknown fields", () => {
    expect(
      parseRelayPushResult({
        type: "push_result",
        pushId: "p1",
        error: "rate_limited",
        extra: 1,
        results: [
          { token: "t1", platform: "apns", ok: false, status: 410, unregistered: true, x: 1 },
          { token: "t2", platform: "fcm", ok: true },
        ],
      }),
    ).toEqual({
      type: "push_result",
      pushId: "p1",
      error: "rate_limited",
      results: [
        { token: "t1", platform: "apns", ok: false, status: 410, unregistered: true },
        { token: "t2", platform: "fcm", ok: true },
      ],
    });
  });

  it("rejects malformed push results", () => {
    expect(parseRelayPushResult({ type: "push_result", pushId: "p1" })).toBeNull();
    expect(
      parseRelayPushResult({
        type: "push_result",
        pushId: "p1",
        results: [{ token: "t", platform: "webpush", ok: true }],
      }),
    ).toBeNull();
    expect(parseRelayPushResult({ type: "ready", hostId: "h" })).toBeNull();
  });
});
