import {
  isListedThreadLineage,
  type EnvironmentId,
  type ScopedThreadRef,
  type ThreadId,
} from "@ankielcode/contracts";
import {
  foldSearchQuery,
  rankSearchItems,
  scoreThreadSearch,
} from "@ankielcode/shared/paletteSearch";

import type { EnvironmentThreadShell } from "./state/models.ts";
import { threadSearchSubject, type ThreadSearchShell } from "./state/threadSearch.ts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

const COMPOSER_THREAD_RESULT_LIMIT = 5;

export type ComposerThreadCandidate = ThreadSearchShell &
  Pick<EnvironmentThreadShell, "archivedAt" | "lineage">;

export interface ComposerThreadItem {
  readonly id: string;
  readonly type: "thread";
  readonly thread: ScopedThreadRef;
  readonly label: string;
  readonly description: string;
}

/**
 * Threads to reference from the composer, matched and ranked like the command
 * palette, without subagent threads or other threads' side chats. The agent reads threads
 * only on its own server, so candidates stay within it.
 */
export function matchComposerThreadItems(
  input: {
    shells: ReadonlyArray<ComposerThreadCandidate>;
    environmentId: EnvironmentId;
    excludeThreadId: ThreadId | null;
    query: string;
    /** Recency is measured against this time. */
    now: number;
  },
  resolve: MFunctionType = mFallback,
): ComposerThreadItem[] {
  const query = foldSearchQuery(input.query);
  if (query.length === 0) return [];
  // Closing an unused side chat deletes it, so only one with a message is offered.
  const isOwnSideChat = (shell: ComposerThreadCandidate) =>
    shell.lineage.sideChat === true &&
    shell.environmentId === input.environmentId &&
    shell.lineage.parentThreadId === input.excludeThreadId &&
    shell.latestUserMessageAt !== null;
  const candidates = input.shells.filter(
    (shell) =>
      shell.environmentId === input.environmentId &&
      shell.id !== input.excludeThreadId &&
      shell.archivedAt === null &&
      (isListedThreadLineage(shell.lineage) || isOwnSideChat(shell)),
  );
  return rankSearchItems(candidates, (shell, options) =>
    scoreThreadSearch(query, threadSearchSubject(shell, null), input.now, {
      ...options,
      picks: false,
    }),
  )
    .slice(0, COMPOSER_THREAD_RESULT_LIMIT)
    .map(({ item: shell }) => ({
      id: `thread:${shell.environmentId}:${shell.id}`,
      type: "thread",
      thread: { environmentId: shell.environmentId, threadId: shell.id },
      label: shell.title,
      description: isOwnSideChat(shell)
        ? resolve(msg("Side chat"))
        : resolve(msg("Thread", { $context: "noun, search result type" })),
    }));
}
