import "~/index.css";

import type { ConnectionOnboarding } from "@ankielcode/client-runtime/connection";
import {
  EnvironmentId,
  IsoDateTime,
  type AuthPairingInviteClaimStatus,
} from "@ankielcode/contracts";
import { buildPairingAppLink, buildPairingInviteAppLink } from "@ankielcode/shared/remote";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { fakeTimers, render } from "../../../test/render";
import { PAIRING_INVITE_POLL_INTERVAL_MS } from "../settings/PairingInviteDialog.logic";
import { DesktopWebLinkCoordinator } from "./DesktopWebLinkCoordinator";

const mocks = vi.hoisted(() => ({
  localEnvironmentDisabled: true,
  requestConfirmDialog: vi.fn<(...args: unknown[]) => Promise<boolean | undefined>>(),
  claim:
    vi.fn<
      (
        input: ConnectionOnboarding.PairingInviteClaimInput,
      ) => Promise<AsyncResult.AsyncResult<ConnectionOnboarding.PairingInviteClaimResult, unknown>>
    >(),
  poll: vi.fn<
    (
      input: ConnectionOnboarding.PairingInvitePollInput,
    ) => Promise<AsyncResult.AsyncResult<AuthPairingInviteClaimStatus, unknown>>
  >(),
  complete:
    vi.fn<
      (
        input: ConnectionOnboarding.PairingInviteCompleteInput,
      ) => Promise<AsyncResult.AsyncResult<EnvironmentId, unknown>>
    >(),
  connectPairing: vi.fn(),
  toastAdd: vi.fn(),
}));

vi.mock("../../localEnvironment", () => ({
  isLocalEnvironmentDisabled: () => mocks.localEnvironmentDisabled,
}));

vi.mock("../../confirmDialog", () => ({
  requestConfirmDialog: (...args: unknown[]) => mocks.requestConfirmDialog(...args),
}));

vi.mock("../../state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/environments")>()),
  usePrimaryEnvironment: () => null,
  useEnvironmentHttpBaseUrl: () => null,
}));

vi.mock("../../hooks/useHandleNewThread", () => ({
  useNewThreadHandler: () => vi.fn(),
}));

vi.mock("../../hooks/useScratchProject", () => ({
  useScratchProject: () => ({
    scratchEnvironmentId: () => null,
    openScratchProject: vi.fn(),
  }),
}));

vi.mock("../../lib/openCommitLink", () => ({
  useOpenCommitLink: () => () => false,
}));

vi.mock("../../state/use-atom-query-runner", () => ({
  useAtomQueryRunner: () => vi.fn(),
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { readonly label: string }) => (value: unknown) => {
    if (command.label === "web:connection:claim-pairing-invite") {
      return mocks.claim(value as ConnectionOnboarding.PairingInviteClaimInput);
    }
    if (command.label === "web:connection:poll-pairing-invite-claim") {
      return mocks.poll(value as ConnectionOnboarding.PairingInvitePollInput);
    }
    if (command.label === "web:connection:complete-pairing-invite") {
      return mocks.complete(value as ConnectionOnboarding.PairingInviteCompleteInput);
    }
    if (command.label === "web:connection:connect-pairing") {
      return mocks.connectPairing(value);
    }
    return Promise.resolve(AsyncResult.success(undefined));
  },
}));

vi.mock("../ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: {
    add: (...args: unknown[]) => mocks.toastAdd(...args),
  },
}));

function installWebLinksBridge() {
  const previous = window.desktopBridge;
  let listener: ((url: string) => void) | null = null;
  const setReady = vi.fn(() => Promise.resolve());
  window.desktopBridge = {
    webLinks: {
      onOpen: (nextListener: (url: string) => void) => {
        listener = nextListener;
        return () => {
          if (listener === nextListener) listener = null;
        };
      },
      setReady,
    },
  } as unknown as NonNullable<typeof window.desktopBridge>;

  return {
    emit(url: string) {
      listener?.(url);
    },
    setReady,
    [Symbol.dispose]() {
      if (previous === undefined) {
        delete window.desktopBridge;
      } else {
        window.desktopBridge = previous;
      }
    },
  };
}

function setup() {
  mocks.localEnvironmentDisabled = true;
  mocks.requestConfirmDialog.mockReset();
  mocks.claim.mockReset();
  mocks.poll.mockReset();
  mocks.complete.mockReset();
  mocks.connectPairing.mockReset();
  mocks.toastAdd.mockReset();
}

it("routes ankielcode://pair-invite links to PairingInviteDialog and ignores completed invites", async () => {
  setup();
  using bridge = installWebLinksBridge();
  const inviteLink = buildPairingInviteAppLink({
    version: 1,
    inviteId: "inv_handoff_1",
    environmentId: "env-macbook",
    baseUrl: "https://macbook.example.ts.net/",
    label: "Work MacBook",
  });

  mocks.claim.mockResolvedValue(
    AsyncResult.success({
      inviteId: "inv_handoff_1",
      environmentId: EnvironmentId.make("env-macbook"),
      environmentLabel: "Work MacBook",
      httpBaseUrl: "https://macbook.example.ts.net/",
      verificationCode: "519-204",
      expiresAt: IsoDateTime.make("2026-11-27T18:05:00.000Z"),
    }),
  );
  mocks.poll.mockResolvedValue(
    AsyncResult.success({
      status: "approved",
      grantExpiresAt: IsoDateTime.make("2026-11-27T19:00:00.000Z"),
      credential: "handoff-grant",
    }),
  );
  mocks.complete.mockResolvedValue(AsyncResult.success(EnvironmentId.make("env-macbook")));

  await using _screen = await render(<DesktopWebLinkCoordinator />);
  using _timers = fakeTimers({ now: new Date("2026-11-27T18:00:00.000Z") });

  await vi.waitFor(() => {
    expect(bridge.setReady).toHaveBeenCalledWith(true);
  });

  bridge.emit(inviteLink);
  await expect.element(page.getByText("Work MacBook")).toBeVisible();
  await expect.element(page.getByText("https://macbook.example.ts.net")).toBeVisible();
  expect(mocks.requestConfirmDialog).not.toHaveBeenCalled();

  await userEvent.click(page.getByRole("button", { name: "Continue" }));
  await expect
    .element(page.getByTestId("pairing-invite-verification-code"))
    .toHaveTextContent("519-204");

  await vi.advanceTimersByTimeAsync(PAIRING_INVITE_POLL_INTERVAL_MS);
  await vi.waitFor(() => {
    expect(mocks.complete).toHaveBeenCalledTimes(1);
  });
  await expect.element(page.getByText("Work MacBook")).not.toBeInTheDocument();

  // Re-sending the same completed inviteId is ignored.
  bridge.emit(inviteLink);
  await vi.advanceTimersByTimeAsync(50);
  await expect.element(page.getByText("Work MacBook")).not.toBeInTheDocument();
});

it("ignores a second pair-invite link while a pairing dialog is already open", async () => {
  setup();
  using bridge = installWebLinksBridge();
  const firstInviteLink = buildPairingInviteAppLink({
    version: 1,
    inviteId: "inv_first_1",
    environmentId: "env-first",
    baseUrl: "https://first.example.ts.net/",
    label: "First Mac",
  });
  const secondInviteLink = buildPairingInviteAppLink({
    version: 1,
    inviteId: "inv_second_2",
    environmentId: "env-second",
    baseUrl: "https://second.example.ts.net/",
    label: "Second Mac",
  });

  await using _screen = await render(<DesktopWebLinkCoordinator />);
  await vi.waitFor(() => {
    expect(bridge.setReady).toHaveBeenCalledWith(true);
  });

  bridge.emit(firstInviteLink);
  await expect.element(page.getByText("First Mac")).toBeVisible();

  bridge.emit(secondInviteLink);
  await expect.element(page.getByText("First Mac")).toBeVisible();
  await expect.element(page.getByText("Second Mac")).not.toBeInTheDocument();

  await userEvent.click(page.getByRole("button", { name: "Cancel" }));
  await expect.element(page.getByText("First Mac")).not.toBeInTheDocument();

  bridge.emit(secondInviteLink);
  await expect.element(page.getByText("Second Mac")).toBeVisible();
});

it("still routes legacy ankielcode://pair links through the confirm dialog", async () => {
  setup();
  using bridge = installWebLinksBridge();
  mocks.requestConfirmDialog.mockResolvedValue(false);

  await using _screen = await render(<DesktopWebLinkCoordinator />);
  await vi.waitFor(() => {
    expect(bridge.setReady).toHaveBeenCalledWith(true);
  });

  bridge.emit(buildPairingAppLink("https://legacy.example.com/pair#token=PAIR123"));
  await vi.waitFor(() => {
    expect(mocks.requestConfirmDialog).toHaveBeenCalledWith(
      "Add the backend at https://legacy.example.com?",
      expect.objectContaining({ focusCancel: true }),
    );
  });
});
