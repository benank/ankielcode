import type { IssueReaction, IssueReactionContent } from "@ankielcode/contracts";
import { trimOptionalString as trimmed } from "@ankielcode/source-control-core/server/pullRequestUtils";

import type * as GitHubSchema from "../../schema/github.graphql.ts";
import type { ReactionGroup } from "./reactions.graphql.ts";

const REACTION_CONTENT_BY_GITHUB: Readonly<Record<string, IssueReactionContent>> = {
  THUMBS_UP: "thumbs-up",
  THUMBS_DOWN: "thumbs-down",
  LAUGH: "laugh",
  HOORAY: "hooray",
  CONFUSED: "confused",
  HEART: "heart",
  ROCKET: "rocket",
  EYES: "eyes",
};

const GITHUB_REACTION_BY_CONTENT: Readonly<
  Record<IssueReactionContent, GitHubSchema.ReactionContent>
> = {
  "thumbs-up": "THUMBS_UP",
  "thumbs-down": "THUMBS_DOWN",
  laugh: "LAUGH",
  hooray: "HOORAY",
  confused: "CONFUSED",
  heart: "HEART",
  rocket: "ROCKET",
  eyes: "EYES",
};

export function gitHubReactionContent(content: IssueReactionContent): GitHubSchema.ReactionContent {
  return GITHUB_REACTION_BY_CONTENT[content];
}

/** Keep the viewer in counts, not actors, to avoid duplicating 'You'. */
export function toReactions(
  groups: ReadonlyArray<ReactionGroup> | null | undefined,
  viewer: string | null,
): ReadonlyArray<IssueReaction> {
  const normalizedViewer = viewer?.toLowerCase() ?? null;
  const reactions: IssueReaction[] = [];
  for (const group of groups ?? []) {
    const content = REACTION_CONTENT_BY_GITHUB[trimmed(group.content)?.toUpperCase() ?? ""];
    if (content === undefined) continue;
    const logins = (group.reactors.nodes ?? []).flatMap((node) =>
      node !== null && "login" in node ? (trimmed(node.login) ?? []) : [],
    );
    const count = Math.max(group.reactors.totalCount, logins.length);
    if (count <= 0) continue;
    const actors =
      normalizedViewer === null
        ? logins
        : logins.filter((login) => login.toLowerCase() !== normalizedViewer);
    reactions.push({ content, count, actors, viewerHasReacted: group.viewerHasReacted });
  }
  return reactions;
}
