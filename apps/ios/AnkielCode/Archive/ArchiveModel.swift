import AnkielKit
import Foundation
import Observation

/// The Archived screen's state (RN `ArchivedThreadsRouteScreen`): one archived snapshot per saved
/// computer, read on appear and after each action (the snapshot is not live), filtered and paged
/// on the client because the RPC takes no arguments.
@MainActor @Observable
final class ArchiveModel {
  enum Load: Equatable {
    case loading
    case loaded(ArchivedShellSnapshot)
    case failed(String)
  }

  struct UndoNotice: Equatable {
    let ref: ThreadRef
    let id = UUID()
  }

  struct Failure: Identifiable {
    let id = UUID()
    let title: String
    let message: String
  }

  static let pageSize = 50

  private let registry: EnvironmentRegistry
  private(set) var loads: [String: Load] = [:]
  var query = ""
  var environmentFilter: String?
  var order = ArchivedThreadList.SortOrder.newest
  /// Rows hidden until the next read confirms the change.
  private(set) var hidden: Set<String> = []
  private(set) var limit = ArchiveModel.pageSize
  private(set) var undo: UndoNotice?
  var failure: Failure?
  @ObservationIgnored private var undoExpiry: Task<Void, Never>?

  init(registry: EnvironmentRegistry) {
    self.registry = registry
  }

  var environments: [EnvironmentModel] {
    registry.environments.sorted { $0.label.localizedCaseInsensitiveCompare($1.label) == .orderedAscending }
  }

  var groups: [ArchivedThreadList.Group] {
    let sources = environments.compactMap { environment -> ArchivedThreadList.Source? in
      guard case .loaded(let snapshot) = loads[environment.id] else { return nil }
      return .init(environmentId: environment.id, label: environment.label, snapshot: snapshot)
    }
    return ArchivedThreadList.groups(sources, environmentId: environmentFilter, query: query, order: order, hidden: hidden)
  }

  /// The groups cut to the first `limit` rows.
  var page: (groups: [ArchivedThreadList.Group], more: Int) {
    var left = limit
    var shown: [ArchivedThreadList.Group] = []
    var total = 0
    for var group in groups {
      total += group.rows.count
      guard left > 0 else { continue }
      group.rows = Array(group.rows.prefix(left))
      left -= group.rows.count
      shown.append(group)
    }
    return (shown, max(0, total - limit))
  }

  func showMore() { limit += Self.pageSize }

  var isLoading: Bool { loads.isEmpty || loads.values.contains(.loading) && groups.isEmpty }

  /// Computers whose archive could not be read, with why.
  var failures: [(label: String, message: String)] {
    environments.compactMap { environment in
      guard environmentFilter == nil || environmentFilter == environment.id,
        case .failed(let message) = loads[environment.id]
      else { return nil }
      return (environment.label, message)
    }
  }

  var isFiltered: Bool {
    !query.trimmingCharacters(in: .whitespaces).isEmpty || environmentFilter != nil
  }

  func refresh() async {
    await withTaskGroup { group in
      for environment in environments { group.addTask { await self.load(environment.id) } }
    }
  }

  /// Computers that connected since their read failed (the page often opens before they do).
  func connectionsChanged() async {
    let retry = environments.filter { environment in
      guard environment.status.isConnected else { return false }
      if case .failed = loads[environment.id] { return true }
      return loads[environment.id] == nil
    }
    for environment in retry { await load(environment.id) }
  }

  func load(_ environmentId: String) async {
    if loads[environmentId] == nil { loads[environmentId] = .loading }
    do {
      let snapshot = try await registry.archivedSnapshot(in: environmentId)
      loads[environmentId] = .loaded(snapshot)
      let present = Set(snapshot.threads.map { "\(environmentId):\($0.id)" })
      hidden = hidden.filter { !$0.hasPrefix("\(environmentId):") || present.contains($0) }
    } catch {
      loads[environmentId] = .failed(Self.message(error))
    }
  }

  func canOperate(_ ref: ThreadRef) -> Bool {
    registry.environment(ref.environmentId)?.allows(AuthScope.orchestrationOperate) ?? false
  }

  func unarchive(_ row: ArchivedThreadList.Row) {
    run(.unarchive, on: row.ref) { self.showUndo(UndoNotice(ref: row.ref)) }
  }

  func delete(_ row: ArchivedThreadList.Row) {
    run(.delete, on: row.ref) {}
  }

  /// Undo of an unarchive: archive it again, and read the archive back.
  func performUndo() {
    guard let notice = undo else { return }
    dismissUndo()
    Task {
      do {
        _ = try await registry.dispatch(ThreadCommand(.archive, threadId: notice.ref.threadId), in: notice.ref.environmentId)
        hidden.remove(notice.ref.key)
        await load(notice.ref.environmentId)
      } catch {
        failure = Failure(title: String(localized: "Could not undo thread action"), message: Self.message(error))
      }
    }
  }

  func dismissUndo() {
    undoExpiry?.cancel()
    undo = nil
  }

  private func run(_ action: ThreadAction, on ref: ThreadRef, then done: @escaping () -> Void) {
    guard canOperate(ref) else {
      failure = Failure(title: HomeModel.failureTitle(action), message: String(localized: "This connection cannot change threads."))
      return
    }
    dismissUndo()
    hidden.insert(ref.key)
    Task {
      do {
        _ = try await registry.dispatch(ThreadCommand(action, threadId: ref.threadId), in: ref.environmentId)
        done()
        await load(ref.environmentId)
      } catch {
        hidden.remove(ref.key)
        failure = Failure(title: HomeModel.failureTitle(action), message: Self.message(error))
      }
    }
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

  static func message(_ error: any Error) -> String {
    switch error {
    case EnvironmentRequestError.notConnected: String(localized: "Not connected")
    case EnvironmentRequestError.rejected(let message?, _) where !message.isEmpty: message
    case EnvironmentRequestError.failed(let message) where !message.isEmpty: message
    default: String(localized: "Try again.")
    }
  }
}
