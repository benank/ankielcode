import { RuntimeRequestId } from "@ankielcode/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import type { PendingApproval } from "../../session-logic";
import { ComposerBanner } from "./ComposerBanner";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";

const commandApproval: PendingApproval = {
  requestId: RuntimeRequestId.make("command-approval"),
  requestKind: "command",
  createdAt: "2026-11-24T19:00:00.000Z",
  detail: "git status -sb",
  reason: "Needs permission to run the command",
  fullAccessOverride: "ask_rule",
  options: [
    { decision: "accept", label: "Allow once" },
    {
      decision: "acceptForSession",
      label: "Allow for this thread",
      warning: "Untrusted files could re-run this action without asking.",
    },
    { decision: "decline", label: "Deny" },
    { decision: "cancel", label: "Cancel" },
  ],
  responseCapability: "live",
};

it("renders command approval as a popup card with full command, warning, and action buttons", async () => {
  const onRespondToApproval = vi.fn(async () => {});
  await using screen = await render(
    <ComposerBanner.Root density="spacious">
      <ComposerPendingApprovalPanel
        approval={commandApproval}
        pendingCount={2}
        isResponding={false}
        onRespondToApproval={onRespondToApproval}
      />
    </ComposerBanner.Root>,
  );

  await expect.element(screen.getByRole("group", { name: "Command approval" })).toBeVisible();
  await expect.element(screen.getByText("1/2")).toBeVisible();
  await expect
    .element(screen.getByLabelText("Command", { exact: true }))
    .toHaveTextContent("git status -sb");
  await expect.element(screen.getByText("Needs permission to run the command")).toBeVisible();
  await expect
    .element(screen.getByText("Untrusted files could re-run this action without asking."))
    .toBeVisible();

  await screen.getByRole("button", { name: "Why am I being asked this?" }).click();
  await expect.element(page.getByText(/an ask rule in the agent's own settings/)).toBeVisible();

  await screen.getByRole("button", { name: "Allow once", exact: true }).click();
  expect(onRespondToApproval).toHaveBeenLastCalledWith(commandApproval.requestId, "accept");

  await screen.getByRole("button", { name: "Allow for this thread", exact: true }).click();
  expect(onRespondToApproval).toHaveBeenLastCalledWith(
    commandApproval.requestId,
    "acceptForSession",
  );

  await screen.getByRole("button", { name: "Deny", exact: true }).click();
  expect(onRespondToApproval).toHaveBeenLastCalledWith(commandApproval.requestId, "decline");

  await screen.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(onRespondToApproval).toHaveBeenLastCalledWith(commandApproval.requestId, "cancel");
});

it("disables controls while responding or read-only and hides actions when not resumable", async () => {
  const onRespondToApproval = vi.fn(async () => {});
  const renderCard = (overrides: {
    approval?: PendingApproval;
    disabled?: boolean;
    isResponding?: boolean;
  }) => (
    <ComposerBanner.Root density="spacious">
      <ComposerPendingApprovalPanel
        approval={overrides.approval ?? commandApproval}
        pendingCount={1}
        disabled={overrides.disabled ?? false}
        isResponding={overrides.isResponding ?? false}
        onRespondToApproval={onRespondToApproval}
      />
    </ComposerBanner.Root>
  );

  await using screen = await render(renderCard({ disabled: true }));
  await expect
    .element(screen.getByRole("button", { name: "Allow once", exact: true }))
    .toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "Deny", exact: true })).toBeDisabled();

  await screen.rerender(renderCard({ isResponding: true }));
  await expect
    .element(screen.getByRole("button", { name: "Allow once", exact: true }))
    .toBeDisabled();

  await screen.rerender(
    renderCard({
      approval: { ...commandApproval, detail: "", responseCapability: "not_resumable" },
    }),
  );
  await expect
    .element(screen.getByLabelText("Command", { exact: true }))
    .toHaveTextContent("Command approval");
  await expect
    .element(screen.getByText("Provider process is gone. Interrupt or restart the run to respond."))
    .toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Allow once", exact: true }))
    .not.toBeInTheDocument();
});
