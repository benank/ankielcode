import Foundation
import Testing

@testable import AnkielKit

/// The thread-detail fixtures. They live in the app target (`AnkielCode/Thread/Fixtures`, bundled
/// into Debug builds for the fixture debug hook) and are read here from the source tree, so the
/// app and the tests share one copy.
enum ThreadFixtures {
  static let names = [
    "thread-short", "thread-markdown", "thread-subagents", "thread-rich-markdown", "thread-pending",
    "thread-failed", "thread-kinds", "thread-replay",
  ] + requestFixtures

  /// Written by `Fixtures/requests/make-request-fixtures.mjs`.
  static let requestFixtures = [
    "thread-approval-command", "thread-approval-file-change", "thread-approval-file-read", "thread-approval-permission",
    "thread-approval-mcp", "thread-approval-stale", "thread-approvals-queued", "thread-question-single", "thread-question-multi",
    "thread-question-text", "thread-question-other", "thread-question-steps", "thread-question-message", "thread-secret",
    "thread-secret-fields", "thread-requests-mixed", "thread-question-resolved",
  ]

  static var directory: URL {
    URL(filePath: #filePath)
      .deletingLastPathComponent()  // Tests/AnkielKitTests
      .deletingLastPathComponent()  // Tests
      .deletingLastPathComponent()  // AnkielKit
      .deletingLastPathComponent()  // Packages
      .deletingLastPathComponent()  // apps/ios
      .appending(path: "AnkielCode/Thread/Fixtures", directoryHint: .isDirectory)
  }

  static func data(_ name: String) throws -> Data {
    try Data(contentsOf: directory.appending(path: "\(name).json"))
  }

  /// `{"items": [<stream item>, …]}`.
  struct Document: Decodable {
    var items: [ThreadStreamItem]
  }

  static func items(_ name: String) throws -> [ThreadStreamItem] {
    try JSONDecoder().decode(Document.self, from: data(name)).items
  }

  /// The projection after applying every item, the way the sync does.
  static func projection(_ name: String) throws -> ThreadProjection {
    var projection: ThreadProjection?
    var sequence = -1
    for item in try items(name) {
      switch item {
      case .snapshot(let snapshot):
        projection = snapshot.projection
        projection?.stampRevisions()
        sequence = snapshot.snapshotSequence
      case .event(let next, let event) where next > sequence:
        sequence = next
        if var current = projection {
          ThreadReducer.apply(event, to: &current)
          projection = current
        }
      default:
        break
      }
    }
    return try #require(projection)
  }

  static func timeline(_ name: String) throws -> ThreadTimeline {
    ThreadTimelineBuilder.build(try projection(name), markdown: MarkdownParser())
  }
}

// MARK: - Builders for hand-made projections

enum Make {
  static let threadId = "thread-reducer"
  static let runId = "run-reducer"
  static let time = WireTimestamp(rawValue: "2026-06-20T00:00:00.000Z")

  static func at(_ seconds: Int) -> WireTimestamp {
    WireTimestamp(Date(timeIntervalSince1970: 1_781_913_600 + TimeInterval(seconds)))
  }

  static func projection(runs: [Run] = [], items: [TurnItem] = []) -> ThreadProjection {
    ThreadProjection(
      thread: AppThread(id: threadId, projectId: "project-reducer", title: "Reducer"), runs: runs, turnItems: items,
      visibleTurnItems: items.enumerated().map { ProjectedTurnItem(position: $0.offset, item: $0.element) },
      updatedAt: time)
  }

  static func run(_ id: String = runId, _ status: RunStatus = .completed, start: Int? = 0, end: Int? = 10) -> Run {
    Run(id: id, status: status, startedAt: start.map(at), completedAt: end.map(at))
  }

  static func command(
    _ id: String, _ input: String = "pwd", ordinal: Int = 1, run: String? = runId, status: TurnItemStatus = .completed,
    exit: Int? = 0, at seconds: Int = 1
  ) -> TurnItem {
    var command = TurnItemBody.CommandExecution(input: input)
    command.exitCode = exit
    return TurnItem(
      id: id, threadId: threadId, runId: run, ordinal: ordinal, status: status, startedAt: at(seconds),
      completedAt: at(seconds), updatedAt: at(seconds), body: .commandExecution(command))
  }

  static func user(
    _ id: String, _ text: String = "Do it", ordinal: Int = 0, run: String? = runId,
    intent: TurnItemBody.UserMessage.InputIntent = .turnStart, at seconds: Int = 0
  ) -> TurnItem {
    TurnItem(
      id: "item-\(id)", threadId: threadId, runId: run, ordinal: ordinal, status: .completed, startedAt: at(seconds),
      updatedAt: at(seconds), body: .userMessage(.init(messageId: id, text: text, inputIntent: intent)))
  }

  static func assistant(
    _ id: String, _ text: String = "Done.", ordinal: Int = 9, run: String? = runId, streaming: Bool = false,
    phase: String? = nil, at seconds: Int = 10
  ) -> TurnItem {
    TurnItem(
      id: "item-\(id)", threadId: threadId, runId: run, ordinal: ordinal, status: streaming ? .running : .completed,
      startedAt: at(seconds), updatedAt: at(seconds),
      body: .assistantMessage(.init(messageId: id, text: text, streaming: streaming, phase: phase)))
  }

  static func reasoning(_ id: String, _ text: String, ordinal: Int, status: TurnItemStatus = .completed) -> TurnItem {
    TurnItem(
      id: id, threadId: threadId, runId: runId, ordinal: ordinal, status: status, startedAt: at(2), updatedAt: at(2),
      body: .reasoning(.init(text: text, streaming: status == .running)))
  }

  static func event(_ payload: ThreadEvent.Payload, type: String, at seconds: Int = 20) -> ThreadEvent {
    ThreadEvent(id: "event-\(type)", type: type, threadId: threadId, occurredAt: at(seconds), payload: payload)
  }

  static func itemEvent(_ item: TurnItem) -> ThreadEvent {
    event(.turnItem(item), type: "turn-item.updated")
  }
}
