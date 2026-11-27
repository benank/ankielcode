import type { DesktopRecentThread } from "@ankielcode/contracts";
import { buildThreadAppLink, readThreadAppLink } from "@ankielcode/shared/remote";
import type * as Electron from "electron";
import { msg } from "gt-i18n";

import { m } from "../i18n/messages.ts";

// The jump list drops an item whose description passes 260 characters; titles stay well under.
const TITLE_MAX_LENGTH = 80;

const recentThreadsHeader = () => m(msg("Recent Threads"));

/** The renderer reports ids; only ones that make a link the app itself accepts are shown. */
const linkedThreads = (threads: ReadonlyArray<DesktopRecentThread>) =>
  threads.flatMap((thread) => {
    const link = buildThreadAppLink(thread);
    return readThreadAppLink(link) === null ? [] : [{ thread, link }];
  });

const shortTitle = (title: string) =>
  title.length > TITLE_MAX_LENGTH ? `${title.slice(0, TITLE_MAX_LENGTH - 1)}…` : title;

/** The macOS dock menu: a header, then one item per thread. Empty when there are none. */
export function recentThreadsDockMenu(
  threads: ReadonlyArray<DesktopRecentThread>,
  open: (link: string) => void,
): Electron.MenuItemConstructorOptions[] {
  const linked = linkedThreads(threads);
  if (linked.length === 0) return [];
  return [
    { label: recentThreadsHeader(), enabled: false },
    ...linked.map(({ thread, link }) => ({
      label: shortTitle(thread.title),
      click: () => open(link),
    })),
  ];
}

export interface JumpListLaunch {
  readonly program: string;
  /** Arguments before the link, such as the app path of an unpackaged build. */
  readonly leadingArgs: ReadonlyArray<string>;
}

const quoteArg = (value: string) => `"${value.replaceAll('"', '\\"')}"`;

/**
 * The Windows jump list. Each item relaunches the app with its thread link, which the running
 * instance receives as `second-instance` argv. An item the user removed stays out: re-adding it
 * would make Windows hide the whole category.
 */
export function recentThreadsJumpList(
  threads: ReadonlyArray<DesktopRecentThread>,
  launch: JumpListLaunch,
  removedItems: ReadonlyArray<Electron.JumpListItem>,
): Electron.JumpListCategory[] | null {
  const removedArgs = new Set(removedItems.flatMap((item) => (item.args ? [item.args] : [])));
  const items = linkedThreads(threads).flatMap(({ thread, link }): Electron.JumpListItem[] => {
    const args = [...launch.leadingArgs, link].map(quoteArg).join(" ");
    if (removedArgs.has(args)) return [];
    const title = shortTitle(thread.title);
    return [
      {
        type: "task",
        title,
        description: title,
        program: launch.program,
        args,
        iconPath: launch.program,
        iconIndex: 0,
      },
    ];
  });
  return items.length === 0 ? null : [{ type: "custom", name: recentThreadsHeader(), items }];
}
