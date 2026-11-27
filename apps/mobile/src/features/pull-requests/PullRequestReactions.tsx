import {
  applyPendingPullRequestReactions,
  type PendingPullRequestReaction,
  PULL_REQUEST_REACTION_ORDER,
  pullRequestReactionEmoji,
  pullRequestReactionName,
  pullRequestReactionTooltip,
  pullRequestReactionsSignature,
} from "@ankielcode/client-runtime/pull-request-reactions";
import type { IssueReaction, IssueReactionContent } from "@ankielcode/contracts";
import { useGT, useLocale, useMessages } from "gt-react-native";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { Menu } from "../../components/ui/Menu";
import { cn } from "../../lib/cn";

const EMPTY_PENDING: ReadonlyMap<IssueReactionContent, PendingPullRequestReaction> = new Map();
const PILL = "min-h-8 flex-row items-center gap-1 rounded-full border px-2.5 active:opacity-70";

/** Reaction pills for any subject; `onReact` resolves false when the host refused the change. */
export function ReactionPills(props: {
  readonly reactions: ReadonlyArray<IssueReaction>;
  readonly canReact: boolean;
  readonly onReact: (content: IssueReactionContent, reacted: boolean) => Promise<boolean>;
  readonly onChanged?: () => void;
}) {
  // Keyed by what the host last reported, so a refresh that lands the change drops the overlay.
  const gt = useGT();
  const messages = useMessages();
  const locale = useLocale();
  const [pending, setPending] = useState({ signature: "", values: EMPTY_PENDING });
  const signature = pullRequestReactionsSignature(props.reactions);
  const values = pending.signature === signature ? pending.values : EMPTY_PENDING;
  const shown = applyPendingPullRequestReactions(props.reactions, values);
  const toggle = async (content: IssueReactionContent, reacted: boolean) => {
    const entry: PendingPullRequestReaction = { reacted };
    setPending({ signature, values: new Map([...values, [content, entry]]) });
    if (!(await props.onReact(content, reacted))) {
      setPending((current) => {
        if (current.values.get(content) !== entry) return current;
        const next = new Map(current.values);
        next.delete(content);
        return { signature: current.signature, values: next };
      });
      Dialog.alert(gt("Couldn't save the reaction"), gt("Try again in a moment."));
      return;
    }
    props.onChanged?.();
  };
  return (
    <>
      {shown.map((reaction) => (
        <Pressable
          key={reaction.content}
          accessibilityRole="button"
          accessibilityLabel={pullRequestReactionTooltip(reaction, messages, locale)}
          accessibilityState={{ selected: reaction.viewerHasReacted, disabled: !props.canReact }}
          disabled={!props.canReact}
          onPress={() => void toggle(reaction.content, !reaction.viewerHasReacted)}
          className={cn(
            PILL,
            reaction.viewerHasReacted
              ? "border-primary bg-primary/10"
              : "border-border-subtle bg-grouped-card",
          )}
        >
          <Text className="text-sm">{pullRequestReactionEmoji(reaction.content)}</Text>
          <Text className="text-xs font-ankiel-medium text-foreground-muted">{reaction.count}</Text>
        </Pressable>
      ))}
      {props.canReact ? (
        <Menu
          accessibilityLabel={gt("Add a reaction")}
          actions={PULL_REQUEST_REACTION_ORDER.map((content) => ({
            id: content,
            title: `${pullRequestReactionEmoji(content)}  ${pullRequestReactionName(content, messages)}`,
            state: shown.some(
              (reaction) => reaction.content === content && reaction.viewerHasReacted,
            )
              ? ("on" as const)
              : ("off" as const),
          }))}
          onPressAction={({ nativeEvent }) => {
            const content = PULL_REQUEST_REACTION_ORDER.find((id) => id === nativeEvent.event);
            if (!content) return;
            const reacted = shown.some(
              (reaction) => reaction.content === content && reaction.viewerHasReacted,
            );
            void toggle(content, !reacted);
          }}
        >
          <View className={cn(PILL, "border-border-subtle")}>
            <SymbolView name="face.smiling" size={15} tintColorClassName="accent-icon-muted" />
          </View>
        </Menu>
      ) : null}
    </>
  );
}
