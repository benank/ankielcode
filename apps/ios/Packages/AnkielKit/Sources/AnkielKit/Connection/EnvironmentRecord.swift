import Foundation

/// A saved environment on this device. Secrets live in the `CredentialStore`, never here.
public struct EnvironmentRecord: Sendable, Hashable, Codable, Identifiable {
  public var environmentId: String
  /// The label the server reported when paired or last connected.
  public var serverLabel: String
  /// A name the user chose on this device.
  public var customLabel: String?
  public var routes: [EnvironmentRoute]
  public var lastRouteId: String?
  public var serverVersion: String
  public var pairedAt: Date
  public var lastConnectedAt: Date?
  /// false when the user turned the computer off on this device; nil (older files) means on.
  public var enabled: Bool?
  /// Route ids in the order the user prefers them; nil keeps the default order.
  public var routeOrder: [String]?

  public var id: String { environmentId }
  public var label: String { customLabel ?? serverLabel }
  public var pairedRoute: EnvironmentRoute? { routes.first { !$0.learned } ?? routes.first }
  public var lastRoute: EnvironmentRoute? { routes.first { $0.id == lastRouteId } ?? pairedRoute }

  public init(_ environment: SavedEnvironment) {
    environmentId = environment.environmentId
    serverLabel = environment.label
    routes = [EnvironmentRoute(endpoint: environment.endpoint)]
    serverVersion = environment.serverVersion
    pairedAt = environment.pairedAt
  }

  /// Re-pairing through a known address: the paired route moves to that address.
  mutating func repair(with environment: SavedEnvironment) {
    serverLabel = environment.label
    serverVersion = environment.serverVersion
    routes.removeAll { $0.endpoint == environment.endpoint }
    routes.insert(EnvironmentRoute(endpoint: environment.endpoint), at: 0)
    routes = routes.enumerated().map { index, route in
      var route = route
      if index > 0 { route.learned = true }
      return route
    }
  }
}

/// The saved environments as one JSON file. Reads and writes run off the caller's actor.
public struct EnvironmentRecordStore: Sendable {
  public let url: URL

  public init(url: URL) {
    self.url = url
  }

  struct File: Codable {
    var version = 1
    var environments: [EnvironmentRecord]
  }

  @concurrent public func load() async -> [EnvironmentRecord]? {
    guard let data = try? Data(contentsOf: url) else { return nil }
    return (try? JSONDecoder().decode(File.self, from: data))?.environments
  }

  @concurrent public func save(_ records: [EnvironmentRecord]) async throws {
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try JSONEncoder().encode(File(environments: records)).write(to: url, options: .protectedAtomic)
  }
}

extension Data.WritingOptions {
  /// Atomic, and on iOS readable only while unlocked after first unlock.
  static var protectedAtomic: Data.WritingOptions {
    #if os(iOS)
      [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
    #else
      .atomic
    #endif
  }
}
