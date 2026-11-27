import Foundation
import Observation

/// One open thread as the UI sees it. Shared by every screen showing the thread (one live stream),
/// and kept for a short while after the last one closes (cache with cursor, open folds and the
/// scroll anchor) so going back and forth is instant.
@MainActor @Observable
public final class ThreadDetailModel {
  public nonisolated let ref: ThreadRef
  public private(set) var state = ThreadDetailState()
  /// Open run folds and work groups.
  public var expanded: Set<String> = []
  /// Where the feed was when the reader left (`.end` when they were at the bottom).
  public var scrollAnchor: FeedScroll.Anchor = .end
  /// Full items fetched when a row expands (the stream strips command output).
  public private(set) var details: [String: DetailLoad] = [:]

  public enum DetailLoad: Sendable, Equatable {
    case loading
    case loaded(TurnItem)
    /// The server no longer has the item.
    case missing
    /// No connection to ask.
    case offline
    case failed(String)
  }

  @ObservationIgnored public let sync: ThreadDetailSync
  @ObservationIgnored var consumers = 0
  @ObservationIgnored var expiry: Task<Void, Never>?
  @ObservationIgnored private var feed: Task<Void, Never>?
  @ObservationIgnored var loadItem: (@Sendable (String) async throws -> TurnItem?)?

  public init(ref: ThreadRef, sync: ThreadDetailSync) {
    self.ref = ref
    self.sync = sync
    feed = Task { [weak self, sync] in
      for await state in sync.states {
        guard let self else { return }
        self.state = state
      }
    }
  }

  isolated deinit {
    feed?.cancel()
    expiry?.cancel()
  }

  public func toggle(_ id: String) {
    if expanded.contains(id) { expanded.remove(id) } else { expanded.insert(id) }
  }

  /// Fetches the full item behind a row once (`orchestration.getTurnItem`).
  public func loadDetail(itemId: String, revision: Int) {
    let key = "\(itemId)@\(revision)"
    switch details[key] {
    case .loading?, .loaded?: return
    case .failed?, .missing?, .offline?, nil: break
    }
    guard let loadItem else {
      details[key] = .offline
      return
    }
    details[key] = .loading
    Task {
      do {
        if let item = try await loadItem(itemId) {
          details[key] = .loaded(item)
        } else {
          details[key] = .missing
        }
      } catch EnvironmentRequestError.notConnected {
        details[key] = .offline
      } catch {
        details[key] = .failed(String(describing: error))
      }
    }
  }

  public func detail(itemId: String, revision: Int) -> DetailLoad? {
    details["\(itemId)@\(revision)"]
  }

  @ObservationIgnored private var lastOperation: Task<Void, Never>?

  /// Runs attach/detach on the sync in the order they were asked for: separate tasks are
  /// unordered, and a late detach must not stop the stream of a thread reopened meanwhile.
  public func enqueue(_ operation: @escaping @Sendable (ThreadDetailSync) async -> Void) {
    let previous = lastOperation
    let sync = sync
    lastOperation = Task {
      await previous?.value
      await operation(sync)
    }
  }

  /// Follows `source` directly (fixtures and previews; the registry attaches live sessions).
  public func start(_ source: any ThreadItemSource) {
    enqueue { await $0.attach(source) }
  }
}

/// `orchestration.getTurnItem` input and result.
struct TurnItemRequest: Encodable, Sendable {
  static let rpcTag = "orchestration.getTurnItem"
  var threadId: String
  var itemId: String
}

struct TurnItemResult: Decodable, Sendable {
  var item: TurnItem?

  enum CodingKeys: String, CodingKey { case item }

  init(from decoder: any Decoder) throws {
    item = try decoder.container(keyedBy: CodingKeys.self).loose(TurnItem.self, .item)
  }
}
