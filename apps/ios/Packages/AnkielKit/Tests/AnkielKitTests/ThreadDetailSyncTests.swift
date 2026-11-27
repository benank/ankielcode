import Foundation
import Synchronization
import Testing

@testable import AnkielKit

/// Scripted thread streams: each subscription takes the next item list; the stream stays open
/// after its items (like a live one) until the reader lets go.
final class ScriptedThreadSource: ThreadItemSource {
  let state = Mutex<(streams: [[ThreadStreamItem]], subscriptions: [ThreadSubscription], stops: Int)>(([], [], 0))

  init(_ streams: [[ThreadStreamItem]]) {
    state.withLock { $0.streams = streams }
  }

  var subscriptions: [ThreadSubscription] { state.withLock { $0.subscriptions } }
  var stops: Int { state.withLock { $0.stops } }

  func threadItems(_ subscription: ThreadSubscription) async throws -> RpcStream<ThreadStreamItem> {
    let items = state.withLock { state -> [ThreadStreamItem] in
      state.subscriptions.append(subscription)
      return state.streams.isEmpty ? [] : state.streams.removeFirst()
    }
    let (stream, continuation) = AsyncThrowingStream.makeStream(of: ThreadStreamItem.self)
    for item in items { continuation.yield(item) }
    return .local(stream) { [self] in
      self.state.withLock { $0.stops += 1 }
      continuation.finish()
    }
  }
}

@Suite("Thread detail sync")
struct ThreadDetailSyncTests {
  static func snapshot(_ sequence: Int, items: [TurnItem] = [Make.user("ask")]) -> ThreadStreamItem {
    .snapshot(ThreadSnapshot(snapshotSequence: sequence, projection: Make.projection(runs: [Make.run()], items: items)))
  }

  static func event(_ sequence: Int, _ item: TurnItem) -> ThreadStreamItem {
    .event(sequence: sequence, Make.itemEvent(item))
  }

  @Test("goes live from a cold snapshot, then resumes from its cursor after a detach")
  func resume() async throws {
    let source = ScriptedThreadSource([
      [Self.snapshot(10), .synchronized, Self.event(12, Make.command("item-a", ordinal: 1))],
      [Self.event(13, Make.command("item-b", ordinal: 2)), .synchronized],
    ])
    let sync = ThreadDetailSync(threadId: Make.threadId, interval: .zero)
    await sync.attach(source)
    await eventuallyAsync { await sync.sequence == 12 }
    #expect(await sync.current.phase == .live)
    #expect(source.subscriptions.first?.afterSequence == nil)
    #expect(source.subscriptions.first?.requestCompletionMarker == true)

    await sync.detach()
    #expect(await sync.current.phase == .stale)
    await eventuallyAsync { source.stops == 1 }
    #expect(await sync.projection?.turnItems.count == 2)

    await sync.attach(source)
    await eventuallyAsync { await sync.sequence == 13 }
    #expect(source.subscriptions.last?.afterSequence == 12)
    await eventuallyAsync { await sync.current.phase == .live }
    await sync.flush()
    #expect(await sync.current.timeline.rows.count >= 2)
  }

  @Test("ignores replayed sequences and advances past skipped items")
  func cursor() async {
    let sync = ThreadDetailSync(threadId: Make.threadId, interval: .zero)
    _ = await sync.apply(Self.snapshot(5))
    _ = await sync.apply(Self.event(4, Make.command("item-old", ordinal: 1)))
    #expect(await sync.projection?.turnItems.count == 1)
    _ = await sync.apply(.skipped(sequence: 9, reason: "unknown event"))
    #expect(await sync.sequence == 9)
    _ = await sync.apply(Self.event(8, Make.command("item-late", ordinal: 1)))
    #expect(await sync.projection?.turnItems.count == 1)
    #expect(await sync.skippedCount == 1)
  }

  @Test("a deleted thread stops the stream and clears the rows")
  func deleted() async {
    let sync = ThreadDetailSync(threadId: Make.threadId, interval: .zero)
    _ = await sync.apply(Self.snapshot(5))
    let outcome = await sync.apply(.event(sequence: 6, Make.event(.thread(AppThread(id: Make.threadId, projectId: "p", title: "x")), type: "thread.deleted")))
    #expect(outcome == .stop)
    #expect(await sync.current.phase == .deleted)
    #expect(await sync.projection == nil)
  }

  @Test("streamed updates coalesce into few publishes")
  func coalesces() async {
    let sync = ThreadDetailSync(threadId: Make.threadId, interval: .seconds(60))
    _ = await sync.apply(Self.snapshot(1))
    let afterSnapshot = await sync.publishCount
    var text = ""
    for step in 0..<30 {
      text += "word \(step) "
      _ = await sync.apply(Self.event(2 + step, Make.assistant("answer", text, streaming: true)))
    }
    // The first update publishes at once only if the interval has passed; the rest wait.
    #expect(await sync.publishCount - afterSnapshot <= 1)
    await sync.flush()
    let state = await sync.current
    guard case .assistant(let answer)? = state.timeline.rows.last?.content else {
      Issue.record("no answer row")
      return
    }
    #expect(answer.text == text)
  }
}

/// `eventually` for conditions that need an await.
func eventuallyAsync(_ condition: () async -> Bool) async {
  for _ in 0..<20_000 {
    if await condition() { return }
    await Task.yield()
  }
}
