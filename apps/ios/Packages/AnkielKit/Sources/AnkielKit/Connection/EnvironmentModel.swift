import Foundation
import Observation

/// What can stop a pairing, for the onboarding UI.
public enum PairingFailure: Error, Sendable, Hashable {
  case input(PairingInputError)
  case connection(ConnectionError)
  /// The address claims to be a saved environment it is not a known route of. The descriptor is
  /// unauthenticated, so pairing there could hand that environment's slot to another machine.
  case claimsSavedEnvironment(environmentId: String, label: String)
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
  /// The scopes this device holds there; nil until the server answers (or when it does not say).
  public internal(set) var grantedScopes: Set<String>?
  /// The server's scratch folder ("No project"), from the last session's config.
  public internal(set) var scratchWorkspaceRoot: String?
  /// Provider instances and models from the last config (kept while offline for drafting).
  public internal(set) var providers: [ServerProvider] = []
  public internal(set) var settings = ServerSettings()
  /// `config.environment.capabilities` from the last session.
  public internal(set) var capabilities: [String: JSONValue] = [:]
  /// A server config arrived since launch, so `settings`, `providers` and `capabilities` are the
  /// computer's own (they are not persisted; before this they are defaults).
  public internal(set) var hasConfig = false

  @ObservationIgnored var runtime: EnvironmentRuntime?
  @ObservationIgnored var session: (any LiveSession)?

  init(record: EnvironmentRecord) {
    id = record.environmentId
    self.record = record
  }

  public var label: String { record.label }

  /// The route to show: the live one, else the one that last worked.
  public var displayRoute: EnvironmentRoute? { activeRoute ?? record.lastRoute }

  /// Rows are live only while the transport is up and the shell caught up.
  public var isShellLive: Bool { status.isConnected && shell.status == .live }

  /// Whether the session holds `scope`. Unknown scopes allow the action; the server still decides.
  public func allows(_ scope: String) -> Bool {
    grantedScopes?.contains(scope) ?? true
  }

  /// Whether the server said this session holds `scope`. Settings and maintenance require a
  /// known answer (RN `useEnvironmentScope`), unlike list actions.
  public func holds(_ scope: String) -> Bool {
    grantedScopes?.contains(scope) == true
  }

  /// Patches sent but not yet confirmed, oldest first.
  public internal(set) var pendingSettings: [PendingSettingsWrite] = []

  /// The confirmed settings with pending patches applied: what settings screens show.
  public var effectiveSettings: ServerSettings {
    pendingSettings.reduce(settings) { $0.applying($1.patch) }
  }

  /// Connected, with a confirmed `settings:write`.
  public var canWriteSettings: Bool { status.isConnected && holds(AuthScope.settingsWrite) }

  /// The server's `ExecutionEnvironmentCapabilities.serverSelfUpdate` (`boot-service`, `respawn`,
  /// `desktop-managed`), nil when it cannot update itself.
  public var selfUpdateMethod: String? { capabilities["serverSelfUpdate"]?.stringValue }

  /// A server update this device started, until the computer next reconnects.
  public internal(set) var serverUpdate: ServerUpdateState = .idle

  /// The user turned this computer off on this device (no connection, rows kept).
  public var isEnabled: Bool { record.enabled != false }
}

/// A self-update this device asked a computer to run (`boot-service`/`respawn` hosts only).
public enum ServerUpdateState: Sendable, Hashable {
  case idle
  /// The server accepted it and is restarting; ends at the next session start.
  case restarting(targetVersion: String)
  case updated(version: String)
  /// It came back still on `version`.
  case notUpdated(version: String)
  case failed(String)
}

/// Why a command, search or page read did not reach a result.
public enum EnvironmentRequestError: Error, Sendable, Hashable {
  /// The computer is not connected right now.
  case notConnected
  /// The server refused it; `message` is the server's own words when it sent any, and `tag` the
  /// error's `_tag` (which kind of refusal it was).
  case rejected(message: String?, tag: String? = nil)
  case failed(String)

  public init(_ error: any Error) {
    switch error {
    case RpcError.failed(let failure): self = .rejected(message: failure.message, tag: failure.tag)
    case RpcError.connectionClosed: self = .notConnected
    case let error as EnvironmentRequestError: self = error
    default: self = .failed(String(describing: error))
    }
  }
}
