const ROW = "[data-sidebar-row]";
const CONTROL = "button, a[href], [tabindex]";
const TEXT_ENTRY = 'input, textarea, select, [contenteditable="true"]';
// Long enough to type a word at a relaxed pace, as in Finder.
const SIDEBAR_TYPEAHEAD_RESET_MS = 1000;

/** Ref callback for a sidebar list; installs its keyboard navigation and returns its cleanup. */
export function attachSidebarTree(element: HTMLElement | null) {
  return element ? installSidebarTree(element) : undefined;
}

/**
 * Arrow keys move focus between rows without opening them, as in VS Code's list commands, and
 * typing a title's first letters moves to it. The list is one Tab stop, the last focused row
 * (or the open one), and Tab goes on to that row's own buttons. Rows keep the button role, not
 * treeitem, so screen readers stay in browse mode.
 */
function installSidebarTree(root: HTMLElement) {
  let focusedId: string | undefined;
  let focusedParent: string | undefined;
  let focusedIndex = -1;
  let ownsFocus = false;
  let contextMenuRow: HTMLElement | undefined;
  let tabStop: HTMLElement | undefined;
  let tabStopId: string | undefined;
  let currentId: string | undefined;
  let typed = "";
  let typedReset: ReturnType<typeof setTimeout> | undefined;

  const isVisibleRow = (row: HTMLElement) => {
    const hidden = row.closest('[hidden], [inert], [aria-hidden="true"]');
    // A dialog can temporarily make the whole workspace inert. Keep rows navigable
    // for its return while still excluding exiting row clones.
    return (!hidden || !root.contains(hidden)) && !row.matches(":disabled");
  };
  const visibleRows = () =>
    Array.from(root.querySelectorAll<HTMLElement>(ROW)).filter(isVisibleRow);

  const ownerRow = (element: HTMLElement) => {
    const row = element.closest<HTMLElement>(ROW);
    if (row) return row;
    const linked = element.dataset.sidebarActionFor;
    return linked
      ? root.querySelector<HTMLElement>(`[data-sidebar-row="${CSS.escape(linked)}"]`)
      : null;
  };

  const setTabIndex = (element: HTMLElement, tabIndex: number) => {
    if (element.tabIndex !== tabIndex) element.tabIndex = tabIndex;
  };
  const isRowControl = (element: HTMLElement) =>
    !element.matches(ROW) &&
    !element.matches(TEXT_ENTRY) &&
    element.getAttribute("aria-hidden") !== "true";
  const setRowReachable = (row: HTMLElement, reachable: boolean) => {
    setTabIndex(row, reachable ? 0 : -1);
    const id = row.dataset.sidebarRow;
    const linked = id
      ? root.querySelectorAll<HTMLElement>(`[data-sidebar-action-for="${CSS.escape(id)}"]`)
      : [];
    for (const control of [...row.querySelectorAll<HTMLElement>(CONTROL), ...linked]) {
      if (isRowControl(control)) setTabIndex(control, reachable ? 0 : -1);
    }
  };
  const setTabStop = (row: HTMLElement) => {
    if (tabStop === row) return;
    if (tabStop) setRowReachable(tabStop, false);
    setRowReachable(row, true);
    tabStop = row;
    tabStopId = row.dataset.sidebarRow;
  };
  // Rows and their buttons mount out of the Tab order unless they belong to the Tab stop.
  const settleTabOrder = (node: Node) => {
    if (!(node instanceof HTMLElement)) return;
    const candidates = node.matches(`${ROW}, ${CONTROL}`) ? [node] : [];
    candidates.push(...node.querySelectorAll<HTMLElement>(`${ROW}, ${CONTROL}`));
    for (const element of candidates) {
      if (element.matches(ROW)) {
        setTabIndex(element, element === tabStop ? 0 : -1);
      } else if (isRowControl(element)) {
        const owner = ownerRow(element);
        if (owner) setTabIndex(element, owner === tabStop ? 0 : -1);
      }
    }
  };
  // Keep exactly one stop: the open row once the route moves while focus is elsewhere,
  // otherwise the row that had it, or the first row.
  const syncTabStop = () => {
    const current = root.querySelector<HTMLElement>(`${ROW}[aria-current]`);
    const routeMoved = current?.dataset.sidebarRow !== currentId;
    currentId = current?.dataset.sidebarRow;
    const currentVisible = current !== null && isVisibleRow(current);
    if (routeMoved && !ownsFocus && currentVisible) {
      setTabStop(current);
      return;
    }
    if (tabStop?.isConnected && isVisibleRow(tabStop)) return;
    const rows = visibleRows();
    const next =
      rows.find((row) => row.dataset.sidebarRow === tabStopId) ??
      (currentVisible ? current : undefined) ??
      rows[0];
    if (next) setTabStop(next);
    else tabStop = undefined;
  };

  const resetTyped = () => {
    typed = "";
    clearTimeout(typedReset);
    typedReset = undefined;
  };
  // Type-to-select, as in Finder: keys typed in quick succession match a thread title's start.
  // Repeating one letter steps through the titles that start with it.
  const typeToSelect = (event: KeyboardEvent, row: HTMLElement) => {
    // Space stays the row's open key, so a match is found from the first word.
    if (event.key.length !== 1 || event.key === " ") return false;
    typed += event.key.toLocaleLowerCase();
    clearTimeout(typedReset);
    typedReset = setTimeout(resetTyped, SIDEBAR_TYPEAHEAD_RESET_MS);
    const rows = visibleRows();
    const index = rows.indexOf(row);
    const cycling = [...typed].every((character) => character === typed[0]);
    const prefix = cycling ? typed[0]! : typed;
    const start = cycling ? index + 1 : index;
    const match = [...rows.slice(start), ...rows.slice(0, start)].find((candidate) =>
      candidate.dataset.sidebarTitle?.trimStart().toLocaleLowerCase().startsWith(prefix),
    );
    if (match && match !== row) focusRow(match);
    return true;
  };

  const focusRow = (row: HTMLElement) => {
    // Revealing before focusing also materializes content-visibility:auto descendants.
    row.scrollIntoView({ block: "nearest" });
    row.focus({ preventScroll: true });
  };

  // A row that moves shelves remounts and drops focus to the body; follow it.
  const restoreFocus = () => {
    if (!ownsFocus || focusedId === undefined) return;
    const active = document.activeElement;
    const lost =
      active === document.body ||
      (active instanceof HTMLElement &&
        root.contains(active) &&
        active.matches(ROW) &&
        !isVisibleRow(active));
    if (!lost) return;
    const rows = visibleRows();
    const target =
      rows.find((row) => row.dataset.sidebarRow === focusedId) ??
      rows.find((row) => row.dataset.sidebarRow === focusedParent) ??
      rows[Math.min(Math.max(focusedIndex, 0), rows.length - 1)];
    // A settled row moves to the bottom shelf; scrolling after it fights the route reveal.
    target?.focus({ preventScroll: true });
  };

  // Clicking non-focusable content, including empty list space, drops focus to the body
  // without a focusin event. A click on the focused row fires no focusin either.
  const onPointerDown = (event: PointerEvent) => {
    const focusable =
      event.target instanceof Element
        ? event.target.closest(`${ROW}, button, a[href], input, [tabindex]`)
        : null;
    ownsFocus = focusable !== null && root.contains(focusable);
  };
  const onFocus = (event: FocusEvent) => {
    ownsFocus = root.contains(event.target as Node);
    if (!ownsFocus) resetTyped();
    if (!ownsFocus || !(event.target instanceof HTMLElement)) return;
    const row = ownerRow(event.target);
    if (!row) return;
    setTabStop(row);
    focusedId = row.dataset.sidebarRow;
    focusedParent = row.dataset.sidebarParent;
    focusedIndex = visibleRows().indexOf(row);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const row = event.target;
    if (
      !event.defaultPrevented &&
      !event.isComposing &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) &&
      row instanceof HTMLElement &&
      row.matches(ROW)
    ) {
      event.preventDefault();
      event.stopPropagation();
      contextMenuRow = row;
      return;
    }
    if (
      event.defaultPrevented ||
      event.isComposing ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      !(row instanceof HTMLElement) ||
      !row.matches(ROW)
    )
      return;
    if (typeToSelect(event, row)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    resetTyped();
    if (event.shiftKey) return;
    const rows = visibleRows();
    const index = rows.indexOf(row);
    if (index < 0) return;
    let target: HTMLElement | undefined;
    switch (event.key) {
      case "ArrowDown":
        target = rows[Math.min(index + 1, rows.length - 1)];
        break;
      case "ArrowUp":
        target = rows[Math.max(index - 1, 0)];
        break;
      case "Home":
        target = rows[0];
        break;
      case "End":
        target = rows.at(-1);
        break;
      case "ArrowRight":
        if (row.getAttribute("aria-expanded") === "false") row.click();
        else
          target = rows.find(
            (candidate) => candidate.dataset.sidebarParent === row.dataset.sidebarRow,
          );
        break;
      case "ArrowLeft":
        if (row.getAttribute("aria-expanded") === "true") row.click();
        else
          target = rows.find(
            (candidate) => candidate.dataset.sidebarRow === row.dataset.sidebarParent,
          );
        break;
      // Row handlers own Return, Space, F2 rename, and the context menu.
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (target) focusRow(target);
  };
  const onKeyUp = (event: KeyboardEvent) => {
    if (!contextMenuRow || (event.key !== "ContextMenu" && event.key !== "F10")) return;
    const row = contextMenuRow;
    contextMenuRow = undefined;
    event.preventDefault();
    event.stopPropagation();
    if (document.activeElement !== row || !row.isConnected) return;
    const rect = row.getBoundingClientRect();
    // Like VS Code's list, suppress keydown and open on release. Reuse the row's
    // selection-aware handler, including its Electron native menu route.
    row.dispatchEvent(
      // A PointerEvent, as Chromium sends, keeps button -1 (a MouseEvent clamps it to 0),
      // which contextMenuSourceOf reads as a keyboard-opened menu.
      new PointerEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: -1,
        clientX: rect.left,
        clientY: rect.bottom,
      }),
    );
  };
  const observer = new MutationObserver((records) => {
    for (const record of records) record.addedNodes.forEach(settleTabOrder);
    restoreFocus();
    syncTabStop();
  });
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["hidden", "inert", "aria-hidden", "aria-current"],
  });
  settleTabOrder(root);
  syncTabStop();
  document.addEventListener("focusin", onFocus);
  document.addEventListener("pointerdown", onPointerDown, true);
  root.addEventListener("keydown", onKeyDown, true);
  root.addEventListener("keyup", onKeyUp, true);
  return () => {
    observer.disconnect();
    clearTimeout(typedReset);
    document.removeEventListener("focusin", onFocus);
    document.removeEventListener("pointerdown", onPointerDown, true);
    root.removeEventListener("keydown", onKeyDown, true);
    root.removeEventListener("keyup", onKeyUp, true);
  };
}
