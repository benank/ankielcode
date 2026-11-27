import AnkielKit
import Foundation

/// Debug-only threads from the bundled fixtures (`Thread/Fixtures`, excluded from Release), so the
/// thread screen can be exercised and screenshotted without a server. They run through the same
/// decode, reduce and timeline path as a live stream. Open one with
/// `ANKIEL_DEBUG_THREAD=<name>`; see `apps/ios/README.md`.
enum ThreadDebug {
  static let environmentId = "fixture"

  static func isFixture(_ ref: ThreadRef) -> Bool { ref.environmentId == environmentId }

  static func environmentLabel(_ ref: ThreadRef) -> String? {
    isFixture(ref) ? String(localized: "Fixture", comment: "debug: a thread loaded from a bundled file") : nil
  }

  #if DEBUG
    @MainActor private static var models: [String: ThreadDetailModel] = [:]

    /// The fixture's shared model; replays restart when reopened after finishing.
    @MainActor static func model(_ ref: ThreadRef, style: MarkdownStyle) -> ThreadDetailModel {
      if let model = models[ref.threadId] { return model }
      let model = ThreadDetailModel(ref: ref, sync: ThreadDetailSync(threadId: ref.threadId, style: style))
      models[ref.threadId] = model
      if let source = source(ref.threadId) {
        model.start(source)
      } else {
        // A child thread named by a fixture has no data of its own.
        model.enqueue { await $0.markUnavailable() }
      }
      return model
    }

    /// The fixture model already open for `ref`, if any (the fake composer sink writes into it).
    @MainActor static func existing(_ ref: ThreadRef) -> ThreadDetailModel? { models[ref.threadId] }

    /// A thread the fake sink "launched": an empty projection holding its first message.
    @MainActor static func registerLaunched(_ launch: ThreadLaunch) {
      let ref = ThreadRef(environmentId: environmentId, threadId: launch.threadId)
      let model = ThreadDetailModel(ref: ref, sync: ThreadDetailSync(threadId: launch.threadId))
      models[launch.threadId] = model
      let projection = ThreadProjection(
        thread: AppThread(id: launch.threadId, projectId: launch.projectId, title: launch.title), updatedAt: WireTimestamp(Date.now))
      let messageId = launch.messageId
      let text = launch.text
      let attachments = launch.attachments
      model.enqueue { sync in
        await sync.seed(projection, sequence: 1)
        await sync.debugAppendUserMessage(messageId: messageId, text: text, attachments: attachments)
      }
    }

    /// `short`, `markdown`, `subagents`, `rich-markdown`, `pending`, `failed`, `kinds`, `replay`
    /// (a streaming turn, paced like a live one), `long` (500+ rows, built from the real fixtures).
    static func source(_ name: String) -> FixtureSource? {
      switch name {
      case "long": longThread().map { FixtureSource(items: $0, pace: nil) }
      case "replay": items("thread-replay").map { FixtureSource(items: $0, pace: .milliseconds(140)) }
      default: items("thread-\(name)").map { FixtureSource(items: $0, pace: nil) }
      }
    }

    static func items(_ file: String) -> [ThreadStreamItem]? {
      guard let url = Bundle.main.url(forResource: file, withExtension: "json"), let data = try? Data(contentsOf: url)
      else { return nil }
      struct Document: Decodable { var items: [ThreadStreamItem] }
      return try? JSONDecoder().decode(Document.self, from: data).items
    }

    /// The fixture's id of the thread each item belongs to (fixtures set it to the file's thread).
    static func threadId(of items: [ThreadStreamItem]) -> String? {
      guard case .snapshot(let snapshot)? = items.first else { return nil }
      return snapshot.projection.thread.id
    }

    /// A long thread: the real markdown and subagent threads' turns repeated until it has 500+
    /// visible rows, with ids and ordinals rewritten so every row is distinct.
    static func longThread() -> [ThreadStreamItem]? {
      guard case .snapshot(let base)? = items("thread-markdown")?.first,
        case .snapshot(let other)? = items("thread-subagents")?.first
      else { return nil }
      var projection = base.projection
      let threadId = projection.thread.id
      projection.thread.title = String(localized: "A very long thread", comment: "debug fixture title")
      projection.runs = []
      projection.turnItems = []
      projection.visibleTurnItems = []
      projection.messages = []
      var ordinal = 0
      var copy = 0
      while projection.visibleTurnItems.count < 500 {
        let source = copy.isMultiple(of: 2) ? base.projection : other.projection
        for run in source.runs {
          var run = run
          run.id = "\(run.id)#\(copy)"
          projection.runs.append(run)
        }
        for row in source.visibleTurnItems {
          var item = row.item
          ordinal += 1
          item.id = "\(item.id)#\(copy)"
          item.threadId = threadId
          item.ordinal = ordinal
          item.runId = item.runId.map { "\($0)#\(copy)" }
          item.body = rekey(item.body, copy: copy)
          projection.turnItems.append(item)
          projection.visibleTurnItems.append(ProjectedTurnItem(position: projection.visibleTurnItems.count, item: item))
        }
        copy += 1
      }
      return [.snapshot(ThreadSnapshot(snapshotSequence: 1, projection: projection)), .synchronized]
    }

    /// Message ids key the feed's rows, so copies need their own.
    private static func rekey(_ body: TurnItemBody, copy: Int) -> TurnItemBody {
      switch body {
      case .userMessage(var message):
        message.messageId += "#\(copy)"
        return .userMessage(message)
      case .assistantMessage(var message):
        message.messageId += "#\(copy)"
        return .assistantMessage(message)
      default:
        return body
      }
    }
  #endif
}

#if DEBUG
  /// Plays fixture stream items into a sync: the snapshot at once, then each event after `pace`
  /// (nil: all at once), like a live stream. Ignores resumes: every subscription replays.
  struct FixtureSource: ThreadItemSource {
    let items: [ThreadStreamItem]
    let pace: Duration?

    func threadItems(_ subscription: ThreadSubscription) async throws -> RpcStream<ThreadStreamItem> {
      let (stream, continuation) = AsyncThrowingStream.makeStream(of: ThreadStreamItem.self)
      let items = items
      let pace = pace
      let task = Task {
        for item in items {
          if case .event = item, let pace { try? await Task.sleep(for: pace) }
          if Task.isCancelled { return }
          continuation.yield(item)
        }
      }
      return .local(stream) {
        task.cancel()
        continuation.finish()
      }
    }
  }
#endif
