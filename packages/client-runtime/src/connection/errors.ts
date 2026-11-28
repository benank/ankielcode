import type { DpopFailureReason, EnvironmentId } from "@ankielcode/contracts";
import { msg } from "gt-i18n";
import type { RemoteEnvironmentAuthError } from "../authorization/remote.ts";
import { detailFromError, type MarkedText, translatableDetail } from "../errors/translatable.ts";
import {
  ConnectionBlockedError,
  type ConnectionAttemptError,
  ConnectionTransientError,
} from "./model.ts";

export function profileMissingError(connectionId: string): ConnectionBlockedError {
  return new ConnectionBlockedError({
    reason: "configuration",
    ...translatableDetail(
      msg("Connection profile {connectionId} is unavailable.", { connectionId }),
    ),
    hop: "device",
  });
}

export function credentialMissingError(connectionId: string): ConnectionBlockedError {
  return new ConnectionBlockedError({
    reason: "authentication",
    ...translatableDetail(
      msg("Connection credential {connectionId} is unavailable.", { connectionId }),
    ),
    hop: "device",
  });
}

/** The host itself answered and refused this device's credential, which pairing again fixes. */
export function isHostCredentialRefusal(error: ConnectionAttemptError): boolean {
  return (
    error._tag === "ConnectionBlockedError" &&
    error.hop === "server" &&
    (error.reason === "authentication" || error.reason === "permission") &&
    error.failureCause !== "clock_skew"
  );
}

export function environmentMismatchError(input: {
  readonly expected: EnvironmentId;
  readonly actual: EnvironmentId;
}): ConnectionBlockedError {
  return new ConnectionBlockedError({
    reason: "configuration",
    ...translatableDetail(
      msg(
        "This address now runs a different Ankiel Code install ({actual}, not {expected}). Remove this connection and add it again.",
        { actual: input.actual, expected: input.expected },
      ),
    ),
  });
}

export function mapRemoteEnvironmentError(
  error: RemoteEnvironmentAuthError,
): ConnectionAttemptError {
  switch (error._tag) {
    case "EnvironmentAuthInvalidError":
      return new ConnectionBlockedError({
        reason: "authentication",
        ...translatableDetail(msg("The environment credential is invalid.")),
        traceId: error.traceId,
        hop: "server",
      });
    case "EnvironmentScopeRequiredError":
    case "EnvironmentOperationForbiddenError":
      return new ConnectionBlockedError({
        reason: "permission",
        ...translatableDetail(
          msg("The environment credential does not grant the required access."),
        ),
        traceId: error.traceId,
        hop: "server",
      });
    case "EnvironmentRequestInvalidError":
      return new ConnectionBlockedError({
        reason: "configuration",
        ...translatableDetail(msg("The environment rejected the authentication request.")),
        traceId: error.traceId,
        hop: "server",
      });
    case "EnvironmentResourceNotFoundError":
      return new ConnectionBlockedError({
        reason: "configuration",
        ...translatableDetail(msg("The environment endpoint could not be found.")),
        traceId: error.traceId,
        hop: "server",
      });
    case "RemoteEnvironmentAuthTimeoutError":
      return new ConnectionTransientError({
        reason: "timeout",
        ...detailFromError(error),
        hop: "server",
      });
    case "RemoteEnvironmentAuthFetchError":
      return new ConnectionTransientError({
        reason: "network",
        ...detailFromError(error),
        hop: "server",
      });
    case "EnvironmentInternalError":
      return new ConnectionTransientError({
        reason: "remote-unavailable",
        ...translatableDetail(msg("The environment could not authorize the connection.")),
        traceId: error.traceId,
        hop: "server",
      });
    case "RemoteEnvironmentAuthInvalidJsonError":
    case "RemoteEnvironmentAuthUndeclaredStatusError":
      return new ConnectionTransientError({
        reason: "remote-unavailable",
        ...detailFromError(error),
        hop: "server",
      });
  }
}

const DPOP_CLOCK_HINT = msg(
  "Hint: Check that automatic date and time is enabled on both devices, then try again.",
);

/** Older servers omit the DPoP category, but newer servers can also omit it for
 * a credential failure that happens after proof verification. */
const DPOP_UNKNOWN_HINT = msg(
  "Hint: Try again. If it still fails, clock skew may be the cause; check that automatic date and time is enabled on both devices.",
);

const DPOP_RETRY_HINT = msg("Hint: Try again. If the problem continues, copy the trace ID.");

function dpopFailureHint(reason: DpopFailureReason | undefined): string {
  if (reason === "time_window") return DPOP_CLOCK_HINT;
  if (reason === undefined) return DPOP_UNKNOWN_HINT;
  return DPOP_RETRY_HINT;
}

function dpopFailureText(message: string, reason: DpopFailureReason | undefined): MarkedText {
  return [message, dpopFailureHint(reason)];
}

/**
 * An older environment server reports a DPoP clock failure as the same generic
 * invalid-credential response as other failures, so keep the compatibility hint
 * cautious when the server omits the category.
 */
export function mapRemoteDpopEnvironmentError(
  error: RemoteEnvironmentAuthError,
): ConnectionAttemptError {
  if (error._tag === "EnvironmentAuthInvalidError" && error.reason === "invalid_credential") {
    return new ConnectionBlockedError({
      reason: "authentication",
      ...translatableDetail(
        ...dpopFailureText(msg("The environment credential is invalid."), error.dpopFailureReason),
      ),
      traceId: error.traceId,
      hop: "server",
      ...(error.dpopFailureReason === "time_window" ? { failureCause: "clock_skew" } : {}),
    });
  }
  return mapRemoteEnvironmentError(error);
}
