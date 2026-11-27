# Keyboard focus

The command palette keeps focus while open. Closing it returns focus to the composer in chat,
or to the previous control on other pages. Choosing a workspace focus command moves to that
area instead. Opening Pull requests moves focus into that page.
While the palette or model picker is open, number shortcuts select its entries instead of
switching threads. Model shortcuts work in Settings as well as the composer.
See [Keybindings](./keybindings.md) to customize these shortcuts.

If you return to typing while a terminal is starting, the composer keeps focus when the terminal
becomes ready. Opening or switching to a terminal explicitly still focuses it.

## Move between workspace areas

On desktop, press `F6` or `Shift+F6` to move between the Threads sidebar,
conversation, message input, and visible panels. Navigation wraps around and restores
the last focused control in each area. Pull requests has a page content area. In Settings,
`F6` moves between the section list and the open section. Hidden areas are skipped. Other
dialogs and form popups retain focus; a thread context menu closes when an area command
moves focus away.

`mod+F6` and `mod+Shift+F6` do the same (`mod` is Command on macOS and Ctrl elsewhere). **Focus Next
Workspace Area** and **Focus Previous Workspace Area** are also in the command palette and
can be remapped in Settings > Keybindings.

## Browse threads

The thread list is one Tab stop: Tab lands on the open thread, or the one you last moved to,
and then on that thread's buttons. Up and Down move between threads without opening them,
Home and End go to the first and last, and Right and Left expand and collapse groups.
Threads inside a collapsed project or shelf are skipped. Type the start of a thread's title to
move to it; type the same letter again to step through the titles that start with it. Space
always opens, so matching stops at the first word.

On macOS, Return renames the focused thread, as in Finder, and Space or `Cmd+Down` opens it.
On Windows and Linux, Enter or Space opens it and `F2` renames it. `F2` also renames on macOS.
Enter or Space toggles a project or shelf header.

Press `Shift+F10` or the Context Menu key to open the focused thread's menu. Use the arrow
keys to move through it, Enter to choose, and Escape to close it.

In the Settings section list, Tab moves through each section, Up and Down also move between
sections without opening them, and Enter opens one.
