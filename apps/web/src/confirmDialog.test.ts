import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  completeConfirmDialogClose,
  readConfirmDialogState,
  requestConfirmDialog,
  resetConfirmDialogForTests,
  respondToConfirmDialog,
  subscribeConfirmDialogHost,
} from "./confirmDialog";

const mountHost = () => subscribeConfirmDialogHost(() => {});
const deleteOptions = { confirmLabel: "Delete", destructive: true } as const;
const continueOptions = { confirmLabel: "Continue", destructive: false } as const;

function requireConfirmation(confirmation: Promise<boolean> | undefined): Promise<boolean> {
  if (!confirmation) {
    throw new Error("Expected a registered confirmation host.");
  }
  return confirmation;
}

describe("confirm dialog coordinator", () => {
  beforeEach(() => {
    resetConfirmDialogForTests();
  });

  it("serializes concurrent confirmations", async () => {
    const unregister = mountHost();
    const first = requireConfirmation(
      requestConfirmDialog("Archive the project?", { confirmLabel: "Archive", destructive: false }),
    );
    const second = requireConfirmation(
      requestConfirmDialog("Delete the worktree too?", deleteOptions),
    );

    respondToConfirmDialog(false);
    await expect(first).resolves.toBe(false);
    expect(readConfirmDialogState()).toEqual({
      status: "closing",
      message: "Archive the project?",
      confirmLabel: "Archive",
      destructive: false,
    });

    completeConfirmDialogClose();
    expect(readConfirmDialogState()).toEqual({
      status: "confirming",
      message: "Delete the worktree too?",
      confirmLabel: "Delete",
      destructive: true,
    });

    respondToConfirmDialog(true);
    await expect(second).resolves.toBe(true);
    completeConfirmDialogClose();
    expect(readConfirmDialogState()).toEqual({ status: "idle" });
    unregister();
  });

  it("cancels active and queued confirmations if the last host unmounts", async () => {
    const unregister = mountHost();
    const active = requireConfirmation(requestConfirmDialog("Delete the thread?", deleteOptions));
    const queued = requireConfirmation(
      requestConfirmDialog("Delete the worktree too?", deleteOptions),
    );

    unregister();

    await expect(Promise.all([active, queued])).resolves.toEqual([false, false]);
    expect(readConfirmDialogState()).toEqual({ status: "idle" });
  });

  it("has no host until one subscribes", () => {
    expect(requestConfirmDialog("Continue?", continueOptions)).toBeUndefined();
    const unsubscribe = mountHost();
    expect(requestConfirmDialog("Continue?", continueOptions)).toBeDefined();
    unsubscribe();
    expect(requestConfirmDialog("Continue?", continueOptions)).toBeUndefined();
  });

  it("requires every caller to name the action and say whether it is destructive", () => {
    // @ts-expect-error the options are required
    expect(requestConfirmDialog("Continue?")).toBeUndefined();
    // @ts-expect-error confirmLabel is required
    expect(requestConfirmDialog("Continue?", { destructive: false })).toBeUndefined();
    // @ts-expect-error destructive is required
    expect(requestConfirmDialog("Continue?", { confirmLabel: "Continue" })).toBeUndefined();
  });

  it("ignores responses after the active dialog has been closed", () => {
    const unregister = mountHost();
    const confirmation = requireConfirmation(requestConfirmDialog("Continue?", continueOptions));

    respondToConfirmDialog(true);
    respondToConfirmDialog(false);
    completeConfirmDialogClose();

    expect(readConfirmDialogState()).toEqual({ status: "idle" });
    unregister();
    return expect(confirmation).resolves.toBe(true);
  });
});
