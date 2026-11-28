import Foundation

/// `ServerProvider` (spec §8.1): one provider instance and its models, the fields the composer
/// reads. Every field decodes loosely; only `instanceId` and `driver` are required, so a provider
/// from a newer server never fails the config (a failed config ends the session).
public struct ServerProvider: Sendable, Hashable, Decodable, Identifiable {
  public var instanceId: String
  public var driver: String
  public var displayName: String?
  public var accentColor: String?
  public var badgeLabel: String?
  public var continuationGroupKey: String?
  public var showInteractionModeToggle: Bool?
  /// nil means all four.
  public var supportedRuntimeModes: [RuntimeMode]?
  public var enabled: Bool
  public var installed: Bool
  public var authStatus: String?
  public var availability: String?
  public var models: [ServerProviderModel]
  public var updateRequiredModelSlugs: [String]
  /// Read-only status for Settings: CLI version, `ready|warning|error|disabled`, the account.
  public var version: String?
  public var state: String?
  public var message: String?
  public var unavailableReason: String?
  public var authLabel: String?
  public var authEmail: String?
  public var latestVersion: String?
  /// `versionAdvisory.status == "behind_latest"`.
  public var isBehindLatest = false
  /// Subscription windows the computer last read for this account; nil when it reports none.
  public var usageLimits: ProviderUsageLimits?
  public var authWorkspaceId: String?
  /// The provider's own commands and skills, and per-folder catalogs that replace them there.
  public var slashCommands: [ProviderSlashCommand] = []
  public var skills: [ProviderSkill] = []
  public var workspaceSnapshots: [ProviderWorkspaceSnapshot] = []

  public var id: String { instanceId }

  public init(
    instanceId: String, driver: String, displayName: String? = nil, enabled: Bool = true, installed: Bool = true,
    models: [ServerProviderModel] = []
  ) {
    self.instanceId = instanceId
    self.driver = driver
    self.displayName = displayName
    self.enabled = enabled
    self.installed = installed
    self.models = models
    updateRequiredModelSlugs = []
  }

  enum CodingKeys: String, CodingKey {
    case instanceId, driver, displayName, accentColor, badgeLabel, continuation, showInteractionModeToggle
    case supportedRuntimeModes, enabled, installed, auth, availability, models, updateRequiredModels
    case version, status, message, unavailableReason, versionAdvisory, usageLimits
    case slashCommands, skills, workspaceSnapshots
  }

  struct Continuation: Decodable { var groupKey: String? }
  struct Auth: Decodable {
    var status: String?
    var label: String?
    var email: String?
    var workspaceId: String?
  }
  struct VersionAdvisory: Decodable {
    var status: String?
    var latestVersion: String?
  }
  struct Slug: Decodable { var slug: String }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    instanceId = try c.decode(String.self, forKey: .instanceId)
    driver = try c.decode(String.self, forKey: .driver)
    displayName = c.loose(String.self, .displayName)
    accentColor = c.loose(String.self, .accentColor)
    badgeLabel = c.loose(String.self, .badgeLabel)
    continuationGroupKey = c.loose(Continuation.self, .continuation)?.groupKey
    showInteractionModeToggle = c.loose(Bool.self, .showInteractionModeToggle)
    supportedRuntimeModes = c.loose([String].self, .supportedRuntimeModes)?.compactMap(RuntimeMode.init(rawValue:))
    enabled = c.loose(Bool.self, .enabled) ?? false
    installed = c.loose(Bool.self, .installed) ?? false
    let auth = c.loose(Auth.self, .auth)
    authStatus = auth?.status
    authLabel = auth?.label
    authEmail = auth?.email
    authWorkspaceId = auth?.workspaceId
    usageLimits = c.loose(ProviderUsageLimits.self, .usageLimits)
    version = c.loose(String.self, .version)
    state = c.loose(String.self, .status)
    message = c.loose(String.self, .message)
    unavailableReason = c.loose(String.self, .unavailableReason)
    let advisory = c.loose(VersionAdvisory.self, .versionAdvisory)
    latestVersion = advisory?.latestVersion
    isBehindLatest = advisory?.status == "behind_latest"
    availability = c.loose(String.self, .availability)
    models = c.loose(LossyArray<ServerProviderModel>.self, .models)?.elements ?? []
    updateRequiredModelSlugs = c.loose(LossyArray<Slug>.self, .updateRequiredModels)?.elements.map(\.slug) ?? []
    slashCommands = c.loose(LossyArray<ProviderSlashCommand>.self, .slashCommands)?.elements ?? []
    skills = c.loose(LossyArray<ProviderSkill>.self, .skills)?.elements ?? []
    workspaceSnapshots = c.loose(LossyArray<ProviderWorkspaceSnapshot>.self, .workspaceSnapshots)?.elements ?? []
  }

  /// RN `resolveProviderSlashCommandsForCwd` / `resolveProviderSkillsForCwd`: a folder's own
  /// catalog when the server scanned it, else the provider's.
  public func slashCommands(forCwd cwd: String?) -> [ProviderSlashCommand] {
    workspaceSnapshots.first { $0.cwd == cwd && cwd != nil }?.slashCommands ?? slashCommands
  }

  public func skills(forCwd cwd: String?) -> [ProviderSkill] {
    workspaceSnapshots.first { $0.cwd == cwd && cwd != nil }?.skills ?? skills
  }

  /// The label RN shows for the instance.
  public var label: String {
    if let displayName, !displayName.trimmingCharacters(in: .whitespaces).isEmpty { return displayName }
    return Self.driverLabels[driver] ?? driver
  }

  static let driverLabels = [
    "codex": "Codex", "claudeAgent": "Claude", "cursor": "Cursor", "opencode": "OpenCode", "grok": "Grok",
    "antigravity": "Antigravity", "kiro": "Kiro", "pi": "Pi", "devReplay": "Replay (dev)",
  ]

  /// RN `buildModelOptions`: installed, enabled, signed in, and (Antigravity) available.
  public var isSelectable: Bool {
    enabled && installed && authStatus != "unauthenticated" && !(driver == "antigravity" && availability == "unavailable")
  }
}

/// `ServerProviderModel`.
public struct ServerProviderModel: Sendable, Hashable, Decodable, Identifiable {
  public var slug: String
  public var name: String
  public var shortName: String?
  public var subProvider: String?
  public var isCustom: Bool
  public var isDefault: Bool
  public var isLegacy: Bool
  public var optionDescriptors: [OptionDescriptor]

  public var id: String { slug }

  public init(slug: String, name: String, isDefault: Bool = false, optionDescriptors: [OptionDescriptor] = []) {
    self.slug = slug
    self.name = name
    isCustom = false
    self.isDefault = isDefault
    isLegacy = false
    self.optionDescriptors = optionDescriptors
  }

  enum CodingKeys: String, CodingKey { case slug, name, shortName, subProvider, isCustom, isDefault, isLegacy, capabilities }
  struct Capabilities: Decodable { var optionDescriptors: LossyArray<OptionDescriptor>? }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    slug = try c.decode(String.self, forKey: .slug)
    name = c.loose(String.self, .name) ?? slug
    shortName = c.loose(String.self, .shortName)
    subProvider = c.loose(String.self, .subProvider)
    isCustom = c.loose(Bool.self, .isCustom) ?? false
    isDefault = c.loose(Bool.self, .isDefault) ?? false
    isLegacy = c.loose(Bool.self, .isLegacy) ?? false
    optionDescriptors = c.loose(Capabilities.self, .capabilities)?.optionDescriptors?.elements ?? []
  }
}

/// `ProviderOptionDescriptor`: a select (effort, variant, …) or a boolean (fast mode, thinking).
public struct OptionDescriptor: Sendable, Hashable, Decodable, Identifiable {
  public var id: String
  public var label: String
  public var description: String?
  public var kind: Kind
  public var choices: [Choice]
  public var currentValue: JSONValue?
  public var promptInjectedValues: [String]
  public var role: String?

  public enum Kind: String, Sendable { case select, boolean }

  public struct Choice: Sendable, Hashable, Decodable, Identifiable {
    public var id: String
    public var label: String
    public var description: String?
    public var isDefault: Bool

    public init(id: String, label: String, isDefault: Bool = false) {
      self.id = id
      self.label = label
      self.isDefault = isDefault
    }

    enum CodingKeys: String, CodingKey { case id, label, description, isDefault }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      id = try c.decode(String.self, forKey: .id)
      label = c.loose(String.self, .label) ?? id
      description = c.loose(String.self, .description)
      isDefault = c.loose(Bool.self, .isDefault) ?? false
    }
  }

  public init(
    id: String, label: String, kind: Kind, choices: [Choice] = [], currentValue: JSONValue? = nil, role: String? = nil
  ) {
    self.id = id
    self.label = label
    self.kind = kind
    self.choices = choices
    self.currentValue = currentValue
    promptInjectedValues = []
    self.role = role
  }

  enum CodingKeys: String, CodingKey { case id, label, description, type, options, currentValue, promptInjectedValues, role }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    guard let kind = Kind(rawValue: try c.decode(String.self, forKey: .type)) else {
      throw DecodingError.dataCorruptedError(forKey: .type, in: c, debugDescription: "unknown descriptor type")
    }
    self.kind = kind
    label = c.loose(String.self, .label) ?? id
    description = c.loose(String.self, .description)
    choices = c.loose(LossyArray<Choice>.self, .options)?.elements ?? []
    currentValue = c.loose(JSONValue.self, .currentValue)
    promptInjectedValues = c.loose([String].self, .promptInjectedValues) ?? []
    role = c.loose(String.self, .role)
  }

  /// RN `selectableProviderOptionChoices`: prompt-injected values ("ultrathink") are not picks.
  public var selectableChoices: [Choice] { choices.filter { !promptInjectedValues.contains($0.id) } }

  /// RN `isReasoningControl`.
  public var isReasoning: Bool {
    (kind == .select && role == "reasoning") || Self.reasoningIds.contains(id)
  }

  static let reasoningIds: Set<String> = ["effort", "reasoningEffort", "reasoning", "thinking"]
}

/// `ServerProviderSlashCommand`.
public struct ProviderSlashCommand: Sendable, Hashable, Decodable {
  public var name: String
  public var description: String?

  public init(name: String, description: String? = nil) {
    self.name = name
    self.description = description
  }
}

/// `ServerProviderSkill`, the fields the composer reads.
public struct ProviderSkill: Sendable, Hashable, Decodable {
  public var name: String
  public var displayName: String?
  public var description: String?
  public var shortDescription: String?
  public var enabled: Bool
  public var userInvocable: Bool?

  public init(name: String, displayName: String? = nil, description: String? = nil, shortDescription: String? = nil, enabled: Bool = true, userInvocable: Bool? = nil) {
    self.name = name
    self.displayName = displayName
    self.description = description
    self.shortDescription = shortDescription
    self.enabled = enabled
    self.userInvocable = userInvocable
  }

  enum CodingKeys: String, CodingKey { case name, displayName, description, shortDescription, enabled, userInvocable }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    name = try c.decode(String.self, forKey: .name)
    displayName = c.loose(String.self, .displayName)
    description = c.loose(String.self, .description)
    shortDescription = c.loose(String.self, .shortDescription)
    enabled = c.loose(Bool.self, .enabled) ?? false
    userInvocable = c.loose(Bool.self, .userInvocable)
  }

  /// Disabled and agent-only skills (`user-invocable: false`) are left out of menus.
  public var isUserInvocable: Bool { enabled && userInvocable != false }
}

/// `ServerProviderWorkspaceSnapshot`: one folder's commands and skills.
public struct ProviderWorkspaceSnapshot: Sendable, Hashable, Decodable {
  public var cwd: String
  public var slashCommands: [ProviderSlashCommand]
  public var skills: [ProviderSkill]

  enum CodingKeys: String, CodingKey { case cwd, slashCommands, skills }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    cwd = try c.decode(String.self, forKey: .cwd)
    slashCommands = c.loose(LossyArray<ProviderSlashCommand>.self, .slashCommands)?.elements ?? []
    skills = c.loose(LossyArray<ProviderSkill>.self, .skills)?.elements ?? []
  }
}
