import Foundation
import Observation

/// A live session as a terminal channel.
struct LiveTerminalChannel: TerminalChannel {
  let session: any LiveSession

  func call<Response: Decodable & Sendable>(
    _ tag: String, payload: some Encodable & Sendable, as type: Response.Type
  ) async throws -> Response {
    try await session.call(tag, payload: payload, as: type)
  }

  func stream<Item: Decodable & Sendable>(
    _ tag: String, payload: some Encodable & Sendable, of type: Item.Type
  ) async throws -> RpcStream<Item> {
    try await session.stream(tag, payload: payload, of: type)
  }
}

/// A computer of the registry as a terminal's host: its sessions as the supervisor connects them.
@MainActor
public final class EnvironmentTerminalHost: TerminalHost {
  private let registry: EnvironmentRegistry
  private let environmentId: String

  public init(registry: EnvironmentRegistry, environmentId: String) {
    self.registry = registry
    self.environmentId = environmentId
  }

  public var canOperate: Bool { registry.environment(environmentId)?.holds(TerminalScope.operate) ?? false }

  public func channel(after previous: ObjectIdentifier?) async -> (id: ObjectIdentifier, channel: any TerminalChannel)? {
    let registry = registry
    let environmentId = environmentId
    // The route changes with every session start and loss, so each new session is observed.
    for await _ in Observations({ registry.environment(environmentId)?.activeRoute }) {
      if let session = registry.environment(environmentId)?.session, ObjectIdentifier(session) != previous {
        return (ObjectIdentifier(session), LiveTerminalChannel(session: session))
      }
    }
    return nil
  }
}

/// A computer's terminals (`subscribeTerminalMetadata`), followed across reconnects while
/// something shows them. It needs `terminal:read`; the server refuses without it and `terminals`
/// stays nil (the scopes arrive after the session starts, so the server decides).
@MainActor @Observable
public final class TerminalDirectory {
  /// nil until the first snapshot (or when the list cannot be read).
  public private(set) var terminals: [TerminalSummary]?
  @ObservationIgnored private let host: any TerminalHost
  @ObservationIgnored private var run: Task<Void, Never>?

  public init(host: any TerminalHost) {
    self.host = host
  }

  public convenience init(registry: EnvironmentRegistry, environmentId: String) {
    self.init(host: EnvironmentTerminalHost(registry: registry, environmentId: environmentId))
  }

  public func start() {
    guard run == nil else { return }
    run = Task { [weak self] in await self?.follow() }
  }

  public func stop() {
    run?.cancel()
    run = nil
  }

  /// A thread's terminals, menu-ready.
  public func entries(threadId: String, current: TerminalMenuEntry? = nil) -> [TerminalMenuEntry] {
    TerminalMenu.entries(terminals ?? [], threadId: threadId, current: current)
  }

  private func follow() async {
    var previous: ObjectIdentifier?
    while !Task.isCancelled {
      guard let next = await host.channel(after: previous) else { return }
      previous = next.id
      do {
        for try await event in try await next.channel.stream(
          TerminalMetadataRequest.rpcTag, payload: EmptyObject(), of: TerminalMetadataEvent.self)
        {
          terminals = event.applied(to: terminals ?? [])
        }
      } catch is CancellationError {
        return
      } catch RpcError.failed {
        terminals = nil
      } catch {
        // Keep the last list while the computer reconnects.
      }
    }
  }
}

/// The bare client as a terminal channel (`ankiel-probe`).
extension RpcClient: TerminalChannel {}

/// A host with one fixed session that never reconnects (`ankiel-probe`).
@MainActor
public final class FixedTerminalHost: TerminalHost {
  private let channel: any TerminalChannel
  private final class Token {}
  private let token = Token()

  public init(channel: any TerminalChannel) {
    self.channel = channel
  }

  public var canOperate: Bool { true }

  public func channel(after previous: ObjectIdentifier?) async -> (id: ObjectIdentifier, channel: any TerminalChannel)? {
    guard ObjectIdentifier(token) != previous else { return nil }
    return (ObjectIdentifier(token), channel)
  }
}
