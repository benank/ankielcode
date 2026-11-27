import * as QuickActions from "expo-quick-actions";
import { Platform } from "react-native";
import type { NavigationState } from "@react-navigation/native";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@ankielcode/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "../../connection/catalog";
import { appIntents } from "../../native/appIntents";
import {
  loadRecentThreadShortcuts,
  saveRecentThreadShortcuts,
  type RecentThreadShortcut,
} from "../../persistence/imperative";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentShell } from "../../state/shell";
import { environmentThreadShells } from "../../state/threads";
import {
  activeThreadRef,
  allowedShortcutHref,
  buildDonatedThreads,
  buildShortcutActions,
  recentThreadKey,
  shortcutHref,
  withRecentThreadShortcut,
} from "./appShortcuts";

export interface RecentThreadShortcutsDependencies {
  readonly load: () => Promise<ReadonlyArray<RecentThreadShortcut>>;
  readonly save: (recents: ReadonlyArray<RecentThreadShortcut>) => Promise<void>;
  readonly publish: (recents: ReadonlyArray<RecentThreadShortcut>) => Promise<void>;
}

export interface RecentThreadPresence {
  readonly key: string;
  readonly inShell: boolean;
  readonly missingFromLiveShell: boolean;
}

/**
 * Keeps the launcher's recent-thread list. Recording waits for the persisted
 * list so the first thread opened after a cold start cannot clobber older
 * entries, and a failed load never persists its empty fallback over valid
 * history until a real thread open makes the in-memory list the new truth.
 */
function createRecentThreadShortcuts(dependencies: RecentThreadShortcutsDependencies) {
  let recents: ReadonlyArray<RecentThreadShortcut> | null = null;
  let persistable = false;
  let active: RecentThreadShortcut | null = null;
  let savedEnvironmentIds: ReadonlySet<string> | null = null;
  // Shells leave out older settled threads, so a thread missing from one proves nothing. One a
  // shell held and then lost while live was archived or deleted, and stays out until it returns.
  const heldThreads = new Set<string>();
  const departedThreads = new Set<string>();
  // Serialize saves so older lists cannot overwrite newer ones.
  let saveQueue: Promise<unknown> = Promise.resolve();

  const commit = (next: ReadonlyArray<RecentThreadShortcut>) => {
    recents = next;
    if (persistable) {
      saveQueue = saveQueue.then(
        () =>
          dependencies.save(next).catch((error: unknown) => {
            console.warn("[app-shortcuts] failed to persist recent threads", error);
          }),
        () => undefined,
      );
    }
    publish(next);
  };

  const publish = (list: ReadonlyArray<RecentThreadShortcut>) => {
    void dependencies.publish(list).catch((error: unknown) => {
      console.warn("[app-shortcuts] failed to update launcher shortcuts", error);
    });
  };

  const isSaved = (thread: RecentThreadShortcut) =>
    savedEnvironmentIds?.has(thread.environmentId) ?? true;

  const withActive = (list: ReadonlyArray<RecentThreadShortcut>) => {
    if (active === null || !isSaved(active) || departedThreads.has(recentThreadKey(active))) {
      return list;
    }
    const next = withRecentThreadShortcut(list, active);
    if (next !== list) persistable = true;
    return next;
  };

  const loaded = dependencies.load().then(
    (threads) => {
      persistable = true;
      commit(withActive(threads.filter(isSaved)));
    },
    (error: unknown) => {
      console.warn("[app-shortcuts] failed to load recent threads", error);
      commit(withActive([]));
    },
  );

  return {
    loaded,
    /** Resolves once every save issued so far has finished. */
    saved: () => saveQueue,
    recordActiveThread(next: RecentThreadShortcut | null): void {
      active = next;
      if (recents === null || next === null) return;
      const updated = withActive(recents);
      if (updated !== recents) commit(updated);
    },
    retainEnvironments(next: ReadonlySet<string>): void {
      savedEnvironmentIds = next;
      if (recents === null) return;
      const kept = recents.filter(isSaved);
      if (kept.length !== recents.length) commit(kept);
    },
    observePresence(presences: ReadonlyArray<RecentThreadPresence>): void {
      for (const presence of presences) {
        if (presence.inShell) {
          heldThreads.add(presence.key);
          departedThreads.delete(presence.key);
        } else if (presence.missingFromLiveShell && heldThreads.delete(presence.key)) {
          departedThreads.add(presence.key);
        }
      }
      if (recents === null || departedThreads.size === 0) return;
      const kept = recents.filter((thread) => !departedThreads.has(recentThreadKey(thread)));
      if (kept.length !== recents.length) commit(kept);
    },
    /** Publishes the current list again, for titles that follow the UI language. */
    republish(): void {
      if (recents !== null) publish(recents);
    },
  };
}

let installedRecents: ReturnType<typeof createRecentThreadShortcuts> | null = null;

export function republishAppShortcuts(): void {
  installedRecents?.republish();
}

const activeThreadRefAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:app-shortcuts-active-thread-ref"),
);

const recentThreadsAtom = Atom.make<ReadonlyArray<RecentThreadShortcut>>([]).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:app-shortcuts-recent-threads"),
);

const activeThreadShortcutAtom = Atom.make((get): RecentThreadShortcut | null => {
  const ref = get(activeThreadRefAtom);
  if (ref === null) return null;
  const title = get(environmentThreadShells.quietThreadShellAtom(ref))?.title ?? "";
  return { environmentId: ref.environmentId, threadId: ref.threadId, title };
}).pipe(
  Atom.withEquality(
    (left: RecentThreadShortcut | null, right: RecentThreadShortcut | null) =>
      left === right ||
      (left !== null &&
        right !== null &&
        left.environmentId === right.environmentId &&
        left.threadId === right.threadId &&
        left.title === right.title),
  ),
);

function scopedThreadRef(thread: RecentThreadShortcut): ScopedThreadRef | null {
  try {
    return {
      environmentId: EnvironmentId.make(thread.environmentId),
      threadId: ThreadId.make(thread.threadId),
    };
  } catch {
    return null;
  }
}

interface ShellThreadsState {
  readonly status: string;
  readonly snapshot: Option.Option<{ readonly threads: ReadonlyArray<{ readonly id: string }> }>;
}

function createRecentThreadPresenceAtom(input: {
  readonly threadsAtom: Atom.Atom<ReadonlyArray<RecentThreadShortcut>>;
  readonly quietThreadShellAtom: (ref: ScopedThreadRef) => Atom.Atom<object | null>;
  readonly shellStateAtom: (environmentId: EnvironmentId) => Atom.Atom<ShellThreadsState>;
}) {
  return Atom.make((get): ReadonlyArray<RecentThreadPresence> =>
    get(input.threadsAtom).flatMap((thread): RecentThreadPresence[] => {
      const ref = scopedThreadRef(thread);
      if (ref === null) return [];
      const key = recentThreadKey(thread);
      if (get(input.quietThreadShellAtom(ref)) !== null) {
        return [{ key, inShell: true, missingFromLiveShell: false }];
      }
      // Status and threads must come from one emission; a reset shell can pair a stale "live" with
      // an empty thread index.
      const shell = get(input.shellStateAtom(ref.environmentId));
      const snapshot = Option.getOrNull(shell.snapshot);
      const missingFromLiveShell =
        shell.status === "live" &&
        snapshot !== null &&
        !snapshot.threads.some((candidate) => candidate.id === ref.threadId);
      return [{ key, inShell: false, missingFromLiveShell }];
    }),
  );
}

const recentThreadPresenceAtom = createRecentThreadPresenceAtom({
  threadsAtom: Atom.make((get) => {
    const active = get(activeThreadShortcutAtom);
    const recent = get(recentThreadsAtom);
    return active === null ? recent : [active, ...recent];
  }),
  quietThreadShellAtom: environmentThreadShells.quietThreadShellAtom,
  shellStateAtom: environmentShell.stateValueAtom,
});

const supportsRecentThreads = Platform.OS === "android" || appIntents !== null;

/** Wired to the root navigation container's state changes. */
export function recordAppShortcutNavigationState(state: NavigationState): void {
  if (!supportsRecentThreads) return;
  const next = activeThreadRef(state);
  const current = appAtomRegistry.get(activeThreadRefAtom);
  if (next?.environmentId === current?.environmentId && next?.threadId === current?.threadId) {
    return;
  }
  appAtomRegistry.set(activeThreadRefAtom, next);
}

/**
 * App-lifetime quick actions. `navigate` must queue until navigation is ready:
 * a cold-start shortcut arrives as the launch action, and pushing it over the
 * initial Home route makes back return home instead of exiting the app.
 */
export function installAppShortcuts(navigate: (href: string) => void): () => void {
  const initialHref = QuickActions.initial ? shortcutHref(QuickActions.initial) : null;
  if (initialHref !== null) navigate(initialHref);
  const subscription = QuickActions.addListener((action) => {
    const href = shortcutHref(action);
    if (href !== null) navigate(href);
  });
  // iOS App Shortcuts and Spotlight taps usually arrive before JS runs, so native keeps the latest.
  const takeAppIntentPath = () => {
    const href = allowedShortcutHref(appIntents?.takePendingPath());
    if (href !== null) navigate(href);
  };
  const appIntentSubscription = appIntents?.addListener("onPendingPath", takeAppIntentPath);
  takeAppIntentPath();
  const removeLaunchListeners = () => {
    subscription.remove();
    appIntentSubscription?.remove();
  };
  if (!supportsRecentThreads) return removeLaunchListeners;

  const recents = createRecentThreadShortcuts({
    load: loadRecentThreadShortcuts,
    save: saveRecentThreadShortcuts,
    publish: async (list) => {
      appAtomRegistry.set(recentThreadsAtom, list);
      if (Platform.OS === "android") {
        await QuickActions.setItems(buildShortcutActions(list));
      } else {
        appIntents?.setRecentThreads(buildDonatedThreads(list));
      }
    },
  });
  installedRecents = recents;
  const unsubscribe = appAtomRegistry.subscribe(
    activeThreadShortcutAtom,
    (active) => recents.recordActiveThread(active),
    { immediate: true },
  );
  const unsubscribePresence = appAtomRegistry.subscribe(
    recentThreadPresenceAtom,
    (presences) => recents.observePresence(presences),
    { immediate: true },
  );
  const unsubscribeCatalog = appAtomRegistry.subscribe(
    environmentCatalog.catalogValueAtom,
    (catalog) => {
      if (catalog.isReady) recents.retainEnvironments(new Set(catalog.entries.keys()));
    },
    { immediate: true },
  );
  return () => {
    if (installedRecents === recents) installedRecents = null;
    removeLaunchListeners();
    unsubscribe();
    unsubscribePresence();
    unsubscribeCatalog();
  };
}
