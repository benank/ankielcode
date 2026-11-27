import AnkielKit
import Foundation
import Observation

/// Where issues are read from: a computer, or (Debug) canned issues with no server.
@MainActor
protocol IssueSource {
  func list(_ request: IssueListRequest, environmentId: String) async throws(EnvironmentRequestError) -> IssueListResult
  func detail(_ ref: IssueRef, environmentId: String) async throws(EnvironmentRequestError) -> IssueDetail
  func olderComments(_ ref: IssueRef, cursor: String, environmentId: String) async throws(EnvironmentRequestError) -> IssueCommentsPage
}

extension EnvironmentRegistry: IssueSource {
  func list(_ request: IssueListRequest, environmentId: String) async throws(EnvironmentRequestError) -> IssueListResult {
    try await issues(request, in: environmentId)
  }

  func detail(_ ref: IssueRef, environmentId: String) async throws(EnvironmentRequestError) -> IssueDetail {
    try await issueDetail(ref, in: environmentId)
  }

  func olderComments(_ ref: IssueRef, cursor: String, environmentId: String) async throws(EnvironmentRequestError) -> IssueCommentsPage {
    try await olderIssueComments(ref, cursor: cursor, in: environmentId)
  }
}

/// One computer's issue list (RN `IssuesScreen`): state and project filters, a search the
/// trackers run, paging per scope. Read-only: writes (comment, close, edit, labels) are not built.
@MainActor @Observable
final class IssuesModel {
  enum Phase: Equatable {
    case idle, loading, loaded
    case failed(String)
  }

  let source: any IssueSource
  var environmentId: String?
  var state = IssueStateFilter.open { didSet { if state != oldValue { reload() } } }
  var projectId: String? { didSet { if projectId != oldValue { reload() } } }
  var query = ""
  private(set) var phase = Phase.idle
  private(set) var result: IssueListResult?
  private(set) var loadingMore = false
  @ObservationIgnored private var task: Task<Void, Never>?

  init(source: any IssueSource, environmentId: String?) {
    self.source = source
    self.environmentId = environmentId
  }

  var entries: [IssueEntry] { result?.entries ?? [] }
  var canLoadMore: Bool { !(result?.nextCursors.isEmpty ?? true) }

  /// Trackers that cannot be read, in their own words.
  var unavailableTrackers: [IssueTracker] { result?.trackers.filter { !$0.configured } ?? [] }

  private func request(cursors: [String: String]? = nil, refresh: Bool = false) -> IssueListRequest {
    IssueListRequest(state: state, projectId: projectId, cursors: cursors, refresh: refresh ? true : nil, query: query)
  }

  func reload(refresh: Bool = false) {
    task?.cancel()
    task = Task { await load(refresh: refresh) }
  }

  func load(refresh: Bool = false) async {
    guard let environmentId else { return }
    if result == nil { phase = .loading }
    do {
      let answer = try await source.list(request(refresh: refresh), environmentId: environmentId)
      guard !Task.isCancelled else { return }
      result = answer
      phase = .loaded
    } catch {
      guard !Task.isCancelled else { return }
      phase = .failed(IssueCopy.describe(error))
    }
  }

  func loadMore() async {
    guard let environmentId, let current = result, !current.nextCursors.isEmpty, !loadingMore else { return }
    loadingMore = true
    defer { loadingMore = false }
    guard let page = try? await source.list(request(cursors: current.nextCursors), environmentId: environmentId) else { return }
    var merged = current
    let known = Set(current.entries.map(\.id))
    merged.entries = (current.entries + page.entries.filter { !known.contains($0.id) }).sorted { $0.updatedAt > $1.updatedAt }
    merged.nextCursors = page.nextCursors
    result = merged
  }
}

/// One issue (RN `IssueRouteScreen`, read-only): body, comments newest last, older pages.
@MainActor @Observable
final class IssueDetailModel {
  let entry: IssueEntry
  let environmentId: String
  private let source: any IssueSource
  private(set) var detail: IssueDetail?
  private(set) var olderComments: [IssueComment] = []
  private(set) var cursor: String?
  private(set) var error: String?
  private(set) var loadingOlder = false
  private(set) var body: MarkdownDocument?

  init(entry: IssueEntry, environmentId: String, source: any IssueSource) {
    self.entry = entry
    self.environmentId = environmentId
    self.source = source
  }

  var comments: [IssueComment] { olderComments + (detail?.comments ?? []) }

  func load() async {
    do {
      let loaded = try await source.detail(entry.ref, environmentId: environmentId)
      body = await Self.parse(loaded.body, style: .thread)
      detail = loaded
      cursor = loaded.commentsCursor
      error = nil
    } catch {
      self.error = IssueCopy.describe(error)
    }
  }

  func loadOlder() async {
    guard let cursor, !loadingOlder else { return }
    loadingOlder = true
    defer { loadingOlder = false }
    do {
      let page = try await source.olderComments(entry.ref, cursor: cursor, environmentId: environmentId)
      olderComments = page.comments + olderComments
      self.cursor = page.nextCursor
    } catch {
      self.error = IssueCopy.describe(error)
    }
  }

  @concurrent
  static func parse(_ text: String, style: MarkdownStyle) async -> MarkdownDocument {
    MarkdownParser(style: style).parse(text)
  }
}

enum IssueCopy {
  static func describe(_ error: EnvironmentRequestError) -> String {
    switch error {
    case .notConnected: String(localized: "Not connected")
    case .rejected(let message, _): message ?? String(localized: "The tracker refused it.")
    case .failed(let message): message
    }
  }

  static func relative(_ iso: String) -> String? {
    guard let date = WireTimestamp(rawValue: iso).date else { return nil }
    return date.formatted(.relative(presentation: .named))
  }
}
