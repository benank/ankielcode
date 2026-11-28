import "~/index.css";

import type { ConnectionOnboarding } from "@ankielcode/client-runtime/connection";
import { EnvironmentId, IsoDateTime } from "@ankielcode/contracts";
import {
  buildPairingInviteAppLink,
  encodePairingInviteFile,
  PAIRING_INVITE_MAX_FILE_BYTES,
  PAIRING_INVITE_MIME_TYPE,
} from "@ankielcode/shared/remote";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import type { EnvironmentPresentation } from "~/state/environments";
import { AddEnvironmentDialog } from "./AddEnvironmentDialog";

const mocks = vi.hoisted(() => ({
  connectPairing: vi.fn(),
  connectSsh: vi.fn(),
  claim:
    vi.fn<
      (
        input: ConnectionOnboarding.PairingInviteClaimInput,
      ) => Promise<AsyncResult.AsyncResult<ConnectionOnboarding.PairingInviteClaimResult, unknown>>
    >(),
  poll: vi.fn(),
  complete: vi.fn(),
  toastAdd: vi.fn(),
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: { readonly label: string }) => (value: unknown) => {
    if (command.label === "web:connection:connect-pairing") {
      return mocks.connectPairing(value);
    }
    if (command.label === "web:connection:connect-ssh") {
      return mocks.connectSsh(value);
    }
    if (command.label === "web:connection:claim-pairing-invite") {
      return mocks.claim(value as ConnectionOnboarding.PairingInviteClaimInput);
    }
    if (command.label === "web:connection:poll-pairing-invite-claim") {
      return mocks.poll(value);
    }
    if (command.label === "web:connection:complete-pairing-invite") {
      return mocks.complete(value);
    }
    throw new Error(`Unexpected command: ${command.label}`);
  },
}));

vi.mock("~/state/server", () => ({
  primaryServerKeybindingsAtom: Atom.make([]),
}));

vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({
    data: null,
    error: null,
    isPending: false,
    isSuccess: false,
    refresh: vi.fn(),
  }),
}));

vi.mock("../ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: {
    add: (...args: unknown[]) => mocks.toastAdd(...args),
  },
}));

function Harness({
  routeTarget = null,
}: {
  readonly routeTarget?: EnvironmentPresentation | null;
}) {
  const [open, setOpen] = useState(true);
  const [error, setError] = useState<string | null>(null);
  return (
    <AddEnvironmentDialog
      open={open}
      routeTarget={routeTarget}
      error={error}
      savedEnvironments={[]}
      onOpenChange={setOpen}
      onErrorChange={setError}
    />
  );
}

function setup() {
  mocks.connectPairing.mockReset();
  mocks.connectSsh.mockReset();
  mocks.claim.mockReset();
  mocks.poll.mockReset();
  mocks.complete.mockReset();
  mocks.toastAdd.mockReset();
}

it("hands off a pasted ankielcode://pair-invite link to PairingInviteDialog with expectedEnvironmentId", async () => {
  setup();
  const routeTarget = {
    environmentId: EnvironmentId.make("env-existing"),
    label: "Studio Mac",
  } as unknown as EnvironmentPresentation;

  const inviteLink = buildPairingInviteAppLink({
    version: 1,
    inviteId: "inv_pasted_1",
    environmentId: "env-existing",
    baseUrl: "https://studio.ts.net/",
    label: "Studio Mac",
  });

  mocks.claim.mockResolvedValue(
    AsyncResult.success({
      inviteId: "inv_pasted_1",
      environmentId: EnvironmentId.make("env-existing"),
      environmentLabel: "Studio Mac",
      httpBaseUrl: "https://studio.ts.net/",
      verificationCode: "731-049",
      expiresAt: IsoDateTime.make("2026-11-27T18:05:00.000Z"),
    }),
  );

  await using _screen = await render(<Harness routeTarget={routeTarget} />);

  await userEvent.fill(page.getByPlaceholder("backend.example.com"), inviteLink);
  await userEvent.click(page.getByRole("button", { name: "Add route" }));

  expect(mocks.connectPairing).not.toHaveBeenCalled();
  await expect.element(page.getByText("Add environment route")).toBeVisible();
  await expect.element(page.getByText("https://studio.ts.net")).toBeVisible();

  await userEvent.click(page.getByRole("button", { name: "Continue" }));
  expect(mocks.claim).toHaveBeenCalledWith({
    invite: expect.objectContaining({
      inviteId: "inv_pasted_1",
      environmentId: "env-existing",
      baseUrl: "https://studio.ts.net/",
    }),
    expectedEnvironmentId: EnvironmentId.make("env-existing"),
  });
});

it("imports a valid .ankielpair file and rejects invalid or oversized files", async () => {
  setup();
  await using _screen = await render(<Harness />);
  await expect.element(page.getByRole("button", { name: "Import .ankielpair file" })).toBeVisible();

  const getFileInput = () => {
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("Missing .ankielpair file input");
    return input;
  };

  // Oversized file is rejected before decoding.
  const oversized = new File(["x".repeat(PAIRING_INVITE_MAX_FILE_BYTES + 1)], "huge.ankielpair", {
    type: PAIRING_INVITE_MIME_TYPE,
  });
  await userEvent.upload(getFileInput(), oversized);
  await expect.element(page.getByText("That pairing invite file is too large.")).toBeVisible();

  // Invalid JSON content is rejected cleanly.
  const invalid = new File(['{"version":999}'], "broken.ankielpair", {
    type: PAIRING_INVITE_MIME_TYPE,
  });
  await userEvent.upload(getFileInput(), invalid);
  await expect.element(page.getByText("That file is not a valid pairing invite.")).toBeVisible();

  // Valid .ankielpair file hands off to PairingInviteDialog.
  const validRaw = encodePairingInviteFile({
    version: 1,
    inviteId: "inv_airdrop_1",
    environmentId: "env-airdrop",
    baseUrl: "https://airdrop.example.ts.net/",
    label: "AirDropped Mac",
  });
  const valid = new File([validRaw], "studio.ankielpair", {
    type: PAIRING_INVITE_MIME_TYPE,
  });
  await userEvent.upload(getFileInput(), valid);

  await expect.element(page.getByText("Connect environment")).toBeVisible();
  await expect.element(page.getByText("AirDropped Mac")).toBeVisible();
  await expect.element(page.getByText("https://airdrop.example.ts.net")).toBeVisible();
});
