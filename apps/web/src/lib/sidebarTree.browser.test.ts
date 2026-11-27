import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { fakeTimers } from "../../test/render";
import { installSidebarTree, SIDEBAR_TYPEAHEAD_RESET_MS } from "./sidebarTree";

function setup() {
  const root = document.createElement("div");
  document.body.append(root);
  let dispose: (() => void) | undefined;
  const row = (id: string, parent?: string, title?: string) => {
    const element = document.createElement("button");
    element.dataset.sidebarRow = id;
    if (parent) element.dataset.sidebarParent = parent;
    if (title !== undefined) element.dataset.sidebarTitle = title;
    element.textContent = id;
    root.append(element);
    return element;
  };
  return {
    root,
    row,
    install: () => {
      dispose = installSidebarTree(root);
    },
    [Symbol.dispose]() {
      dispose?.();
      root.remove();
    },
  };
}

function press(target: HTMLElement, key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

describe("sidebar keyboard navigation", () => {
  it("moves focus without activating rows, clamps at the ends, and keeps one Tab stop", () => {
    using tree = setup();
    const first = tree.row("first");
    const second = tree.row("second");
    const last = tree.row("last");
    const activate = vi.fn();
    tree.root.addEventListener("click", activate);
    tree.install();
    first.focus();
    press(first, "ArrowDown");
    expect(document.activeElement).toBe(second);
    press(second, "End");
    expect(document.activeElement).toBe(last);
    press(last, "ArrowDown");
    expect(document.activeElement).toBe(last);
    press(last, "Home");
    expect(document.activeElement).toBe(first);
    expect(activate).not.toHaveBeenCalled();
    expect([first.tabIndex, second.tabIndex, last.tabIndex]).toEqual([0, -1, -1]);
  });

  it("keeps one Tab stop on the open row, the first row, or the row that last had it", async () => {
    using tree = setup();
    const first = tree.row("first");
    const second = tree.row("second");
    const third = tree.row("third");
    tree.install();
    // Nothing is open, as in Settings or on a draft: the first row takes the stop.
    expect([first.tabIndex, second.tabIndex, third.tabIndex]).toEqual([0, -1, -1]);
    // Opening a thread from elsewhere moves the stop to it.
    second.setAttribute("aria-current", "page");
    await vi.waitFor(() => expect(second.tabIndex).toBe(0));
    expect(first.tabIndex).toBe(-1);
    third.focus();
    expect([second.tabIndex, third.tabIndex]).toEqual([-1, 0]);
    // A row that moves shelves remounts; the new element takes the stop back.
    third.remove();
    const moved = tree.row("third");
    await vi.waitFor(() => expect(moved.tabIndex).toBe(0));
    expect(tree.root.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
  });

  it("expands a group before entering its first child and returns to the parent", () => {
    using tree = setup();
    const group = tree.row("project");
    group.setAttribute("aria-expanded", "false");
    group.addEventListener("click", () => {
      const expanded = group.getAttribute("aria-expanded") === "true";
      group.setAttribute("aria-expanded", String(!expanded));
      if (expanded) tree.root.querySelector('[data-sidebar-row="thread"]')?.remove();
      else tree.row("thread", "project");
    });
    tree.install();
    group.focus();
    press(group, "ArrowRight");
    expect(group.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(group);
    press(group, "ArrowRight");
    const child = document.activeElement as HTMLElement;
    expect(child.dataset.sidebarRow).toBe("thread");
    press(child, "ArrowLeft");
    expect(document.activeElement).toBe(group);
    press(group, "ArrowLeft");
    expect(group.getAttribute("aria-expanded")).toBe("false");
  });

  it("opens the row menu on Shift+F10 release without moving focus", () => {
    using tree = setup();
    tree.row("first");
    const selected = tree.row("selected");
    const contextMenu = vi.fn((event: MouseEvent) => event.preventDefault());
    selected.addEventListener("contextmenu", contextMenu);
    tree.install();
    selected.focus();
    expect(press(selected, "F10", { shiftKey: true }).defaultPrevented).toBe(true);
    expect(contextMenu).not.toHaveBeenCalled();
    selected.dispatchEvent(
      new KeyboardEvent("keyup", { key: "F10", shiftKey: true, bubbles: true, cancelable: true }),
    );
    expect(contextMenu).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(selected);
  });

  it("lets Tab reach only the focused row's buttons", () => {
    using tree = setup();
    const first = tree.row("first");
    const second = tree.row("second");
    const action = (owner: string) => {
      const button = document.createElement("button");
      button.textContent = `Archive ${owner}`;
      button.dataset.sidebarActionFor = owner;
      tree.root.append(button);
      return button;
    };
    const firstAction = action("first");
    const secondAction = action("second");
    tree.install();
    first.focus();
    expect([firstAction.tabIndex, secondAction.tabIndex]).toEqual([0, -1]);
    press(first, "ArrowDown");
    expect(document.activeElement).toBe(second);
    expect([firstAction.tabIndex, secondAction.tabIndex]).toEqual([-1, 0]);
  });

  it("keeps a rendered row under a collapsed group reachable", () => {
    using tree = setup();
    const shelf = tree.row("shelf:settled");
    shelf.setAttribute("aria-expanded", "false");
    // A collapsed shelf still renders the open thread.
    const open = tree.row("thread", "shelf:settled");
    tree.install();
    shelf.focus();
    press(shelf, "ArrowDown");
    expect(document.activeElement).toBe(open);
  });

  it("skips disabled rows and leaves controls outside rows in the Tab order", () => {
    using tree = setup();
    const first = tree.row("first");
    const loading = tree.row("settled:more");
    loading.disabled = true;
    const undo = document.createElement("button");
    undo.textContent = "Undo";
    tree.root.append(undo);
    tree.install();
    first.focus();
    press(first, "ArrowDown");
    expect(document.activeElement).toBe(first);
    expect(undo.tabIndex).toBe(0);
  });

  it("moves to the thread whose title starts with what was typed", () => {
    using tree = setup();
    const draft = tree.row("draft:1");
    const fix = tree.row("fix", undefined, "Fix the login redirect");
    const fixTests = tree.row("fix-tests", undefined, "Fix flaky tests");
    const sidebar = tree.row("sidebar", undefined, "  Sidebar polish");
    const activate = vi.fn();
    tree.root.addEventListener("click", activate);
    tree.install();
    using _timers = fakeTimers();
    draft.focus();
    press(draft, "F", { shiftKey: true });
    expect(document.activeElement).toBe(fix);
    for (const key of ["i", "x", "-"]) {
      expect(press(document.activeElement as HTMLElement, key).defaultPrevented).toBe(true);
    }
    expect(document.activeElement).toBe(fix);
    expect(activate).not.toHaveBeenCalled();
    // Space stays the row's own key and clears what was typed.
    expect(press(fix, " ").defaultPrevented).toBe(false);
    press(fix, "f");
    expect(document.activeElement).toBe(fixTests);
    vi.advanceTimersByTime(SIDEBAR_TYPEAHEAD_RESET_MS);
    press(fixTests, "s");
    expect(document.activeElement).toBe(sidebar);
    vi.advanceTimersByTime(SIDEBAR_TYPEAHEAD_RESET_MS);
    // Repeating a letter steps through the titles that start with it, wrapping around.
    press(sidebar, "f");
    press(fix, "f");
    expect(document.activeElement).toBe(fixTests);
    press(fixTests, "f");
    expect(document.activeElement).toBe(fix);
    vi.advanceTimersByTime(SIDEBAR_TYPEAHEAD_RESET_MS);
    expect(press(fix, "f", { metaKey: true }).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(fix);
  });

  it("keeps the scroll position when focus follows a row that moved away", async () => {
    using tree = setup();
    Object.assign(tree.root.style, { height: "100px", overflow: "auto" });
    const settled = tree.row("settled");
    const settle = document.createElement("button");
    settle.textContent = "Settle";
    settled.after(settle);
    settle.dataset.sidebarActionFor = "settled";
    for (let index = 0; index < 20; index++) tree.row(`row-${index}`).style.display = "block";
    tree.install();
    settle.focus();
    // Settling moves the row to the shelf at the bottom and removes the focused button.
    settle.remove();
    settled.remove();
    const moved = tree.row("settled");
    await vi.waitFor(() => expect(document.activeElement).toBe(moved));
    expect(tree.root.scrollTop).toBe(0);
  });

  it("does not pull focus back after a click outside the rows", async () => {
    using tree = setup();
    const first = tree.row("first");
    tree.install();
    const text = document.createElement("p");
    text.textContent = "Chat text";
    document.body.append(text);
    using _text = { [Symbol.dispose]: () => text.remove() };
    const spacer = document.createElement("div");
    spacer.textContent = "Empty list space";
    tree.root.append(spacer);
    for (const target of [text, spacer]) {
      first.focus();
      await userEvent.click(target);
      expect(document.activeElement).toBe(document.body);
      // A status change re-renders the list while the user works elsewhere.
      tree.row(`second-${target.tagName}`);
      // The list's mutation observer callback is queued ahead of this continuation.
      await Promise.resolve();
      expect(document.activeElement).toBe(document.body);
    }
  });
});
