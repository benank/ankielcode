import AnkielKit
import Foundation
import Observation
import SwiftUI

/// The thread list's state: the merged rows of every computer, the user's list options, search,
/// the older-settled shelf, and the list actions with their dismissal and undo. Layout runs off
/// the main actor, only when an input changes, and the latest request wins.
@Observable
final class HomeModel {
  // MARK: Output

  private(set) var layout = ThreadListLayout()
  /// The list has been laid out once (so empty states do not flash before the first pass).
  private(set) var hasLaidOut = false
  private(set) var projectChoices: [ProjectScope] = []
  private(set) var search = SearchState()
  private(set) var undo: UndoNotice?
  /// A failed action, for an alert.
  var failure: ActionFailure?

  // MARK: Options

  var searchQuery = "" {
    didSet {
      guard searchQuery != oldValue else { return }
      settledLimit = ThreadListLayout.settledInitialCount
      scheduleSearch()
      scheduleLayout()
    }
  }
  private(set) var environmentFilter: String?
  private(set) var projectFilterKey: String?
  private(set) var snoozedExpanded = false
  private(set) var settledExpanded = false
  private(set) var collapsedFolders: Set<String> = []
  private(set) var settledLimit = ThreadListLayout.settledInitialCount
  var selectedKey: String? {
    didSet { if selectedKey != oldValue { scheduleLayout() } }
  }

  struct SearchState: Equatable {
    var query = ""
    var pending = false
    var failed = false
    var hits: [ThreadSearchHit] = []
    /// Older settled rows a search returned, by environment.
    var rows: [String: [ThreadShell]] = [:]
  }

  struct UndoNotice: Identifiable, Equatable {
    enum Kind { case settled, snoozed, unpinned, archived }
    let id = UUID()
    let kind: Kind
    let ref: ThreadRef
    /// The commands that put the thread back, in order.
    let steps: [ThreadAction]

    static func == (lhs: Self, rhs: Self) -> Bool { lhs.id == rhs.id }
  }

  struct ActionFailure: Identifiable {
    let id = UUID()
    let title: String
    let message: String
  }

  // MARK: Internals

  @ObservationIgnored private let registry: EnvironmentRegistry
  @ObservationIgnored private let defaults: UserDefaults
  @ObservationIgnored private var sources: [ThreadListSource] = []
  @ObservationIgnored private var scopes: [ProjectScope] = []
  @ObservationIgnored private var layoutTask: Task<Void, Never>?
  @ObservationIgnored private var layoutGeneration = 0
  @ObservationIgnored private var wakeTask: Task<Void, Never>?
  @ObservationIgnored private var searchTask: Task<Void, Never>?
  @ObservationIgnored private var undoExpiry: Task<Void, Never>?
  /// Rows hidden while their command runs, with the sequence that releases them.
  @ObservationIgnored private var dismissals: [String: Dismissal] = [:]
  @ObservationIgnored private var olderPages: [String: OlderSettledPages] = [:]
  @ObservationIgnored private var started = false
  #if DEBUG
    @ObservationIgnored var debugSources: [ThreadListSource]?
  #endif

  private struct Dismissal {
    var environmentId: String
    /// Released once the shell reaches this sequence; nil while the command is in flight.
    var releaseAt: Int?
    var expiry: Task<Void, Never>?
  }

  init(registry: EnvironmentRegistry, defaults: UserDefaults = .standard) {
    self.registry = registry
    self.defaults = defaults
    environmentFilter = defaults.string(forKey: Keys.environment)
    projectFilterKey = defaults.string(forKey: Keys.project)
    snoozedExpanded = defaults.bool(forKey: Keys.snoozedShelf)
    settledExpanded = defaults.bool(forKey: Keys.settledShelf)
    collapsedFolders = Set(defaults.stringArray(forKey: Keys.collapsedFolders) ?? [])
  }

  private enum Keys {
    static let environment = "threadList.environmentId"
    static let project = "threadList.projectKey"
    static let snoozedShelf = "threadList.snoozedShelfExpanded"
    static let settledShelf = "threadList.settledShelfExpanded"
    static let collapsedFolders = "threadList.collapsedProjectGroups"
  }

  /// Starts following the registry's shells.
  func start() {
    guard !started else { return }
    started = true
    observeSources()
  }

  // MARK: Derived

  /// The computers the list holds rows for, by label (the filter menu's choices).
  var environmentChoices: [(id: String, label: String)] {
    sources.map { ($0.environmentId, $0.label) }.sorted { $0.label.localizedStandardCompare($1.label) == .orderedAscending }
  }

  var isFiltered: Bool { environmentFilterResolved != nil || projectFilterKey != nil }

  /// A saved filter for a computer that was removed lists everything.
  var environmentFilterResolved: String? {
    guard let environmentFilter, sources.contains(where: { $0.environmentId == environmentFilter }) else { return nil }
    return environmentFilter
  }

  var projectFilter: ProjectScope? {
    guard let projectFilterKey else { return nil }
    return projectChoices.first { $0.key == projectFilterKey }
  }

  func environment(_ id: String) -> EnvironmentModel? { registry.environment(id) }

  func canOperate(_ ref: ThreadRef) -> Bool {
    #if DEBUG
      // Canned rows show every action; their commands fail as not connected.
      if debugSources != nil { return true }
    #endif
    return registry.environment(ref.environmentId)?.allows(AuthScope.orchestrationOperate) ?? false
  }

  // MARK: Options

  func setEnvironmentFilter(_ id: String?) {
    environmentFilter = id
    defaults.set(id, forKey: Keys.environment)
    rebuildScopes()
    scheduleSearch()
    scheduleLayout()
  }

  func setProjectFilter(_ key: String?) {
    projectFilterKey = key
    defaults.set(key, forKey: Keys.project)
    scheduleSearch()
    scheduleLayout()
  }

  func toggle(_ shelf: ThreadShelf) {
    switch shelf {
    case .snoozed:
      snoozedExpanded.toggle()
      defaults.set(snoozedExpanded, forKey: Keys.snoozedShelf)
    case .settled:
      settledExpanded.toggle()
      defaults.set(settledExpanded, forKey: Keys.settledShelf)
      settledLimit = ThreadListLayout.settledInitialCount
    }
    scheduleLayout()
  }

  func toggleFolder(_ key: String) {
    if collapsedFolders.contains(key) { collapsedFolders.remove(key) } else { collapsedFolders.insert(key) }
    defaults.set(Array(collapsedFolders).sorted(), forKey: Keys.collapsedFolders)
    scheduleLayout()
  }

  func showMoreSettled() {
    settledLimit += ThreadListLayout.settledPageCount
    retryFailedPages()
    scheduleLayout()
  }

  /// Pull to refresh (`useHomeRefresh`): reconnect computers that are down and read failed pages again.
  func refresh() async {
    registry.wake(.retry)
    retryFailedPages()
    // The shell streams live; this only gives the pull a visible beat while reconnects start.
    try? await Task.sleep(for: .milliseconds(600))
  }

  // MARK: Sources

  func observeSources() {
    let next = withObservationTracking {
      readSources()
    } onChange: { [weak self] in
      Task { @MainActor in self?.observeSources() }
    }
    guard next != sources else { return }
    sources = next
    syncOlderPages()
    releaseDismissals()
    rebuildScopes()
    scheduleLayout()
  }

  private func readSources() -> [ThreadListSource] {
    #if DEBUG
      if let debugSources { return debugSources }
    #endif
    return registry.environments.map { environment in
      ThreadListSource(
        environmentId: environment.id, label: environment.label, threads: environment.shell.threads,
        projects: environment.shell.projects)
    }
  }

  private func rebuildScopes() {
    let projects = sources.filter { environmentFilterResolved == nil || $0.environmentId == environmentFilterResolved }
      .flatMap { source in
        let scratch = registry.environment(source.environmentId)?.scratchWorkspaceRoot
        return source.projects.map {
          ScopedProject(
            environmentId: source.environmentId, project: $0,
            isScratch: ProjectGrouping.isScratch($0, scratchRoot: scratch))
        }
      }
    scopes = ProjectGrouping.scopes(projects)
    let threads = sources.flatMap { source in source.threads.map { (source.environmentId, $0) } }
    let choices = ProjectGrouping.filterChoices(scopes, threads: threads, projects: projects)
    if choices != projectChoices { projectChoices = choices }
  }

  // MARK: Layout

  private func input(now: Date) -> ThreadListInput {
    var sources = sources
    // Older settled pages and search rows join their environment's rows; the shell wins.
    for index in sources.indices {
      let environmentId = sources[index].environmentId
      let extra = (olderPages[environmentId]?.rows ?? []) + (search.rows[environmentId] ?? [])
      guard !extra.isEmpty else { continue }
      let held = Set(sources[index].threads.map(\.id))
      var seen = held
      sources[index].threads += extra.filter { seen.insert($0.id).inserted }
    }
    var input = ThreadListInput(sources: sources, now: now)
    input.environmentFilter = environmentFilterResolved
    input.projectFilter = projectFilter?.projectKeys
    input.searchQuery = searchQuery
    input.searchHits = search.query == ThreadSearch.normalized(searchQuery) ? search.hits : []
    input.settledLimit = settledLimit
    input.snoozedExpanded = snoozedExpanded
    input.settledExpanded = settledExpanded
    input.collapsedFolders = collapsedFolders
    input.selectedKey = selectedKey
    input.hiddenKeys = Set(dismissals.keys)
    let scoped = olderPages.filter { environmentFilterResolved == nil || $0.key == environmentFilterResolved }
    input.settledFrontier = OlderSettledPages.shelfFrontier(scoped.values)
    input.unloadedSettledCount = scoped.reduce(0) { total, entry in
      let projectIds = projectFilter.map { scope in
        Set(scope.projectKeys.compactMap { key -> String? in
          let prefix = "\(entry.key):"
          return key.hasPrefix(prefix) ? String(key.dropFirst(prefix.count)) : nil
        })
      }
      let held = sources.first { $0.environmentId == entry.key }?.threads ?? []
      return total + entry.value.unloaded(projectIds: projectIds, held: held)
    }
    return input
  }

  func scheduleLayout() {
    layoutGeneration += 1
    let generation = layoutGeneration
    let input = input(now: .now)
    layoutTask?.cancel()
    layoutTask = Task {
      let next = await Self.lay(out: input)
      guard !Task.isCancelled, generation == self.layoutGeneration else { return }
      if next != self.layout { self.layout = next }
      self.hasLaidOut = true
      self.armSnoozeWake(next.nextSnoozeWakeAt)
      self.loadOlderPagesIfNeeded()
    }
  }

  @concurrent nonisolated private static func lay(out input: ThreadListInput) async -> ThreadListLayout {
    ThreadListLayout.build(input)
  }

  /// Membership changes on time only when a snooze ends.
  private func armSnoozeWake(_ date: Date?) {
    wakeTask?.cancel()
    guard let date else { return }
    wakeTask = Task {
      try? await Task.sleep(for: .seconds(max(0.5, date.timeIntervalSinceNow + 0.5)))
      guard !Task.isCancelled else { return }
      self.scheduleLayout()
    }
  }

  // MARK: Older settled shelf

  private func syncOlderPages() {
    var next: [String: OlderSettledPages] = [:]
    for environment in registry.environments {
      guard let cut = environment.shell.snapshot?.olderSettled else { continue }
      if let held = olderPages[environment.id], held.before == cut.before {
        next[environment.id] = held
      } else {
        next[environment.id] = OlderSettledPages(cut: cut)
      }
    }
    olderPages = next
  }

  /// While the expanded shelf lists fewer rows than its limit, read the next page from each
  /// computer whose frontier is the shelf's (`wantedOlderSettledPages`).
  private func loadOlderPagesIfNeeded() {
    guard settledExpanded, searchQuery.isEmpty, layout.listedSettledCount < settledLimit,
      let frontier = OlderSettledPages.shelfFrontier(olderPages.values)
    else { return }
    for (environmentId, pages) in olderPages where pages.frontier == frontier && pages.status == .ready {
      guard environmentFilterResolved == nil || environmentFilterResolved == environmentId else { continue }
      olderPages[environmentId]?.status = .loading
      let projectIds = projectFilter.map { scope in
        scope.projectKeys.compactMap { key -> String? in
          key.hasPrefix("\(environmentId):") ? String(key.dropFirst(environmentId.count + 1)) : nil
        }.sorted()
      }
      let request = OlderSettledRequest(before: frontier, projectIds: projectIds, limit: OlderSettledRequest.pageSize)
      Task {
        do {
          let page = try await registry.olderSettledPage(request, in: environmentId)
          olderPages[environmentId]?.append(page)
        } catch {
          olderPages[environmentId]?.status = .failed
        }
        scheduleLayout()
      }
    }
  }

  var olderSettledState: OlderSettledPages.Status {
    if olderPages.values.contains(where: { $0.status == .loading }) { return .loading }
    if olderPages.values.contains(where: { $0.status == .failed }) { return .failed }
    return .ready
  }

  private func retryFailedPages() {
    for (id, pages) in olderPages where pages.status == .failed { olderPages[id]?.status = .ready }
  }

  // MARK: Search

  private func scheduleSearch() {
    searchTask?.cancel()
    let query = ThreadSearch.normalized(searchQuery)
    let targets = registry.environments.filter { environment in
      environment.isShellLive && (environmentFilterResolved == nil || environment.id == environmentFilterResolved)
    }
    let anyOlder = targets.contains { $0.shell.snapshot?.olderSettled != nil }
    guard !targets.isEmpty, ThreadSearch.canSearchServer(query, anyOlderSettled: anyOlder) else {
      search = SearchState()
      return
    }
    search.pending = true
    let scope = projectFilter
    searchTask = Task {
      try? await Task.sleep(for: ThreadSearch.debounce)
      guard !Task.isCancelled else { return }
      var hits: [ThreadSearchHit] = []
      var rows: [String: [ThreadShell]] = [:]
      var failures = 0
      // One request per computer, in parallel; each answers on its own socket.
      var requests: [(environmentId: String, task: Task<ThreadSearchResult?, Never>)] = []
      for environment in targets {
        let environmentId = environment.id
        let projectIds = scope.map { scope in
          scope.projectKeys.compactMap { key -> String? in
            key.hasPrefix("\(environmentId):") ? String(key.dropFirst(environmentId.count + 1)) : nil
          }.sorted()
        }
        if let projectIds, projectIds.isEmpty { continue }
        let request = ThreadSearchRequest(
          query: query, olderSettledBefore: environment.shell.snapshot?.olderSettled?.before.rawValue,
          projectIds: projectIds)
        let registry = registry
        requests.append((environmentId, Task { try? await registry.searchThreads(request, in: environmentId) }))
      }
      for (environmentId, task) in requests {
        guard let result = await task.value else {
          failures += 1
          continue
        }
        hits += result.matches.map {
          ThreadSearchHit(key: "\(environmentId):\($0.threadId)", snippet: $0.snippet, messageId: $0.messageId)
        }
        if !result.threads.isEmpty { rows[environmentId] = result.threads }
      }
      guard !Task.isCancelled else { return }
      search = SearchState(query: query, pending: false, failed: !requests.isEmpty && failures == requests.count, hits: hits, rows: rows)
      scheduleLayout()
    }
  }

  // MARK: Actions

  /// Runs a list action. Actions that move a row out of its place dismiss it until the shell
  /// shows the change (`withThreadDismissal`); a failure puts it back and explains.
  func perform(_ action: ThreadAction, on ref: ThreadRef, undoable: UndoNotice.Kind? = nil, undoSteps: [ThreadAction] = []) {
    guard canOperate(ref) else {
      failure = ActionFailure(
        title: Self.failureTitle(action), message: String(localized: "This connection cannot change threads."))
      return
    }
    let dismisses = Self.dismisses(action)
    if dismisses { dismiss(ref) }
    if undoable != nil || dismisses { dismissUndo() }
    Task {
      do {
        let sequence = try await registry.dispatch(ThreadCommand(action, threadId: ref.threadId), in: ref.environmentId)
        if dismisses { holdDismissal(ref, until: sequence) }
        if let undoable { showUndo(UndoNotice(kind: undoable, ref: ref, steps: undoSteps)) }
      } catch {
        if dismisses { restore(ref) }
        failure = ActionFailure(title: Self.failureTitle(action), message: Self.message(for: error, action: action))
      }
    }
  }

  func archive(_ row: ThreadRow) {
    guard row.canArchive else {
      failure = ActionFailure(
        title: Self.failureTitle(.archive),
        message: String(localized: "This thread is working. Interrupt it first, then try again."))
      return
    }
    perform(.archive, on: row.ref, undoable: .archived, undoSteps: [.unarchive])
  }

  func settle(_ row: ThreadRow) {
    guard let thread = thread(row.ref) else { return }
    // `planThreadUndo("settle")`: unsettle back to the old active position, then restore the pin
    // and the snooze settling cleared.
    var steps: [ThreadAction] = [.unsettle(restoreUnsettledAt: .some(thread.unsettledAt))]
    if thread.pinnedAt != nil { steps.append(.pin(orderKey: thread.pinOrderKey)) }
    if let until = thread.snoozedUntil?.date { steps.append(.snooze(until: until)) }
    perform(.settle, on: row.ref, undoable: .settled, undoSteps: steps)
  }

  func snooze(_ row: ThreadRow, until: Date) {
    guard until > .now else {
      failure = ActionFailure(
        title: String(localized: "Could not snooze thread"),
        message: String(localized: "That snooze time has passed. Choose another time."))
      return
    }
    perform(.snooze(until: until), on: row.ref, undoable: .snoozed, undoSteps: [.unsnooze])
  }

  func pin(_ row: ThreadRow) {
    let keys = sources.flatMap(\.threads).filter { $0.pinnedAt != nil }.map(\.pinOrderKey)
    perform(.pin(orderKey: ThreadOrder.topOfPinned(keys)), on: row.ref)
  }

  func unpin(_ row: ThreadRow) {
    guard let thread = thread(row.ref) else { return }
    var steps: [ThreadAction] = [.pin(orderKey: thread.pinOrderKey)]
    if let until = thread.snoozedUntil?.date { steps.append(.snooze(until: until)) }
    perform(.unpin, on: row.ref, undoable: .unpinned, undoSteps: steps)
  }

  func toggleRead(_ row: ThreadRow) {
    switch row.readToggle {
    case .markRead(let visitedAt)?: perform(.markRead(visitedAt: visitedAt), on: row.ref)
    case .markUnread?: perform(.markUnread, on: row.ref)
    case nil: break
    }
  }

  func rename(_ ref: ThreadRef, to title: String) {
    let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, trimmed != thread(ref)?.title else { return }
    perform(.rename(trimmed), on: ref)
  }

  func thread(_ ref: ThreadRef) -> ThreadShell? {
    sources.first { $0.environmentId == ref.environmentId }?.threads.first { $0.id == ref.threadId }
      ?? olderPages[ref.environmentId]?.rows.first { $0.id == ref.threadId }
      ?? search.rows[ref.environmentId]?.first { $0.id == ref.threadId }
  }

  // MARK: Undo

  func performUndo() {
    guard let notice = undo else { return }
    dismissUndo()
    Task {
      for step in notice.steps {
        // A snooze can expire before Undo runs, and the server rejects an expired restore.
        if case .snooze(let until) = step, until <= .now { continue }
        do {
          _ = try await registry.dispatch(ThreadCommand(step, threadId: notice.ref.threadId), in: notice.ref.environmentId)
        } catch {
          failure = ActionFailure(
            title: String(localized: "Could not undo thread action"), message: Self.message(for: error, action: step))
          return
        }
      }
    }
  }

  func dismissUndo() {
    undoExpiry?.cancel()
    undo = nil
  }

  private func showUndo(_ notice: UndoNotice) {
    undo = notice
    undoExpiry?.cancel()
    undoExpiry = Task {
      try? await Task.sleep(for: .seconds(5))
      guard !Task.isCancelled, self.undo == notice else { return }
      self.undo = nil
    }
  }

  // MARK: Dismissal

  private static func dismisses(_ action: ThreadAction) -> Bool {
    switch action {
    case .archive, .delete, .settle, .unsettle, .snooze, .unsnooze: true
    default: false
    }
  }

  private func dismiss(_ ref: ThreadRef) {
    dismissals[ref.key]?.expiry?.cancel()
    dismissals[ref.key] = Dismissal(environmentId: ref.environmentId)
    scheduleLayout()
  }

  private func holdDismissal(_ ref: ThreadRef, until sequence: Int) {
    guard dismissals[ref.key] != nil else { return }
    dismissals[ref.key]?.releaseAt = sequence
    // Sequences skip and identical updates are dropped, so a stuck hold also times out.
    dismissals[ref.key]?.expiry = Task {
      try? await Task.sleep(for: .seconds(5))
      guard !Task.isCancelled else { return }
      self.restore(ref)
    }
    releaseDismissals()
  }

  private func restore(_ ref: ThreadRef) {
    guard let dismissal = dismissals.removeValue(forKey: ref.key) else { return }
    dismissal.expiry?.cancel()
    scheduleLayout()
  }

  private func releaseDismissals() {
    var released = false
    for (key, dismissal) in dismissals {
      guard let releaseAt = dismissal.releaseAt,
        let sequence = registry.environment(dismissal.environmentId)?.shell.sequence, sequence >= releaseAt
      else { continue }
      dismissal.expiry?.cancel()
      dismissals.removeValue(forKey: key)
      released = true
    }
    if released { scheduleLayout() }
  }

  // MARK: Copy

  static func failureTitle(_ action: ThreadAction) -> String {
    switch action {
    case .archive: String(localized: "Could not archive thread")
    case .unarchive: String(localized: "Could not unarchive thread")
    case .delete: String(localized: "Could not delete thread")
    case .settle: String(localized: "Could not settle thread")
    case .unsettle: String(localized: "Could not un-settle thread")
    case .snooze: String(localized: "Could not snooze thread")
    case .unsnooze: String(localized: "Could not wake thread")
    case .pin: String(localized: "Could not pin thread")
    case .unpin: String(localized: "Could not unpin thread")
    case .markRead, .markUnread: String(localized: "Could not update thread")
    case .rename: String(localized: "Could not rename thread")
    }
  }

  static func message(for error: any Error, action: ThreadAction) -> String {
    switch error {
    case EnvironmentRequestError.notConnected:
      return String(localized: "This computer is not connected. Try again when it reconnects.")
    case EnvironmentRequestError.rejected(let message?) where !message.isEmpty:
      return message
    default:
      return String(localized: "Try again.")
    }
  }
}
