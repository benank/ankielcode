import {
  EnvironmentOperationForbiddenError,
  EnvironmentRequestInvalidError,
  EnvironmentResourceNotFoundError,
} from "@ankielcode/contracts";
import { describe, expect, it } from "@effect/vitest";

import { errorDisplayMessage, thrownErrorMessage } from "../errors/translatable.ts";
import { mapRemoteDpopEnvironmentError, mapRemoteEnvironmentError } from "./errors.ts";

describe("pairing invite error mapping", () => {
  it.each([
    {
      label: "pairing_invite_not_found",
      error: new EnvironmentResourceNotFoundError({
        code: "not_found",
        reason: "pairing_invite_not_found",
        traceId: "trace-not-found",
      }),
      expectedMessage:
        "This pairing invite was not found or has already expired. Start a new pairing request on your other device.",
    },
    {
      label: "pairing_invite_invalid_state",
      error: new EnvironmentOperationForbiddenError({
        code: "operation_forbidden",
        reason: "pairing_invite_invalid_state",
        traceId: "trace-invalid-state",
      }),
      expectedMessage:
        "This pairing invite is no longer active or has already been claimed. Start a new pairing request on your other device.",
    },
    {
      label: "pairing_invite_limit_reached",
      error: new EnvironmentOperationForbiddenError({
        code: "operation_forbidden",
        reason: "pairing_invite_limit_reached",
        traceId: "trace-limit-reached",
      }),
      expectedMessage:
        "Too many pairing invites are currently active on this environment. Wait a moment or cancel one before trying again.",
    },
    {
      label: "pairing_invite_verification_code_mismatch",
      error: new EnvironmentRequestInvalidError({
        code: "invalid_request",
        reason: "pairing_invite_verification_code_mismatch",
        traceId: "trace-code-mismatch",
      }),
      expectedMessage: "The verification code did not match. Start a new pairing request.",
    },
  ])(
    "maps $label to a clear translatable message in remote and direct HTTP errors",
    ({ error, expectedMessage }) => {
      const mapped = mapRemoteEnvironmentError(error);
      expect(mapped).toMatchObject({
        _tag: "ConnectionBlockedError",
        reason: "configuration",
        hop: "server",
        traceId: error.traceId,
        detail: expectedMessage,
      });
      expect(mapped.message).toBe(expectedMessage);
      expect(mapped.i18nMessage).toHaveLength(1);
      expect(mapRemoteDpopEnvironmentError(error)).toMatchObject({
        _tag: "ConnectionBlockedError",
        reason: "configuration",
        detail: expectedMessage,
        traceId: error.traceId,
      });
      expect(errorDisplayMessage(error)).toBe(expectedMessage);
      expect(thrownErrorMessage(error)).toBe(expectedMessage);
      expect(errorDisplayMessage(mapped)).toBe(expectedMessage);
      expect(thrownErrorMessage(mapped)).toBe(expectedMessage);
    },
  );

  it("keeps existing fallback messages for non-pairing errors", () => {
    const forbidden = new EnvironmentOperationForbiddenError({
      code: "operation_forbidden",
      reason: "current_session_revoke_not_allowed",
      traceId: "trace-forbidden",
    });
    expect(mapRemoteEnvironmentError(forbidden)).toMatchObject({
      _tag: "ConnectionBlockedError",
      reason: "permission",
      hop: "server",
      detail: "The environment credential does not grant the required access.",
    });

    const notFound = new EnvironmentResourceNotFoundError({
      code: "not_found",
      reason: "thread_not_found",
      traceId: "trace-thread-missing",
    });
    expect(mapRemoteEnvironmentError(notFound)).toMatchObject({
      _tag: "ConnectionBlockedError",
      reason: "configuration",
      hop: "server",
      detail: "The environment endpoint could not be found.",
    });

    const invalid = new EnvironmentRequestInvalidError({
      code: "invalid_request",
      reason: "scope_not_granted",
      traceId: "trace-scope",
    });
    expect(mapRemoteEnvironmentError(invalid)).toMatchObject({
      _tag: "ConnectionBlockedError",
      reason: "configuration",
      hop: "server",
      detail: "The environment rejected the authentication request.",
    });
  });
});
