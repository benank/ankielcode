import AnkielKit
import Observation
import SwiftUI

/// Where the pull request screens go: the list, optionally with one pull request open on it.
struct PullRequestTarget: Hashable, Identifiable {
  let environmentId: String
  let ref: PullRequestRef
  var preview: PullRequestListEntry?

  var id: String { "\(environmentId):\(ref.key)" }

  static func == (lhs: Self, rhs: Self) -> Bool { lhs.id == rhs.id }
  func hash(into hasher: inout Hasher) { hasher.combine(id) }
}

/// A screen on the pull request stack.
enum PullRequestRoute: Hashable {
  case pullRequest(PullRequestTarget)
  case file(PullRequestTarget, path: String)
}

/// The pull request feature's shared state: where reads and writes go, the list, routing trust,
/// the detail cache, the branch summaries thread chips read, and what is presented.
@MainActor
@Observable
final class PullRequestFeature {
  /// The pull request screens over home (a full-screen stack), nil when closed.
  var presented = false
  /// Screens pushed on that stack (pull requests and their files), root first.
  var path: [PullRequestRoute] = []

  /// The pull request shown (the split view's selection).
  var selected: PullRequestTarget? {
    for route in path.reversed() { if case .pullRequest(let target) = route { return target } }
    return nil
  }

  let source: any PullRequestSource
  let sink: any PullRequestSink
  let trust: PullRequestRoutingStore
  let detailCache = PullRequestDetailCache()
  @ObservationIgnored let isFixture: Bool
  @ObservationIgnored private weak var app: AppModel?
  @ObservationIgnored private(set) lazy var list = PullRequestListModel(
    source: source, targets: { [weak self] in self?.targets ?? [] },
    cache: PullRequestListCache(directory: isFixture ? nil : Self.cacheDirectory), defaults: isFixture ? nil : .standard)
  /// Branch pull request summaries for thread chips, by `environmentId|ref.key`.
  private(set) var summaries: [String: PullRequestSummary] = [:]
  @ObservationIgnored private var summaryReads: Set<String> = []
  @ObservationIgnored private var models: [String: PullRequestDetailModel] = [:]
  #if DEBUG
    /// `ANKIEL_DEBUG_PR_OPEN` presets, consumed by the screen they open.
    var debugPreset: (kind: String, argument: String?)?
    var debugSheet: PullRequestListSheet?
    var debugLink: String?
  #endif

  static var cacheDirectory: URL {
    URL.cachesDirectory.appending(path: "AnkielCode/pull-requests", directoryHint: .isDirectory)
  }

  init(app: AppModel) {
    self.app = app
    #if DEBUG
      let debug = PullRequestDebug.current
    #else
      let debug: PullRequestDebug? = nil
    #endif
    trust = PullRequestRoutingStore(defaults: debug == nil ? .standard : nil)
    if let debug, let fixture = debug.fixtureSource {
      source = fixture
      isFixture = true
    } else {
      let service = LivePullRequestService(router: PullRequestRouter(registry: app.registry, trust: trust))
      source = service
      isFixture = false
    }
    if let debug, let fake = debug.sink {
      sink = fake
    } else if let live = source as? LivePullRequestService {
      sink = live
    } else {
      sink = RecordingPullRequestSink()
    }
  }

  /// Computers that serve pull requests (their config says `pullRequests`).
  var targets: [AnkielKit.PullRequestTarget] {
    if isFixture { return [.init(environmentId: PullRequestFixtures.environmentId, label: "Fixture Mac", connected: true)] }
    return (app?.registry.environments ?? []).filter { $0.isEnabled && $0.capabilities["pullRequests"]?.boolValue == true }.map {
      .init(environmentId: $0.id, label: $0.label, connected: $0.status.isConnected)
    }
  }

  /// Whether this session may send writes on `environmentId` (`source-control:write`).
  func canWrite(_ environmentId: String) -> Bool {
    if isFixture { return PullRequestDebug.current?.readOnly != true }
    guard let environment = app?.registry.environment(environmentId) else { return false }
    return environment.status.isConnected && environment.holds(AuthScope.sourceControlWrite)
  }

  func isConnected(_ environmentId: String) -> Bool {
    isFixture || app?.registry.environment(environmentId)?.status.isConnected == true
  }

  func label(_ environmentId: String) -> String {
    if isFixture { return "Fixture Mac" }
    return app?.registry.environment(environmentId)?.label ?? String(localized: "Computer")
  }

  // MARK: Presenting

  func openList() {
    path = []
    presented = true
  }

  func open(_ target: PullRequestTarget) {
    path = [.pullRequest(target)]
    presented = true
  }

  func close() {
    presented = false
  }

  /// The one model per open pull request, shared by its tabs and file screens.
  func model(_ target: PullRequestTarget) -> PullRequestDetailModel {
    if let held = models[target.id] { return held }
    let model = PullRequestDetailModel(
      environmentId: target.environmentId, ref: target.ref, preview: target.preview, source: source, sink: sink, cache: detailCache)
    models[target.id] = model
    if models.count > 8, let oldest = models.keys.first(where: { $0 != target.id }) { models[oldest] = nil }
    return model
  }

  // MARK: Thread chips

  /// The chip for a thread: its linked pull requests, else its branch's open one (read on demand).
  func badge(for thread: ThreadShell?, environmentId: String) -> ThreadPullRequestBadge? {
    guard let thread else { return nil }
    if let linked = ThreadPullRequests.badge(thread.pullRequests) { return linked }
    guard let branch = thread.branchPullRequest ?? thread.linkedPullRequest else { return nil }
    let ref = PullRequestRef(projectId: branch.projectId, repository: branch.repository, number: branch.number)
    return summaries["\(environmentId)|\(ref.key)"].map { ThreadPullRequests.badge(summary: $0, host: nil) }
  }

  /// Reads a branch pull request's summary once per launch, when its row shows.
  func loadSummary(for thread: ThreadShell?, environmentId: String) {
    guard !isFixture, let thread, ThreadPullRequests.badge(thread.pullRequests) == nil,
      let branch = thread.branchPullRequest ?? thread.linkedPullRequest, isConnected(environmentId)
    else { return }
    let ref = PullRequestRef(projectId: branch.projectId, repository: branch.repository, number: branch.number)
    let key = "\(environmentId)|\(ref.key)"
    guard summaryReads.insert(key).inserted, let registry = app?.registry else { return }
    Task {
      if let summary = try? await PullRequestSummaryReader.read(ref, in: environmentId, registry: registry) {
        summaries[key] = summary
      } else {
        summaryReads.remove(key)
      }
    }
  }

  /// Opens a thread's chip.
  func open(_ badge: ThreadPullRequestBadge, thread: ThreadShell, environmentId: String) {
    open(PullRequestTarget(environmentId: environmentId, ref: ThreadPullRequests.ref(badge, projectId: thread.projectId)))
  }
}

/// `pullRequests.summary` for a branch chip.
enum PullRequestSummaryReader {
  @MainActor
  static func read(_ ref: PullRequestRef, in environmentId: String, registry: EnvironmentRegistry) async throws -> PullRequestSummary {
    try await registry.reviewCall(environmentId) { caller in
      try await PullRequestCalls.read(.summary, ref, as: PullRequestSummary.self, via: caller)
    }
  }
}

extension AuthScope {
  static let sourceControlWrite = "source-control:write"
}
