import Foundation
import Testing

@testable import AnkielKit

@Suite("Thread undo plans")
struct ThreadUndoTests {
  static let unsettledAt = WireTimestamp(rawValue: "2026-11-27T04:00:00.000Z")

  @Test func undoingASettleRestoresAManualActivePosition() throws {
    var thread = try Fixture.thread("t1")
    thread.pinnedAt = nil
    thread.snoozedUntil = nil
    thread.unsettledAt = Self.unsettledAt
    thread.activeOrderKey = "a0V"
    #expect(ThreadUndo.plan(.settle, before: thread) == [.unsettle(restoreUnsettledAt: .some(Self.unsettledAt)), .reorderActive(orderKey: "a0V")])
  }

  @Test func aPinnedThreadIsPlacedByItsPinNotItsActiveKey() throws {
    var thread = try Fixture.thread("t1")
    thread.pinnedAt = Self.unsettledAt
    thread.pinOrderKey = "n"
    thread.activeOrderKey = "a0V"
    thread.unsettledAt = nil
    let until = Date(timeIntervalSince1970: 1_800_000_000)
    thread.snoozedUntil = WireTimestamp(until)
    #expect(ThreadUndo.plan(.settle, before: thread) == [.unsettle(restoreUnsettledAt: .some(nil)), .pin(orderKey: "n"), .snooze(until: until)])
    #expect(ThreadUndo.plan(.unpin, before: thread) == [.pin(orderKey: "n"), .snooze(until: until)])
    #expect(ThreadUndo.plan(.snooze, before: thread) == [.unsnooze])
  }
}
