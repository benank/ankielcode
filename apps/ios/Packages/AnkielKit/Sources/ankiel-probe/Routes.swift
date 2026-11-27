import AnkielKit
import Foundation

/// `--routes`: the better-route switch against a real server. The computer is saved with two
/// addresses of the same server (`127.0.0.1` and `localhost`) and connects over the first; the
/// order is then flipped and the supervisor must connect over `localhost` and move the live
/// session there without the computer going offline, the shell staying live. Then a hand-added
/// address is refused for loopback, and one that answers as another computer would be refused
/// too (checked against the descriptor, before any credential is sent). Nothing on the server
/// changes.
@MainActor
func probeRoutes(_ environment: SavedEnvironment, connector: EnvironmentConnector) async throws {
  let directory = URL.temporaryDirectory.appending(path: "ankiel-probe-routes-\(UUID().uuidString)")
  defer { try? FileManager.default.removeItem(at: directory) }
  guard var components = URLComponents(url: environment.endpoint.httpBaseURL, resolvingAgainstBaseURL: false) else { return }
  components.host = "localhost"
  guard let url = components.url, let other = EnvironmentEndpoint(httpBaseURL: url) else { return }
  var record = EnvironmentRecord(environment)
  let second = EnvironmentRoute(endpoint: other, manual: true)
  record.routes.append(second)
  record.routeOrder = [record.routes[0].id, second.id]
  try await EnvironmentRecordStore(url: directory.appending(path: "environments.json")).save([record])

  let registry = EnvironmentRegistry(connector: connector, directory: directory)
  await registry.load()
  guard let model = registry.environment(environment.environmentId) else { throw ProbeFailure(description: "not loaded") }
  func wait(_ what: String, seconds: Double = 20, until done: () -> Bool) async throws {
    let deadline = Date.now.addingTimeInterval(seconds)
    while !done() {
      guard Date.now < deadline else { throw ProbeFailure(description: "Timed out waiting for \(what).") }
      try await Task.sleep(for: .milliseconds(50))
    }
  }
  try await wait("a live shell") { model.isShellLive }
  print("connected over:    \(model.activeRoute?.id ?? "-")")
  var statuses: [String] = []
  let watcher = Task { @MainActor in
    var last = ""
    while !Task.isCancelled {
      let text = String(describing: model.status)
      if text != last { statuses.append(text); last = text }
      try? await Task.sleep(for: .milliseconds(20))
    }
  }
  let started = Date.now
  registry.setRouteOrder([second.id, record.routes[0].id], for: model.id)
  try await wait("the switch to localhost") { model.activeRoute?.id == second.id }
  print("switched to:       \(model.activeRoute?.id ?? "-") after \(Int(Date.now.timeIntervalSince(started) * 1000)) ms")
  try await wait("the shell live again") { model.isShellLive }
  watcher.cancel()
  print("statuses meanwhile: \(statuses)")
  print("shell live:        \(model.isShellLive), \(model.shell.threads.count) threads")

  do {
    let relay = try await registry.relayStatus(model.id)
    print("relay status:      configured=\(relay.configured) connected=\(relay.connected) source=\(relay.source ?? "-") url=\(relay.publicBaseUrl ?? "-")")
  } catch {
    print("relay status:      \(error)")
  }
  do {
    _ = try await registry.addRoute("127.0.0.1:1", to: model.id)
    print("loopback add:      UNEXPECTEDLY accepted")
  } catch {
    print("loopback add:      refused (\(error))")
  }
  do {
    _ = try await registry.addRoute("http://203.0.113.9:3773", to: model.id)
    print("public http add:   UNEXPECTEDLY accepted")
  } catch {
    print("public http add:   refused (\(error)); paired over plain http, so only the descriptor check stops it")
  }
}
