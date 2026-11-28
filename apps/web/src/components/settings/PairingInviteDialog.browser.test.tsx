import "~/index.css";

import {
  ConnectionBlockedError,
  ConnectionTransientError,
  type ConnectionOnboarding,
} from "@ankielcode/client-runtime/connection";
import {
  EnvironmentId,
  IsoDateTime,
  type AuthPairingInviteClaimStatus,
} from "@ankielcode/contracts";
import type { PairingInvitePayload } from "@ankielcode/shared/remote";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { fakeTimers, render } from "../../../test/render";
import { PairingInviteDialog } from "./PairingInviteDialog";
import {
  PAIRING_INVITE_MAX_CONSECUTIVE_POLL_ERRORS,
  PAIRING_INVITE_POLL_INTERVAL_MS,
} from "./PairingInviteDialog.logic";

type CommandCall = {
  readonly label: string;
  readonly value: unknown;
  readonly signal: AbortSignal | undefined;
};

const mocks = vi.hoisted(() => ({
  claim:
    vi.fn<
      (
        input: ConnectionOnboarding.PairingInviteClaimInput,
        call?: { readonly signal?: AbortSignal | undefined },
      ) => Promise<AsyncResult.AsyncResult<ConnectionOnboarding.PairingInviteClaimResult, unknown>>
    >(),
  poll: vi.fn<
    (
      input: ConnectionOnboarding.PairingInvitePollInput,
      call?: { readonly signal?: AbortSignal | undefined },
    ) => Promise<AsyncResult.AsyncResult<AuthPairingInviteClaimStatus, unknown>>
  >(),
  complete:
    vi.fn<
      (
        input: ConnectionOnboarding.PairingInviteCompleteInput,
        call?: { readonly signal?: AbortSignal | undefined },
      ) => Promise<AsyncResult.AsyncResult<EnvironmentId, unknown>>
    >(),
  toastAdd: vi.fn(),
  calls: [] as CommandCall[],
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand:
    (command: { readonly label: string }) =>
    (value: unknown, call?: { readonly signal?: AbortSignal | undefined }) => {
      mocks.calls.push({ label: command.label, value, signal: call?.signal });
      if (command.label === "web:connection:claim-pairing-invite") {
        return mocks.claim(value as ConnectionOnboarding.PairingInviteClaimInput, call);
      }
      if (command.label === "web:connection:poll-pairing-invite-claim") {
        return mocks.poll(value as ConnectionOnboarding.PairingInvitePollInput, call);
      }
      if (command.label === "web:connection:complete-pairing-invite") {
        return mocks.complete(value as ConnectionOnboarding.PairingInviteCompleteInput, call);
      }
      throw new Error(`Unexpected command: ${command.label}`);
    },
}));

vi.mock("../ui/toast", () => ({
  toastManager: {
    add: (...args: unknown[]) => mocks.toastAdd(...args),
  },
}));

const BASE_TIME = new Date("2026-11-27T18:00:00.000Z");

const SAMPLE_INVITE: PairingInvitePayload = {
  version: 1,
  inviteId: "inv_test_1",
  environmentId: "env-studio",
  baseUrl: "http://192.168.1.44:3773/",
  label: "Studio Mac",
  expiresAt: "2026-11-27T18:05:00.000Z",
};

const SAMPLE_CLAIM: ConnectionOnboarding.PairingInviteClaimResult = {
  inviteId: "inv_test_1",
  environmentId: EnvironmentId.make("env-studio"),
  environmentLabel: "Studio Mac (Verified)",
  httpBaseUrl: "http://192.168.1.44:3773/",
  verificationCode: "482-910",
  expiresAt: IsoDateTime.make("2026-11-27T18:03:00.000Z"),
};

function setup() {
  mocks.claim.mockReset();
  mocks.poll.mockReset();
  mocks.complete.mockReset();
  mocks.toastAdd.mockReset();
  mocks.calls.length = 0;
}

it("focuses Cancel by default, claims, polls sequentially until approved, and completes pairing", async () => {
  setup();
  mocks.claim.mockResolvedValue(AsyncResult.success(SAMPLE_CLAIM));
  mocks.poll
    .mockResolvedValueOnce(
      AsyncResult.success({
        status: "claimed",
        expiresAt: SAMPLE_CLAIM.expiresAt,
      }),
    )
    .mockResolvedValueOnce(
      AsyncResult.success({
        status: "approved",
        grantExpiresAt: IsoDateTime.make("2026-11-27T19:00:00.000Z"),
        credential: "one-time-grant-token",
      }),
    );
  mocks.complete.mockResolvedValue(AsyncResult.success(EnvironmentId.make("env-studio")));

  const onClose = vi.fn();
  const onConnected = vi.fn();

  await using _screen = await render(
    <PairingInviteDialog invite={SAMPLE_INVITE} onClose={onClose} onConnected={onConnected} />,
  );
  using _timers = fakeTimers({ now: BASE_TIME });

  await expect.element(page.getByText("Studio Mac")).toBeVisible();
  await expect.element(page.getByText("http://192.168.1.44:3773")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Cancel" })).toHaveFocus();

  await userEvent.click(page.getByRole("button", { name: "Continue" }));

  await expect
    .element(page.getByTestId("pairing-invite-verification-code"))
    .toHaveTextContent("482-910");
  await expect.element(page.getByText("Studio Mac (Verified)")).toBeVisible();
  await expect.element(page.getByText("Expires in 3:00")).toBeVisible();

  await vi.advanceTimersByTimeAsync(PAIRING_INVITE_POLL_INTERVAL_MS);
  expect(mocks.poll).toHaveBeenCalledTimes(1);
  await expect.element(page.getByText("Expires in 2:59")).toBeVisible();

  await vi.advanceTimersByTimeAsync(PAIRING_INVITE_POLL_INTERVAL_MS);
  await vi.waitFor(() => {
    expect(mocks.complete).toHaveBeenCalledWith(
      {
        httpBaseUrl: SAMPLE_CLAIM.httpBaseUrl,
        environmentId: SAMPLE_CLAIM.environmentId,
        environmentLabel: SAMPLE_CLAIM.environmentLabel,
        credential: "one-time-grant-token",
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  expect(onConnected).toHaveBeenCalledWith(EnvironmentId.make("env-studio"), SAMPLE_CLAIM.inviteId);
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(mocks.toastAdd).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "success",
      title: "Environment connected",
    }),
  );
});

it("shows terminal messages for denied and expired invites without retrying", async () => {
  setup();
  mocks.claim.mockResolvedValue(AsyncResult.success(SAMPLE_CLAIM));
  mocks.poll.mockResolvedValueOnce(AsyncResult.success({ status: "denied" }));

  const onClose = vi.fn();
  await using screen = await render(
    <PairingInviteDialog invite={SAMPLE_INVITE} onClose={onClose} />,
  );
  using _timers = fakeTimers({ now: BASE_TIME });

  await userEvent.click(page.getByRole("button", { name: "Continue" }));
  await expect.element(page.getByTestId("pairing-invite-verification-code")).toBeVisible();

  await vi.advanceTimersByTimeAsync(PAIRING_INVITE_POLL_INTERVAL_MS);
  await expect
    .element(page.getByText("This pairing request was denied on your other device."))
    .toBeVisible();
  await expect.element(page.getByRole("button", { name: "Try again" })).not.toBeInTheDocument();

  // Switching to a new invite resets back to confirm and handles expiration cleanly.
  mocks.poll.mockResolvedValueOnce(AsyncResult.success({ status: "expired" }));
  await screen.rerender(
    <PairingInviteDialog invite={{ ...SAMPLE_INVITE, inviteId: "inv_test_2" }} onClose={onClose} />,
  );
  await expect.element(page.getByRole("button", { name: "Continue" })).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Continue" }));
  await expect.element(page.getByTestId("pairing-invite-verification-code")).toBeVisible();

  await vi.advanceTimersByTimeAsync(PAIRING_INVITE_POLL_INTERVAL_MS);
  await expect
    .element(
      page.getByText("This pairing invite expired. Start a new invite from your other device."),
    )
    .toBeVisible();
});

it("offers Try again on a transient claim error and retries cleanly", async () => {
  setup();
  mocks.claim
    .mockResolvedValueOnce(
      AsyncResult.failure(
        Cause.fail(
          new ConnectionTransientError({
            reason: "transport",
            detail: "Host unreachable",
          }),
        ),
      ),
    )
    .mockResolvedValueOnce(AsyncResult.success(SAMPLE_CLAIM));

  await using _screen = await render(
    <PairingInviteDialog invite={SAMPLE_INVITE} onClose={vi.fn()} />,
  );
  using _timers = fakeTimers({ now: BASE_TIME });

  await userEvent.click(page.getByRole("button", { name: "Continue" }));
  await expect.element(page.getByText("Host unreachable")).toBeVisible();

  await userEvent.click(page.getByRole("button", { name: "Try again" }));
  await expect
    .element(page.getByTestId("pairing-invite-verification-code"))
    .toHaveTextContent("482-910");
  expect(mocks.claim).toHaveBeenCalledTimes(2);
});

it("does not offer Try again on a permanent blocked claim error or expired invite", async () => {
  setup();
  mocks.claim.mockResolvedValueOnce(
    AsyncResult.failure(
      Cause.fail(
        new ConnectionBlockedError({
          reason: "configuration",
          detail: "Invite belongs to a different machine.",
        }),
      ),
    ),
  );

  const onClose = vi.fn();
  await using screen = await render(
    <PairingInviteDialog invite={SAMPLE_INVITE} onClose={onClose} />,
  );
  using _timers = fakeTimers({ now: BASE_TIME });

  await userEvent.click(page.getByRole("button", { name: "Continue" }));
  await expect.element(page.getByText("Invite belongs to a different machine.")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Try again" })).not.toBeInTheDocument();

  await screen.rerender(
    <PairingInviteDialog
      invite={{
        ...SAMPLE_INVITE,
        inviteId: "inv_expired_1",
        expiresAt: "2026-11-27T17:59:00.000Z",
      }}
      onClose={onClose}
    />,
  );
  await userEvent.click(page.getByRole("button", { name: "Continue" }));
  await expect
    .element(
      page.getByText("This pairing invite expired. Start a new invite from your other device."),
    )
    .toBeVisible();
  expect(mocks.claim).toHaveBeenCalledTimes(1);
});

it("resets back to confirm when cancelled during claiming and re-opened with the same invite", async () => {
  setup();
  let claimSignal: AbortSignal | undefined;
  mocks.claim.mockImplementation(
    (_input, call) =>
      new Promise(() => {
        claimSignal = call?.signal;
      }),
  );

  const onClose = vi.fn();
  await using screen = await render(
    <PairingInviteDialog invite={SAMPLE_INVITE} onClose={onClose} />,
  );
  using _timers = fakeTimers({ now: BASE_TIME });

  await userEvent.click(page.getByRole("button", { name: "Continue" }));
  await expect.element(page.getByText("Requesting verification code…")).toBeVisible();
  expect(claimSignal?.aborted).toBe(false);

  await userEvent.click(page.getByRole("button", { name: "Cancel" }));
  expect(claimSignal?.aborted).toBe(true);
  expect(onClose).toHaveBeenCalledTimes(1);

  await screen.rerender(<PairingInviteDialog invite={null} onClose={onClose} />);
  await screen.rerender(<PairingInviteDialog invite={SAMPLE_INVITE} onClose={onClose} />);

  await expect.element(page.getByRole("button", { name: "Continue" })).toBeVisible();
  await expect.element(page.getByText("Requesting verification code…")).not.toBeInTheDocument();
});

it("recovers from transient poll errors and stops after consecutive failures", async () => {
  setup();
  const transientError = new ConnectionTransientError({
    reason: "transport",
    detail: "Relay timed out",
  });
  mocks.claim.mockResolvedValue(AsyncResult.success(SAMPLE_CLAIM));
  mocks.poll
    .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(transientError)))
    .mockResolvedValueOnce(
      AsyncResult.success({
        status: "approved",
        grantExpiresAt: IsoDateTime.make("2026-11-27T19:00:00.000Z"),
        credential: "recovered-grant",
      }),
    );
  mocks.complete.mockResolvedValue(AsyncResult.success(EnvironmentId.make("env-studio")));

  const onClose = vi.fn();
  const onConnected = vi.fn();
  await using screen = await render(
    <PairingInviteDialog invite={SAMPLE_INVITE} onClose={onClose} onConnected={onConnected} />,
  );
  using _timers = fakeTimers({ now: BASE_TIME });

  await userEvent.click(page.getByRole("button", { name: "Continue" }));
  await expect.element(page.getByTestId("pairing-invite-verification-code")).toBeVisible();

  await vi.advanceTimersByTimeAsync(PAIRING_INVITE_POLL_INTERVAL_MS);
  expect(mocks.poll).toHaveBeenCalledTimes(1);
  await expect.element(page.getByTestId("pairing-invite-verification-code")).toBeVisible();

  await vi.advanceTimersByTimeAsync(PAIRING_INVITE_POLL_INTERVAL_MS);
  await vi.waitFor(() => {
    expect(mocks.complete).toHaveBeenCalledTimes(1);
  });
  expect(onConnected).toHaveBeenCalledWith(EnvironmentId.make("env-studio"), SAMPLE_CLAIM.inviteId);

  // Exceeding consecutive transient errors transitions to terminal error.
  mocks.poll.mockReset();
  mocks.poll.mockResolvedValue(AsyncResult.failure(Cause.fail(transientError)));
  await screen.rerender(
    <PairingInviteDialog
      invite={{ ...SAMPLE_INVITE, inviteId: "inv_flaky_2" }}
      onClose={onClose}
    />,
  );
  await userEvent.click(page.getByRole("button", { name: "Continue" }));
  await expect.element(page.getByTestId("pairing-invite-verification-code")).toBeVisible();

  for (let attempt = 0; attempt < PAIRING_INVITE_MAX_CONSECUTIVE_POLL_ERRORS; attempt += 1) {
    await vi.advanceTimersByTimeAsync(PAIRING_INVITE_POLL_INTERVAL_MS);
  }
  await expect.element(page.getByText("Relay timed out")).toBeVisible();
  expect(mocks.poll).toHaveBeenCalledTimes(PAIRING_INVITE_MAX_CONSECUTIVE_POLL_ERRORS);
});

it("offers working Try again when completePairingInvite fails transiently", async () => {
  setup();
  mocks.claim.mockResolvedValue(AsyncResult.success(SAMPLE_CLAIM));
  mocks.poll.mockResolvedValueOnce(
    AsyncResult.success({
      status: "approved",
      grantExpiresAt: IsoDateTime.make("2026-11-27T19:00:00.000Z"),
      credential: "unspent-dpop-grant",
    }),
  );
  mocks.complete
    .mockResolvedValueOnce(
      AsyncResult.failure(
        Cause.fail(
          new ConnectionTransientError({
            reason: "transport",
            detail: "Token exchange timed out",
          }),
        ),
      ),
    )
    .mockResolvedValueOnce(AsyncResult.success(EnvironmentId.make("env-studio")));

  const onClose = vi.fn();
  const onConnected = vi.fn();
  await using _screen = await render(
    <PairingInviteDialog invite={SAMPLE_INVITE} onClose={onClose} onConnected={onConnected} />,
  );
  using _timers = fakeTimers({ now: BASE_TIME });

  await userEvent.click(page.getByRole("button", { name: "Continue" }));
  await expect.element(page.getByTestId("pairing-invite-verification-code")).toBeVisible();

  await vi.advanceTimersByTimeAsync(PAIRING_INVITE_POLL_INTERVAL_MS);
  await expect.element(page.getByText("Token exchange timed out")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Try again" })).toBeVisible();
  expect(mocks.claim).toHaveBeenCalledTimes(1);
  expect(mocks.complete).toHaveBeenCalledTimes(1);

  await userEvent.click(page.getByRole("button", { name: "Try again" }));
  await vi.waitFor(() => {
    expect(mocks.complete).toHaveBeenCalledTimes(2);
  });
  expect(mocks.claim).toHaveBeenCalledTimes(1);
  expect(mocks.complete).toHaveBeenLastCalledWith(
    {
      httpBaseUrl: SAMPLE_CLAIM.httpBaseUrl,
      environmentId: SAMPLE_CLAIM.environmentId,
      environmentLabel: SAMPLE_CLAIM.environmentLabel,
      credential: "unspent-dpop-grant",
    },
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(onConnected).toHaveBeenCalledWith(EnvironmentId.make("env-studio"), SAMPLE_CLAIM.inviteId);
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("aborts polling and closes cleanly when Cancel is clicked while waiting", async () => {
  setup();
  mocks.claim.mockResolvedValue(AsyncResult.success(SAMPLE_CLAIM));
  let pollSignal: AbortSignal | undefined;
  mocks.poll.mockImplementation(
    (_input, call) =>
      new Promise(() => {
        pollSignal = call?.signal;
      }),
  );

  const onClose = vi.fn();
  await using screen = await render(
    <PairingInviteDialog invite={SAMPLE_INVITE} onClose={onClose} />,
  );
  using _timers = fakeTimers({ now: BASE_TIME });

  await userEvent.click(page.getByRole("button", { name: "Continue" }));
  await expect.element(page.getByTestId("pairing-invite-verification-code")).toBeVisible();

  await vi.advanceTimersByTimeAsync(PAIRING_INVITE_POLL_INTERVAL_MS);
  expect(mocks.poll).toHaveBeenCalledTimes(1);
  expect(pollSignal?.aborted).toBe(false);

  await userEvent.click(page.getByRole("button", { name: "Cancel" }));
  expect(onClose).toHaveBeenCalledTimes(1);

  await screen.rerender(<PairingInviteDialog invite={null} onClose={onClose} />);
  expect(pollSignal?.aborted).toBe(true);

  await vi.advanceTimersByTimeAsync(PAIRING_INVITE_POLL_INTERVAL_MS * 3);
  expect(mocks.poll).toHaveBeenCalledTimes(1);
});
