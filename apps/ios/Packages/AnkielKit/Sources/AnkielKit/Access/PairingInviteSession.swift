import Foundation
import Observation

/// Where invite calls go: the registry's live session, or a fake for fixtures and tests.
public protocol PairingInviteService: AnyObject, Sendable {
  @MainActor func create(_ request: CreatePairingInviteRequest) async throws(PairingInviteError) -> PairingInviteCreated
  @MainActor func status(_ inviteId: String) async throws(PairingInviteError) -> PairingInviteStatus
  @MainActor func approve(_ inviteId: String, code: String) async throws(PairingInviteError) -> PairingInviteApproved
  /// Denies a claimed invite, or cancels a pending one.
  @MainActor func deny(_ inviteId: String) async throws(PairingInviteError) -> PairingInviteDenied
}

/// One pairing attempt (RN `ActivePairingSession`): create an invite, poll it once a second (one
/// request at a time, paused while the app is in the background or offline), show the claim, then
/// approve or deny. Leaving with a live invite denies it, so it never lingers in the server's 16
/// slots. "Try again" is a new session.
@MainActor @Observable
public final class PairingInviteSession {
  public enum Phase: Sendable, Hashable {
    case creating
    case pending(PairingInvitePayload, expiresAt: Date)
    case claimed(PairingInvitePayload, PairingInviteClaim, scopes: [String])
    case approved
    case ended(EndReason)
    case failed(PairingInviteError)
  }

  public enum EndReason: Sendable, Hashable { case expired, denied, cancelled }
  public enum Decision: Sendable, Hashable { case approve, deny }

  public private(set) var phase = Phase.creating
  /// An approve or deny in flight; polling waits while it runs.
  public private(set) var decision: Decision?
  /// Why the last approve or deny failed; the claim stays on screen.
  public private(set) var actionError: PairingInviteError?
  /// Bumped once per claimed invite and once per approval (haptic triggers).
  public private(set) var claims = 0
  public private(set) var approvals = 0

  /// The invite as the other device receives it, while it is live.
  public var invite: PairingInvitePayload? {
    switch phase {
    case .pending(let invite, _), .claimed(let invite, _, _): invite
    default: nil
    }
  }

  @ObservationIgnored private let service: any PairingInviteService
  @ObservationIgnored private let environmentId: String
  @ObservationIgnored private let label: String
  @ObservationIgnored private let baseURL: String
  @ObservationIgnored private let scopes: [String]?
  @ObservationIgnored private let interval: Duration
  @ObservationIgnored private var run: Task<Void, Never>?
  @ObservationIgnored private var sleeper: Task<Void, Never>?
  @ObservationIgnored private var liveInviteId: String?
  @ObservationIgnored private var active = true
  @ObservationIgnored private var connected = true
  @ObservationIgnored private var stopped = false

  /// `label` and `baseURL` are fixed here, so a rename or route change mid-flight does not remake
  /// the invite.
  public init(
    service: any PairingInviteService, environmentId: String, label: String, baseURL: String, scopes: [String]?,
    interval: Duration = .seconds(1)
  ) {
    self.service = service
    self.environmentId = environmentId
    self.label = label.trimmingCharacters(in: .whitespacesAndNewlines)
    self.baseURL = baseURL
    self.scopes = scopes
    self.interval = interval
  }

  public func start() {
    guard run == nil, !stopped else { return }
    run = Task { [weak self] in await self?.follow() }
  }

  /// The app's scene is active; coming back polls at once.
  public func setActive(_ active: Bool) {
    let resumed = active && !self.active
    self.active = active
    if resumed { sleeper?.cancel() }
  }

  /// The computer's connection is up; reconnecting polls at once.
  public func setConnected(_ connected: Bool) {
    let resumed = connected && !self.connected
    self.connected = connected
    if resumed { sleeper?.cancel() }
  }

  public func approve() async {
    guard decision == nil, case .claimed(let invite, let claim, _) = phase else { return }
    decision = .approve
    actionError = nil
    do {
      _ = try await service.approve(invite.inviteId, code: claim.verificationCode)
      finish(.approved)
      approvals += 1
    } catch {
      actionError = error
    }
    decision = nil
  }

  public func deny() async {
    guard decision == nil, case .claimed(let invite, _, _) = phase else { return }
    decision = .deny
    actionError = nil
    do {
      _ = try await service.deny(invite.inviteId)
      finish(.ended(.denied))
    } catch {
      actionError = error
    }
    decision = nil
  }

  /// Stops polling and denies a live invite without waiting (leaving the page, Cancel).
  public func stop() {
    stopped = true
    run?.cancel()
    run = nil
    sleeper?.cancel()
    if let id = liveInviteId {
      liveInviteId = nil
      let service = service
      Task { _ = try? await service.deny(id) }
    }
  }

  private func finish(_ next: Phase) {
    liveInviteId = nil
    phase = next
  }

  private func follow() async {
    let created: PairingInviteCreated
    do {
      created = try await service.create(CreatePairingInviteRequest(scopes: scopes))
    } catch {
      if !stopped { phase = .failed(error) }
      return
    }
    // Left while creating: the invite exists, so take it back.
    if stopped || Task.isCancelled {
      let service = service
      Task { _ = try? await service.deny(created.inviteId) }
      return
    }
    let invite = payload(for: created)
    liveInviteId = created.inviteId
    phase = .pending(invite, expiresAt: created.expiresAt.date ?? .now.addingTimeInterval(120))
    var claimedOnce = false

    while !Task.isCancelled, liveInviteId != nil {
      await pause()
      guard !Task.isCancelled, liveInviteId != nil else { return }
      guard active, connected, decision == nil else { continue }
      let result: Result<PairingInviteStatus, PairingInviteError>
      do {
        result = .success(try await service.status(created.inviteId))
      } catch {
        result = .failure(error)
      }
      // A decision started while this poll was out, or the page left: its answer wins.
      guard !Task.isCancelled, liveInviteId != nil, decision == nil else { continue }
      switch result {
      case .success(let status):
        switch status.status.known {
        case .pending: phase = .pending(invite, expiresAt: status.expiresAt.date ?? .now)
        case .claimed:
          guard let claim = status.claim else { break }
          if !claimedOnce {
            claimedOnce = true
            claims += 1
          }
          phase = .claimed(invite, claim, scopes: status.scopes)
        case .approved: finish(.approved)
        case .denied: finish(.ended(.denied))
        case .cancelled: finish(.ended(.cancelled))
        case .expired: finish(.ended(.expired))
        case nil: break
        }
      case .failure(let error):
        switch error.pollOutcome {
        case .expired: finish(.ended(.expired))
        case .permanent: finish(.failed(error))
        case .transient: break
        }
      }
    }
  }

  /// RN builds the payload from the create answer: `expiresAt` as the server sent it.
  private func payload(for created: PairingInviteCreated) -> PairingInvitePayload {
    let withLabel = PairingInvitePayload(
      inviteId: created.inviteId, environmentId: environmentId, baseUrl: baseURL, label: label.isEmpty ? nil : label,
      expiresAt: created.expiresAt.rawValue)
    if let valid = withLabel.validated() { return valid }
    // A label the receiver would refuse (too long) must not sink the invite.
    var bare = withLabel
    bare.label = nil
    return bare.validated() ?? bare
  }

  /// Waits one interval; `setActive`/`setConnected` and `stop` cut it short.
  private func pause() async {
    let interval = interval
    let sleeper = Task<Void, Never> { try? await Task.sleep(for: interval) }
    self.sleeper = sleeper
    await sleeper.value
    if self.sleeper == sleeper { self.sleeper = nil }
  }
}

/// A computer of the registry as an invite service.
@MainActor
public final class EnvironmentPairingInviteService: PairingInviteService {
  private let registry: EnvironmentRegistry
  private let environmentId: String

  public init(registry: EnvironmentRegistry, environmentId: String) {
    self.registry = registry
    self.environmentId = environmentId
  }

  public func create(_ request: CreatePairingInviteRequest) async throws(PairingInviteError) -> PairingInviteCreated {
    try await perform { try await $0.postJSON(PairingInviteWire.path, body: request, as: PairingInviteCreated.self) }
  }

  public func status(_ inviteId: String) async throws(PairingInviteError) -> PairingInviteStatus {
    try await perform { try await $0.getJSON(PairingInviteWire.path(inviteId), as: PairingInviteStatus.self) }
  }

  public func approve(_ inviteId: String, code: String) async throws(PairingInviteError) -> PairingInviteApproved {
    try await perform {
      try await $0.postJSON(
        PairingInviteWire.approvePath(inviteId), body: ApprovePairingInviteRequest(verificationCode: code), as: PairingInviteApproved.self)
    }
  }

  public func deny(_ inviteId: String) async throws(PairingInviteError) -> PairingInviteDenied {
    try await perform { try await $0.postJSON(PairingInviteWire.denyPath(inviteId), body: EmptyObject(), as: PairingInviteDenied.self) }
  }

  private func perform<Result: Sendable>(_ body: (any LiveSession) async throws -> Result) async throws(PairingInviteError) -> Result {
    guard let session = registry.environment(environmentId)?.session else { throw .notConnected }
    do {
      return try await body(session)
    } catch {
      throw PairingInviteError(error)
    }
  }
}

#if DEBUG
  /// Invites without a server, for fixtures, screenshots and UI tests (a synthetic laptop).
  @MainActor
  public final class FakePairingInviteService: PairingInviteService {
    public enum Mode: String, Sendable {
      /// Stays pending until it expires.
      case ready
      /// A laptop claims it a moment after it is created.
      case claimed
      /// Expires a few seconds after it is created.
      case expired
      /// Create is refused.
      case fail
      /// The server already holds 16 invites.
      case limit
    }

    public let mode: Mode
    public private(set) var writes: [String] = []
    private var created: Date?
    private var state = PairingInviteStatus.Phase.pending
    private let claimAfter: TimeInterval
    private let lifetime: TimeInterval

    public static let claim = PairingInviteClaim(
      clientLabel: "Harbor MacBook Pro", clientDeviceType: "desktop", clientOs: "macOS", verificationCode: "482-913")

    public init(mode: Mode, claimAfter: TimeInterval = 1.5, lifetime: TimeInterval? = nil) {
      self.mode = mode
      self.claimAfter = claimAfter
      self.lifetime = lifetime ?? (mode == .expired ? 6 : 120)
    }

    public func create(_ request: CreatePairingInviteRequest) async throws(PairingInviteError) -> PairingInviteCreated {
      writes.append("create")
      try? await Task.sleep(for: .milliseconds(300))
      switch mode {
      case .fail: throw .rejected(tag: "EnvironmentInternalError", reason: nil, message: "The computer could not create an invite right now.")
      case .limit: throw .rejected(tag: "EnvironmentOperationForbiddenError", reason: "pairing_invite_limit_reached", message: nil)
      default: break
      }
      let now = Date.now
      created = now
      return PairingInviteCreated(
        inviteId: "invite-fake-1", expiresAt: WireTimestamp(now.addingTimeInterval(lifetime)), scopes: request.scopes ?? AuthScope.grants)
    }

    public func status(_ inviteId: String) async throws(PairingInviteError) -> PairingInviteStatus {
      let created = created ?? .now
      let expires = created.addingTimeInterval(lifetime)
      if state == .pending || state == .claimed {
        if Date.now >= expires {
          state = .expired
        } else if mode == .claimed, Date.now.timeIntervalSince(created) >= claimAfter {
          state = .claimed
        }
      }
      return PairingInviteStatus(
        inviteId: inviteId, expiresAt: WireTimestamp(expires), scopes: AuthScope.grants, status: state,
        claim: state == .claimed ? Self.claim : nil)
    }

    public func approve(_ inviteId: String, code: String) async throws(PairingInviteError) -> PairingInviteApproved {
      writes.append("approve \(code)")
      try? await Task.sleep(for: .milliseconds(300))
      guard state == .claimed, code == Self.claim.verificationCode else {
        throw .rejected(tag: "EnvironmentOperationForbiddenError", reason: "pairing_invite_invalid_state", message: nil)
      }
      state = .approved
      return PairingInviteApproved(status: "approved", grantExpiresAt: WireTimestamp(.now.addingTimeInterval(120)))
    }

    public func deny(_ inviteId: String) async throws(PairingInviteError) -> PairingInviteDenied {
      writes.append("deny")
      try? await Task.sleep(for: .milliseconds(200))
      state = state == .claimed ? .denied : .cancelled
      return PairingInviteDenied(status: state.rawValue)
    }
  }
#endif
