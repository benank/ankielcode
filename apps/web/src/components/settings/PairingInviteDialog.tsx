import type { ConnectionOnboarding } from "@ankielcode/client-runtime/connection";
import { thrownErrorMessage } from "@ankielcode/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@ankielcode/client-runtime/state/runtime";
import type { EnvironmentId } from "@ankielcode/contracts";
import type { PairingInvitePayload } from "@ankielcode/shared/remote";
import { T, useGT, useMessages } from "gt-react";
import { AlertCircleIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import {
  claimPairingInvite as claimPairingInviteAtom,
  completePairingInvite as completePairingInviteAtom,
  pollPairingInviteClaim as pollPairingInviteClaimAtom,
} from "~/connection/onboarding";
import { m } from "~/i18n/messages";
import { useAtomCommand } from "~/state/use-atom-command";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import {
  formatPairingInviteOrigin,
  formatRemainingPairingTime,
  formatVerificationCode,
  INITIAL_PAIRING_INVITE_STATE,
  isPairingInviteBlockedError,
  isPairingInviteExpired,
  isPairingInviteTransientError,
  PAIRING_INVITE_MAX_CONSECUTIVE_POLL_ERRORS,
  PAIRING_INVITE_POLL_INTERVAL_MS,
  pairingInviteTerminalMessage,
  resolvePairingInvitePollTransition,
  type PairingInviteDialogState,
} from "./PairingInviteDialog.logic";

export function PairingInviteDialog({
  invite,
  expectedEnvironmentId,
  onClose,
  onConnected,
}: {
  readonly invite: PairingInvitePayload | null;
  readonly expectedEnvironmentId?: EnvironmentId;
  readonly onClose: () => void;
  readonly onConnected?: (environmentId: EnvironmentId, inviteId: string) => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const claimPairingInvite = useAtomCommand(claimPairingInviteAtom, { reportFailure: false });
  const pollPairingInviteClaim = useAtomCommand(pollPairingInviteClaimAtom, {
    reportFailure: false,
  });
  const completePairingInvite = useAtomCommand(completePairingInviteAtom, {
    reportFailure: false,
  });

  const currentKey =
    invite !== null ? `${invite.inviteId}:${invite.baseUrl}:${expectedEnvironmentId ?? ""}` : null;
  const [sessionState, setSessionState] = useState<{
    readonly key: string;
    readonly state: PairingInviteDialogState;
  } | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const activeRequestRef = useRef<{
    readonly key: string;
    readonly controller: AbortController;
  } | null>(null);

  if (currentKey === null && sessionState !== null) {
    setSessionState(null);
  }

  const state: PairingInviteDialogState =
    currentKey !== null && sessionState?.key === currentKey
      ? sessionState.state
      : INITIAL_PAIRING_INVITE_STATE;

  const setDialogState = (key: string, nextState: PairingInviteDialogState) => {
    setSessionState({ key, state: nextState });
  };

  const abortActiveRequest = () => {
    activeRequestRef.current?.controller.abort();
    activeRequestRef.current = null;
  };

  const handleClose = () => {
    abortActiveRequest();
    setSessionState(null);
    onClose();
  };

  // oxlint-disable-next-line ankielcode/no-unreasoned-state-sync -- aborts in-flight claim or completion requests when the invite changes or unmounts
  useEffect(() => {
    if (activeRequestRef.current && activeRequestRef.current.key !== currentKey) {
      activeRequestRef.current.controller.abort();
      activeRequestRef.current = null;
    }
    return () => {
      if (activeRequestRef.current && activeRequestRef.current.key === currentKey) {
        activeRequestRef.current.controller.abort();
        activeRequestRef.current = null;
      }
    };
  }, [currentKey]);

  const runComplete = async (
    key: string,
    claim: ConnectionOnboarding.PairingInviteClaimResult,
    credential: string,
  ) => {
    abortActiveRequest();
    const controller = new AbortController();
    activeRequestRef.current = { key, controller };
    setDialogState(key, { phase: "completing", claim });

    const result = await completePairingInvite(
      {
        httpBaseUrl: claim.httpBaseUrl,
        environmentId: claim.environmentId,
        environmentLabel: claim.environmentLabel,
        credential,
        ...(expectedEnvironmentId !== undefined ? { expectedEnvironmentId } : {}),
      },
      { signal: controller.signal },
    );

    if (controller.signal.aborted) return;
    if (activeRequestRef.current?.controller === controller) activeRequestRef.current = null;

    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      const message =
        thrownErrorMessage(error, m) ?? gt("Could not finish connecting to this environment.");
      if (isPairingInviteTransientError(error)) {
        setDialogState(key, {
          phase: "terminal",
          reason: "error",
          message,
          canRetry: true,
          retry: { kind: "complete", claim, credential },
        });
        return;
      }
      setDialogState(key, {
        phase: "terminal",
        reason: "error",
        message,
        canRetry: false,
      });
      return;
    }

    toastManager.add(
      expectedEnvironmentId !== undefined
        ? {
            type: "success",
            title: gt("Route added"),
            description: gt("{environment} now has another way to connect.", {
              environment: claim.environmentLabel,
            }),
          }
        : {
            type: "success",
            title: gt("Environment connected"),
            description: gt("The environment is saved and will reconnect on app startup."),
          },
    );
    onConnected?.(result.value, claim.inviteId);
    setSessionState(null);
    onClose();
  };

  const handleStartClaim = async () => {
    if (invite === null || currentKey === null) return;
    const key = currentKey;
    if (isPairingInviteExpired(invite.expiresAt, Date.now())) {
      setDialogState(key, {
        phase: "terminal",
        reason: "expired",
        canRetry: false,
      });
      return;
    }
    abortActiveRequest();
    const controller = new AbortController();
    activeRequestRef.current = { key, controller };
    setDialogState(key, { phase: "claiming" });

    const result = await claimPairingInvite(
      {
        invite,
        ...(expectedEnvironmentId !== undefined ? { expectedEnvironmentId } : {}),
      },
      { signal: controller.signal },
    );

    if (controller.signal.aborted) return;
    if (activeRequestRef.current?.controller === controller) activeRequestRef.current = null;

    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      const message = thrownErrorMessage(error, m) ?? gt("Could not send the pairing request.");
      if (isPairingInviteBlockedError(error)) {
        setDialogState(key, {
          phase: "terminal",
          reason: "error",
          message,
          canRetry: false,
        });
        return;
      }
      setDialogState(key, {
        phase: "terminal",
        reason: "error",
        message,
        canRetry: true,
        retry: { kind: "claim" },
      });
      return;
    }

    setNowMs(Date.now());
    setDialogState(key, { phase: "waiting", claim: result.value });
  };

  const handleRetry = () => {
    if (state.phase !== "terminal" || !state.canRetry || currentKey === null) return;
    if (state.retry.kind === "complete") {
      void runComplete(currentKey, state.retry.claim, state.retry.credential);
      return;
    }
    void handleStartClaim();
  };

  const waitingClaim = state.phase === "waiting" ? state.claim : null;
  const waitingKey = waitingClaim !== null && currentKey !== null ? currentKey : null;
  const waitingHttpBaseUrl = waitingClaim?.httpBaseUrl ?? null;
  const waitingInviteId = waitingClaim?.inviteId ?? null;
  const isWaiting = waitingKey !== null;

  const pollOnce = useEffectEvent(
    async (
      key: string,
      httpBaseUrl: string,
      inviteId: string,
      signal: AbortSignal,
      consecutiveTransientErrors: number,
    ): Promise<"continue" | "transient" | "stop"> => {
      const result = await pollPairingInviteClaim({ httpBaseUrl, inviteId }, { signal });
      if (signal.aborted) return "stop";

      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) return "stop";
        const error = squashAtomCommandFailure(result);
        if (isPairingInviteTransientError(error)) {
          const expired =
            waitingClaim !== null && isPairingInviteExpired(waitingClaim.expiresAt, Date.now());
          if (
            !expired &&
            consecutiveTransientErrors + 1 < PAIRING_INVITE_MAX_CONSECUTIVE_POLL_ERRORS
          ) {
            return "transient";
          }
          if (expired) {
            setDialogState(key, {
              phase: "terminal",
              reason: "expired",
              canRetry: false,
            });
            return "stop";
          }
        }
        setDialogState(key, {
          phase: "terminal",
          reason: "error",
          message: thrownErrorMessage(error, m) ?? gt("Could not check pairing approval status."),
          canRetry: false,
        });
        return "stop";
      }

      if (waitingClaim === null) return "stop";
      const transition = resolvePairingInvitePollTransition(waitingClaim, result.value);
      if (transition.kind === "continue") {
        if (transition.claim !== waitingClaim) {
          setDialogState(key, { phase: "waiting", claim: transition.claim });
        }
        return "continue";
      }
      if (transition.kind === "approved") {
        void runComplete(key, transition.claim, transition.credential);
        return "stop";
      }
      setDialogState(key, transition.state);
      return "stop";
    },
  );

  // oxlint-disable-next-line ankielcode/no-unreasoned-state-sync -- polls approval status sequentially while waiting for the other device
  useEffect(() => {
    if (waitingKey === null || waitingHttpBaseUrl === null || waitingInviteId === null) return;
    const controller = new AbortController();
    let timeoutId: number | undefined;
    let stopped = false;
    let consecutiveTransientErrors = 0;

    const schedule = () => {
      if (stopped || controller.signal.aborted) return;
      timeoutId = window.setTimeout(() => {
        void run();
      }, PAIRING_INVITE_POLL_INTERVAL_MS);
    };

    const run = async () => {
      if (stopped || controller.signal.aborted) return;
      const outcome = await pollOnce(
        waitingKey,
        waitingHttpBaseUrl,
        waitingInviteId,
        controller.signal,
        consecutiveTransientErrors,
      );
      if (outcome === "continue") {
        consecutiveTransientErrors = 0;
        if (!stopped && !controller.signal.aborted) schedule();
        return;
      }
      if (outcome === "transient") {
        consecutiveTransientErrors += 1;
        if (!stopped && !controller.signal.aborted) schedule();
      }
    };

    schedule();

    return () => {
      stopped = true;
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [waitingKey, waitingHttpBaseUrl, waitingInviteId]);

  // oxlint-disable-next-line ankielcode/no-unreasoned-state-sync -- updates the expiration countdown once per second while waiting for approval
  useEffect(() => {
    if (!isWaiting) return;
    const intervalId = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1_000);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [isWaiting]);

  const origin =
    state.phase === "waiting" || state.phase === "completing"
      ? formatPairingInviteOrigin(state.claim.httpBaseUrl)
      : invite !== null
        ? formatPairingInviteOrigin(invite.baseUrl)
        : "";

  const remaining =
    state.phase === "waiting"
      ? formatRemainingPairingTime(state.claim.expiresAt, nowMs, messages)
      : null;

  const title = (() => {
    switch (state.phase) {
      case "confirm":
        return expectedEnvironmentId !== undefined
          ? gt("Add environment route")
          : gt("Connect environment");
      case "claiming":
        return gt("Sending pairing request");
      case "waiting":
        return gt("Approve pairing");
      case "completing":
        return gt("Connecting environment");
      case "terminal":
        switch (state.reason) {
          case "denied":
            return gt("Pairing denied");
          case "cancelled":
            return gt("Pairing cancelled");
          case "expired":
            return gt("Pairing invite expired");
          case "error":
            return gt("Could not connect");
        }
    }
  })();

  const description = (() => {
    switch (state.phase) {
      case "confirm":
        return gt(
          "This device will send a pairing request to this environment. You'll approve it on your other device after confirming a 6-digit code.",
        );
      case "claiming":
        return gt("Checking this environment and starting a pairing request.");
      case "waiting":
        return gt(
          "Open Ankiel Code on your other device and approve this device after checking the code matches.",
        );
      case "completing":
        return gt("Pairing was approved. Saving the connection to this device.");
      case "terminal":
        return null;
    }
  })();

  const terminalMessage =
    state.phase === "terminal"
      ? state.reason === "error"
        ? state.message
        : pairingInviteTerminalMessage(state.reason, messages)
      : null;

  return (
    <Dialog
      open={invite !== null}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) handleClose();
      }}
    >
      <DialogPopup initialFocus={cancelButtonRef} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <DialogPanel>
          {state.phase === "confirm" && invite !== null ? (
            <div className="space-y-1 rounded-xl border border-border bg-muted/40 px-4 py-3">
              {invite.label ? (
                <p className="text-sm font-medium text-foreground">{invite.label}</p>
              ) : null}
              <p
                className={
                  invite.label
                    ? "break-all font-mono text-xs text-muted-foreground"
                    : "break-all font-mono text-sm font-medium text-foreground"
                }
              >
                {origin}
              </p>
            </div>
          ) : null}

          {state.phase === "claiming" ? (
            <div className="flex items-center gap-3 rounded-xl border border-border bg-muted/40 px-4 py-3.5 text-sm text-muted-foreground">
              <Spinner size="sm" tone="muted" />
              <span>
                <T>Requesting verification code…</T>
              </span>
            </div>
          ) : null}

          {state.phase === "waiting" ? (
            <div className="space-y-3 rounded-xl border border-border bg-muted/40 px-5 py-5 text-center">
              <div className="space-y-0.5">
                <p className="text-sm font-medium text-foreground">
                  {state.claim.environmentLabel}
                </p>
                <p className="break-all font-mono text-xs text-muted-foreground">{origin}</p>
              </div>
              <p
                data-testid="pairing-invite-verification-code"
                className="font-mono text-4xl font-semibold tracking-widest text-foreground tabular-nums select-all"
              >
                {formatVerificationCode(state.claim.verificationCode)}
              </p>
              {remaining && remaining.label ? (
                <p className="text-xs text-muted-foreground tabular-nums">{remaining.label}</p>
              ) : null}
            </div>
          ) : null}

          {state.phase === "completing" ? (
            <div className="flex items-center gap-3 rounded-xl border border-border bg-muted/40 px-4 py-3.5 text-sm text-muted-foreground">
              <Spinner size="sm" tone="muted" />
              <span>
                <T>Connecting…</T>
              </span>
            </div>
          ) : null}

          {state.phase === "terminal" && terminalMessage ? (
            <Alert variant="error">
              <AlertCircleIcon />
              <AlertDescription>{terminalMessage}</AlertDescription>
            </Alert>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          {state.phase === "confirm" ? (
            <>
              <Button ref={cancelButtonRef} variant="outline" onClick={handleClose}>
                <T>Cancel</T>
              </Button>
              <Button onClick={() => void handleStartClaim()}>
                <T>Continue</T>
              </Button>
            </>
          ) : null}

          {state.phase === "claiming" ||
          state.phase === "waiting" ||
          state.phase === "completing" ? (
            <Button ref={cancelButtonRef} variant="outline" onClick={handleClose}>
              <T>Cancel</T>
            </Button>
          ) : null}

          {state.phase === "terminal" ? (
            <>
              <Button ref={cancelButtonRef} variant="outline" onClick={handleClose}>
                <T>Close</T>
              </Button>
              {state.canRetry ? (
                <Button onClick={handleRetry}>
                  <T>Try again</T>
                </Button>
              ) : null}
            </>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
