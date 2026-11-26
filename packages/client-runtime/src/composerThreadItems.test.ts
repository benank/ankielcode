import { EnvironmentId, ThreadId } from "@ankielcode/contracts";
import { expect, it } from "vite-plus/test";

import { matchComposerThreadItems, type ComposerThreadCandidate } from "./composerThreadItems.ts";

const environmentId = EnvironmentId.make("env-composer");

function shell(
  id: string,
  title: string,
  overrides: Partial<ComposerThreadCandidate> = {},
): ComposerThreadCandidate {
  return {
    environmentId,
    id: ThreadId.make(id),
    title,
    branch: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    latestUserMessageAt: null,
    opens: null,
    archivedAt: null,
    lineage: { rootThreadId: ThreadId.make(id), parentThreadId: null, relationshipToParent: null },
    ...overrides,
  };
}

it("ranks thread mentions like the palette and leaves out subagent threads", () => {
  const items = matchComposerThreadItems({
    shells: [
      shell("newer-mid-word", "Remodel the settings page", {
        updatedAt: "2026-10-20T00:00:00.000Z",
      }),
      shell("word", "Fix model picker"),
      shell("subagent", "Model review", {
        lineage: {
          rootThreadId: ThreadId.make("word"),
          parentThreadId: ThreadId.make("word"),
          relationshipToParent: "subagent",
        },
      }),
      shell("other-environment", "Model docs", { environmentId: EnvironmentId.make("env-other") }),
    ],
    environmentId,
    excludeThreadId: null,
    query: "model",
    now: Date.parse("2026-10-23T00:00:00.000Z"),
  });
  expect(items.map((item) => item.thread.threadId)).toEqual(["word", "newer-mid-word"]);
});

it("offers the composer thread's own used side chats, but not other threads' side chats", () => {
  const sideChatOf = (parent: string) => ({
    rootThreadId: ThreadId.make(parent),
    parentThreadId: ThreadId.make(parent),
    relationshipToParent: "fork" as const,
    sideChat: true,
  });
  const latestUserMessageAt = "2026-10-22T00:00:00.000Z";
  const items = matchComposerThreadItems({
    shells: [
      shell("mine", "Why is the build slow?", { lineage: sideChatOf("main"), latestUserMessageAt }),
      shell("unused", "Slow side chat", { lineage: sideChatOf("main") }),
      shell("theirs", "Why is the test slow?", {
        lineage: sideChatOf("other"),
        latestUserMessageAt,
      }),
    ],
    environmentId,
    excludeThreadId: ThreadId.make("main"),
    query: "slow",
    now: Date.parse("2026-10-23T00:00:00.000Z"),
  });
  expect(items.map(({ thread, description }) => ({ id: thread.threadId, description }))).toEqual([
    { id: "mine", description: "Side chat" },
  ]);
});
