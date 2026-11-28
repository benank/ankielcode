import { assert, describe, it } from "vite-plus/test";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@ankielcode/shared/keybindings";

import {
  type KeybindingCommand,
  type KeybindingShortcut,
  type KeybindingWhenNode,
  type ResolvedKeybindingsConfig,
} from "@ankielcode/contracts";
import {
  isTerminalNewShortcut,
  resolveShortcutCommand,
  type ShortcutEventLike,
} from "./keybindings";

function event(overrides: Partial<ShortcutEventLike> = {}): ShortcutEventLike {
  return {
    key: "j",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  };
}

function modShortcut(
  key: string,
  overrides: Partial<Omit<KeybindingShortcut, "key">> = {},
): KeybindingShortcut {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    modKey: true,
    ...overrides,
  };
}

function whenIdentifier(name: string): KeybindingWhenNode {
  return { type: "identifier", name };
}

function whenNot(node: KeybindingWhenNode): KeybindingWhenNode {
  return { type: "not", node };
}

function whenAnd(left: KeybindingWhenNode, right: KeybindingWhenNode): KeybindingWhenNode {
  return { type: "and", left, right };
}

interface TestBinding {
  shortcut: KeybindingShortcut;
  command: KeybindingCommand;
  whenAst?: KeybindingWhenNode;
}

function compile(bindings: TestBinding[]): ResolvedKeybindingsConfig {
  return bindings.map((binding) => ({
    command: binding.command,
    shortcut: binding.shortcut,
    ...(binding.whenAst ? { whenAst: binding.whenAst } : {}),
  }));
}

const DEFAULT_BINDINGS = compile([
  { shortcut: modShortcut("b"), command: "sidebar.toggle" },
  { shortcut: modShortcut("j"), command: "terminal.toggle" },
  { shortcut: modShortcut("b", { altKey: true }), command: "rightPanel.toggle" },
  {
    shortcut: modShortcut("d"),
    command: "terminal.split",
    whenAst: whenIdentifier("terminalFocus"),
  },
  {
    shortcut: modShortcut("d", { shiftKey: true }),
    command: "terminal.splitVertical",
    whenAst: whenIdentifier("terminalFocus"),
  },
  {
    shortcut: modShortcut("n"),
    command: "terminal.new",
    whenAst: whenIdentifier("terminalFocus"),
  },
  {
    shortcut: modShortcut("w"),
    command: "terminal.close",
    whenAst: whenIdentifier("terminalFocus"),
  },
  {
    shortcut: modShortcut("w"),
    command: "rightPanel.close",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("d"),
    command: "diff.toggle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("k"),
    command: "commandPalette.toggle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("p"),
    command: "filePicker.toggle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("f", { shiftKey: true }),
    command: "projectSearch.toggle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("t", { altKey: true, shiftKey: true }),
    command: "themeEditor.toggle",
  },
  {
    shortcut: modShortcut("f"),
    command: "chat.find",
    whenAst: whenAnd(
      whenNot(whenIdentifier("terminalFocus")),
      whenNot(whenIdentifier("previewFocus")),
    ),
  },
  {
    shortcut: modShortcut("m", { shiftKey: true }),
    command: "modelPicker.toggle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  { shortcut: modShortcut("o", { shiftKey: true }), command: "chat.new" },
  { shortcut: modShortcut("n", { shiftKey: true }), command: "chat.newLocal" },
  { shortcut: modShortcut("o"), command: "editor.openFavorite" },
  { shortcut: modShortcut("[", { shiftKey: true }), command: "thread.previous" },
  { shortcut: modShortcut("]", { shiftKey: true }), command: "thread.next" },
  {
    shortcut: modShortcut("c", { shiftKey: true }),
    command: "thread.copyReference",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("s", { shiftKey: true }),
    command: "thread.settle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  { shortcut: modShortcut("1"), command: "thread.jump.1" },
  { shortcut: modShortcut("2"), command: "thread.jump.2" },
  { shortcut: modShortcut("3"), command: "thread.jump.3" },
  {
    shortcut: modShortcut("1"),
    command: "modelPicker.jump.1",
    whenAst: whenIdentifier("modelPickerOpen"),
  },
  {
    shortcut: modShortcut("2"),
    command: "modelPicker.jump.2",
    whenAst: whenIdentifier("modelPickerOpen"),
  },
  {
    shortcut: modShortcut("3"),
    command: "modelPicker.jump.3",
    whenAst: whenIdentifier("modelPickerOpen"),
  },
]);

describe("cross-command precedence", () => {
  it("uses when + order so a later focused rule overrides a global rule", () => {
    const keybindings = compile([
      { shortcut: modShortcut("n"), command: "chat.new" },
      {
        shortcut: modShortcut("n"),
        command: "terminal.new",
        whenAst: whenIdentifier("terminalFocus"),
      },
    ]);

    assert.isTrue(
      isTerminalNewShortcut(event({ key: "n", metaKey: true }), keybindings, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "n", metaKey: true }), keybindings, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
      "terminal.new",
    );
    assert.isFalse(
      isTerminalNewShortcut(event({ key: "n", metaKey: true }), keybindings, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "n", metaKey: true }), keybindings, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
      "chat.new",
    );
  });

  it("still lets a later global rule win when both rules match", () => {
    const keybindings = compile([
      {
        shortcut: modShortcut("n"),
        command: "terminal.new",
        whenAst: whenIdentifier("terminalFocus"),
      },
      { shortcut: modShortcut("n"), command: "chat.new" },
    ]);

    assert.isFalse(
      isTerminalNewShortcut(event({ key: "n", ctrlKey: true }), keybindings, {
        platform: "Linux",
        context: { terminalFocus: true },
      }),
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "n", ctrlKey: true }), keybindings, {
        platform: "Linux",
        context: { terminalFocus: true },
      }),
      "chat.new",
    );
  });
});
describe("resolveShortcutCommand", () => {
  it("routes mod+w to the terminal while focused and to the right panel otherwise", () => {
    const closeEvent = event({ key: "w", metaKey: true });
    assert.strictEqual(
      resolveShortcutCommand(closeEvent, DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
      "terminal.close",
    );
    assert.strictEqual(
      resolveShortcutCommand(closeEvent, DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
      "rightPanel.close",
    );
  });

  it("navigates history with mod+[ and mod+] outside the terminal", () => {
    const back = event({ key: "[", code: "BracketLeft", metaKey: true });
    const forward = event({ key: "]", code: "BracketRight", ctrlKey: true });
    assert.strictEqual(
      resolveShortcutCommand(back, DEFAULT_RESOLVED_KEYBINDINGS, { platform: "MacIntel" }),
      "navigation.back",
    );
    assert.strictEqual(
      resolveShortcutCommand(forward, DEFAULT_RESOLVED_KEYBINDINGS, { platform: "Linux" }),
      "navigation.forward",
    );
    assert.isNull(
      resolveShortcutCommand(back, DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
    );
  });

  it("matches punctuation shortcuts by physical key across keyboard layouts", () => {
    const keybindings = compile([
      { shortcut: modShortcut("'", { shiftKey: true }), command: "diff.toggle" },
    ]);

    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "@", code: "Quote", metaKey: true, shiftKey: true }),
        keybindings,
        { platform: "MacIntel" },
      ),
      "diff.toggle",
    );
    assert.isNull(
      resolveShortcutCommand(
        event({ key: '"', code: "Digit2", metaKey: true, shiftKey: true }),
        keybindings,
        { platform: "MacIntel" },
      ),
    );
  });

  it('matches Ctrl+layout "+" as itself unless Shift, Alt or the number row is involved', () => {
    assert.isNull(
      resolveShortcutCommand(
        event({ key: "+", code: "BracketRight", ctrlKey: true }),
        DEFAULT_RESOLVED_KEYBINDINGS,
        { platform: "Linux", context: { terminalFocus: false } },
      ),
    );
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "+", code: "Minus", ctrlKey: true }),
        DEFAULT_RESOLVED_KEYBINDINGS,
        { platform: "Linux", context: { previewFocus: true } },
      ),
      "preview.zoomIn",
    );
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "+", code: "Digit1", ctrlKey: true }),
        DEFAULT_RESOLVED_KEYBINDINGS,
        { platform: "Linux", context: { isDesktop: true } },
      ),
      "thread.jump.1",
    );
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "+", code: "BracketRight", altKey: true }),
        compile([
          {
            shortcut: modShortcut("]", { modKey: false, altKey: true }),
            command: "terminal.toggle",
          },
        ]),
        { platform: "Linux" },
      ),
      "terminal.toggle",
    );
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "+", code: "Equal", ctrlKey: true, shiftKey: true }),
        compile([{ shortcut: modShortcut("=", { shiftKey: true }), command: "terminal.toggle" }]),
        { platform: "Linux" },
      ),
      "terminal.toggle",
    );
  });

  it("does not let a punctuation position shadow a Latin layout key", () => {
    const keybindings = compile([
      { shortcut: modShortcut("m"), command: "diff.toggle" },
      { shortcut: modShortcut(";"), command: "sidebar.toggle" },
    ]);

    assert.strictEqual(
      resolveShortcutCommand(event({ key: "m", code: "Semicolon", metaKey: true }), keybindings, {
        platform: "MacIntel",
      }),
      "diff.toggle",
    );
  });
});
