import Foundation
import Observation

/// A computer the list can read from.
public struct PullRequestTarget: Sendable, Hashable {
  public var environmentId: String
  public var label: String
  public var connected: Bool
  public init(environmentId: String, label: String, connected: Bool) {
    self.environmentId = environmentId
    self.label = label
    self.connected = connected
  }
}

/// The last answered first page per computer and request, and the stats answered per row, on
/// disk so the list shows at once and refreshes behind it (RN pull-request cache and
/// `pullRequestStatsPersistence`).
public struct PullRequestListCache: Sendable {
  public let directory: URL?

  public init(directory: URL?) { self.directory = directory }

  struct File: Codable {
    var version = 1
    var heads: [String: PullRequestListResult]
    var stats: PullRequestStatsCache
  }

  @concurrent public func load() async -> (heads: [String: PullRequestListResult], stats: PullRequestStatsCache) {
    guard let url = directory?.appending(path: "pull-requests.json"), let data = try? Data(contentsOf: url),
      let file = try? JSONDecoder().decode(File.self, from: data), file.version == 1
    else { return ([:], PullRequestStatsCache()) }
    return (file.heads, file.stats)
  }

  @concurrent public func save(heads: [String: PullRequestListResult], stats: PullRequestStatsCache) async {
    guard let directory else { return }
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    try? JSONEncoder().encode(File(heads: heads, stats: stats)).write(to: directory.appending(path: "pull-requests.json"), options: .atomic)
  }
}

/// The pull request list: controls, query, every computer's pages, paging and refresh.
@MainActor
@Observable
public final class PullRequestListModel {
  public enum Phase: Sendable, Hashable { case idle, loading, loaded }

  public struct ComputerError: Sendable, Hashable, Identifiable {
    public var environmentId: String
    public var projectTitle: String?
    public var message: String
    public var id: String { "\(environmentId) \(projectTitle ?? "") \(message)" }
  }

  public var controls: PullRequestListControls {
    didSet { if controls != oldValue { saveControls(); reload() } }
  }
  /// The search field's text; applied after a short pause.
  public var query = "" {
    didSet { if query != oldValue { scheduleQuery() } }
  }
  /// Only this computer's pull requests (nil: every computer).
  public var environmentId: String? {
    didSet { if environmentId != oldValue { saveControls(); reload() } }
  }

  public private(set) var phase: Phase = .idle
  public private(set) var refreshing = false
  public private(set) var loadingMore = false
  public private(set) var loadMoreError: PullRequestError?
  /// A whole computer that could not answer (signed out, unsupported, offline).
  public private(set) var failures: [String: PullRequestError] = [:]
  public private(set) var projectErrors: [ComputerError] = []
  public private(set) var items: [PullRequestListItem] = []
  public private(set) var providers: [String: [PullRequestProviderSummary]] = [:]
  public private(set) var viewers: [String: String] = [:]
  /// Authors and labels seen in this list, kept while the filters change.
  public private(set) var knownAuthors: [String] = []
  public private(set) var knownLabels: [String] = []
  public private(set) var labelColors: [String: String] = [:]

  @ObservationIgnored let source: any PullRequestSource
  @ObservationIgnored let targets: @MainActor () -> [PullRequestTarget]
  @ObservationIgnored let cache: PullRequestListCache
  @ObservationIgnored let defaults: UserDefaults?
  @ObservationIgnored private var pages: [String: PullRequestListPages] = [:]
  @ObservationIgnored private var requests: [String: PullRequestListRequest] = [:]
  @ObservationIgnored private var cachedHeads: [String: PullRequestListResult] = [:]
  @ObservationIgnored private var stats = PullRequestStatsCache()
  @ObservationIgnored private var cacheLoaded = false
  @ObservationIgnored private var loadTask: Task<Void, Never>?
  @ObservationIgnored private var queryTask: Task<Void, Never>?
  @ObservationIgnored private var statsTask: Task<Void, Never>?
  @ObservationIgnored private var appliedQuery = ""
  @ObservationIgnored private var generation = 0

  static let controlsKey = "ankiel.pullRequestList.v1"

  struct Saved: Codable {
    var controls: PullRequestListControls
    var environmentId: String?
  }

  public init(
    source: any PullRequestSource, targets: @escaping @MainActor () -> [PullRequestTarget], cache: PullRequestListCache,
    defaults: UserDefaults?
  ) {
    self.source = source
    self.targets = targets
    self.cache = cache
    self.defaults = defaults
    let saved = defaults?.data(forKey: Self.controlsKey).flatMap { try? JSONDecoder().decode(Saved.self, from: $0) }
    controls = saved?.controls ?? PullRequestListControls()
    environmentId = saved?.environmentId
  }

  private func saveControls() {
    defaults?.set(try? JSONEncoder().encode(Saved(controls: controls, environmentId: environmentId)), forKey: Self.controlsKey)
  }

  /// The computers this list reads.
  public var activeTargets: [PullRequestTarget] {
    let all = targets()
    let chosen = environmentId.flatMap { id in all.contains { $0.environmentId == id } ? id : nil }
    return all.filter { target in
      (chosen == nil || target.environmentId == chosen)
        && (controls.projectEnvironmentId == nil || target.environmentId == controls.projectEnvironmentId)
    }
  }

  public var hasMore: Bool { pages.values.contains(where: PullRequestList.hasMore) }

  /// Rows that loaded but whose computer is not connected now.
  public var offline: Bool { !activeTargets.isEmpty && activeTargets.allSatisfy { !$0.connected } }

  func cacheKey(_ environmentId: String, _ request: PullRequestListRequest) -> String {
    let data = (try? JSONEncoder.sortedWire.encode(request)) ?? Data()
    return "\(environmentId)|\(String(decoding: data, as: UTF8.self))"
  }

  /// Starts (or restarts) the first page for every computer, showing cached rows first.
  public func reload() {
    generation += 1
    let generation = generation
    loadTask?.cancel()
    loadTask = Task { [weak self] in await self?.load(generation: generation, refresh: false) }
  }

  /// Pull to refresh: asks every computer to drop its shared cache first.
  public func refresh() async {
    generation += 1
    let generation = generation
    loadTask?.cancel()
    refreshing = true
    for target in activeTargets where target.connected { await source.invalidate(nil, in: target.environmentId) }
    await load(generation: generation, refresh: true)
    refreshing = false
  }

  private func scheduleQuery() {
    queryTask?.cancel()
    queryTask = Task { [weak self] in
      try? await Task.sleep(for: .milliseconds(180))
      guard let self, !Task.isCancelled else { return }
      let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
      guard trimmed != appliedQuery else { return }
      appliedQuery = trimmed
      reload()
    }
  }

  private func load(generation: Int, refresh: Bool) async {
    if !cacheLoaded {
      cacheLoaded = true
      let loaded = await cache.load()
      cachedHeads = loaded.heads
      stats = loaded.stats
    }
    let targets = activeTargets
    let request = PullRequestList.request(controls, query: appliedQuery)
    pages = [:]
    requests = [:]
    failures = [:]
    loadMoreError = nil
    for target in targets {
      requests[target.environmentId] = request
      if let cached = cachedHeads[cacheKey(target.environmentId, request)] {
        pages[target.environmentId] = PullRequestListPages(head: cached)
      }
    }
    phase = pages.isEmpty ? .loading : .loaded
    publish()
    // Each computer answers on its own; rows show as each arrives.
    let reads = targets.filter(\.connected).map { target in
      Task { [weak self] in
        guard let self else { return }
        do throws(PullRequestError) {
          let head = try await source.list(request, in: target.environmentId)
          guard generation == self.generation else { return }
          pages[target.environmentId] = PullRequestList.head(nil, head)
          cachedHeads[cacheKey(target.environmentId, request)] = head
          failures[target.environmentId] = nil
        } catch {
          guard generation == self.generation else { return }
          failures[target.environmentId] = error
          if case .notConnected = error {} else { pages[target.environmentId] = nil }
        }
        publish()
      }
    }
    for read in reads { await read.value }
    guard generation == self.generation else { return }
    phase = .loaded
    publish()
    loadStats()
    await persist()
  }

  /// The next page of every computer that has one.
  public func loadMore() async {
    guard !loadingMore, hasMore else { return }
    loadingMore = true
    loadMoreError = nil
    let generation = generation
    for (environmentId, current) in pages {
      guard let request = requests[environmentId], let next = PullRequestList.nextRequest(current, after: request) else { continue }
      do throws(PullRequestError) {
        let page = try await source.list(next, in: environmentId)
        guard generation == self.generation, let held = pages[environmentId] else { break }
        pages[environmentId] = PullRequestList.append(held, page: page, request: next)
        requests[environmentId] = next
      } catch {
        loadMoreError = error
      }
    }
    loadingMore = false
    publish()
    loadStats()
  }

  /// Fills the rows the listing gave no line counts for.
  private func loadStats() {
    statsTask?.cancel()
    let byEnvironment = Dictionary(grouping: items.filter { $0.entry.additions + $0.entry.deletions == 0 }, by: \.environmentId)
    statsTask = Task { [weak self] in
      guard let self else { return }
      for (environmentId, rows) in byEnvironment {
        let missing = stats.missing(rows.map(\.entry))
        guard !missing.isEmpty, targets().first(where: { $0.environmentId == environmentId })?.connected == true else { continue }
        let refs = missing.map { PullRequestRef(projectId: $0.projectId, host: $0.host, repository: $0.repository, number: $0.number) }
        guard let answered = try? await source.stats(refs, in: environmentId), !Task.isCancelled else { continue }
        stats.answered(answered)
        publish()
      }
      stats.trim()
      await persist()
    }
  }

  private func persist() async {
    // Keep the newest 40 heads; each is one page.
    if cachedHeads.count > 40 { cachedHeads = Dictionary(uniqueKeysWithValues: cachedHeads.prefix(40).map { ($0.key, $0.value) }) }
    await cache.save(heads: cachedHeads, stats: stats)
  }

  /// Rebuilds `items` and the facets from the pages.
  private func publish() {
    var all: [PullRequestListItem] = []
    var viewers: [String: String] = [:]
    var localSearch = Set<String>()
    var providers: [String: [PullRequestProviderSummary]] = [:]
    var errors: [ComputerError] = []
    for (environmentId, page) in pages {
      _ = stats.listed(page.entries)
      let entries = PullRequestList.withStats(page.entries, stats: stats.stats)
      all += entries.map { PullRequestListItem(environmentId: environmentId, entry: $0) }
      for (host, viewer) in page.head.viewers { viewers["\(environmentId) \(host)"] = viewer }
      for provider in page.head.providers where !provider.searchesOnHost { localSearch.insert("\(environmentId) \(provider.host)") }
      providers[environmentId] = page.head.providers
      errors += page.head.errors.map { ComputerError(environmentId: environmentId, projectTitle: $0.projectTitle, message: $0.message) }
    }
    let connected = Set(targets().filter(\.connected).map(\.environmentId))
    let filtered = PullRequestList.filter(
      all, controls: controls, viewers: viewers, query: appliedQuery, localSearchHosts: localSearch, connected: connected)
    if filtered != items { items = filtered }
    self.viewers = viewers
    self.providers = providers
    projectErrors = errors
    let facets = PullRequestList.facets(all.map(\.entry))
    knownAuthors = Array(Set(knownAuthors + facets.authors)).sorted { $0.localizedCompare($1) == .orderedAscending }
    knownLabels = Array(Set(knownLabels + facets.labels)).sorted { $0.localizedCompare($1) == .orderedAscending }
    labelColors.merge(facets.colors) { held, _ in held }
  }

  /// Applies an action's answer to its row at once (RN `patchPullRequestListEntry`).
  public func patch(_ item: PullRequestListItem, state: PullRequestState?, isDraft: Bool?) {
    guard var page = pages[item.environmentId], let index = page.entries.firstIndex(where: { PullRequestList.key(host: $0.host, repository: $0.repository, number: $0.number) == item.key }) else { return }
    if let state { page.entries[index].state = .known(state) }
    if let isDraft { page.entries[index].isDraft = isDraft }
    pages[item.environmentId] = page
    publish()
  }

  /// Resets the menus (Reset filters).
  public func resetFilters() {
    controls = PullRequestListControls()
  }
}

extension JSONEncoder {
  static var sortedWire: JSONEncoder {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return encoder
  }
}
