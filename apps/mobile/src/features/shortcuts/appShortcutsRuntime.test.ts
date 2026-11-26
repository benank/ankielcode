import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo-quick-actions", () => ({}));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("../../connection/catalog", () => ({}));
vi.mock("../../native/appIntents", () => ({ appIntents: null }));
vi.mock("../../persistence/imperative", () => ({}));
vi.mock("../../state/atom-registry", () => ({}));
vi.mock("../../state/shell", () => ({ environmentShell: {} }));
vi.mock("../../state/threads", () => ({ environmentThreadShells: {} }));
vi.mock("./appShortcuts", async () => {
  const { recentThreadKey, withRecentThreadShortcut } =
    await vi.importActual<typeof import("./appShortcuts")>("./appShortcuts");
  return { recentThreadKey, withRecentThreadShortcut };
});

import type { RecentThreadShortcut } from "../../persistence/imperative";
import {
  createRecentThreadPresenceAtom,
  createRecentThreadShortcuts,
  type RecentThreadPresence,
} from "./appShortcutsRuntime";

const thread = (threadId: string, title = threadId): RecentThreadShortcut => ({
  environmentId: "env",
  threadId,
  title,
});

const presence = (threadId: string, inShell: boolean, shellLive = true): RecentThreadPresence => ({
  key: `/threads/env/${threadId}`,
  inShell,
  missingFromLiveShell: !inShell && shellLive,
});

function setup(load: () => Promise<ReadonlyArray<RecentThreadShortcut>>) {
  const save = vi.fn<(list: ReadonlyArray<RecentThreadShortcut>) => Promise<void>>(() =>
    Promise.resolve(),
  );
  const publish = vi.fn<(list: ReadonlyArray<RecentThreadShortcut>) => Promise<void>>(() =>
    Promise.resolve(),
  );
  return { save, publish, recents: createRecentThreadShortcuts({ load, save, publish }) };
}

describe("createRecentThreadShortcuts", () => {
  it("waits for the persisted list before recording the open thread", async () => {
    const { save, publish, recents } = setup(() => Promise.resolve([thread("old")]));
    recents.recordActiveThread(thread("new"));
    expect(publish).not.toHaveBeenCalled();
    await recents.loaded;
    await recents.saved();
    expect(publish).toHaveBeenLastCalledWith([thread("new"), thread("old")]);
    expect(save).toHaveBeenLastCalledWith([thread("new"), thread("old")]);
  });

  it("does not persist the empty fallback after a failed load", async () => {
    using _warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { save, publish, recents } = setup(() => Promise.reject(new Error("read failed")));
    await recents.loaded;
    await recents.saved();
    expect(publish).toHaveBeenLastCalledWith([]);
    expect(save).not.toHaveBeenCalled();

    recents.recordActiveThread(thread("a"));
    await recents.saved();
    expect(save).toHaveBeenLastCalledWith([thread("a")]);
  });

  it("drops threads of environments that are no longer saved", async () => {
    const gone = { environmentId: "gone", threadId: "b", title: "b" };
    const kept = { environmentId: "kept", threadId: "c", title: "c" };
    const { save, publish, recents } = setup(() => Promise.resolve([thread("a"), gone, kept]));
    recents.retainEnvironments(new Set(["env", "kept"]));
    await recents.loaded;
    expect(publish).toHaveBeenLastCalledWith([thread("a"), kept]);

    recents.retainEnvironments(new Set(["kept"]));
    await recents.saved();
    expect(publish).toHaveBeenLastCalledWith([kept]);
    expect(save).toHaveBeenLastCalledWith([kept]);

    recents.recordActiveThread(thread("a"));
    expect(publish).toHaveBeenLastCalledWith([kept]);
  });

  it("records title changes of the open thread and ignores repeats", async () => {
    const { publish, recents } = setup(() => Promise.resolve([]));
    await recents.loaded;
    recents.recordActiveThread(thread("a", ""));
    recents.recordActiveThread(thread("a", "Named"));
    recents.recordActiveThread(thread("a", "Named"));
    recents.recordActiveThread(null);
    expect(publish.mock.calls.map(([list]) => list)).toEqual([
      [],
      [thread("a", "")],
      [thread("a", "Named")],
    ]);
  });

  it("drops a thread the live shell lost, and only that", async () => {
    const { save, publish, recents } = setup(() =>
      Promise.resolve([thread("archived"), thread("older-settled"), thread("kept")]),
    );
    await recents.loaded;
    recents.observePresence([
      presence("archived", true, false),
      presence("older-settled", false),
      presence("kept", true),
    ]);
    // A cached shell losing a thread is not proof; a live one is.
    recents.observePresence([presence("archived", false, false), presence("kept", true)]);
    expect(publish).toHaveBeenLastCalledWith([
      thread("archived"),
      thread("older-settled"),
      thread("kept"),
    ]);

    recents.observePresence([presence("archived", false), presence("older-settled", false)]);
    await recents.saved();
    expect(publish).toHaveBeenLastCalledWith([thread("older-settled"), thread("kept")]);
    expect(save).toHaveBeenLastCalledWith([thread("older-settled"), thread("kept")]);
  });

  it("keeps a departed open thread out until a shell holds it again", async () => {
    const { publish, recents } = setup(() => Promise.resolve([]));
    await recents.loaded;
    recents.recordActiveThread(thread("a", "Named"));
    recents.observePresence([presence("a", true)]);
    recents.observePresence([presence("a", false)]);
    recents.recordActiveThread(thread("a", ""));
    expect(publish).toHaveBeenLastCalledWith([]);

    recents.observePresence([presence("a", true)]);
    recents.recordActiveThread(thread("a", "Named"));
    expect(publish).toHaveBeenLastCalledWith([thread("a", "Named")]);
  });
});

describe("createRecentThreadPresenceAtom", () => {
  type Shell = {
    readonly status: string;
    readonly snapshot: Option.Option<{ readonly threads: ReadonlyArray<{ readonly id: string }> }>;
  };
  const liveShell = (...ids: string[]): Shell => ({
    status: "live",
    snapshot: Option.some({ threads: ids.map((id) => ({ id })) }),
  });

  function setupPresence(initial: { readonly quiet: object | null; readonly shell: Shell }) {
    const registry = AtomRegistry.make();
    const quiet = Atom.make<object | null>(initial.quiet);
    const shell = Atom.make<Shell>(initial.shell);
    const presence = createRecentThreadPresenceAtom({
      threadsAtom: Atom.make([thread("a")]),
      quietThreadShellAtom: () => quiet,
      shellStateAtom: () => shell,
    });
    const seen: Array<ReadonlyArray<RecentThreadPresence>> = [];
    registry.subscribe(presence, (value) => seen.push(value), { immediate: true });
    return { registry, quiet, shell, seen };
  }

  it("does not call a thread gone when its shell resets under a stale live status", () => {
    const { registry, quiet, shell, seen } = setupPresence({
      quiet: {},
      shell: liveShell("a"),
    });
    registry.set(quiet, null);
    registry.set(shell, { status: "live", snapshot: Option.none() });
    registry.set(shell, { status: "synchronizing", snapshot: Option.some({ threads: [] }) });
    expect(seen.some((list) => list.some((entry) => entry.missingFromLiveShell))).toBe(false);
  });

  it("calls a thread gone once the live snapshot itself lacks it", () => {
    const { registry, quiet, shell, seen } = setupPresence({
      quiet: {},
      shell: liveShell("a"),
    });
    registry.set(shell, liveShell());
    registry.set(quiet, null);
    expect(seen.at(-1)).toEqual([
      { key: "/threads/env/a", inShell: false, missingFromLiveShell: true },
    ]);
  });
});
