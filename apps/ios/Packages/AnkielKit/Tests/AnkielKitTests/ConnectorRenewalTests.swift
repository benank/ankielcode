import Foundation
import Synchronization
import Testing

@testable import AnkielKit

/// Serves scripted HTTP responses by path, and records the paths requested.
final class StubProtocol: URLProtocol {
  struct Reply: Sendable {
    var status: Int
    var body: String
  }

  static let routes = Mutex<[String: [Reply]]>([:])
  static let requested = Mutex<[String]>([])

  static func reset(_ replies: [String: [Reply]]) {
    routes.withLock { $0 = replies }
    requested.withLock { $0 = [] }
  }

  override class func canInit(with _: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    let path = request.url?.path() ?? ""
    Self.requested.withLock { $0.append(path) }
    let reply = Self.routes.withLock { routes -> Reply? in
      guard var queue = routes[path], !queue.isEmpty else { return nil }
      let next = queue.count > 1 ? queue.removeFirst() : queue[0]
      routes[path] = queue
      return next
    } ?? Reply(status: 404, body: "{}")
    let response = HTTPURLResponse(url: request.url!, statusCode: reply.status, httpVersion: nil, headerFields: nil)!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(reply.body.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }

  override func stopLoading() {}
}

/// The stub is process-global, so these run one at a time.
@Suite(.serialized) struct ConnectorRenewalTests {
  let endpoint = EnvironmentEndpoint(httpBaseURL: URL(string: "http://192.168.1.20:3773/")!)!
  let descriptor = #"{"environmentId":"env-1","label":"Mac","serverVersion":"1","orchestrationProtocolVersion":2,"capabilities":{"accessTokenRenewal":true}}"#
  let token = #"{"access_token":"new-token","issued_token_type":"urn:ietf:params:oauth:token-type:access_token","token_type":"DPoP","expires_in":3600,"scope":"orchestration:read"}"#
  let rejected = #"{"_tag":"EnvironmentAuthInvalidError","code":"auth_invalid","reason":"invalid_credential"}"#

  func connector() throws -> (EnvironmentConnector, InMemoryCredentialStore) {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [StubProtocol.self]
    let store = InMemoryCredentialStore()
    try store.set(AccessCredential.dpop(accessToken: "old-token", expiresAt: .now.addingTimeInterval(3000)), for: CredentialKeys.credential("env-1"))
    let connector = EnvironmentConnector(
      store: store, client: ClientIdentity(label: "test", deviceType: .phone, os: "iOS", appVersion: "1"),
      http: EnvironmentHTTPClient(session: URLSession(configuration: configuration)))
    return (connector, store)
  }

  @Test func `a 401 at the ticket renews once and retries`() async throws {
    StubProtocol.reset([
      "/.well-known/ankiel/environment": [.init(status: 200, body: descriptor)],
      "/api/auth/websocket-ticket/rpc": [.init(status: 401, body: rejected), .init(status: 500, body: "{}")],
      "/oauth/token": [.init(status: 200, body: token)],
    ])
    let (connector, store) = try connector()
    let vault = CredentialVault(environmentId: "env-1", connector: connector)
    do {
      _ = try await connector.connect(environmentId: "env-1", endpoint: endpoint, vault: vault)
      Issue.record("expected the stubbed ticket to fail")
    } catch {
      // The retry got past the 401 (to the scripted 500), so the failure is not a rejection.
      #expect(error != .credentialRejected)
    }
    #expect(StubProtocol.requested.withLock { $0 } == [
      "/.well-known/ankiel/environment", "/api/auth/websocket-ticket/rpc", "/oauth/token",
      "/api/auth/websocket-ticket/rpc",
    ])
    #expect(try store.value(AccessCredential.self, for: CredentialKeys.credential("env-1"))?.token == "new-token")
  }

  @Test func `a second 401 after renewal means pair again`() async throws {
    StubProtocol.reset([
      "/.well-known/ankiel/environment": [.init(status: 200, body: descriptor)],
      "/api/auth/websocket-ticket/rpc": [.init(status: 401, body: rejected)],
      "/oauth/token": [.init(status: 200, body: token)],
    ])
    let (connector, _) = try connector()
    let vault = CredentialVault(environmentId: "env-1", connector: connector)
    await #expect(throws: ConnectionError.credentialRejected) {
      _ = try await connector.connect(environmentId: "env-1", endpoint: endpoint, vault: vault)
    }
    #expect(StubProtocol.requested.withLock { $0 }.filter { $0 == "/oauth/token" }.count == 1)
  }

  @Test func `a refused renewal means pair again`() async throws {
    StubProtocol.reset([
      "/.well-known/ankiel/environment": [.init(status: 200, body: descriptor)],
      "/api/auth/websocket-ticket/rpc": [.init(status: 401, body: rejected)],
      "/oauth/token": [.init(status: 401, body: rejected)],
    ])
    let (connector, _) = try connector()
    let vault = CredentialVault(environmentId: "env-1", connector: connector)
    await #expect(throws: ConnectionError.credentialRejected) {
      _ = try await connector.connect(environmentId: "env-1", endpoint: endpoint, vault: vault)
    }
  }

  @Test func `a DPoP time window failure is clock skew, not a rejection`() async throws {
    StubProtocol.reset([
      "/.well-known/ankiel/environment": [.init(status: 200, body: descriptor)],
      "/api/auth/websocket-ticket/rpc": [
        .init(status: 401, body: #"{"_tag":"EnvironmentAuthInvalidError","reason":"invalid_credential","dpopFailureReason":"time_window"}"#)
      ],
    ])
    let (connector, _) = try connector()
    let vault = CredentialVault(environmentId: "env-1", connector: connector)
    await #expect(throws: ConnectionError.clockSkew) {
      _ = try await connector.connect(environmentId: "env-1", endpoint: endpoint, vault: vault)
    }
  }

  @Test func `the wrong machine at a saved address is refused before any credential goes out`() async throws {
    StubProtocol.reset([
      "/.well-known/ankiel/environment": [.init(status: 200, body: descriptor.replacingOccurrences(of: "env-1", with: "env-2"))]
    ])
    let (connector, _) = try connector()
    let vault = CredentialVault(environmentId: "env-1", connector: connector)
    await #expect(throws: ConnectionError.environmentMismatch(expected: "env-1", found: "env-2")) {
      _ = try await connector.connect(environmentId: "env-1", endpoint: endpoint, vault: vault)
    }
    #expect(StubProtocol.requested.withLock { $0 } == ["/.well-known/ankiel/environment"])
  }
}

/// Re-pairing a saved computer at a new address (same stub, so in the serialized suite).
extension ConnectorRenewalTests {
  @MainActor @Test func `a new address for a saved computer needs the caller to name it, then updates it`() async throws {
    let directory = URL.temporaryDirectory.appending(path: "repair-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    StubProtocol.reset([
      "/.well-known/ankiel/environment": [.init(status: 200, body: descriptor)],
      "/oauth/token": [.init(status: 200, body: token)],
    ])
    let (connector, store) = try connector()
    let registry = EnvironmentRegistry(connector: connector, directory: directory, cachesShell: false)
    await registry.load(adopting: SavedEnvironment(environmentId: "env-1", label: "Mac", endpoint: endpoint, serverVersion: "1"))
    let target = try PairingInput.resolve(pairingURL: "http://10.0.0.5:3773/pair#token=ABCDEFGHJKMN")

    do {
      _ = try await registry.pair(target)
      Issue.record("expected the unnamed new address to be refused")
    } catch {
      #expect(error == .claimsSavedEnvironment(environmentId: "env-1", label: "Mac"))
    }
    #expect(!StubProtocol.requested.withLock { $0 }.contains("/oauth/token"))

    let model = try await registry.pair(target, updating: "env-1")
    #expect(registry.environments.count == 1)
    #expect(model.record.routes.first?.endpoint == target.endpoint)
    #expect(model.record.routes.first?.learned == false)
    #expect(model.record.routes.contains { $0.endpoint == endpoint && $0.learned })
    #expect(try store.value(AccessCredential.self, for: CredentialKeys.credential("env-1"))?.token == "new-token")
    await registry.remove("env-1")
  }

  @MainActor @Test func `naming a computer refuses an address that answers as another one`() async throws {
    let directory = URL.temporaryDirectory.appending(path: "repair-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    StubProtocol.reset([
      "/.well-known/ankiel/environment": [.init(status: 200, body: descriptor)],
      "/oauth/token": [.init(status: 200, body: token)],
    ])
    let (connector, _) = try connector()
    let registry = EnvironmentRegistry(connector: connector, directory: directory, cachesShell: false)
    await registry.load()
    let target = try PairingInput.resolve(pairingURL: "http://10.0.0.5:3773/pair#token=ABCDEFGHJKMN")
    do {
      _ = try await registry.pair(target, updating: "env-other")
      Issue.record("expected a mismatch")
    } catch {
      guard case .connection(.environmentMismatch) = error else {
        Issue.record("unexpected \(error)")
        return
      }
    }
    #expect(!StubProtocol.requested.withLock { $0 }.contains("/oauth/token"))
  }
}
