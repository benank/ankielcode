import type {
  GitRunStackedActionInput,
  GitStackedAction,
  VcsStatusResult,
} from "@ankielcode/contracts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

export type GitActionIconName = "commit" | "push";

export type GitDialogAction = "commit" | "push";

export interface GitActionMenuItem {
  id: "commit" | "push";
  label: string;
  disabled: boolean;
  icon: GitActionIconName;
  kind: "open_dialog";
  dialogAction: GitDialogAction;
}

export interface GitQuickAction {
  label: string;
  disabled: boolean;
  kind: "run_action" | "run_pull" | "show_hint";
  action?: GitStackedAction;
  hint?: string;
}

export interface DefaultBranchActionDialogCopy {
  title: string;
  description: string;
  continueLabel: string;
}

export type DefaultBranchConfirmableAction = "push" | "commit_push";

export type GitActionRequestInput = Pick<
  GitRunStackedActionInput,
  "commitMessage" | "featureBranch" | "filePaths"
> & { readonly action: GitStackedAction };

export function buildMenuItems(
  gitStatus: VcsStatusResult | null,
  isBusy: boolean,
  hasOriginRemote = true,
  resolve: MFunctionType = mFallback,
): GitActionMenuItem[] {
  if (!gitStatus) return [];

  const hasBranch = gitStatus.refName !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const isBehind = gitStatus.behindCount > 0;
  const canPushWithoutUpstream = hasOriginRemote && !gitStatus.hasUpstream;
  const canCommit = !isBusy && hasChanges;
  const canPush =
    !isBusy &&
    hasBranch &&
    !hasChanges &&
    !isBehind &&
    gitStatus.aheadCount > 0 &&
    (gitStatus.hasUpstream || canPushWithoutUpstream);

  return [
    {
      id: "commit",
      label: resolve(msg("Commit", { $context: "verb, git action" })),
      disabled: !canCommit,
      icon: "commit",
      kind: "open_dialog",
      dialogAction: "commit",
    },
    {
      id: "push",
      label: resolve(msg("Push", { $context: "verb, git action" })),
      disabled: !canPush,
      icon: "push",
      kind: "open_dialog",
      dialogAction: "push",
    },
  ];
}

export function resolveQuickAction(
  gitStatus: VcsStatusResult | null,
  isBusy: boolean,
  hasOriginRemote = true,
  resolve: MFunctionType = mFallback,
): GitQuickAction {
  if (isBusy) {
    return {
      label: resolve(msg("Commit", { $context: "verb, git action" })),
      disabled: true,
      kind: "show_hint",
      hint: resolve(msg("Git action in progress.")),
    };
  }

  if (!gitStatus) {
    return {
      label: resolve(msg("Commit", { $context: "verb, git action" })),
      disabled: true,
      kind: "show_hint",
      hint: resolve(msg("Git status is unavailable.")),
    };
  }

  const hasBranch = gitStatus.refName !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const isAhead = gitStatus.aheadCount > 0;
  const isBehind = gitStatus.behindCount > 0;

  if (!hasBranch) {
    return {
      label: resolve(msg("Commit", { $context: "verb, git action" })),
      disabled: true,
      kind: "show_hint",
      hint: resolve(msg("Create and checkout a branch before pushing.")),
    };
  }

  if (hasChanges) {
    if (isBehind || (!gitStatus.hasUpstream && !hasOriginRemote)) {
      return {
        label: resolve(msg("Commit", { $context: "verb, git action" })),
        disabled: false,
        kind: "run_action",
        action: "commit",
      };
    }
    return {
      label: resolve(msg("Commit & push")),
      disabled: false,
      kind: "run_action",
      action: "commit_push",
    };
  }

  if (!gitStatus.hasUpstream) {
    if (!hasOriginRemote) {
      return {
        label: resolve(msg("Push", { $context: "verb, git action" })),
        disabled: true,
        kind: "show_hint",
        hint: resolve(msg('Add an "origin" remote before pushing.')),
      };
    }
    if (!isAhead) {
      return {
        label: resolve(msg("Push", { $context: "verb, git action" })),
        disabled: true,
        kind: "show_hint",
        hint: resolve(msg("No local commits to push.")),
      };
    }
    return {
      label: resolve(msg("Push", { $context: "verb, git action" })),
      disabled: false,
      kind: "run_action",
      action: "push",
    };
  }

  if (isAhead && isBehind) {
    return {
      label: resolve(msg("Sync branch")),
      disabled: true,
      kind: "show_hint",
      hint: resolve(msg("Branch has diverged from upstream. Rebase/merge first.")),
    };
  }

  if (isBehind) {
    return {
      label: resolve(msg("Pull", { $context: "verb, git action" })),
      disabled: false,
      kind: "run_pull",
    };
  }

  if (isAhead) {
    return {
      label: resolve(msg("Push", { $context: "verb, git action" })),
      disabled: false,
      kind: "run_action",
      action: "push",
    };
  }

  return {
    label: resolve(msg("Commit", { $context: "verb, git action" })),
    disabled: true,
    kind: "show_hint",
    hint: resolve(msg("Branch is up to date. No action needed.")),
  };
}

export function getGitActionDisabledReason(
  input: {
    item: GitActionMenuItem;
    gitStatus: VcsStatusResult | null;
    isBusy: boolean;
    hasOriginRemote: boolean;
  },
  resolve: MFunctionType = mFallback,
): string | null {
  const { item, gitStatus, isBusy, hasOriginRemote } = input;
  if (!item.disabled) return null;
  if (isBusy) return resolve(msg("Git action in progress."));
  if (!gitStatus) return resolve(msg("Git status is unavailable."));

  if (item.id === "commit") {
    if (!gitStatus.hasWorkingTreeChanges) {
      return resolve(msg("Worktree is clean. Make changes before committing."));
    }
    return resolve(msg("Commit is currently unavailable."));
  }

  if (gitStatus.refName === null) {
    return resolve(msg("Detached HEAD: checkout a branch before pushing."));
  }
  if (gitStatus.hasWorkingTreeChanges) {
    return resolve(msg("Commit or stash local changes before pushing."));
  }
  if (gitStatus.behindCount > 0) {
    return resolve(msg("Branch is behind upstream. Pull/rebase before pushing."));
  }
  if (!gitStatus.hasUpstream && !hasOriginRemote) {
    return resolve(msg('Add an "origin" remote before pushing.'));
  }
  if (gitStatus.aheadCount <= 0) {
    return resolve(msg("No local commits to push."));
  }
  return resolve(msg("Push is currently unavailable."));
}

export function requiresDefaultBranchConfirmation(
  action: GitStackedAction,
  isDefaultBranch: boolean,
): action is DefaultBranchConfirmableAction {
  return isDefaultBranch && (action === "push" || action === "commit_push");
}

export function resolveDefaultBranchActionDialogCopy(
  input: {
    action: DefaultBranchConfirmableAction;
    branchName: string;
    includesCommit: boolean;
  },
  resolve: MFunctionType = mFallback,
): DefaultBranchActionDialogCopy {
  const branchLabel = input.branchName;
  if (input.includesCommit) {
    return {
      title: resolve(msg("Commit & push to default branch?")),
      description: resolve(
        msg(
          'This action will commit and push changes on "{branch}". You can continue on this branch or create a feature branch and run the same action there.',
          { branch: branchLabel },
        ),
      ),
      continueLabel: resolve(msg("Commit & push to {branch}", { branch: branchLabel })),
    };
  }
  return {
    title: resolve(msg("Push to default branch?")),
    description: resolve(
      msg(
        'This action will push local commits on "{branch}". You can continue on this branch or create a feature branch and run the same action there.',
        { branch: branchLabel },
      ),
    ),
    continueLabel: resolve(msg("Push to {branch}", { branch: branchLabel })),
  };
}
