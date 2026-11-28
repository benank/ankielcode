import AnkielKit
import Foundation

/// `--pair-invite [--deny] [--edges]`: a device pairing invite end to end, with this probe as the
/// phone and a throwaway software DPoP key as the other device. Creates an invite, claims it,
/// checks both sides show one code, approves (or denies), spends the credential at `/oauth/token`,
/// reads the new session, checks it cannot read the invite, then revokes it. `--edges` adds a
/// cancelled invite, a wrong code, and the 16-invite limit. Every invite it makes is denied on the
/// way out and the new session is revoked, even when a step fails.
///
/// `--claim-invite <file> [--approve-wait <s>]`: the other device only, for the simulator: reads a
/// `.ankielpair` file the app wrote, claims it, prints the code and waits for the app's decision.
@MainActor func probePairInvite(_ environment: SavedEnvironment, connector: EnvironmentConnector) async throws {
  let owner = InviteOwner(environment: environment, connector: connector)
  do {
    try await owner.run()
  } catch {
    await owner.cleanUp()
    throw error
  }
  await owner.cleanUp()
}

func probeClaimInvite(_ file: String) async throws {
  let deadline = Date.now.addingTimeInterval(Double(argument("--approve-wait") ?? "") ?? 90)
  var raw: String?
  while raw == nil, Date.now < deadline {
    raw = try? String(contentsOfFile: file, encoding: .utf8)
    if raw == nil { try await Task.sleep(for: .milliseconds(500)) }
  }
  guard let raw, let json = try? JSONDecoder().decode([String: JSONValue].self, from: Data(raw.utf8)),
    let inviteId = json["inviteId"]?.stringValue, let base = json["baseUrl"]?.stringValue,
    let endpoint = EnvironmentEndpoint(httpBaseURL: URL(string: argument("--claim-base") ?? base)!)
  else { throw ProbeFailure(description: "no invite file at \(file)") }
  print("invite file:       \(raw)")
  let claimant = Claimant(endpoint: endpoint)
  let claimed = try await claimant.claim(inviteId)
  print("claimed:           code \(claimed.verificationCode), expires \(claimed.expiresAt.rawValue)")
  while Date.now < deadline {
    let status = try await claimant.poll(inviteId)
    if status.status != "claimed" {
      print("decision:          \(status.status)")
      if let credential = status.credential {
        let token = try await claimant.exchange(credential)
        let state = try await claimant.session(token)
        print("new session:       \(state["sessionId"]?.stringValue ?? "?") scopes=\(state["permissions"]?.arrayValue?.count ?? 0)")
        print("revoke it with:    --access --revoke-session \(state["sessionId"]?.stringValue ?? "?")")
      }
      return
    }
    try await Task.sleep(for: .seconds(1))
  }
  throw ProbeFailure(description: "the app did not decide within the wait")
}

/// The other device: an unauthenticated client holding only its DPoP key.
private struct Claimant {
  let endpoint: EnvironmentEndpoint
  let key = DPoPKey()
  let http = EnvironmentHTTPClient()

  func claim(_ inviteId: String) async throws -> PairingInviteClaimed {
    let url = endpoint.httpURL(PairingInviteWire.claimPath(inviteId))
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue(try key.proof(method: "POST", url: url), forHTTPHeaderField: "DPoP")
    request.httpBody = try JSONEncoder().encode(
      ClaimPairingInviteRequest(clientLabel: "ankiel-probe claimant", clientDeviceType: "desktop", clientOs: "macOS"))
    return try await http.send(request, as: PairingInviteClaimed.self)
  }

  func poll(_ inviteId: String) async throws -> PairingInviteClaimStatus {
    let url = endpoint.httpURL(PairingInviteWire.claimPath(inviteId))
    var request = URLRequest(url: url)
    request.setValue(try key.proof(method: "GET", url: url), forHTTPHeaderField: "DPoP")
    return try await http.send(request, as: PairingInviteClaimStatus.self)
  }

  func exchange(_ credential: String) async throws -> AccessTokenResult {
    try await http.exchangePairingCode(
      credential, at: endpoint, key: key,
      client: ClientIdentity(label: "ankiel-probe claimant", deviceType: .desktop, os: "macOS", appVersion: "0.0.1-probe"))
  }

  func session(_ token: AccessTokenResult) async throws -> JSONValue {
    try await http.authorizedSend(
      URLRequest(url: endpoint.httpURL("/api/auth/session")), credential: .dpop(accessToken: token.accessToken, expiresAt: .now),
      key: key, as: JSONValue.self)
  }

  /// The new session asking for an invite it did not create.
  func readInvite(_ inviteId: String, token: AccessTokenResult) async -> String {
    do {
      _ = try await http.authorizedSend(
        URLRequest(url: endpoint.httpURL(PairingInviteWire.path(inviteId))),
        credential: .dpop(accessToken: token.accessToken, expiresAt: .now), key: key, as: JSONValue.self)
      return "UNEXPECTEDLY answered"
    } catch {
      return "refused: \(error)"
    }
  }
}

@MainActor
private final class InviteOwner {
  let environment: SavedEnvironment
  let connector: EnvironmentConnector
  let vault: CredentialVault
  var open: Set<String> = []
  var newSession: String?

  init(environment: SavedEnvironment, connector: EnvironmentConnector) {
    self.environment = environment
    self.connector = connector
    vault = CredentialVault(environmentId: environment.environmentId, connector: connector)
  }

  var endpoint: EnvironmentEndpoint { environment.endpoint }

  func create() async throws -> PairingInviteCreated {
    let created = try await connector.postJSON(
      PairingInviteWire.path, body: CreatePairingInviteRequest(scopes: nil), endpoint: endpoint, vault: vault, as: PairingInviteCreated.self)
    open.insert(created.inviteId)
    return created
  }

  func status(_ id: String) async throws -> PairingInviteStatus {
    try await connector.getJSON(PairingInviteWire.path(id), endpoint: endpoint, vault: vault, as: PairingInviteStatus.self)
  }

  func rawStatus(_ id: String) async -> String {
    do {
      let raw = try await connector.getJSON(PairingInviteWire.path(id), endpoint: endpoint, vault: vault, as: JSONValue.self)
      return String(decoding: try JSONEncoder.sortedWire.encode(raw), as: UTF8.self)
    } catch {
      return "error \(PairingInviteError(error))"
    }
  }

  func deny(_ id: String) async throws -> PairingInviteDenied {
    let result = try await connector.postJSON(
      PairingInviteWire.denyPath(id), body: EmptyObject(), endpoint: endpoint, vault: vault, as: PairingInviteDenied.self)
    open.remove(id)
    return result
  }

  func approve(_ id: String, code: String) async throws -> PairingInviteApproved {
    let result = try await connector.postJSON(
      PairingInviteWire.approvePath(id), body: ApprovePairingInviteRequest(verificationCode: code), endpoint: endpoint, vault: vault,
      as: PairingInviteApproved.self)
    open.remove(id)
    return result
  }

  func run() async throws {
    let created = try await create()
    print("created:           \(created.inviteId) expires \(created.expiresAt.rawValue) scopes=\(created.scopes.count)")
    print("pending:           \(await rawStatus(created.inviteId))")
    let payload = PairingInvitePayload(
      inviteId: created.inviteId, environmentId: environment.environmentId, baseUrl: endpoint.httpBaseURL.absoluteString,
      label: environment.label, expiresAt: created.expiresAt.rawValue
    ).validated()!
    print("app link:          \(payload.appLink())")

    let claimant = Claimant(endpoint: endpoint)
    let claimed = try await claimant.claim(created.inviteId)
    print("claimed:           code \(claimed.verificationCode) (claimant side)")
    let seen = try await status(created.inviteId)
    print("claimed (owner):   \(await rawStatus(created.inviteId))")
    guard seen.status == .claimed, let claim = seen.claim else { throw ProbeFailure(description: "owner does not see the claim") }
    guard claim.verificationCode == claimed.verificationCode, claim.verificationCode.wholeMatch(of: /\d{3}-\d{3}/) != nil else {
      throw ProbeFailure(description: "codes differ: owner \(claim.verificationCode), claimant \(claimed.verificationCode)")
    }
    print("codes match:       \(claim.verificationCode)")
    print("claim poll:        \(try await claimant.poll(created.inviteId))")

    if CommandLine.arguments.contains("--deny") {
      print("denied:            \(try await deny(created.inviteId).status)")
      print("claimant sees:     \(try await claimant.poll(created.inviteId).status)")
      print("owner sees:        \(await rawStatus(created.inviteId))")
    } else {
      let approved = try await approve(created.inviteId, code: claim.verificationCode)
      print("approved:          grant expires \(approved.grantExpiresAt.rawValue)")
      let grant = try await claimant.poll(created.inviteId)
      guard grant.status == "approved", let credential = grant.credential else { throw ProbeFailure(description: "no credential: \(grant)") }
      print("claimant sees:     approved, credential \(credential.count) chars")
      let token = try await claimant.exchange(credential)
      print("token:             \(token.tokenType.rawValue) expires in \(token.expiresIn)s scope \(token.scope.split(separator: " ").count) scopes")
      let state = try await claimant.session(token)
      print("new session:       authenticated=\(state["authenticated"]?.boolValue == true) method=\(state["sessionMethod"]?.stringValue ?? "-") permissions=\(state["permissions"]?.arrayValue?.count ?? 0)")
      newSession = try await findSession(issuedAfter: created.expiresAt.date!.addingTimeInterval(-125))
      print("listed as:         \(newSession ?? "not listed")")
      print("credential reused: \(await reuse(claimant, inviteId: created.inviteId))")
      print("owner sees:        \(await rawStatus(created.inviteId))")
      let other = try await create()
      print("new session reads another invite: \(await claimant.readInvite(other.inviteId, token: token))")
      print("cancelled:         \(try await deny(other.inviteId).status)")
      try await revokeNewSession()
      do {
        let after = try await claimant.session(token)
        let signedIn = after["authenticated"]?.boolValue == true
        print("after revoke:      \(signedIn ? "UNEXPECTEDLY still signed in" : "signed out (authenticated=false)")")
      } catch {
        print("after revoke:      refused: \(error)")
      }
    }

    if CommandLine.arguments.contains("--edges") { try await edges() }
  }

  /// The claimant's second read after approval: the credential goes out once.
  private func reuse(_ claimant: Claimant, inviteId: String) async -> String {
    do { return "\(try await claimant.poll(inviteId))" } catch { return "refused: \(error)" }
  }

  private func edges() async throws {
    let pending = try await create()
    print("cancel pending:    \(try await deny(pending.inviteId).status), then \(await rawStatus(pending.inviteId))")

    let wrong = try await create()
    _ = try await Claimant(endpoint: endpoint).claim(wrong.inviteId)
    do {
      _ = try await approve(wrong.inviteId, code: "000-000")
      print("wrong code:        UNEXPECTEDLY approved")
    } catch {
      open.insert(wrong.inviteId)
      print("wrong code:        \(PairingInviteError(error))")
    }
    print("after wrong code:  \(await rawStatus(wrong.inviteId))")
    _ = try? await deny(wrong.inviteId)

    var made: [String] = []
    for index in 1...17 {
      do {
        made.append(try await create().inviteId)
      } catch {
        print("limit:             invite \(index) refused: \(PairingInviteError(error))")
        break
      }
    }
    print("limit:             \(made.count) open before the refusal")
    for id in made { _ = try? await deny(id) }
    print("missing invite:    \(await rawStatus("no-such-invite"))")
  }

  /// `/api/auth/session` does not name the session, so find it in the access list by its label.
  private func findSession(issuedAfter: Date) async throws -> String? {
    let session = try await connector.connect(environment)
    defer { Task { await session.close() } }
    for try await event in try await session.rpc.stream(AccessRpc.subscribe, payload: EmptyObject(), of: AccessStreamEvent.self) {
      guard case .snapshot(let snapshot) = event else { continue }
      return snapshot.clientSessions.first {
        $0.client.label == "ankiel-probe claimant" && !$0.current && ($0.issuedAt.date ?? .distantPast) >= issuedAfter
      }?.sessionId
    }
    return nil
  }

  private func revokeNewSession() async throws {
    guard let sessionId = newSession else { return }
    let result = try await connector.postJSON(
      RevokeClientRequest.path, body: RevokeClientRequest(sessionId: sessionId), endpoint: endpoint, vault: vault, as: RevokeResult.self)
    print("revoked session:   \(sessionId) revoked=\(result.revoked)")
    newSession = nil
  }

  func cleanUp() async {
    for id in open { _ = try? await deny(id) }
    try? await revokeNewSession()
  }
}

extension JSONEncoder {
  fileprivate static var sortedWire: JSONEncoder {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return encoder
  }
}
