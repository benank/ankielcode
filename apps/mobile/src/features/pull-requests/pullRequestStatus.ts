import type { IssueLinkedPullRequest } from "@ankielcode/contracts";
import { msg } from "gt-react-native";

import type { AppSymbolName } from "../../components/ui/AppSymbol";
import { m, type MessageResolver } from "../../i18n/messages";
import { PullRequestGlyph } from "./pullRequestGlyphs";

const STATES = {
  open: {
    label: msg("Open", { $context: "pull request state" }),
    icon: PullRequestGlyph.pullRequest,
    tint: "accent-signal-success",
  },
  merged: {
    label: msg("Merged", { $context: "pull request state" }),
    icon: PullRequestGlyph.merged,
    // oxlint-disable-next-line ankielcode/no-palette-color-classes -- pull request merged glyph keeps forge violet
    tint: "accent-adaptive-violet-600-400",
  },
  closed: {
    label: msg("Closed", { $context: "pull request state" }),
    icon: PullRequestGlyph.closed,
    tint: "accent-danger-foreground",
  },
  draft: {
    label: msg("Draft", { $context: "pull request state" }),
    icon: PullRequestGlyph.draft,
    tint: "accent-icon-muted",
  },
} satisfies Record<string, { label: string; icon: AppSymbolName; tint: string }>;

export function pullRequestStatus(
  pr: Pick<IssueLinkedPullRequest, "state" | "isDraft">,
  resolve: MessageResolver = m,
) {
  const status = STATES[pr.isDraft && pr.state === "open" ? "draft" : pr.state];
  return { ...status, label: resolve(status.label) };
}
