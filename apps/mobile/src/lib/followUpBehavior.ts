import type { ActiveTurnComposerAction } from "@ankielcode/client-runtime/state/composer-dispatch";

export type FollowUpBehavior = Extract<ActiveTurnComposerAction, "queue" | "steer">;

export const DEFAULT_FOLLOW_UP_BEHAVIOR: FollowUpBehavior = "steer";
