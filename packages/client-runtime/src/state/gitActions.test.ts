import { type VcsStatusResult } from "@ankielcode/contracts";
import { describe, expect, it } from "vite-plus/test";

import { sourceControlClients } from "../sourceControlClients.ts";
import {
  buildMenuItems,
  getGitActionDisabledReason,
  resolveDefaultBranchActionDialogCopy,
  resolveQuickAction,
} from "./gitActions.ts";

function status(overrides: Partial<VcsStatusResult> = {}): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature/test",
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  };
}

const openPr = {
  number: 7,
  title: "Feature",
  url: "https://example.com/pr/7",
  baseRef: "main",
  headRef: "feature/test",
  state: "open" as const,
};

describe("git action copy", () => {
  it("says PR for a GitHub ref", () => {
    expect(resolveQuickAction(status({ aheadCount: 1 }), false).label).toBe("Push & create PR");
    expect(resolveQuickAction(status({ pr: openPr }), false).label).toBe("View PR");
    const [, , prItem] = buildMenuItems(status(), false);
    expect(prItem?.label).toBe("Create PR");
    expect(
      getGitActionDisabledReason({
        item: prItem!,
        gitStatus: status(),
        isBusy: false,
        hasOriginRemote: true,
      }),
    ).toBe("No local commits to include in a PR.");
  });

  it("offers creating a PR after the feature branch has been fully pushed", () => {
    const pushed = status({ aheadCount: 0, behindCount: 0, aheadOfDefaultCount: 1 });
    expect(resolveQuickAction(pushed, false)).toMatchObject({
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    });
    expect(resolveQuickAction({ ...pushed, isDefaultRef: true }, false, true).disabled).toBe(true);
  });

  it.each([
    { tracking: "with an upstream", hasUpstream: true },
    { tracking: "without an upstream", hasUpstream: false },
  ])("pushes existing commits from a clean default branch $tracking", ({ hasUpstream }) => {
    const cleanDefaultBranch = status({
      refName: "main",
      isDefaultRef: true,
      hasUpstream,
      aheadCount: 1,
    });
    expect(resolveQuickAction(cleanDefaultBranch, false, true)).toMatchObject({
      disabled: false,
      kind: "run_action",
      action: "push",
    });
  });

  it("names the host's change request in the default-branch dialog", () => {
    const input = { action: "commit_push_pr", branchName: "main", includesCommit: true } as const;
    expect(
      resolveDefaultBranchActionDialogCopy({
        ...input,
        terminology: sourceControlClients.get("github").changeRequest,
      }).title,
    ).toBe("Commit, push & create PR from default branch?");
  });
});
