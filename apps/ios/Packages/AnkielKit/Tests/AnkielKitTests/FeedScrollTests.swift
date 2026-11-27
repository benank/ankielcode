import Testing

@testable import AnkielKit

@Suite("Feed scroll anchor")
struct FeedScrollTests {
  static let rows = ["a": 0.0, "b": 400.0, "c": 900.0]
  static func top(_ id: String) -> Double? { rows[id] }

  @Test func opensAtTheEndAndFollows() {
    let scroll = FeedScroll()
    #expect(scroll.following)
    #expect(scroll.target(rowTop: Self.top, insetTop: 100, range: -100...2000) == 2000)
  }

  @Test func scrollingUpHoldsTheTopRow() {
    var scroll = FeedScroll()
    scroll.scrolled(distanceToEnd: 300, top: (id: "b", offset: -20))
    #expect(scroll.anchor == .row("b", offset: -20))
    // The row's top stays 20 pt above the visible top, wherever it moves in the content.
    #expect(scroll.target(rowTop: { $0 == "b" ? 700 : nil }, insetTop: 100, range: -100...2000) == 620)
  }

  @Test func scrollingNearTheEndFollowsAgain() {
    var scroll = FeedScroll(.row("b", offset: 0))
    scroll.contentChanged()
    #expect(scroll.unseen)
    scroll.scrolled(distanceToEnd: FeedScroll.threshold, top: (id: "c", offset: 0))
    #expect(scroll.following)
    #expect(!scroll.unseen)
  }

  @Test func newContentWhileFollowingRaisesNoDot() {
    var scroll = FeedScroll()
    scroll.contentChanged()
    #expect(!scroll.unseen)
  }

  @Test func sendingAlwaysReturnsToTheEnd() {
    var scroll = FeedScroll(.row("a", offset: 0))
    scroll.contentChanged()
    scroll.jumpToEnd()
    #expect(scroll.following)
    #expect(!scroll.unseen)
  }

  @Test func toggleHoldsTheTappedRowEvenAtTheEnd() {
    var scroll = FeedScroll()
    scroll.toggled("c", offset: 450)
    #expect(scroll.target(rowTop: Self.top, insetTop: 100, range: -100...5000) == 350)
    // It opened downward, so the end is now further away: keep holding the row.
    scroll.settled(distanceToEnd: 800)
    #expect(scroll.anchor == .row("c", offset: 450))
  }

  @Test func aHeldRowClampedAtTheEndFollows() {
    var scroll = FeedScroll(.row("c", offset: 450))
    scroll.contentChanged()
    scroll.settled(distanceToEnd: 0)
    #expect(scroll.following)
    #expect(!scroll.unseen)
  }

  @Test func targetIsClampedAndAMissingRowKeepsTheOffset() {
    let scroll = FeedScroll(.row("a", offset: 300))
    #expect(scroll.target(rowTop: Self.top, insetTop: 100, range: -100...2000) == -100)
    #expect(FeedScroll(.row("gone", offset: 0)).target(rowTop: Self.top, insetTop: 0, range: 0...10) == nil)
  }
}
