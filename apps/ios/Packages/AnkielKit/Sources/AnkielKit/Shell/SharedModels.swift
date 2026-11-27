/// `{instanceId, model, options?}`. Decodes the legacy `provider` key and object-shaped options.
public struct ModelSelection: Sendable, Hashable, Codable {
  public var instanceId: String
  public var model: String
  public var options: [Option]?

  public struct Option: Sendable, Hashable, Codable {
    public var id: String
    /// A string or a boolean.
    public var value: JSONValue
  }

  public init(instanceId: String, model: String, options: [Option]? = nil) {
    self.instanceId = instanceId
    self.model = model
    self.options = options
  }

  enum CodingKeys: String, CodingKey { case instanceId, provider, model, options }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    if let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId) {
      self.instanceId = instanceId
    } else {
      instanceId = try container.decode(String.self, forKey: .provider)
    }
    model = try container.decode(String.self, forKey: .model)
    if let list = try? container.decodeIfPresent([Option].self, forKey: .options) {
      options = list
    } else if let object = try? container.decodeIfPresent([String: JSONValue].self, forKey: .options) {
      options = object.sorted { $0.key < $1.key }.map { Option(id: $0.key, value: $0.value) }
    } else {
      options = nil
    }
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(instanceId, forKey: .instanceId)
    try container.encode(model, forKey: .model)
    try container.encodeIfPresent(options, forKey: .options)
  }
}

public enum RuntimeMode: String, Sendable, Codable, CaseIterable {
  case approvalRequired = "approval-required"
  case autoAcceptEdits = "auto-accept-edits"
  case auto
  case fullAccess = "full-access"
}

public enum InteractionMode: String, Sendable, Codable, CaseIterable {
  case `default`, plan
}

public struct RepositoryIdentity: Sendable, Hashable, Codable {
  public var canonicalKey: String
  public var locator: Locator?
  public var webUrl: String?
  public var rootPath: String?
  public var displayName: String?
  public var provider: String?
  public var owner: String?
  public var name: String?
  public var origin: Origin?

  public struct Locator: Sendable, Hashable, Codable {
    public var source: String
    public var remoteName: String?
    public var remoteUrl: String?
  }

  public struct Origin: Sendable, Hashable, Codable {
    public var canonicalKey: String
    public var remoteUrl: String?
    public var displayName: String?
  }

  /// The key that groups projects across environments.
  public var groupingKey: String { origin?.canonicalKey ?? canonicalKey }
}
