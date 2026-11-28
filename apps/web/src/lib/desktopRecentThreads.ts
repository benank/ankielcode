import type { EnvironmentThreadShell } from "@ankielcode/client-runtime/state/models";
import { threadLastUsedAt } from "@ankielcode/client-runtime/state/thread-search";
import { isShownUnderParent } from "@ankielcode/client-runtime/state/threads";
import {
  DESKTOP_RECENT_THREADS_LIMIT,
  type DesktopBridge,
  type DesktopRecentThread,
} from "@ankielcode/contracts";
import type { AtomRegistry } from "effect/reactivity";

import type { AppRouter } from "../router";
import { environmentThreadShells } from "../state/threads";

const PUBLISH_DELAY_MS = 1000;
const TITLE_MAX_LENGTH = 200;

/**
 * Recent by the palette's rule: last written in or opened. Untitled threads have nothing to
 * show, and subagent threads and side chats open from their parent.
 */
function selectRecentThreads(
  shells: ReadonlyArray<EnvironmentThreadShell>,
  limit = DESKTOP_RECENT_THREADS_LIMIT,
): DesktopRecentThread[] {
  return shells
    .flatMap((shell) => {
      const title = shell.title.trim();
      if (shell.archivedAt !== null || title.length === 0 || isShownUnderParent(shell.lineage)) {
        return [];
      }
      return [{ shell, title, usedAt: threadLastUsedAt(shell) }];
    })
    .toSorted((left, right) => right.usedAt - left.usedAt)
    .slice(0, limit)
    .map(({ shell, title }) => ({
      environmentId: shell.environmentId,
      threadId: shell.id,
      title: title.slice(0, TITLE_MAX_LENGTH),
    }));
}

const listKey = (threads: ReadonlyArray<DesktopRecentThread>) =>
  JSON.stringify(threads.map((thread) => [thread.environmentId, thread.threadId, thread.title]));

/**
 * Coalesces changes into one read `delayMs` after the first, and sends the list only when it
 * differs from the last one sent. A streaming thread changes shells constantly, so the timer
 * is not restarted by later changes: it would never fire.
 */
function createRecentThreadsPublisher(input: {
  readonly read: () => ReadonlyArray<DesktopRecentThread>;
  readonly send: (threads: ReadonlyArray<DesktopRecentThread>) => Promise<void>;
  readonly delayMs?: number;
}) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let sentKey: string | null = null;
  const publish = () => {
    timer = null;
    const threads = input.read();
    const key = listKey(threads);
    if (key === sentKey) return;
    sentKey = key;
    input.send(threads).catch(() => {
      // Sending again on the next change is better than leaving the menu stale.
      if (sentKey === key) sentKey = null;
    });
  };
  return {
    schedule(): void {
      timer ??= setTimeout(publish, input.delayMs ?? PUBLISH_DELAY_MS);
    },
    dispose(): void {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}

/** Keeps the desktop dock menu (macOS) and jump list (Windows) on the recent threads. */
export function startDesktopRecentThreads(
  bridge: Pick<DesktopBridge, "setRecentThreads"> | undefined,
  registry: AtomRegistry.AtomRegistry,
  router: AppRouter,
): () => void {
  const send = bridge?.setRecentThreads;
  if (!send) return () => {};
  const publisher = createRecentThreadsPublisher({
    read: () => selectRecentThreads(registry.get(environmentThreadShells.quietThreadShellsAtom)),
    send,
  });
  const unsubscribeShells = registry.subscribe(
    environmentThreadShells.quietThreadShellsAtom,
    publisher.schedule,
    { immediate: true },
  );
  // Opening a thread bumps only this client's open time, which no shell carries.
  const unsubscribeRouter = router.subscribe("onResolved", publisher.schedule);
  return () => {
    unsubscribeShells();
    unsubscribeRouter();
    publisher.dispose();
  };
}
