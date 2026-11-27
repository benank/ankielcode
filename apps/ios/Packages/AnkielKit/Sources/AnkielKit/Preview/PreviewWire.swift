import Foundation

/// `PreviewNavStatus` (`packages/contracts/src/preview.ts`): what a browser tab shows.
public enum PreviewNavStatus: Sendable, Hashable, Decodable {
  case idle
  case loading(url: String, title: String)
  case success(url: String, title: String)
  case loadFailed(url: String, title: String, code: Int, description: String)
  case unknown(String)

  enum CodingKeys: String, CodingKey { case _tag, url, title, code, description }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    let tag = try c.decode(String.self, forKey: ._tag)
    let url = c.loose(String.self, .url) ?? ""
    let title = c.loose(String.self, .title) ?? ""
    switch tag {
    case "Idle": self = .idle
    case "Loading": self = .loading(url: url, title: title)
    case "Success": self = .success(url: url, title: title)
    case "LoadFailed":
      self = .loadFailed(
        url: url, title: title, code: c.loose(Int.self, .code) ?? 0, description: c.loose(String.self, .description) ?? "")
    default: self = .unknown(tag)
    }
  }

  public var url: String? {
    switch self {
    case .loading(let url, _), .success(let url, _), .loadFailed(let url, _, _, _): url
    case .idle, .unknown: nil
    }
  }

  public var title: String? {
    switch self {
    case .loading(_, let title), .success(_, let title), .loadFailed(_, let title, _, _): title
    case .idle, .unknown: nil
    }
  }
}

/// `PreviewSessionSnapshot`: one browser tab a thread opened (the agent's or a person's).
public struct PreviewTab: Sendable, Hashable, Decodable, Identifiable {
  public var threadId: String
  public var tabId: String
  public var navStatus: PreviewNavStatus
  public var canGoBack: Bool
  public var canGoForward: Bool
  /// `desktop` (a desktop app's own webview) or `server` (headless on the computer).
  public var runtime: String?
  public var updatedAt: WireTimestamp

  public var id: String { tabId }

  public init(
    threadId: String, tabId: String, navStatus: PreviewNavStatus, canGoBack: Bool = false, canGoForward: Bool = false,
    runtime: String? = "server", updatedAt: WireTimestamp
  ) {
    self.threadId = threadId
    self.tabId = tabId
    self.navStatus = navStatus
    self.canGoBack = canGoBack
    self.canGoForward = canGoForward
    self.runtime = runtime
    self.updatedAt = updatedAt
  }

  enum CodingKeys: String, CodingKey { case threadId, tabId, navStatus, canGoBack, canGoForward, runtime, updatedAt }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    threadId = try c.decode(String.self, forKey: .threadId)
    tabId = try c.decode(String.self, forKey: .tabId)
    navStatus = (try? c.decode(PreviewNavStatus.self, forKey: .navStatus)) ?? .unknown("")
    canGoBack = c.loose(Bool.self, .canGoBack) ?? false
    canGoForward = c.loose(Bool.self, .canGoForward) ?? false
    runtime = c.loose(String.self, .runtime)
    updatedAt = c.loose(WireTimestamp.self, .updatedAt) ?? WireTimestamp(rawValue: "")
  }

  /// RN `browserTabUrl`.
  public var url: String { navStatus.url ?? "" }

  /// RN `browserTabTitle`: the page title, else its host, else the address; nil for a new tab.
  public var displayTitle: String? {
    guard let url = navStatus.url else { return nil }
    let title = (navStatus.title ?? "").trimmingCharacters(in: .whitespaces)
    if !title.isEmpty { return title }
    return URLComponents(string: url).flatMap { components in
      components.host.map { host in components.port.map { "\(host):\($0)" } ?? host }
    } ?? url
  }
}

/// `preview.list {threadId}`.
public struct PreviewListRequest: Sendable, Hashable, Encodable {
  public static let rpcTag = "preview.list"
  public var threadId: String
  public init(threadId: String) { self.threadId = threadId }
}

/// `PreviewListResult`.
public struct PreviewList: Sendable, Hashable, Decodable {
  public var sessions: [PreviewTab]
  public var serverEpoch: String
  public var revision: Int

  public init(sessions: [PreviewTab], serverEpoch: String, revision: Int) {
    self.sessions = sessions
    self.serverEpoch = serverEpoch
    self.revision = revision
  }

  enum CodingKeys: String, CodingKey { case sessions, serverEpoch, revision }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    sessions = (try? c.decode(LossyArray<PreviewTab>.self, forKey: .sessions))?.elements ?? []
    serverEpoch = try c.decode(String.self, forKey: .serverEpoch)
    revision = try c.decode(Int.self, forKey: .revision)
  }
}

/// `subscribePreviewEvents {}`: every thread's tab changes on the computer.
public struct PreviewEventsRequest: Sendable, Hashable, Encodable {
  public static let rpcTag = "subscribePreviewEvents"
  public init() {}
}

/// `PreviewEvent`.
public struct PreviewEvent: Sendable, Hashable, Decodable {
  public enum Kind: Sendable, Hashable {
    case snapshot(PreviewTab)
    case failed(url: String, title: String, code: Int, description: String)
    case closed
    case unknown(String)
  }

  public var threadId: String
  public var tabId: String
  public var createdAt: WireTimestamp
  public var serverEpoch: String
  public var revision: Int
  public var kind: Kind

  public init(threadId: String, tabId: String, createdAt: WireTimestamp, serverEpoch: String, revision: Int, kind: Kind) {
    self.threadId = threadId
    self.tabId = tabId
    self.createdAt = createdAt
    self.serverEpoch = serverEpoch
    self.revision = revision
    self.kind = kind
  }

  enum CodingKeys: String, CodingKey { case threadId, tabId, createdAt, serverEpoch, revision, type, snapshot, url, title, code, description }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    threadId = try c.decode(String.self, forKey: .threadId)
    tabId = try c.decode(String.self, forKey: .tabId)
    createdAt = c.loose(WireTimestamp.self, .createdAt) ?? WireTimestamp(rawValue: "")
    serverEpoch = try c.decode(String.self, forKey: .serverEpoch)
    revision = try c.decode(Int.self, forKey: .revision)
    let type = try c.decode(String.self, forKey: .type)
    switch type {
    case "opened", "navigated", "resized": kind = .snapshot(try c.decode(PreviewTab.self, forKey: .snapshot))
    case "failed":
      kind = .failed(
        url: c.loose(String.self, .url) ?? "", title: c.loose(String.self, .title) ?? "",
        code: c.loose(Int.self, .code) ?? 0, description: c.loose(String.self, .description) ?? "")
    case "closed": kind = .closed
    default: kind = .unknown(type)
    }
  }
}

/// A thread's browser tabs from `preview.list` plus `subscribePreviewEvents` (RN
/// `threadPreviewTabsAtom`): a list may land after events it predates, so newer events replay
/// over each list; a restarted server (new epoch) resets revisions and needs a fresh list.
public struct PreviewTabsState: Sendable, Hashable {
  public private(set) var serverEpoch: String?
  public private(set) var revision = 0
  public private(set) var sessions: [PreviewTab] = []
  /// A list arrived, so an empty `sessions` means no tabs.
  public private(set) var listed = false
  private var list: PreviewList?
  private var replay: [PreviewEvent] = []

  static let maxReplay = 200

  public init() {}

  /// Tabs a phone can show: the server's headless ones (RN filters on `runtime == "server"`).
  public var serverTabs: [PreviewTab] { sessions.filter { $0.runtime == "server" } }

  /// The most recently changed tab (RN `latestBrowserTab`).
  public var latest: PreviewTab? { serverTabs.max { $0.updatedAt < $1.updatedAt } }

  public mutating func apply(list result: PreviewList) {
    if let list, list.serverEpoch == result.serverEpoch, result.revision < list.revision { return }
    list = result
    replay = replay.filter { $0.serverEpoch == result.serverEpoch && $0.revision > result.revision }
    serverEpoch = result.serverEpoch
    revision = result.revision
    sessions = result.sessions
    listed = true
    for event in replay { reduce(event) }
  }

  /// Applies an event for this thread. Returns true when a fresh list is needed (new epoch).
  @discardableResult
  public mutating func apply(event: PreviewEvent) -> Bool {
    if let list, list.serverEpoch == event.serverEpoch, event.revision <= list.revision { return false }
    replay = Array(replay.suffix(Self.maxReplay - 1)) + [event]
    if let serverEpoch, event.serverEpoch != serverEpoch { return true }
    reduce(event)
    return false
  }

  private mutating func reduce(_ event: PreviewEvent) {
    guard event.revision > revision else { return }
    let index = sessions.firstIndex { $0.tabId == event.tabId }
    switch event.kind {
    case .closed:
      if let index { sessions.remove(at: index) }
    case .failed(let url, let title, let code, let description):
      if let index {
        sessions[index].navStatus = .loadFailed(url: url, title: title, code: code, description: description)
        sessions[index].updatedAt = event.createdAt
      }
    case .snapshot(let tab):
      if let index { sessions[index] = tab } else { sessions.append(tab) }
    case .unknown:
      break
    }
    serverEpoch = event.serverEpoch
    revision = event.revision
  }
}
