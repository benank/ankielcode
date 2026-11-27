import AnkielKit
import Foundation

/// `--live repair --link-a <url> --link-b <url>`: re-pairing an already saved computer with fresh
/// links, at its saved address (`link-a`) and at a new address of the same server (`link-b`).
@MainActor
func liveRepair(_ environment: SavedEnvironment, connector: EnvironmentConnector) async throws {
  guard let linkA = argument("--link-a"), let linkB = argument("--link-b") else {
    throw ProbeFailure(description: "Pass --link-a and --link-b (two fresh pairing links).")
  }
  let directory = URL.temporaryDirectory.appending(path: "ankiel-probe-repair-\(UUID().uuidString)")
  defer { try? FileManager.default.removeItem(at: directory) }
  let registry = EnvironmentRegistry(connector: connector, directory: directory)
  await registry.load(adopting: environment)
  guard let model = registry.environment(environment.environmentId) else { throw ProbeFailure(description: "Not adopted.") }
  func wait(_ what: String, _ seconds: Double = 20, _ done: () -> Bool) async throws {
    let deadline = Date.now.addingTimeInterval(seconds)
    while !done() {
      guard Date.now < deadline else { throw ProbeFailure(description: "Timed out waiting for \(what).") }
      try await Task.sleep(for: .milliseconds(50))
    }
  }
  try await wait("a live shell") { model.isShellLive }
  print("saved routes: \(model.record.routes.map(\.id))")

  let again = try await registry.pair(linkA)
  print("same address: \(again === model ? "updated the saved computer" : "added ANOTHER computer"); environments \(registry.environments.count)")
  try await wait("a live shell after re-pairing", 30) { model.isShellLive }
  print("  live again after re-pairing")

  let target = try PairingInput.resolve(linkB)
  do {
    _ = try await registry.pair(target)
    print("new address: paired WITHOUT asking")
  } catch .claimsSavedEnvironment(let id, let label) {
    print("new address: refused as claiming \(label) (\(id == model.id ? "this computer" : id))")
    let moved = try await registry.pair(target, updating: id)
    print("  updating \(label): \(moved === model ? "same computer" : "another"), routes \(moved.record.routes.map { "\($0.id)\($0.learned ? "(learned)" : "")" })")
    try await wait("a live shell at the new address", 30) { model.isShellLive }
    print("  live via \(model.activeRoute?.id ?? "?")")
  } catch {
    print("new address: \(error)")
    throw ProbeFailure(description: "Unexpected pairing failure.")
  }
  print("credential store: re-pairs wrote the probe's own file only")
}
