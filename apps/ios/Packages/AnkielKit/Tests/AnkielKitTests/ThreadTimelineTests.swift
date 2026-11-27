import Foundation
import Testing

@testable import AnkielKit

@Suite("Thread timeline")
struct ThreadTimelineTests {
  private func build(_ projection: ThreadProjection) -> ThreadTimeline {
    ThreadTimelineBuilder.build(projection, markdown: MarkdownParser())
  }

  private func kinds(_ rows: [TimelineRow]) -> [String] {
    rows.map { row in
      switch row.content {
      case .user: "user"
      case .assistant: "assistant"
      case .fold: "fold"
      case .workGroup(let group): "group(\(group.count))"
      case .work(let work): work.inGroup ? "detail" : "work"
      case .subagent: "subagent"
      case .plan: "plan"
      case .notice: "notice"
      case .answered: "answered"
      case .working: "working"
      }
    }
  }

  @Test("a settled turn folds its work under one row and keeps the answer")
  func settledFold() throws {
    let projection = Make.projection(runs: [Make.run(start: 0, end: 124)], items: [
      Make.user("ask"),
      Make.reasoning("think", "**Looking around**\n\nfirst", ordinal: 1),
      Make.command("item-ls", "ls -la", ordinal: 2),
      Make.command("item-rg", "rg foo", ordinal: 3),
      Make.assistant("answer", "Here you go.", ordinal: 4),
    ])
    let timeline = build(projection)
    #expect(kinds(timeline.rows) == ["user", "fold", "group(3)", "detail", "detail", "detail", "assistant"])
    guard case .fold(let fold) = timeline.rows[1].content else { throw Expectation.failed }
    #expect(fold.label == .worked(seconds: 124))
    #expect(timeline.status == .idle)
    // Collapsed: the fold hides the work; open the fold, then the group.
    #expect(kinds(timeline.visibleRows(expanded: [])) == ["user", "fold", "assistant"])
    #expect(kinds(timeline.visibleRows(expanded: [fold.foldId])) == ["user", "fold", "group(3)", "assistant"])
    guard case .workGroup(let group) = timeline.rows[2].content else { throw Expectation.failed }
    #expect(timeline.visibleRows(expanded: [fold.foldId, group.groupId]).count == 7)
    guard case .assistant(let answer) = timeline.rows.last?.content else { throw Expectation.failed }
    #expect(answer.footer != nil)
  }

  @Test("a group summary counts actions, edits by distinct file")
  func summary() {
    func edit(_ id: String, _ paths: [String], ordinal: Int) -> TurnItem {
      var change = TurnItemBody.FileChange(fileName: paths[0])
      change.changes = LossyArray(paths.map { .init(operation: "update", path: $0) })
      return TurnItem(
        id: id, threadId: Make.threadId, runId: Make.runId, ordinal: ordinal, status: .completed, updatedAt: Make.at(3),
        body: .fileChange(change))
    }
    let activities = [
      Make.command("c1", ordinal: 1), Make.command("c2", ordinal: 2),
      edit("e1", ["a.swift", "b.swift"], ordinal: 3), edit("e2", ["a.swift"], ordinal: 4),
      Make.reasoning("r", "hm", ordinal: 5),
    ].map { WorkActivity(row: ProjectedTurnItem(position: 0, item: $0), attemptId: nil) }
    let summary = WorkSummary(activities)
    #expect(summary.clauses == [.init(action: .command, count: 2), .init(action: .edit, count: 2)])
    #expect(summary.otherCount == 0)
    #expect(summary.thoughts == nil)
    #expect(WorkSummary([activities[4]]).thoughts == 1)
  }

  @Test("an active run does not fold, shows its live call and a working row")
  func activeRun() throws {
    let projection = Make.projection(runs: [Make.run(Make.runId, .running, end: nil)], items: [
      Make.user("ask"),
      Make.command("item-done", "ls", ordinal: 1),
      Make.command("item-live", "cd app && rg -n scroll", ordinal: 2, status: .running, exit: nil),
    ])
    let timeline = build(projection)
    #expect(timeline.status == .working)
    #expect(kinds(timeline.rows) == ["user", "group(2)", "detail", "detail", "working"])
    guard case .workGroup(let group) = timeline.rows[1].content else { throw Expectation.failed }
    #expect(group.live)
    #expect(group.label == .activity(.program("rg", .inProgress)))
    guard case .working(let working) = timeline.rows.last?.content else { throw Expectation.failed }
    #expect(working.activity == .program("rg", .inProgress))
  }

  @Test("no working row while the reply streams")
  func streamingReply() {
    let projection = Make.projection(runs: [Make.run(Make.runId, .running, end: nil)], items: [
      Make.user("ask"), Make.assistant("answer", "Partial", streaming: true),
    ])
    #expect(kinds(build(projection).rows) == ["user", "assistant"])
  }

  @Test("a failed turn keeps each call on its own row and shows the error")
  func failedRun() throws {
    let timeline = try ThreadFixtures.timeline("thread-failed")
    #expect(timeline.status == .failed)
    let tail = Array(kinds(timeline.rows).suffix(4))
    #expect(tail == ["user", "work", "notice", "notice"])
    guard case .notice(let error) = timeline.rows[timeline.rows.count - 2].content else { throw Expectation.failed }
    #expect(error.tone == .error)
    #expect(error.label == .providerError)
    guard case .work(let command) = timeline.rows[timeline.rows.count - 3].content else { throw Expectation.failed }
    #expect(command.activity.outcome == .failure)
  }

  @Test("pending requests wait the thread and stay out of the feed (they dock above the composer)")
  func pendingRequests() throws {
    let timeline = try ThreadFixtures.timeline("thread-pending")
    #expect(timeline.status == .waiting)
    let pending = PendingRequestDerivation.derive(try ThreadFixtures.projection("thread-pending"))
    #expect(pending.approvals.map(\.requestKind) == ["command"])
    #expect(pending.approvals.first?.options?.map(\.label) == ["Allow once", "Allow for this session", "Decline"])
    #expect(pending.approvals.first?.isLive == true)
    #expect(pending.userInputs.map(\.questions.count) == [1])
  }

  @Test("every item kind renders a row, unknown ones quietly")
  func allKinds() throws {
    let timeline = try ThreadFixtures.timeline("thread-kinds")
    let all = timeline.visibleRows(expanded: Set(timeline.rows.compactMap { row -> String? in
      switch row.content {
      case .fold(let fold): fold.foldId
      case .workGroup(let group): group.groupId
      default: nil
      }
    }))
    let labels = all.compactMap { row -> ActivityLabel? in
      switch row.content {
      case .work(let work): work.activity.label
      case .notice(let notice): notice.label
      default: nil
      }
    }
    #expect(labels.contains(.unknown(type: "hologram_projection", title: "Projected a hologram")))
    #expect(labels.contains(.compaction(before: 549000, after: 16800)))
    #expect(labels.contains(.forked))
    #expect(all.contains { if case .plan = $0.content { true } else { false } })
    // RN leaves todo lists, checkpoints, link requests and stop requests out of the feed.
    #expect(!labels.contains(.todo))
    #expect(!labels.contains(.checkpoint))
    #expect(!labels.contains(.interruptRequested))
  }

  @Test("subagent calls become subagent rows that name the child thread")
  func subagents() throws {
    let timeline = try ThreadFixtures.timeline("thread-subagents")
    let rows = timeline.rows.compactMap { row -> SubagentRow? in
      if case .subagent(let subagent) = row.content { subagent } else { nil }
    }
    #expect(rows.count == 4)
    #expect(rows.allSatisfy { $0.childThreadId?.hasPrefix("thread:subagent:") == true })
  }

  @Test("the replayed stream ends settled with a footer on the answer")
  func replay() throws {
    let timeline = try ThreadFixtures.timeline("thread-replay")
    #expect(timeline.status == .idle)
    guard case .assistant(let answer) = timeline.rows.last?.content else { throw Expectation.failed }
    #expect(!answer.streaming)
    #expect(answer.footer != nil)
    #expect(answer.document.blocks.count > 1)
  }

  @Test("row ids are unique", arguments: ThreadFixtures.names)
  func uniqueIds(_ name: String) throws {
    let rows = try ThreadFixtures.timeline(name).rows
    #expect(Set(rows.map(\.id)).count == rows.count)
  }

  @Test("command program names")
  func programNames() {
    #expect(WorkActivity.programName("cd apps/ios && xcodebuild -scheme X") == "xcodebuild")
    #expect(WorkActivity.programName("FOO=1 sudo /usr/bin/rg -n x") == "rg")
    #expect(WorkActivity.programName("git status; git diff") == "git")
    #expect(WorkActivity.thoughtLine("**Planning the scroll model**\n\nmore") == "Planning the scroll model")
    #expect(WorkActivity.thoughtLine("First sentence. Second one.") == "First sentence.")
  }
}

enum Expectation: Error { case failed }

@Suite("Thread timeline cost")
struct ThreadTimelineCostTests {
  /// The Instruments-free number for the feed: deriving a 500+ row timeline from scratch, and
  /// again after one streamed change (markdown cached), on this machine.
  @Test("deriving a 500-row timeline")
  func cost() throws {
    let base = try ThreadFixtures.projection("thread-markdown")
    var projection = base
    projection.turnItems = []
    projection.visibleTurnItems = []
    projection.runs = []
    var ordinal = 0
    var copy = 0
    while projection.visibleTurnItems.count < 500 {
      projection.runs += base.runs.map { run in
        var run = run
        run.id += "#\(copy)"
        return run
      }
      for row in base.visibleTurnItems {
        var item = row.item
        ordinal += 1
        item.id += "#\(copy)"
        item.ordinal = ordinal
        item.runId = item.runId.map { "\($0)#\(copy)" }
        if case .assistantMessage(var message) = item.body {
          message.messageId += "#\(copy)"
          item.body = .assistantMessage(message)
        } else if case .userMessage(var message) = item.body {
          message.messageId += "#\(copy)"
          item.body = .userMessage(message)
        }
        projection.turnItems.append(item)
        projection.visibleTurnItems.append(ProjectedTurnItem(position: projection.visibleTurnItems.count, item: item))
      }
      copy += 1
    }
    let parser = MarkdownParser()
    let cache = TimelineCache()
    let clock = ContinuousClock()
    var timeline = ThreadTimeline.empty
    let cold = clock.measure { timeline = ThreadTimelineBuilder.build(projection, markdown: parser, cache: cache) }
    // One streamed change: the last item gets a new revision.
    projection.revisionClock += 1
    projection.visibleTurnItems[projection.visibleTurnItems.count - 1].item.revision = projection.revisionClock
    let warm = clock.measure { timeline = ThreadTimelineBuilder.build(projection, markdown: parser, cache: cache) }
    print("timeline: \(projection.visibleTurnItems.count) items → \(timeline.rows.count) rows; cold \(cold), warm \(warm)")
    #expect(timeline.rows.count > 100)
    #expect(warm < .milliseconds(100))
  }
}
