import Foundation
import Testing

@testable import AnkielKit

@MainActor @Suite struct EnvironmentRegistryTests {
  @Test func `removing an environment deletes its record, credential and cached shell`() async throws {
    let directory = URL.temporaryDirectory.appending(path: "registry-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = InMemoryCredentialStore()
    // Nothing listens on this port, so the supervisor only ever fails transiently.
    let endpoint = EnvironmentEndpoint(httpBaseURL: URL(string: "http://127.0.0.1:9/")!)!
    let legacy = SavedEnvironment(environmentId: "env-1", label: "Mac", endpoint: endpoint, serverVersion: "1")
    try store.set(AccessCredential.bearer(token: "t"), for: CredentialKeys.credential("env-1"))
    let cache = ShellCache(directory: directory.appending(path: "shell"))
    await cache.save(
      ShellCacheEntry(savedAt: .now, source: ShellSource(try FakeSession().initialConfig), snapshot: ShellSnapshot()),
      for: "env-1")

    let connector = EnvironmentConnector(
      store: store, client: ClientIdentity(label: "test", deviceType: .phone, os: "iOS", appVersion: "1"))
    let registry = EnvironmentRegistry(connector: connector, directory: directory)
    await registry.load(adopting: legacy)
    #expect(registry.environments.map(\.id) == ["env-1"])
    #expect(await EnvironmentRecordStore(url: directory.appending(path: "environments.json")).load()?.count == 1)

    await registry.remove("env-1")
    #expect(registry.environments.isEmpty)
    #expect(store.data(for: CredentialKeys.credential("env-1")) == nil)
    #expect(await cache.load("env-1") == nil)
    let reloaded = EnvironmentRegistry(connector: connector, directory: directory)
    await reloaded.load()
    #expect(reloaded.environments.isEmpty)
  }
}

extension EnvironmentRegistryTests {
  @Test func `turning a computer off persists, and back on while it stops keeps the new connection`() async throws {
    let directory = URL.temporaryDirectory.appending(path: "enable-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = InMemoryCredentialStore()
    let endpoint = EnvironmentEndpoint(httpBaseURL: URL(string: "http://127.0.0.1:9/")!)!
    let connector = EnvironmentConnector(
      store: store, client: ClientIdentity(label: "test", deviceType: .phone, os: "iOS", appVersion: "1"))
    let registry = EnvironmentRegistry(connector: connector, directory: directory, cachesShell: false)
    await registry.load(adopting: SavedEnvironment(environmentId: "env-1", label: "Mac", endpoint: endpoint, serverVersion: "1"))
    let model = try #require(registry.environment("env-1"))

    await registry.setEnabled("env-1", false)
    #expect(model.status == .disabled)
    #expect(model.runtime == nil)
    let reloaded = EnvironmentRegistry(connector: connector, directory: directory, cachesShell: false)
    await reloaded.load()
    #expect(reloaded.environment("env-1")?.status == .disabled)
    #expect(reloaded.environment("env-1")?.runtime == nil)

    // Off and on again without waiting: the second call's runtime must survive the first.
    await registry.setEnabled("env-1", true)
    let off = Task { await registry.setEnabled("env-1", false) }
    await eventually { !model.isEnabled }
    await registry.setEnabled("env-1", true)
    await off.value
    #expect(model.isEnabled)
    #expect(model.runtime != nil)
    #expect(model.status != .disabled)
    await registry.remove("env-1")
    await reloaded.remove("env-1")
  }
}
