import AnkielKit
import Foundation

/// `--access [--revoke-session <sessionId>]`: Sharing & access against a server. Reads the access
/// stream, creates a read-only pairing link (labelled "ankiel-probe access") and revokes it again,
/// checks that this session cannot revoke itself, and with `--revoke-session` revokes that one
/// other session and waits for the stream to drop it. It never calls revoke-others.
func probeAccess(_ session: EnvironmentSession, environment: SavedEnvironment, connector: EnvironmentConnector) async throws {
  let vault = CredentialVault(environmentId: environment.environmentId, connector: connector)
  let endpoint = environment.endpoint
  var iterator = try await session.rpc.stream(AccessRpc.subscribe, payload: EmptyObject(), of: AccessStreamEvent.self).makeAsyncIterator()
  var snapshot = AccessSnapshot()

  func next(_ what: String, until done: (AccessStreamEvent) -> Bool) async throws {
    let deadline = Date.now.addingTimeInterval(10)
    while Date.now < deadline {
      guard let event = try await iterator.next() else { throw ProbeFailure(description: "access stream ended") }
      snapshot = event.applied(to: snapshot)
      print("  event:           \(describe(event))")
      if done(event) { return }
    }
    throw ProbeFailure(description: "no \(what) within 10 s")
  }

  try await next("snapshot") { if case .snapshot = $0 { true } else { false } }
  print("links:             \(snapshot.openLinks(at: .now).count)")
  for client in snapshot.sortedSessions {
    let seen = client.lastConnectedAt?.rawValue ?? "never"
    print(
      "  session \(client.sessionId)\(client.current ? " (this)" : "") \(client.displayName) [\(client.client.deviceType)] "
        + "live=\(client.isLive) issued=\(client.issuedAt.rawValue) seen=\(seen) scopes=\(client.scopes.count)")
  }

  let created = try await connector.postJSON(
    CreatePairingLinkRequest.path, body: CreatePairingLinkRequest(label: "ankiel-probe access", scopes: PairingScopes.readOnly),
    endpoint: endpoint, vault: vault, as: PairingCredential.self)
  print("created link:      \(created.id) code=\(created.credential.count) chars expires=\(created.expiresAt.rawValue)")
  print("share url shape:   \(PairingShare.pairingURL(endpoint: endpoint, code: "<code>")?.absoluteString ?? "-")")
  try await next("link upsert") { if case .pairingLinkUpserted(let link) = $0 { link.id == created.id } else { false } }
  let revoked = try await connector.postJSON(
    RevokePairingLinkRequest.path, body: RevokePairingLinkRequest(id: created.id), endpoint: endpoint, vault: vault, as: RevokeResult.self)
  print("revoked link:      \(revoked.revoked)")
  try await next("link removal") { if case .pairingLinkRemoved(let id) = $0 { id == created.id } else { false } }

  if let current = snapshot.clientSessions.first(where: \.current) {
    do {
      _ = try await connector.postJSON(
        RevokeClientRequest.path, body: RevokeClientRequest(sessionId: current.sessionId), endpoint: endpoint, vault: vault,
        as: RevokeResult.self)
      print("self revoke:       UNEXPECTEDLY accepted")
    } catch {
      print("self revoke:       refused: \(error)")
    }
  }

  if let target = argument("--revoke-session") {
    guard let other = snapshot.clientSessions.first(where: { $0.sessionId == target }), !other.current else {
      throw ProbeFailure(description: "--revoke-session \(target) is not another listed session")
    }
    let result = try await connector.postJSON(
      RevokeClientRequest.path, body: RevokeClientRequest(sessionId: target), endpoint: endpoint, vault: vault, as: RevokeResult.self)
    print("revoked session:   \(target) \(other.displayName) revoked=\(result.revoked)")
    try await next("session removal") { if case .clientRemoved(let id) = $0 { id == target } else { false } }
  }
}

private func describe(_ event: AccessStreamEvent) -> String {
  switch event {
  case .snapshot(let snapshot): "snapshot links=\(snapshot.pairingLinks.count) sessions=\(snapshot.clientSessions.count)"
  case .pairingLinkUpserted(let link): "link upserted \(link.id) \(link.label ?? "-") scopes=\(link.scopes)"
  case .pairingLinkRemoved(let id): "link removed \(id)"
  case .clientUpserted(let client): "session upserted \(client.sessionId) \(client.displayName) live=\(client.isLive)"
  case .clientRemoved(let id): "session removed \(id)"
  case .unknown(let type): "unknown \(type)"
  }
}
