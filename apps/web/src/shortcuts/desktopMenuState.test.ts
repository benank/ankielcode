import { DESKTOP_MENU_COMMANDS, type DesktopMenuState } from "@ankielcode/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@ankielcode/shared/keybindings";
import { describe, expect, it } from "vite-plus/test";

import { createDesktopMenuStateReporter, isUnclaimedCloseWindowChord } from "./desktopMenuState";

const settle = () => new Promise<void>((resolve) => queueMicrotask(resolve));

function setup() {
  const available = new Set<string>(["sidebar.toggle"]);
  const sent: DesktopMenuState[] = [];
  let keybindings = DEFAULT_RESOLVED_KEYBINDINGS;
  const reporter = createDesktopMenuStateReporter({
    isAvailable: (command) => available.has(command),
    keybindings: () => keybindings,
    send: async (state) => {
      sent.push(state);
    },
  });
  return {
    available,
    sent,
    reporter,
    setKeybindings: (next: typeof keybindings) => {
      keybindings = next;
    },
  };
}

describe("desktop menu state", () => {
  it("reports every command once, then only what changed", async () => {
    const { available, sent, reporter } = setup();
    reporter.refresh();
    await settle();

    expect(sent).toHaveLength(1);
    expect(Object.keys(sent[0]?.enabled ?? {})).toHaveLength(DESKTOP_MENU_COMMANDS.length);
    expect(sent[0]?.enabled?.["sidebar.toggle"]).toBe(true);
    expect(sent[0]?.enabled?.["chat.new"]).toBe(false);
    expect(sent[0]?.shortcuts?.["sidebar.toggle"]).toMatchObject({ key: "b", modKey: true });
    expect(sent[0]?.shortcuts?.["thread.stop"]).toMatchObject({ key: ".", modKey: true });
    // Labelled as they run while find is open, where mod+shift+g is not the branch picker.
    expect(sent[0]?.shortcuts?.["chat.findNext"]).toMatchObject({ key: "g", shiftKey: false });
    expect(sent[0]?.shortcuts?.["chat.findPrevious"]).toMatchObject({ key: "g", shiftKey: true });

    available.add("chat.new");
    reporter.refresh();
    await settle();
    expect(sent[1]).toEqual({ enabled: { "chat.new": true } });
  });

  it("sends nothing when a screen re-registers the same commands", async () => {
    const { available, sent, reporter } = setup();
    reporter.refresh();
    await settle();

    available.delete("sidebar.toggle");
    reporter.refresh();
    available.add("sidebar.toggle");
    reporter.refresh();
    await settle();

    expect(sent).toHaveLength(1);
  });

  it("follows a rebound command", async () => {
    const { sent, reporter, setKeybindings } = setup();
    reporter.refresh();
    await settle();

    const shortcut = {
      key: "e",
      modKey: true,
      metaKey: false,
      ctrlKey: false,
      altKey: true,
      shiftKey: false,
    };
    setKeybindings([...DEFAULT_RESOLVED_KEYBINDINGS, { command: "thread.stop", shortcut }]);
    // Bindings are read only when they change.
    reporter.refresh();
    await settle();
    expect(sent).toHaveLength(1);

    reporter.refreshShortcuts();
    await settle();
    expect(sent[1]).toEqual({ shortcuts: { "thread.stop": shortcut } });
  });
});

describe("unclaimed Cmd+W", () => {
  const chord = {
    key: "w",
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
  };

  it.each([
    { name: "closes the window on macOS", event: chord, expected: true },
    { name: "reads an uppercase key", event: { ...chord, key: "W" }, expected: true },
    { name: "leaves a claimed chord", event: chord, consumed: true, expected: false },
    { name: "ignores a held key", event: { ...chord, repeat: true }, expected: false },
    { name: "ignores Shift+Cmd+W", event: { ...chord, shiftKey: true }, expected: false },
    {
      name: "never closes off macOS",
      event: { ...chord, metaKey: false, ctrlKey: true },
      platform: "Win32",
      expected: false,
    },
  ])("$name", ({ event, consumed = false, platform = "MacIntel", expected }) => {
    expect(isUnclaimedCloseWindowChord(event, consumed, platform)).toBe(expected);
  });
});
