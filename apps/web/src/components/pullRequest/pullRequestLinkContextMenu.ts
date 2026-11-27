import type { ContextMenuItem, ContextMenuSource } from "@ankielcode/contracts";
import {
  type SourceControlDefinition,
  UNKNOWN_SOURCE_CONTROL_CLIENT,
} from "@ankielcode/client-runtime/source-control-clients";

import { msg } from "gt-react";

import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { m, type MessageResolver } from "~/i18n/messages";
import { readLocalApi } from "~/localApi";

import { toastManager } from "../ui/toast";

export type PullRequestLinkContextMenuAction = "open" | "copy-link" | "open-external";

/** Opens the item inside the app, ahead of the link actions. */
interface LinkContextMenuOpen {
  readonly label: string;
  readonly run: () => void;
}

export const openOnHostLabel = (
  host: SourceControlDefinition,
  resolve: MessageResolver = m,
): string =>
  host === UNKNOWN_SOURCE_CONTROL_CLIENT
    ? resolve(msg("Open on host"))
    : resolve(msg("Open on {host}", { host: host.label }));

function pullRequestLinkContextMenuItems(
  openLabel: string,
  open: LinkContextMenuOpen | undefined,
): readonly ContextMenuItem<PullRequestLinkContextMenuAction>[] {
  return [
    ...(open ? [{ id: "open" as const, label: open.label }] : []),
    {
      id: "copy-link",
      label: m(msg("Copy link")),
      icon: "copy",
      ...(open ? { separatorBefore: true } : {}),
    },
    { id: "open-external", label: openLabel },
  ];
}

export async function showPullRequestLinkContextMenu({
  url,
  openLabel,
  open,
  position,
  source,
}: {
  readonly url: string;
  readonly openLabel: string;
  readonly open?: LinkContextMenuOpen | undefined;
  readonly position: { readonly x: number; readonly y: number };
  readonly source: ContextMenuSource;
}): Promise<void> {
  const api = readLocalApi();
  if (!api) return;
  let action: PullRequestLinkContextMenuAction | null = null;
  try {
    action = await api.contextMenu.show(
      pullRequestLinkContextMenuItems(openLabel, open),
      position,
      source,
    );
  } catch {
    return;
  }
  if (action === "open") {
    open?.run();
    return;
  }
  try {
    if (action === "copy-link")
      await writeTextToClipboard(url, {
        target: "link",
        unavailableMessage: msg("Clipboard API is unavailable while copying link."),
        failureMessage: msg("Failed to copy link to the clipboard."),
      });
    else if (action === "open-external") await api.shell.openExternal(url);
  } catch {
    toastManager.add({
      type: "error",
      title:
        action === "copy-link"
          ? m(msg("Could not copy the link"))
          : m(msg("Could not open the link")),
    });
  }
}
