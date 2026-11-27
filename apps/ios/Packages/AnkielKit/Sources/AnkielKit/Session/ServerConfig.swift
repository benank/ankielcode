/// The parts of `ServerConfig` this client reads so far. Unknown and unread fields are skipped.
public struct ServerConfig: Sendable, Hashable, Decodable {
  public var environment: EnvironmentDescriptor
  public var cwd: String?
  public var hostname: String?
  public var serverTime: WireTimestamp?
  public var shellThreadFamilies: Bool?
  public var shellOlderSettled: Bool?
  public var shellResumeCompletionMarker: Bool?
  public var directEndpoints: [DirectEndpoint]

  public struct DirectEndpoint: Sendable, Hashable, Decodable {
    public var kind: WireEnum<Kind>
    public var httpBaseUrl: String

    public enum Kind: String, Sendable { case lan, tailnet, relay }
  }

  enum CodingKeys: String, CodingKey {
    case environment, cwd, hostname, serverTime, shellThreadFamilies, shellOlderSettled,
      shellResumeCompletionMarker, directEndpoints
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    environment = try c.decode(EnvironmentDescriptor.self, forKey: .environment)
    cwd = try? c.decodeIfPresent(String.self, forKey: .cwd)
    hostname = try? c.decodeIfPresent(String.self, forKey: .hostname)
    serverTime = try? c.decodeIfPresent(WireTimestamp.self, forKey: .serverTime)
    shellThreadFamilies = try? c.decodeIfPresent(Bool.self, forKey: .shellThreadFamilies)
    shellOlderSettled = try? c.decodeIfPresent(Bool.self, forKey: .shellOlderSettled)
    shellResumeCompletionMarker = try? c.decodeIfPresent(Bool.self, forKey: .shellResumeCompletionMarker)
    directEndpoints =
      ((try? c.decodeIfPresent(LossyArray<DirectEndpoint>.self, forKey: .directEndpoints)) ?? nil)?.elements ?? []
  }

  /// The subscription the RN client sends for this server: omit idle subagents and older settled
  /// threads when advertised, and always ask for the completion marker.
  public var shellSubscription: ShellSubscription {
    let families = shellThreadFamilies == true
    return ShellSubscription(
      requestCompletionMarker: true,
      omitIdleSubagents: families ? true : nil,
      omitOlderSettled: families && shellOlderSettled == true ? true : nil)
  }
}

/// One item of `subscribeServerConfig` (`{"version":1,"type":…}`).
public enum ServerConfigEvent: Sendable, Decodable {
  case snapshot(ServerConfig)
  /// `keybindingsUpdated`, `providerStatuses`, `settingsUpdated`, … (decoded in later phases).
  case other(type: String)

  enum CodingKeys: String, CodingKey { case type, config }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    let type = try c.decode(String.self, forKey: .type)
    if type == "snapshot" {
      self = .snapshot(try c.decode(ServerConfig.self, forKey: .config))
    } else {
      self = .other(type: type)
    }
  }
}

/// `subscribeServerConfig` opt-ins. Each flag changes event shapes, so only send what is handled.
public struct ServerConfigSubscription: Sendable, Hashable, Encodable {
  public var usageLimitsCommand: Bool?
  public var providerCatalogsOnDemand: Bool?
  public var providerCatalogDigests: Bool?
  public var providerStatusDeltas: Bool?
  public var workspaceSnapshotsOnDemand: Bool?

  public init() {}

  public static let rpcTag = "subscribeServerConfig"
}
