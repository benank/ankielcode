import { EnvironmentAuthInvalidError } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { presentConnectionDiagnosis } from "./diagnosis.ts";
import { mapRemoteDpopEnvironmentError, mapRemoteEnvironmentError } from "./errors.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  ConnectionBlockedError,
  type ConnectionAttemptError,
  type SupervisorConnectionState,
} from "./model.ts";
import { RemoteEnvironmentAuthFetchError } from "../rpc/http.ts";

const backoff = (lastFailure: ConnectionAttemptError): SupervisorConnectionState => ({
  ...AVAILABLE_CONNECTION_STATE,
  desired: true,
  network: "online",
  phase: "backoff",
  attempt: 3,
  lastFailure,
  retryAt: Date.UTC(2026, 9, 19, 12, 0, 30),
});

const unreachable = () =>
  mapRemoteEnvironmentError(
    new RemoteEnvironmentAuthFetchError({ message: "Failed to fetch", cause: new TypeError() }),
  );

const diagnose = (state: SupervisorConnectionState) =>
  presentConnectionDiagnosis({ hostLabel: "Mac mini", state });

const results = (state: SupervisorConnectionState) =>
  diagnose(state)?.hops.map((hop) => `${hop.hop}:${hop.result}`);

describe("presentConnectionDiagnosis", () => {
  it("blames T3 Code on the host when it does not answer", () => {
    const state = backoff(unreachable());
    expect(diagnose(state)?.headline).toBe("T3 Code on Mac mini did not answer");
    expect(results(state)).toEqual(["device:ok", "server:failed"]);
  });

  it("reports this device as offline before any other hop", () => {
    const state = { ...backoff(unreachable()), network: "offline" as const };
    expect(diagnose(state)?.headline).toBe("This device is offline");
    expect(results(state)?.[0]).toBe("device:failed");
  });

  it("names a clock refusal as this device's clock", () => {
    const failure = mapRemoteDpopEnvironmentError(
      new EnvironmentAuthInvalidError({
        code: "auth_invalid",
        reason: "invalid_credential",
        dpopFailureReason: "time_window",
        traceId: "trace-clock",
      }),
    );
    expect(diagnose(backoff(failure))?.headline).toBe("This device's clock is off");
  });

  it("tells a host that refused this device's login to sign in again, not to start T3 Code", () => {
    const failure = mapRemoteEnvironmentError(
      new EnvironmentAuthInvalidError({
        code: "auth_invalid",
        reason: "invalid_credential",
        traceId: "trace-1",
      }),
    );
    const steps = diagnose(backoff(failure))?.steps.join(" ");
    expect(steps).not.toContain("Make sure T3 Code is running");
    expect(steps).toMatch(/pair|sign in/i);
  });

  it("does not report hops as working when the failure names none", () => {
    const failure = new ConnectionBlockedError({
      reason: "authentication",
      detail: "The credential was refused.",
    });
    expect(results(backoff(failure))).not.toContainEqual(expect.stringMatching(/:ok$/));
  });

  it("lists the attempts and the failure in the facts", () => {
    const diagnosis = diagnose(backoff(unreachable()));
    expect(diagnosis?.facts.map(([label]) => label)).toEqual(
      expect.arrayContaining(["Attempts", "Next retry", "Error"]),
    );
  });
});
