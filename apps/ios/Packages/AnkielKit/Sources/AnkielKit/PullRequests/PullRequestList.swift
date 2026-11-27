import Foundation

/// The list's saved choices (RN `PullRequestListControls`), per device.
public struct PullRequestListControls: Sendable, Hashable, Codable {
  public enum Sort: String, Sendable, Codable, CaseIterable { case updated, created, oldest }

  public var state: PullRequestListState = .open
  public var involvement: PullRequestInvolvement = .all
  public var filters = PullRequestListFilters()
  public var projectId: String?
  public var projectEnvironmentId: String?
  public var sort: Sort = .updated

  public init() {}

  public var isDefault: Bool { self == Self() }
}

/// One listed pull request and the computer that listed it.
public struct PullRequestListItem: Sendable, Hashable, Identifiable, Codable {
  public var environmentId: String
  public var entry: PullRequestListEntry

  public init(environmentId: String, entry: PullRequestListEntry) {
    self.environmentId = environmentId
    self.entry = entry
  }

  /// Host, repository and number, so one pull request listed by two computers is one row.
  public var key: String { PullRequestList.key(host: entry.host, repository: entry.repository, number: entry.number) }
  public var id: String { "\(environmentId):\(key)" }

  public var ref: PullRequestRef {
    PullRequestRef(projectId: entry.projectId, host: entry.host, repository: entry.repository, number: entry.number)
  }
}

/// The list's pages for one computer (RN `PullRequestListPages`).
public struct PullRequestListPages: Sendable, Hashable, Codable {
  public var head: PullRequestListResult
  public var entries: [PullRequestListEntry]
  public var nextCursors: [String: String]
  public var truncated: Bool
  public var limit: Int
  /// A later page was appended, so a refreshed head merges instead of replacing.
  public var continued: Bool

  public init(head: PullRequestListResult) {
    self.head = head
    entries = head.entries
    nextCursors = head.nextCursors
    truncated = head.truncated
    limit = PullRequestList.pageSize
    continued = false
  }
}

/// RN `pullRequestList.ts`: building the request, merging pages, and the device-side filter that
/// keeps rows the server could not filter (local-search hosts, involvement, typed qualifiers).
public enum PullRequestList {
  public static let pageSize = 30

  public static func key(host: String, repository: String, number: Int) -> String {
    "\(host.lowercased()):\(repository.lowercased()):\(number)"
  }

  public static func request(_ controls: PullRequestListControls, query: String) -> PullRequestListRequest {
    let parsed = PullRequestQuery.parse(query)
    return PullRequestListRequest(
      state: controls.state, involvement: controls.involvement, filters: controls.filters.overlaid(by: parsed.filters),
      projectId: controls.projectId, limit: pageSize, query: parsed.text.isEmpty ? nil : parsed.text)
  }

  /// The next page's request: by cursors when the server gave any, else a larger limit while the
  /// answer was truncated (up to 500); nil when there is no more.
  public static func nextRequest(_ pages: PullRequestListPages, after request: PullRequestListRequest) -> PullRequestListRequest? {
    var next = request
    if !pages.nextCursors.isEmpty {
      next.limit = pageSize
      next.cursors = pages.nextCursors
      return next
    }
    guard pages.truncated, pages.limit < 500 else { return nil }
    next.limit = min(pages.limit + pageSize, 500)
    return next
  }

  /// Newer observations win; the result is ordered newest update first.
  public static func merge(_ previous: [PullRequestListEntry], _ incoming: [PullRequestListEntry]) -> [PullRequestListEntry] {
    var byKey: [String: PullRequestListEntry] = [:]
    var order: [String] = []
    for entry in previous + incoming {
      let key = key(host: entry.host, repository: entry.repository, number: entry.number)
      if let held = byKey[key] {
        if (entry.observedAt ?? 0) >= (held.observedAt ?? 0) { byKey[key] = entry }
      } else {
        byKey[key] = entry
        order.append(key)
      }
    }
    return order.compactMap { byKey[$0] }.sorted { $0.updatedAt > $1.updatedAt }
  }

  public static func head(_ previous: PullRequestListPages?, _ head: PullRequestListResult) -> PullRequestListPages {
    guard var previous, previous.continued else { return PullRequestListPages(head: head) }
    previous.head = head
    previous.entries = merge(previous.entries, head.entries)
    return previous
  }

  public static func append(_ previous: PullRequestListPages, page: PullRequestListResult, request: PullRequestListRequest) -> PullRequestListPages {
    var next = previous
    next.entries = merge(previous.entries, page.entries)
    next.nextCursors = page.nextCursors
    next.truncated = page.truncated
    next.limit = request.limit ?? pageSize
    next.continued = true
    return next
  }

  public static func hasMore(_ pages: PullRequestListPages) -> Bool {
    !pages.nextCursors.isEmpty || (pages.truncated && pages.limit < 500)
  }

  /// RN `filterPullRequestList`: the device-side filter and sort over every computer's rows,
  /// one row per pull request (a connected computer's copy wins).
  public static func filter(
    _ items: [PullRequestListItem], controls: PullRequestListControls, viewers: [String: String], query: String,
    localSearchHosts: Set<String>, connected: Set<String>? = nil
  ) -> [PullRequestListItem] {
    let parsed = PullRequestQuery.parse(query)
    let words = parsed.text.lowercased().split(whereSeparator: \.isWhitespace).map(String.init)
    let filters = controls.filters.overlaid(by: parsed.filters)
    let kept = items.filter { item in
      let entry = item.entry
      if controls.state != .all, entry.state.rawValue != controls.state.rawValue { return false }
      if let projectId = controls.projectId, entry.projectId != projectId { return false }
      if let environmentId = controls.projectEnvironmentId, item.environmentId != environmentId { return false }
      let viewerKey = "\(item.environmentId) \(entry.host)"
      let viewer = viewers[viewerKey]
      if controls.involvement == .reviewing, !entry.viewerReviewRequested { return false }
      if controls.involvement == .authored {
        guard let viewer, entry.author?.login.lowercased() == viewer.lowercased() else { return false }
      }
      if filters.draft == .only, !entry.isDraft { return false }
      if filters.draft == .hide, entry.isDraft { return false }
      if let author = filters.author {
        let resolved = PullRequestQuery.resolveAuthor(author, viewer: viewer)
        if (entry.author?.login ?? "").lowercased() != resolved.lowercased() { return false }
      }
      if let review = filters.review {
        if review == .none {
          if entry.reviewDecision != nil { return false }
        } else if let decision = entry.reviewDecision, decision.rawValue != review.rawValue {
          return false
        }
      }
      if let checks = filters.checks, let state = entry.checksState, state.rawValue != checks.rawValue { return false }
      let labels = Set(entry.labels.map { $0.name.lowercased() })
      if let groups = filters.labels, groups.contains(where: { group in !group.contains { labels.contains($0.lowercased()) } }) {
        return false
      }
      if let excluded = filters.excludedLabels, excluded.contains(where: { labels.contains($0.lowercased()) }) { return false }
      if !words.isEmpty, localSearchHosts.contains(viewerKey) {
        let text =
          "\(entry.repository) #\(entry.number) \(entry.title) \(entry.author?.login ?? "") \(entry.headBranch) \(entry.baseBranch) \(entry.labels.map(\.name).joined(separator: " "))"
          .lowercased()
        if !words.allSatisfy(text.contains) { return false }
      }
      return true
    }
    var unique: [String: PullRequestListItem] = [:]
    var order: [String] = []
    for item in kept {
      if let held = unique[item.key] {
        if let connected, !connected.contains(held.environmentId), connected.contains(item.environmentId) { unique[item.key] = item }
      } else {
        unique[item.key] = item
        order.append(item.key)
      }
    }
    let rows = order.compactMap { unique[$0] }
    return rows.sorted { left, right in
      switch controls.sort {
      case .created: left.entry.createdAt > right.entry.createdAt
      case .oldest: left.entry.updatedAt < right.entry.updatedAt
      case .updated: left.entry.updatedAt > right.entry.updatedAt
      }
    }
  }

  /// Authors and labels seen on the loaded rows, for the filter menus.
  public static func facets(_ entries: [PullRequestListEntry]) -> (authors: [String], labels: [String], colors: [String: String]) {
    let authors = Set(entries.compactMap { $0.author?.login }).sorted { $0.localizedCompare($1) == .orderedAscending }
    let labels = Set(entries.flatMap { $0.labels.map(\.name) }).sorted { $0.localizedCompare($1) == .orderedAscending }
    var colors: [String: String] = [:]
    for label in entries.flatMap(\.labels) {
      let key = label.name.lowercased()
      if colors[key] == nil, let color = labelColor(label.color) { colors[key] = color }
    }
    return (authors, labels, colors)
  }

  /// A six-digit hex color with its `#`, or nil.
  public static func labelColor(_ color: String?) -> String? {
    guard var hex = color else { return nil }
    if hex.hasPrefix("#") { hex.removeFirst() }
    guard hex.count == 6, hex.allSatisfy(\.isHexDigit) else { return nil }
    return "#\(hex)"
  }

  public enum ReviewBadge: Sendable, Hashable { case changesRequested, approved, yourReview, reviewRequired }

  /// The row's review badge (RN `pullRequestListReviewStatus`).
  public static func reviewBadge(decision: WireEnum<PullRequestReviewDecision>?, viewerReviewRequested: Bool) -> ReviewBadge? {
    if decision == .changesRequested { return .changesRequested }
    if decision == .approved { return .approved }
    if viewerReviewRequested { return .yourReview }
    if decision == .reviewRequired { return .reviewRequired }
    return nil
  }

  /// Fills rows that list zero lines from the stats answers (GitHub listings omit counts).
  public static func withStats(_ entries: [PullRequestListEntry], stats: [String: PullRequestDiffStat]) -> [PullRequestListEntry] {
    guard !stats.isEmpty else { return entries }
    return entries.map { entry in
      guard entry.additions + entry.deletions == 0, let stat = stats[statKey(entry)], stat.additions + stat.deletions > 0 else { return entry }
      var filled = entry
      filled.additions = stat.additions
      filled.deletions = stat.deletions
      return filled
    }
  }

  public static func statKey(_ entry: PullRequestListEntry) -> String { "\(entry.projectId):\(entry.repository):\(entry.number)" }
  public static func statKey(_ stat: PullRequestDiffStat) -> String { "\(stat.projectId):\(stat.repository):\(stat.number)" }
}

/// Diff stats answered per row, kept with each row's `updatedAt` so a moved row drops its old
/// counts (stats carry no head). RN `withListedPullRequests` and `pullRequestStatsPersistence`.
public struct PullRequestStatsCache: Sendable, Hashable, Codable {
  public var stats: [String: PullRequestDiffStat] = [:]
  public var updatedAt: [String: WireTimestamp] = [:]

  public init() {}

  /// Records the rows a list answered; returns the keys whose stats must be read again.
  public mutating func listed(_ entries: [PullRequestListEntry]) -> [String] {
    var stale: [String] = []
    for entry in entries {
      let key = PullRequestList.statKey(entry)
      if updatedAt[key] != entry.updatedAt {
        if stats.removeValue(forKey: key) != nil || updatedAt[key] != nil { stale.append(key) }
        updatedAt[key] = entry.updatedAt
      }
    }
    return stale
  }

  public mutating func answered(_ answered: [PullRequestDiffStat]) {
    for stat in answered { stats[PullRequestList.statKey(stat)] = stat }
  }

  /// The rows still without counts, in order, at most `limit`.
  public func missing(_ entries: [PullRequestListEntry], limit: Int = 100) -> [PullRequestListEntry] {
    Array(entries.filter { $0.additions + $0.deletions == 0 && stats[PullRequestList.statKey($0)] == nil }.prefix(limit))
  }

  /// Keeps the newest `limit` rows (by key order of `updatedAt`), so the file stays small.
  public mutating func trim(to limit: Int = 2000) {
    guard updatedAt.count > limit else { return }
    let kept = Set(updatedAt.sorted { $0.value > $1.value }.prefix(limit).map(\.key))
    updatedAt = updatedAt.filter { kept.contains($0.key) }
    stats = stats.filter { kept.contains($0.key) }
  }
}
