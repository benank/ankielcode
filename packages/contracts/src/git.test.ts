import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  GitCommandError,
  GitRunStackedActionInput,
  GitRunStackedActionResult,
  VcsCreateWorktreeInput,
  VcsRef,
  VcsStatusRemoteResult,
} from "./git.ts";
import { WorktreeMcpHandoffInput } from "./worktreeMcp.ts";
import { ReviewDiffFileContentsInput } from "./review.ts";

const encodeVcsRef = Schema.encodeUnknownSync(VcsRef);
const decodeVcsRef = Schema.decodeUnknownSync(VcsRef);
const encodeCreateWorktreeInput = Schema.encodeUnknownSync(VcsCreateWorktreeInput);
const decodeCreateWorktreeInput = Schema.decodeUnknownSync(VcsCreateWorktreeInput);
const decodeWorktreeHandoffInput = Schema.decodeUnknownSync(WorktreeMcpHandoffInput);
const decodeGitCommandError = Schema.decodeUnknownSync(Schema.toCodecJson(GitCommandError));
const decodeRemoteStatus = Schema.decodeUnknownSync(VcsStatusRemoteResult);
const encodeRemoteStatus = Schema.encodeUnknownSync(VcsStatusRemoteResult);
const decodeRunStackedActionInput = Schema.decodeUnknownSync(GitRunStackedActionInput);
const decodeRunStackedActionResult = Schema.decodeUnknownSync(GitRunStackedActionResult);
const encodeRunStackedActionInput = Schema.encodeUnknownSync(GitRunStackedActionInput);
const decodeReviewDiffFileContentsInput = Schema.decodeUnknownSync(ReviewDiffFileContentsInput);
const encodeReviewDiffFileContentsInput = Schema.encodeUnknownSync(ReviewDiffFileContentsInput);

describe("GitCommandError", () => {
  it("decodes an unknown failure reason as absent", () => {
    const error = decodeGitCommandError({
      _tag: "GitCommandError",
      operation: "GitVcsDriver.createWorktree",
      command: "git",
      cwd: "/repo",
      detail: "git worktree add failed",
      reason: "added_by_a_newer_server",
    });

    expect(error.reason).toBeUndefined();
    expect(error.message).toBe(
      "Git command failed in GitVcsDriver.createWorktree (/repo): git worktree add failed",
    );
  });
});

describe("retired pull request fields", () => {
  const remote = { hasUpstream: true, aheadCount: 0, behindCount: 0 };

  it("reads an older server's status pull request as null and still sends the key", () => {
    const parsed = decodeRemoteStatus({
      ...remote,
      pr: {
        number: 1,
        title: "Fix",
        url: "https://github.com/owner/repo/pull/1",
        baseRef: "main",
        headRef: "fix",
        state: "open",
      },
    });
    expect(parsed.pr).toBeNull();
    expect(encodeRemoteStatus(parsed)).toEqual({ ...remote, pr: null });
  });

  it("reads an older server's pull request push result without its pull request parts", () => {
    const result = decodeRunStackedActionResult({
      action: "push",
      branch: { status: "skipped_not_requested" },
      commit: { status: "skipped_not_requested" },
      push: { status: "pushed", branch: "fix" },
      pr: { status: "opened_existing", url: "https://github.com/owner/repo/pull/1", number: 1 },
      toast: {
        title: "Pushed fix",
        cta: { kind: "open_pr", label: "View PR", url: "https://github.com/owner/repo/pull/1" },
      },
    });
    expect(result.pr).toEqual({ status: "skipped_not_requested" });
    expect(result.toast.cta).toEqual({ kind: "none" });
    expect(
      decodeRunStackedActionResult({
        ...result,
        toast: {
          title: "Pushed",
          cta: { kind: "run_action", label: "Create PR", action: { kind: "create_pr" } },
        },
      }).toast.cta,
    ).toEqual({ kind: "none" });
  });

  it("still decodes the pull request actions older clients send", () => {
    expect(
      decodeRunStackedActionInput({ actionId: "action-1", cwd: "/repo", action: "create_pr" })
        .action,
    ).toBe("create_pr");
  });
});

describe("Git file paths", () => {
  it.each([
    {
      operation: "commit",
      decode: decodeRunStackedActionInput,
      encode: encodeRunStackedActionInput,
      input: {
        actionId: "action-1",
        cwd: "/repo",
        action: "commit",
        filePaths: [" leading.txt", "trailing.txt "],
      },
    },
    {
      operation: "local diff expansion",
      decode: decodeReviewDiffFileContentsInput,
      encode: encodeReviewDiffFileContentsInput,
      input: {
        cwd: "/repo",
        sourceKind: "working-tree",
        changeType: "rename-changed",
        baseRef: "HEAD",
        headRef: null,
        oldPath: " leading.txt",
        newPath: "trailing.txt ",
      },
    },
  ])("preserves leading and trailing whitespace for $operation", ({ decode, encode, input }) => {
    expect(decode(input)).toEqual(input);
    expect(encode(input)).toEqual(input);
  });
});

describe("Git ref names", () => {
  it.each(["origin/release/v2\u3000", "\u00a0release", "\u3000"])(
    "keeps Unicode whitespace at the edges of %j across the wire",
    (name) => {
      const ref = { name, upstreamRef: `refs/remotes/${name}`, current: false, isDefault: false };
      const wireRef = encodeVcsRef({ ...ref, worktreePath: null });
      expect(decodeVcsRef(wireRef)).toMatchObject(ref);

      const input = { cwd: "/repo", refName: name, newRefName: name, baseRefName: name };
      const wireInput = encodeCreateWorktreeInput({ ...input, path: null });
      expect(decodeCreateWorktreeInput(wireInput)).toMatchObject(input);

      const handoff = { branch: name, baseRef: name, startFromOrigin: true };
      expect(decodeWorktreeHandoffInput(handoff)).toEqual(handoff);
    },
  );

  it("still trims ASCII whitespace and rejects a blank name", () => {
    expect(
      decodeCreateWorktreeInput({ cwd: "/repo", refName: " \tmain\n", path: null }).refName,
    ).toBe("main");
    expect(() => decodeCreateWorktreeInput({ cwd: "/repo", refName: " \t", path: null })).toThrow();
  });
});
