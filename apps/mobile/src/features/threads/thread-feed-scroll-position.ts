export interface ThreadWorkGroupScrollPosition {
  readonly rowId: string;
  readonly offsetWithinRow: number;
  readonly scrollOffset: number;
}

export function resolveThreadWorkGroupInitialScroll(
  rows: ReadonlyArray<{ readonly id: string }>,
  position: ThreadWorkGroupScrollPosition | undefined,
) {
  const index = position ? rows.findIndex((row) => row.id === position.rowId) : -1;
  return index >= 0 && position ? { index, viewOffset: -position.offsetWithinRow } : undefined;
}

export function resolveThreadFeedSubmissionAnchor<AnchorId>(input: {
  readonly currentAnchorMessageId: AnchorId | null;
  readonly submittedMessageId: AnchorId;
  readonly startsTurn: boolean;
  readonly queuedMessageCount: number;
  readonly deliveryDeferred: boolean;
}): AnchorId | null {
  // A message that starts a turn now moves to the top; a steer or queued one keeps the anchor.
  if (input.deliveryDeferred || !input.startsTurn || input.queuedMessageCount > 0) {
    return input.currentAnchorMessageId;
  }
  return input.submittedMessageId;
}

/**
 * The sent message the feed keeps at its top with blank space below. `landing` follows the end
 * until the list has scrolled the anchor up; `held` stops end follow so a reply that outgrows the
 * blank space does not scroll the feed; `released` follows the end again.
 */
export interface ThreadFeedAnchor<AnchorId> {
  readonly messageId: AnchorId;
  readonly hold: "landing" | "held" | "released";
}

/** Switches to a newly requested anchor once its row is in the feed, so the old one holds until then. */
export function retargetThreadFeedAnchor<AnchorId>(
  current: ThreadFeedAnchor<AnchorId> | null,
  requested: AnchorId | null,
  isInFeed: (messageId: AnchorId) => boolean,
): ThreadFeedAnchor<AnchorId> | null {
  if (requested === null || requested === current?.messageId || !isInFeed(requested)) {
    return current;
  }
  return { messageId: requested, hold: "landing" };
}

export function settleThreadFeedAnchorHold<AnchorId>(
  anchor: ThreadFeedAnchor<AnchorId> | null,
  view: {
    /** The anchor and every row after it are measured. */
    readonly anchorReady: boolean;
    readonly blankSpace: number;
    readonly atEnd: boolean;
  },
): ThreadFeedAnchor<AnchorId> | null {
  if (anchor === null || !view.atEnd) return anchor;
  if (anchor.hold === "landing" && view.anchorReady) {
    return { ...anchor, hold: view.blankSpace > 0 ? "held" : "released" };
  }
  // Only the reader (or the scroll-to-end button) reaches the end once the reply outgrew the blank
  // space: the composer inset keeps the content end ahead of the anchored scroll offset.
  if (anchor.hold === "held" && view.blankSpace === 0) return { ...anchor, hold: "released" };
  return anchor;
}
