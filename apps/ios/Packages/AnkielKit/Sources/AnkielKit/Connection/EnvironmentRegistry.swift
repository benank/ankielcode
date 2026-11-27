import Foundation
import Observation

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
public final class EnvironmentRegistry: SettingsSink {
  public private(set) var environments: [EnvironmentModel] = []
  public private(set) var isLoaded = false

  @ObservationIgnored public let connector: EnvironmentConnector
  @ObservationIgnored private let records: EnvironmentRecordStore
  @ObservationIgnored private let shellCache: ShellCache?
  @ObservationIgnored private var networkOnline = true
  @ObservationIgnored private var networkTask: Task<Void, Never>?
  @ObservationIgnored private var lastSave: Task<Void, Never>?
  /// Open and recently closed threads, by `ThreadRef.key`.
  @ObservationIgnored private var threadDetails: [String: ThreadDetailModel] = [:]
  /// How inline code, links and code tokens look in thread markdown (set by the app at launch).
  @ObservationIgnored public var markdownStyle = MarkdownStyle()
  /// How long a closed thread keeps its rows and cursor for a fast reopen.
  @ObservationIgnored public var threadCacheLifetime: Duration = .seconds(90)
  @ObservationIgnored private var assetURLs: [String: (url: URL, expires: Date)] = [:]
  /// Attachment uploads (signed URLs, no credentials).
  @ObservationIgnored let uploadSession = EnvironmentHTTPClient.makeSession()

  /// `directory` holds `environments.json` and the `shell/` cache (Application Support in the app).
  public init(connector: EnvironmentConnector, directory: URL, cachesShell: Bool = true) {
    self.connector = connector
    records = EnvironmentRecordStore(url: directory.appending(path: "environments.json"))
    shellCache = cachesShell ? ShellCache(directory: directory.appending(path: "shell", directoryHint: .isDirectory)) : nil
  }

  public func environment(_ id: String) -> EnvironmentModel? {
    environments.first { $0.id == id }
  }

  /// Reads the saved environments (adopting `legacy`, a single record, when the file is missing) and
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

  /// Reads the descriptor (before the one-time code is spent), exchanges the code, then saves and
  /// connects. An address that claims to be a saved environment it is not a known route of is
  /// refused unless the caller names that environment in `updating` (the user chose to move it
  /// there): the descriptor is unauthenticated, so pairing there replaces that computer's sign-in.
  /// The computer's other addresses stay as fallbacks.
  public func pair(
    _ target: PairingTarget, updating: String? = nil, progress: (PairingStep) -> Void = { _ in }
  ) async throws(PairingFailure) -> EnvironmentModel {
    progress(.checkingServer)
    let descriptor: EnvironmentDescriptor
    do { descriptor = try await connector.describe(target, expectedEnvironmentId: updating) } catch { throw .connection(error) }
    if let existing = environment(descriptor.environmentId),
      !existing.record.routes.contains(where: { $0.endpoint == target.endpoint }), updating != existing.id
    {
      throw .claimsSavedEnvironment(environmentId: existing.id, label: existing.label)
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

  /// Closes the connection and deletes the credential and cached rows. Nothing changes on the
  /// computer: a session cannot revoke itself (`current_session_revoke_not_allowed`) and there is
  /// no sign-out route, so the server lists this device until someone revokes it there.
  public func remove(_ id: String, forgetCredential: Bool = true) async {
    guard let index = environments.firstIndex(where: { $0.id == id }) else { return }
    let model = environments.remove(at: index)
    persist()
    await stopRuntime(model, clearingShell: true)
    await shellCache?.remove(id)
    if forgetCredential { connector.forget(id) }
    await lastSave?.value
  }

  /// Removes every saved computer from this device.
  public func removeAll() async {
    for id in environments.map(\.id) { await remove(id) }
  }

  /// Turns a computer off on this device (closes its connection, keeps its sign-in and cached
  /// rows on disk) or back on.
  public func setEnabled(_ id: String, _ enabled: Bool) async {
    guard let model = environment(id), model.isEnabled != enabled else { return }
    model.record.enabled = enabled ? nil : false
    persist()
    let saved = lastSave
    if enabled {
      guard model.runtime == nil else { return }
      #if DEBUG
        if let status = debugFixtureStatus[id] {
          model.status = status
          model.activeRoute = status.isConnected ? model.record.lastRoute : nil
          return
        }
      #endif
      model.status = .connecting
      startRuntime(model)
    } else {
      await stopRuntime(model)
      // Turned back on while stopping: that call owns the status and runtime now.
      guard !model.isEnabled else { return }
      model.status = .disabled
      model.shell = ShellState()
      await saved?.value
    }
  }

  /// Stops connecting. Removal also clears the shell sync, which otherwise may still write its cache.
  private func stopRuntime(_ model: EnvironmentModel, clearingShell: Bool = false) async {
    for (key, detail) in threadDetails where detail.ref.environmentId == model.id {
      threadDetails[key] = nil
      detail.enqueue { await $0.detach() }
    }
    // Detached before the awaits, so a runtime started meanwhile (turned back on) is not cleared.
    guard let runtime = model.runtime else { return }
    model.runtime = nil
    model.session = nil
    model.activeRoute = nil
    model.pendingSettings = []
    for task in runtime.tasks { task.cancel() }
    await runtime.supervisor.stop()
    if clearingShell { await runtime.shell.clear() } else { await runtime.shell.detach() }
  }

  // MARK: Client storage

  /// Bytes of the cached thread list for one computer.
  public func shellCacheSize(_ id: String) async -> Int64 {
    guard let shellCache else { return 0 }
    return await shellCache.size(id)
  }

  /// Forgets one computer's cached thread list; a live computer writes a fresh one.
  public func clearShellCache(_ id: String) async {
    await shellCache?.remove(id)
    if let model = environment(id), !model.status.isConnected { model.shell = ShellState() }
  }

  // MARK: Threads

  /// The thread's shared model. The first open starts its stream on the environment's session (and
  /// follows replacement sessions); pair every open with `closeThread`.
  public func openThread(_ ref: ThreadRef) -> ThreadDetailModel {
    let model = threadDetails[ref.key] ?? makeThreadModel(ref)
    threadDetails[ref.key] = model
    model.expiry?.cancel()
    model.expiry = nil
    model.consumers += 1
    if model.consumers == 1, let session = environment(ref.environmentId)?.session {
      model.enqueue { await $0.attach(session) }
    }
    return model
  }

  /// Releases one open. The last one stops the stream (the server stops counting a viewer) and
  /// keeps the rows for `threadCacheLifetime`.
  public func closeThread(_ model: ThreadDetailModel) {
    guard model.consumers > 0 else { return }
    model.consumers -= 1
    guard model.consumers == 0 else { return }
    model.enqueue { await $0.detach() }
    let key = model.ref.key
    let lifetime = threadCacheLifetime
    model.expiry = Task { [weak self, weak model] in
      try? await Task.sleep(for: lifetime)
      guard !Task.isCancelled, let self, let model, model.consumers == 0, self.threadDetails[key] === model else { return }
      self.threadDetails[key] = nil
    }
  }

  /// Starts a just-launched thread from the launch result's projection, so opening it resumes
  /// after the launch instead of loading a snapshot.
  func seedThread(_ ref: ThreadRef, result: ThreadLaunchResult) {
    guard let projection = result.projection, let sequence = result.sequence else { return }
    let model = threadDetails[ref.key] ?? makeThreadModel(ref)
    if threadDetails[ref.key] == nil {
      threadDetails[ref.key] = model
      model.expiry = Task { [weak self, weak model] in
        try? await Task.sleep(for: self?.threadCacheLifetime ?? .seconds(90))
        guard let self, let model, model.consumers == 0, self.threadDetails[ref.key] === model else { return }
        self.threadDetails[ref.key] = nil
      }
    }
    model.enqueue { await $0.seed(projection, sequence: sequence) }
  }

  private func makeThreadModel(_ ref: ThreadRef) -> ThreadDetailModel {
    let model = ThreadDetailModel(ref: ref, sync: ThreadDetailSync(threadId: ref.threadId, style: markdownStyle))
    model.loadItem = { [weak self] itemId in
      guard let self else { throw EnvironmentRequestError.notConnected }
      return try await self.turnItem(itemId, in: ref)
    }
    return model
  }

  /// The full item (`orchestration.getTurnItem`), including what the stream strips.
  public func turnItem(_ itemId: String, in ref: ThreadRef) async throws(EnvironmentRequestError) -> TurnItem? {
    try await request(ref.environmentId) { session in
      try await session.call(
        TurnItemRequest.rpcTag, payload: TurnItemRequest(threadId: ref.threadId, itemId: itemId), as: TurnItemResult.self
      ).item
    }
  }

  /// A signed URL for an attachment or workspace file (no auth header needed to GET it), reused
  /// until a minute before it expires.
  public func assetURL(_ resource: AssetResource, in environmentId: String) async throws(EnvironmentRequestError) -> URL {
    let key = "\(environmentId)|\(resource)"
    if let cached = assetURLs[key], cached.expires.timeIntervalSinceNow > 60 { return cached.url }
    guard let endpoint = environment(environmentId)?.activeRoute?.endpoint else { throw .notConnected }
    let result = try await request(environmentId) { session in
      try await session.call(AssetURLRequest.rpcTag, payload: AssetURLRequest(resource: resource), as: AssetURLResult.self)
    }
    guard let url = endpoint.resolve(relativeURL: result.relativeUrl) else { throw .failed("Unreadable asset URL.") }
    assetURLs[key] = (url, Date(timeIntervalSince1970: result.expiresAt.value / 1000))
    return url
  }

  private func threadSessionStarted(_ environmentId: String, _ session: any LiveSession) {
    for model in threadDetails.values where model.ref.environmentId == environmentId && model.consumers > 0 {
      model.enqueue { await $0.attach(session) }
    }
  }

  private func threadSessionLost(_ environmentId: String) {
    for model in threadDetails.values where model.ref.environmentId == environmentId {
      model.enqueue { await $0.detach() }
    }
  }

  // MARK: Requests

  /// Sends one thread command; returns the event sequence that carries it.
  public func dispatch(_ command: ThreadCommand, in environmentId: String) async throws(EnvironmentRequestError) -> Int {
    try await request(environmentId) { session in
      try await session.call(ThreadCommand.rpcTag, payload: command, as: DispatchResult.self).sequence
    }
  }

  public func searchThreads(
    _ search: ThreadSearchRequest, in environmentId: String
  ) async throws(EnvironmentRequestError) -> ThreadSearchResult {
    try await request(environmentId) { session in
      try await session.call(ThreadSearchRequest.rpcTag, payload: search, as: ThreadSearchResult.self)
    }
  }

  public func olderSettledPage(
    _ page: OlderSettledRequest, in environmentId: String
  ) async throws(EnvironmentRequestError) -> OlderSettledPage {
    try await request(environmentId) { session in
      try await session.call(OlderSettledRequest.rpcTag, payload: page, as: OlderSettledPage.self)
    }
  }

  /// `server.updateSettings`: the server's settings after the patch.
  public func updateSettings(
    _ patch: ServerSettingsPatch, in environmentId: String
  ) async throws(EnvironmentRequestError) -> ServerSettings {
    try await request(environmentId) { session in
      try await session.call(UpdateSettingsRequest.rpcTag, payload: UpdateSettingsRequest(patch: patch), as: ServerSettings.self)
    }
  }

  /// Asks the computer to update itself (`server.updateServer`). Only for hosts whose
  /// `serverSelfUpdate` is `boot-service` or `respawn`; desktop-managed hosts update through
  /// their app. The socket dropping before the answer is the handoff, not a failure.
  public func updateServer(_ id: String, to targetVersion: String) async {
    guard let model = environment(id), model.status.isConnected, model.holds(AuthScope.environmentMaintain),
      let method = model.selfUpdateMethod, method == "boot-service" || method == "respawn"
    else { return }
    model.serverUpdate = .restarting(targetVersion: targetVersion)
    do {
      _ = try await request(id) { session in
        try await session.call(ServerUpdateRequest.rpcTag, payload: ServerUpdateRequest(targetVersion: targetVersion), as: ServerUpdateResult.self)
      }
    } catch {
      switch error {
      // The socket dropping before the answer is the handoff; the next session start resolves it.
      case .notConnected: return
      case .rejected(let message, _): model.serverUpdate = .failed(message ?? "")
      case .failed(let message): model.serverUpdate = .failed(message)
      }
    }
  }

  func request<Result: Sendable>(
    _ environmentId: String, _ body: (any LiveSession) async throws -> Result
  ) async throws(EnvironmentRequestError) -> Result {
    guard let session = environment(environmentId)?.session else { throw .notConnected }
    do {
      return try await body(session)
    } catch {
      throw EnvironmentRequestError(error)
    }
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
    /// A canned computer for screenshots and UI tests: no runtime, no network.
    public struct DebugFixture {
      public var record: EnvironmentRecord
      public var status: ConnectionStatus
      public var settings: ServerSettings
      public var providers: [ServerProvider]
      public var scopes: Set<String>?
      public var capabilities: [String: JSONValue]

      public init(
        record: EnvironmentRecord, status: ConnectionStatus, settings: ServerSettings = ServerSettings(),
        providers: [ServerProvider] = [], scopes: Set<String>? = nil, capabilities: [String: JSONValue] = [:]
      ) {
        self.record = record
        self.status = status
        self.settings = settings
        self.providers = providers
        self.scopes = scopes
        self.capabilities = capabilities
      }
    }

    @ObservationIgnored private var debugFixtureStatus: [String: ConnectionStatus] = [:]

    /// Loads canned computers instead of the saved ones (the caller gives this registry its own
    /// directory and credential store). Turning one back on restores its canned status.
    public func debugLoad(_ fixtures: [DebugFixture]) {
      guard !isLoaded else { return }
      for fixture in fixtures {
        let model = EnvironmentModel(record: fixture.record)
        model.status = fixture.record.enabled == false ? .disabled : fixture.status
        model.settings = fixture.settings
        model.providers = fixture.providers
        model.grantedScopes = fixture.scopes
        model.capabilities = fixture.capabilities
        model.hasConfig = fixture.status.isConnected
        if fixture.status.isConnected { model.activeRoute = fixture.record.lastRoute }
        debugFixtureStatus[model.id] = fixture.status
        environments.append(model)
      }
      isLoaded = true
    }

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
    environments.append(model)
    if model.isEnabled { startRuntime(model) } else { model.status = .disabled }
  }

  private func startRuntime(_ model: EnvironmentModel) {
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
            model.session = session
            model.scratchWorkspaceRoot = session.initialConfig.scratchWorkspaceRoot
            model.providers = session.initialConfig.providers
            model.settings = session.initialConfig.settings
            model.capabilities = session.initialConfig.environment.capabilities
            model.hasConfig = true
            Task { [weak model] in
              for await event in session.configUpdates {
                guard let model, model.session === session else { return }
                switch event {
                case .snapshot(let config):
                  model.providers = config.providers
                  model.settings = config.settings
                  model.capabilities = config.environment.capabilities
                case .providers(let providers): model.providers = providers
                case .settings(let settings): model.settings = settings
                case .other: break
                }
              }
            }
            Task { [weak model] in
              let scopes = try? await session.grantedScopes()
              if let model, model.session === session, let scopes { model.grantedScopes = scopes }
            }
            self.sessionStarted(model, session: session, routes: routes)
            self.threadSessionStarted(model.id, session)
            await shell.attach(session)
          case .sessionLost:
            model.activeRoute = nil
            model.session = nil
            self.threadSessionLost(model.id)
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
  }

  private func sessionStarted(_ model: EnvironmentModel, session: any LiveSession, routes: RouteBook) {
    let config = session.initialConfig
    var record = model.record
    record.lastConnectedAt = .now
    record.lastRouteId = session.route.id
    record.serverVersion = config.environment.serverVersion
    if case .restarting(let target) = model.serverUpdate {
      model.serverUpdate =
        SemanticVersion.compare(record.serverVersion, target) >= 0
        ? .updated(version: record.serverVersion) : .notUpdated(version: record.serverVersion)
    }
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
