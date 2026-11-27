import Foundation
import Testing

@testable import AnkielKit

@Suite("Thread fixtures")
struct ThreadFixtureTests {
  @Test("every fixture decodes without skipping an item", arguments: ThreadFixtures.names)
  func decodes(_ name: String) throws {
    let items = try ThreadFixtures.items(name)
    #expect(!items.isEmpty)
    for item in items {
      if case .skipped(_, let reason) = item { Issue.record("\(name): skipped \(reason)") }
    }
    guard case .snapshot(let snapshot) = items.first else {
      Issue.record("\(name) does not start with a snapshot")
      return
    }
    #expect(!snapshot.projection.visibleTurnItems.isEmpty)
    #expect(snapshot.projection.visibleTurnItems.map(\.position) == Array(snapshot.projection.visibleTurnItems.indices))
  }

  @Test("fixtures carry no home paths, emails or tokens", arguments: ThreadFixtures.names)
  func scrubbed(_ name: String) throws {
    let text = String(decoding: try ThreadFixtures.data(name), as: UTF8.self)
    // Every text is invented (a made-up tide-chart project); nothing comes from real conversations.
    #expect(text.contains(#""synthetic":true"#))
    #expect(!text.contains("/Users/"))
    let emails = text.matches(of: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/).map { String($0.output) }
    #expect(emails.allSatisfy { $0.hasSuffix("@example.com") }, "\(Set(emails))")
    #expect(text.firstMatch(of: /\b(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|gho_[A-Za-z0-9]{8,}|xox[abp]-)/) == nil)
    #expect(text.firstMatch(of: /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/) == nil)
  }

  @Test("an unknown item kind decodes as a quiet unknown body, not a dropped row")
  func unknownKind() throws {
    let projection = try ThreadFixtures.projection("thread-kinds")
    let unknown = try #require(projection.visibleTurnItems.first { $0.item.type == "hologram_projection" })
    #expect(unknown.item.body == .unknown(type: "hologram_projection"))
    #expect(unknown.item.title == "Projected a hologram")
  }

  /// The TypeScript reducer (`applyOrchestrationV2ProjectionEvent`) run over the same fixtures
  /// produced `thread-reducer-golden.json`: `position:type:status:sourceItemId` per visible row.
  /// The TS client drops unknown item kinds; this client keeps them, so they are filtered here.
  @Test("the reducer matches the TypeScript reducer on the fixtures", arguments: ["thread-replay", "thread-subagents", "thread-kinds"])
  func golden(_ name: String) throws {
    let golden = try JSONDecoder().decode([String: [String]].self, from: Fixture.data("thread-reducer-golden"))
    let expected = try #require(golden["\(name).json"])
    let rows = try ThreadFixtures.projection(name).visibleTurnItems.filter { $0.item.type != "hologram_projection" }
    let actual = rows.enumerated().map { "\($0.offset):\($0.element.item.type):\($0.element.item.status.rawValue):\($0.element.sourceItemId)" }
    #expect(actual == expected)
  }
}

@Suite("Thread reducer")
struct ThreadReducerTests {
  @Test("inserts live turn items by authoritative ordinal")
  func insertsByOrdinal() {
    var projection = Make.projection(runs: [Make.run()], items: [Make.command("item-queued-future", ordinal: 300)])
    ThreadReducer.apply(Make.itemEvent(Make.command("item-active", ordinal: 201)), to: &projection)
    #expect(projection.visibleTurnItems.map(\.item.id) == ["item-active", "item-queued-future"])
    #expect(projection.visibleTurnItems.map(\.position) == [0, 1])
  }

  @Test("moves an updated item to its new ordinal and renumbers the rows it passes")
  func movesItem() {
    var inherited = Make.command("item-inherited", ordinal: 0)
    inherited.threadId = "parent"
    let items = [Make.command("item-a", ordinal: 1), Make.command("item-b", ordinal: 2), Make.command("item-c", ordinal: 2)]
    var projection = Make.projection(runs: [Make.run()], items: items)
    projection.visibleTurnItems = [ProjectedTurnItem(position: 0, item: inherited, visibility: .inherited)]
      + items.enumerated().map { ProjectedTurnItem(position: $0.offset + 1, item: $0.element) }

    ThreadReducer.apply(Make.itemEvent(Make.command("item-a", "moved", ordinal: 2)), to: &projection)
    // Equal ordinals order by id, so item-a stays ahead of item-b.
    #expect(projection.visibleTurnItems.map { "\($0.item.id)@\($0.position)" } == [
      "item-inherited@0", "item-a@1", "item-b@2", "item-c@3",
    ])
    #expect(projection.turnItems.map(\.id) == ["item-a", "item-b", "item-c"])

    ThreadReducer.apply(Make.itemEvent(Make.command("item-a", "later", ordinal: 3)), to: &projection)
    #expect(projection.visibleTurnItems.map { "\($0.item.id)@\($0.position)" } == [
      "item-inherited@0", "item-b@1", "item-c@2", "item-a@3",
    ])
  }

  @Test("replaces a streamed item in place and stamps a new revision")
  func replacesInPlace() {
    var projection = Make.projection(runs: [Make.run()], items: [Make.assistant("answer", "Hel", streaming: true)])
    projection.stampRevisions()
    let before = projection.visibleTurnItems[0].item.revision
    ThreadReducer.apply(Make.itemEvent(Make.assistant("answer", "Hello", streaming: true)), to: &projection)
    #expect(projection.visibleTurnItems.count == 1)
    #expect(projection.visibleTurnItems[0].item.revision > before)
    guard case .assistantMessage(let message) = projection.visibleTurnItems[0].item.body else {
      Issue.record("not a message")
      return
    }
    #expect(message.text == "Hello")
  }

  @Test("hides a steer that fell back to the queue until its run starts")
  func hidesQueuedSteer() {
    let steer = Make.user("steer", "also this", ordinal: 5, run: "run-queued", intent: .queuedTurn)
    var projection = Make.projection(runs: [Make.run(), Make.run("run-queued", .queued, start: nil, end: nil)])
    ThreadReducer.apply(Make.itemEvent(steer), to: &projection)
    #expect(projection.visibleTurnItems.isEmpty)
    #expect(projection.turnItems.count == 1)

    ThreadReducer.apply(Make.event(.run(Make.run("run-queued", .running, end: nil)), type: "run.updated"), to: &projection)
    #expect(projection.visibleTurnItems.map(\.item.id) == ["item-steer"])
  }

  @Test("a rolled-back run hides its items and keeps inherited rows")
  func rolledBack() {
    var inherited = Make.command("item-parent", ordinal: 0)
    inherited.threadId = "parent"
    let items = [Make.user("prompt"), Make.command("item-cmd", ordinal: 2)]
    var projection = Make.projection(runs: [Make.run()], items: items)
    projection.visibleTurnItems.insert(ProjectedTurnItem(position: 0, item: inherited, visibility: .inherited), at: 0)
    ThreadReducer.apply(Make.event(.run(Make.run(Make.runId, .rolledBack)), type: "run.updated"), to: &projection)
    #expect(projection.visibleTurnItems.map(\.item.id) == ["item-parent"])
    #expect(projection.visibleTurnItems.map(\.position) == [0])
  }

  @Test("keeps the run output and token usage an update leaves out")
  func keepsHeldFields() {
    var run = Make.run()
    run.output = ["ok": true]
    var projection = Make.projection(runs: [run])
    ThreadReducer.apply(Make.event(.run(Make.run()), type: "run.updated"), to: &projection)
    #expect(projection.runs[0].output == ["ok": true])

    let turn = ProviderTurn(id: "turn", status: "running", model: nil, tokenUsage: .init(usedTokens: 120, maxTokens: 1000))
    projection.providerTurns = [turn]
    ThreadReducer.apply(
      Make.event(.providerTurn(ProviderTurn(id: "turn", status: "completed", model: nil, tokenUsage: nil)), type: "provider-turn.updated"),
      to: &projection)
    #expect(projection.providerTurns[0].tokenUsage?.usedTokens == 120)
    #expect(projection.providerTurns[0].status == "completed")
  }

  @Test("visits do not bump updatedAt; lifecycle events do")
  func visitsDoNotBump() {
    var projection = Make.projection()
    var thread = projection.thread
    thread.title = "Visited"
    ThreadReducer.apply(Make.event(.thread(thread), type: "thread.visited", at: 50), to: &projection)
    #expect(projection.thread.title == "Visited")
    #expect(projection.updatedAt == Make.time)
    ThreadReducer.apply(Make.event(.thread(thread), type: "thread.settled", at: 60), to: &projection)
    #expect(projection.updatedAt == Make.at(60))
  }

  @Test("ignores another thread's events")
  func otherThread() {
    var projection = Make.projection()
    var event = Make.itemEvent(Make.command("item-x"))
    event.threadId = "someone-else"
    #expect(ThreadReducer.apply(event, to: &projection) == false)
    #expect(projection.turnItems.isEmpty)
  }

  @Test("a superseded interrupt result hides unless its stop request is present")
  func supersededInterrupt() {
    var result = Make.command("item-result", ordinal: 3)
    result.nodeId = "root"
    result.type = "run_interrupt_result"
    result.body = .runInterruptResult(message: "Stopped")
    var projection = Make.projection(runs: [Make.run()])
    projection.attempts = [RunAttempt(id: "attempt", runId: Make.runId, rootNodeId: "root", status: "superseded")]
    ThreadReducer.apply(Make.itemEvent(result), to: &projection)
    #expect(projection.visibleTurnItems.isEmpty)

    var request = Make.command("item-request", ordinal: 2)
    request.type = "run_interrupt_request"
    request.body = .runInterruptRequest(message: "Stop")
    ThreadReducer.apply(Make.itemEvent(request), to: &projection)
    ThreadReducer.apply(Make.itemEvent(result), to: &projection)
    #expect(projection.visibleTurnItems.map(\.item.id) == ["item-request", "item-result"])
  }

  @Suite("partial timeline")
  struct Partial {
    @Test("drops updates for items older than the window")
    func dropsOld() {
      var projection = Make.projection(runs: [Make.run()], items: [Make.command("item-window", ordinal: 50)])
      let partial = ThreadReducer.PartialWindow(latestLocalTurnOrdinal: 50)
      ThreadReducer.apply(Make.itemEvent(Make.command("item-old", ordinal: 10, run: "other-run")), to: &projection, partial: partial)
      #expect(projection.turnItems.map(\.id) == ["item-window"])
    }

    @Test("keeps a running run's item when the window starts after its earlier items")
    func keepsRunning() {
      var projection = Make.projection(
        runs: [Make.run(Make.runId, .running, end: nil)], items: [Make.command("item-window", ordinal: 50)])
      let partial = ThreadReducer.PartialWindow(latestLocalTurnOrdinal: 50)
      ThreadReducer.apply(Make.itemEvent(Make.command("item-late", ordinal: 10)), to: &projection, partial: partial)
      #expect(projection.visibleTurnItems.map(\.item.id) == ["item-late", "item-window"])
    }
  }
}
