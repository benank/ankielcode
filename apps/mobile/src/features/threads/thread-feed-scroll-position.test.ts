import { describe, expect, it } from "vite-plus/test";
import {
  resolveThreadFeedSubmissionAnchor,
  resolveThreadWorkGroupInitialScroll,
  retargetThreadFeedAnchor,
  settleThreadFeedAnchorHold,
} from "./thread-feed-scroll-position";

describe("tool-group scroll restoration", () => {
  const position = {
    rowId: "read-output",
    offsetWithinRow: 80,
    scrollOffset: 600,
  };

  it("restores the visible row and its detail offset rather than stale absolute pixels", () => {
    const before = [{ id: "first" }, { id: "read-output" }, { id: "last" }];
    const after = [{ id: "older" }, ...before];
    expect(resolveThreadWorkGroupInitialScroll(before, position)).toEqual({
      index: 1,
      viewOffset: -80,
    });
    expect(resolveThreadWorkGroupInitialScroll(after, position)).toEqual({
      index: 2,
      viewOffset: -80,
    });
  });
});

describe("resolveThreadFeedSubmissionAnchor", () => {
  const send = {
    currentAnchorMessageId: "first-message",
    submittedMessageId: "second-message",
    startsTurn: true,
    queuedMessageCount: 0,
    deliveryDeferred: false,
  };

  it("moves every message that starts a turn to the top", () => {
    expect(resolveThreadFeedSubmissionAnchor({ ...send, currentAnchorMessageId: null })).toBe(
      "second-message",
    );
    expect(resolveThreadFeedSubmissionAnchor(send)).toBe("second-message");
  });

  it("keeps the current anchor for a message that waits or steers", () => {
    for (const waiting of [
      { deliveryDeferred: true },
      { startsTurn: false },
      { queuedMessageCount: 1 },
    ]) {
      expect(resolveThreadFeedSubmissionAnchor({ ...send, ...waiting })).toBe("first-message");
      expect(
        resolveThreadFeedSubmissionAnchor({ ...send, ...waiting, currentAnchorMessageId: null }),
      ).toBeNull();
    }
  });
});

describe("thread feed anchor", () => {
  const inFeed = (ids: ReadonlyArray<string>) => (id: string) => ids.includes(id);

  it("keeps the previous anchor until the sent row is in the feed", () => {
    const held = { messageId: "first", hold: "held" } as const;
    expect(retargetThreadFeedAnchor(held, "second", inFeed(["first"]))).toBe(held);
    expect(retargetThreadFeedAnchor(held, "second", inFeed(["first", "second"]))).toEqual({
      messageId: "second",
      hold: "landing",
    });
    expect(retargetThreadFeedAnchor(null, null, inFeed([]))).toBeNull();
  });

  it("holds end follow once the anchor has landed at the top, until the reader reaches the end", () => {
    const landing = { messageId: "sent", hold: "landing" } as const;
    const atTop = { anchorReady: true, blankSpace: 320, atEnd: true };
    // Still scrolling up, or rows below the anchor not measured yet.
    expect(settleThreadFeedAnchorHold(landing, { ...atTop, atEnd: false })).toBe(landing);
    expect(settleThreadFeedAnchorHold(landing, { ...atTop, anchorReady: false })).toBe(landing);

    const held = settleThreadFeedAnchorHold(landing, atTop);
    expect(held).toEqual({ messageId: "sent", hold: "held" });
    // The reply fills the blank space, then outgrows it while the reader stays put.
    expect(settleThreadFeedAnchorHold(held, { ...atTop, blankSpace: 40 })).toBe(held);
    expect(settleThreadFeedAnchorHold(held, { ...atTop, blankSpace: 0, atEnd: false })).toBe(held);
    expect(settleThreadFeedAnchorHold(held, { ...atTop, blankSpace: 0 })).toEqual({
      messageId: "sent",
      hold: "released",
    });
  });

  it("follows the end when a sent message leaves no blank space", () => {
    expect(
      settleThreadFeedAnchorHold(
        { messageId: "long", hold: "landing" },
        { anchorReady: true, blankSpace: 0, atEnd: true },
      ),
    ).toEqual({ messageId: "long", hold: "released" });
  });
});
