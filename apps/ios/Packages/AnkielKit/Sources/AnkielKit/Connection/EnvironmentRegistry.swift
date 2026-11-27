import Foundation
import Observation

/// What can stop a pairing, for the onboarding UI.
public enum PairingFailure: Error, Sendable, Hashable {
  case input(PairingInputError)
  case connection(ConnectionError)
  /// The address claims to be a saved environment it is not a known route of. The descriptor is
  /// unauthenticated, so pairing there could hand that environment's slot to another machine.
  case claimsSavedEnvironment(label: String)
}

/// Where a pairing is, for progress UI.
public enum PairingStep: Sendable, Hashable {
  case checkingServer
  case exchangingCode
  case connecting
}

/// One saved environment as the UI sees it: its record, transport status and shell rows.
@MainActor @Observable
public final class EnvironmentModel: Identifiable {
  public nonisolated let id: String
  public internal(set) var record: EnvironmentRecord
  public internal(set) var status = ConnectionStatus.connecting
  public internal(set) var shell = ShellState()
  /// The route of the live session, nil while not connected.
  public internal(set) var activeRoute: EnvironmentRoute?

  @ObservationIgnored var runtime: EnvironmentRuntime?

  init(record: EnvironmentRecord) {
    id = record.environmentId
    self.record = record
  }

  public var label: String { record.label }

  /// The route to show: the live one, else the one that last worked.
  public var displayRoute: EnvironmentRoute? { activeRoute ?? record.lastRoute }

  /// Rows are live only while the transport is up and the shell caught up.
  public var isShellLive: Bool { status.isConnected && shell.status == .live }
}

/// The supervisor, shell sync and the tasks that bridge them to the model.
struct EnvironmentRuntime {
  let supervisor: ConnectionSupervisor
  let shell: ShellSync
  let routes: RouteBook
  let tasks: [Task<Void, Never>]
}

/// Every saved environment: persists records (file) and credentials (Keychain), connects to all of
/// them, and removes one cleanly.
@MainActor @Observable
public final class EnvironmentRegistry {
  public private(set) var environments: [EnvironmentModel] = []
  public private(set) var isLoaded = false

  @ObservationIgnored public let connector: EnvironmentConnector
  @ObservationIgnored private let records: EnvironmentRecordStore
  @ObservationIgnored private let shellCache: ShellCache?
  @ObservationIgnored private var networkOnline = true
  @ObservationIgnored private var networkTask: Task<Void, Never>?
  @ObservationIgnored private var lastSave: Task<Void, Never>?

  /// `directory` holds `environments.json` and the `shell/` cache (Application Support in the app).
  public init(connector: EnvironmentConnector, directory: URL, cachesShell: Bool = true) {
    self.connector = connector
    records = EnvironmentRecordStore(url: directory.appending(path: "environments.json"))
    shellCache = cachesShell ? ShellCache(directory: directory.appending(path: "shell", directoryHint: .isDirectory)) : nil
  }

  public func environment(_ id: String) -> EnvironmentModel? {
    environments.first { $0.id == id }
  }

  /// Reads the saved environments (adopting a phase-2 single record when the file is missing) and
  /// starts connecting to each. Cached shells show before the sockets are up.
  public func load(adopting legacy: SavedEnvironment? = nil) async {
    guard !isLoaded else { return }
    var saved = await records.load()
    if saved == nil, let legacy {
      saved = [EnvironmentRecord(legacy)]
      try? await records.save(saved ?? [])
    }
    for record in saved ?? [] where environment(record.environmentId) == nil {
      start(EnvironmentModel(record: record))
    }
    isLoaded = true
    monitorNetwork()
  }

  // MARK: Pairing

  /// Pairs from anything a user can paste or scan.
  public func pair(
    _ input: String, progress: (PairingStep) -> Void = { _ in }
  ) async throws(PairingFailure) -> EnvironmentModel {
    let target: PairingTarget
    do { target = try PairingInput.resolve(input) } catch { throw .input(error) }
    return try await pair(target, progress: progress)
  }

  /// Reads the descriptor (before the one-time code is spent), refuses an address that claims to be
  /// a saved environment it is not a route of, exchanges the code, then saves and connects.
  public func pair(
    _ target: PairingTarget, progress: (PairingStep) -> Void = { _ in }
  ) async throws(PairingFailure) -> EnvironmentModel {
    progress(.checkingServer)
    let descriptor: EnvironmentDescriptor
    do { descriptor = try await connector.describe(target) } catch { throw .connection(error) }
    if let existing = environment(descriptor.environmentId),
      !existing.record.routes.contains(where: { $0.endpoint == target.endpoint })
    {
      throw .claimsSavedEnvironment(label: existing.label)
    }
    progress(.exchangingCode)
    let paired: SavedEnvironment
    do { paired = try await connector.exchange(target, descriptor: descriptor) } catch { throw .connection(error) }
    progress(.connecting)
    if let existing = environment(paired.environmentId) {
      existing.record.repair(with: paired)
      existing.runtime?.routes.routes = existing.record.routes
      persist()
      if let supervisor = existing.runtime?.supervisor { Task { await supervisor.wake(.retry) } }
      return existing
    }
    let model = EnvironmentModel(record: EnvironmentRecord(paired))
    start(model)
    persist()
    return model
  }

  // MARK: Managing

  public func rename(_ id: String, to label: String?) {
    guard let model = environment(id) else { return }
    let trimmed = label?.trimmingCharacters(in: .whitespacesAndNewlines)
    model.record.customLabel = trimmed?.isEmpty == false && trimmed != model.record.serverLabel ? trimmed : nil
    persist()
  }

  /// Closes the connection and deletes the credential and cached rows.
  public func remove(_ id: String, forgetCredential: Bool = true) async {
    guard let index = environments.firstIndex(where: { $0.id == id }) else { return }
    let model = environments.remove(at: index)
    persist()
    if let runtime = model.runtime {
      for task in runtime.tasks { task.cancel() }
      await runtime.supervisor.stop()
      await runtime.shell.clear()
    }
    model.runtime = nil
    if forgetCredential { connector.forget(id) }
    await lastSave?.value
  }

  public func retry(_ id: String) {
    guard let supervisor = environment(id)?.runtime?.supervisor else { return }
    Task { await supervisor.wake(.retry) }
  }

  /// Foreground, network or retry wakeups for every environment.
  public func wake(_ reason: ConnectionWakeup) {
    for model in environments {
      guard let supervisor = model.runtime?.supervisor else { continue }
      Task { await supervisor.wake(reason) }
    }
  }

  /// Renews a DPoP credential now (diagnostics). Returns the new expiry, nil for bearer.
  public func renewCredential(_ id: String) async throws(ConnectionError) -> Date? {
    guard let model = environment(id), let route = model.displayRoute else { return nil }
    let vault = CredentialVault(environmentId: id, connector: connector)
    guard case .dpop = try await vault.stored() else { return nil }
    guard case .dpop(_, let expiresAt) = try await vault.renew(at: route.endpoint) else { return nil }
    return expiresAt
  }

  /// The last shell subscription sent for an environment (diagnostics).
  public func lastShellSubscription(_ id: String) async -> ShellSubscription? {
    await environment(id)?.runtime?.shell.lastSubscription
  }

  /// Drops one environment's live session as if the socket died (debug).
  public func dropSession(_ id: String) {
    guard let supervisor = environment(id)?.runtime?.supervisor else { return }
    Task { await supervisor.dropSession() }
  }

  #if DEBUG
    /// Shows `status` on every environment and stops their supervisors from overwriting it
    /// (screenshots of failure states without breaking a real connection).
    public func debugPresent(status: ConnectionStatus) {
      for model in environments {
        for task in model.runtime?.tasks.prefix(1) ?? [] { task.cancel() }
        model.status = status
        if !status.isConnected { model.activeRoute = nil }
      }
    }
  #endif

  // MARK: Runtime

  private func start(_ model: EnvironmentModel) {
    let routes = RouteBook(routes: model.record.routes, lastUsed: model.record.lastRouteId)
    let vault = CredentialVault(environmentId: model.id, connector: connector)
    let supervisor = ConnectionSupervisor(
      link: LiveEnvironmentLink(environmentId: model.id, connector: connector, vault: vault, routes: routes))
    let shell = ShellSync(environmentId: model.id, cache: shellCache)
    let online = networkOnline
    let tasks = [
      Task { [weak self, weak model] in
        for await event in supervisor.events {
          guard let self, let model else { return }
          switch event {
          case .status(let status):
            model.status = status
          case .session(let session):
            model.activeRoute = session.route
            self.sessionStarted(model, session: session, routes: routes)
            await shell.attach(session)
          case .sessionLost:
            model.activeRoute = nil
            await shell.detach()
          }
        }
      },
      Task { [weak model] in
        for await state in shell.states {
          model?.shell = state
        }
      },
      Task {
        await shell.restore()
        await supervisor.start(networkOnline: online)
      },
    ]
    model.runtime = EnvironmentRuntime(supervisor: supervisor, shell: shell, routes: routes, tasks: tasks)
    environments.append(model)
  }

  private func sessionStarted(_ model: EnvironmentModel, session: any LiveSession, routes: RouteBook) {
    let config = session.initialConfig
    var record = model.record
    record.lastConnectedAt = .now
    record.lastRouteId = session.route.id
    record.serverVersion = config.environment.serverVersion
    if config.environment.label != record.serverLabel, !config.environment.label.isEmpty {
      record.serverLabel = config.environment.label
    }
    record.routes = RouteSelection.learn(config.directEndpoints, into: record.routes)
    routes.routes = record.routes
    if record != model.record {
      model.record = record
      persist()
    }
  }

  private func monitorNetwork() {
    guard networkTask == nil else { return }
    networkTask = Task { [weak self] in
      var first = true
      for await online in NetworkMonitor.paths() {
        guard let self else { return }
        self.networkOnline = online
        if first {
          first = false
          continue
        }
        self.wake(.networkChanged(online: online))
      }
    }
  }

  private func persist() {
    let snapshot = environments.map(\.record)
    let records = records
    let previous = lastSave
    lastSave = Task {
      await previous?.value
      try? await records.save(snapshot)
    }
  }
}
