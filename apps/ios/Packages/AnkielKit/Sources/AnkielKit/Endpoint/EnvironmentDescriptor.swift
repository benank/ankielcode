/// `GET /.well-known/ankiel/environment`: who answers at an address, read before any credential
/// is sent.
public struct EnvironmentDescriptor: Sendable, Hashable, Decodable {
  public var environmentId: String
  public var label: String
  public var platform: Platform?
  public var serverVersion: String
  /// Absent means protocol 1.
  public var orchestrationProtocolVersion: Int?
  public var databaseMigration: Int?
  /// Every capability flag the server advertised, kept whole; the client reads the few it uses.
  public var capabilities: [String: JSONValue]

  public struct Platform: Sendable, Hashable, Decodable {
    public var os: WireEnum<OS>
    public var arch: WireEnum<Arch>

    public enum OS: String, Sendable { case darwin, linux, windows, unknown }
    public enum Arch: String, Sendable { case arm64, x64, other }
  }

  public static let supportedProtocolVersion = 2

  public var protocolVersion: Int { orchestrationProtocolVersion ?? 1 }

  public func capability(_ name: String) -> Bool {
    capabilities[name]?.boolValue == true
  }

  enum CodingKeys: String, CodingKey {
    case environmentId, label, platform, serverVersion, orchestrationProtocolVersion,
      databaseMigration, capabilities
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    environmentId = try container.decode(String.self, forKey: .environmentId)
    label = try container.decode(String.self, forKey: .label)
    platform = try? container.decodeIfPresent(Platform.self, forKey: .platform)
    serverVersion = try container.decodeIfPresent(String.self, forKey: .serverVersion) ?? "unknown"
    orchestrationProtocolVersion = try? container.decodeIfPresent(Int.self, forKey: .orchestrationProtocolVersion)
    databaseMigration = try? container.decodeIfPresent(Int.self, forKey: .databaseMigration)
    capabilities = (try? container.decodeIfPresent([String: JSONValue].self, forKey: .capabilities)) ?? [:]
  }

  public init(
    environmentId: String, label: String, serverVersion: String,
    orchestrationProtocolVersion: Int?, capabilities: [String: JSONValue] = [:]
  ) {
    self.environmentId = environmentId
    self.label = label
    self.serverVersion = serverVersion
    self.orchestrationProtocolVersion = orchestrationProtocolVersion
    self.capabilities = capabilities
  }
}
