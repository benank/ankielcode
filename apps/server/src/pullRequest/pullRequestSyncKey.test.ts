import { ProjectId, SourceControlProviderKind } from "@ankielcode/contracts";
import { describe, expect, it } from "vite-plus/test";

import { pullRequestSyncKey } from "./pullRequestSyncKey.ts";

describe("pullRequestSyncKey", () => {
  const reference = { projectId: ProjectId.make("project"), repository: "acme/web", number: 7 };

  it("takes a hostless reference's host from the project's checkout", () => {
    const identity = {
      canonicalKey: "github.com/acme/web",
      provider: SourceControlProviderKind.make("github"),
      displayName: "acme/web",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "https://github.com/acme/web.git",
      },
    };
    expect(pullRequestSyncKey(reference, identity)).toEqual({
      host: "github.com",
      repository: "acme/web",
      number: 7,
    });
  });

  it("keys a hosted reference without a checkout, and nothing without a host", () => {
    expect(pullRequestSyncKey({ ...reference, host: "github.com" })).toEqual({
      host: "github.com",
      repository: "acme/web",
      number: 7,
    });
    expect(pullRequestSyncKey(reference)).toBeNull();
  });
});
