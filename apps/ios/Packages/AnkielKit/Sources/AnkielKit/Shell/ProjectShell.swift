/// `OrchestrationProjectShell`: one project in the shell.
public struct ProjectShell: Sendable, Hashable, Codable, Identifiable {
  public var id: String
  public var title: String
  public var hasCustomTitle: Bool?
  public var workspaceRoot: String
  public var repositoryIdentity: RepositoryIdentity?
  public var defaultModelSelection: ModelSelection?
  public var defaultThreadEnvMode: WireEnum<ThreadEnvMode>?
  public var autoPull: Bool?
  public var faviconPath: String?
  public var projectIcon: ProjectIcon?
  public var scripts: [ProjectScript]
  public var trackedFolders: [TrackedFolder]?
  public var pinnedAt: WireTimestamp?
  public var archivedAt: WireTimestamp?
  public var createdAt: WireTimestamp
  public var updatedAt: WireTimestamp

  public enum ThreadEnvMode: String, Sendable { case local, worktree }

  public struct TrackedFolder: Sendable, Hashable, Codable {
    public var path: String
    public var name: String
    public var discovered: Bool?
  }

  enum CodingKeys: String, CodingKey {
    case id, title, hasCustomTitle, workspaceRoot, repositoryIdentity, defaultModelSelection,
      defaultThreadEnvMode, autoPull, faviconPath, projectIcon, scripts, trackedFolders, pinnedAt,
      archivedAt, createdAt, updatedAt
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    title = try c.decode(String.self, forKey: .title)
    hasCustomTitle = try c.decodeIfPresent(Bool.self, forKey: .hasCustomTitle)
    workspaceRoot = try c.decode(String.self, forKey: .workspaceRoot)
    repositoryIdentity = try c.decodeIfPresent(RepositoryIdentity.self, forKey: .repositoryIdentity)
    defaultModelSelection = try c.decodeIfPresent(ModelSelection.self, forKey: .defaultModelSelection)
    defaultThreadEnvMode = try c.decodeIfPresent(WireEnum<ThreadEnvMode>.self, forKey: .defaultThreadEnvMode)
    autoPull = try c.decodeIfPresent(Bool.self, forKey: .autoPull)
    faviconPath = try c.decodeIfPresent(String.self, forKey: .faviconPath)
    // Forward-compatible optional: an unreadable icon is dropped, not the project.
    projectIcon = try? c.decodeIfPresent(ProjectIcon.self, forKey: .projectIcon)
    scripts = (try? c.decodeIfPresent(LossyArray<ProjectScript>.self, forKey: .scripts))??.elements ?? []
    trackedFolders = try? c.decodeIfPresent([TrackedFolder].self, forKey: .trackedFolders)
    pinnedAt = try c.decodeIfPresent(WireTimestamp.self, forKey: .pinnedAt)
    archivedAt = try c.decodeIfPresent(WireTimestamp.self, forKey: .archivedAt)
    createdAt = try c.decode(WireTimestamp.self, forKey: .createdAt)
    updatedAt = try c.decode(WireTimestamp.self, forKey: .updatedAt)
  }
}

public enum ProjectIcon: Sendable, Hashable, Codable {
  case lucide(name: String, color: String, monogram: String?)
  case emoji(String)
  case monogram(text: String, color: String)
  case unknown(kind: String)

  enum CodingKeys: String, CodingKey { case kind, name, color, monogramText, monogram, emoji, text }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    switch try c.decode(String.self, forKey: .kind) {
    case "lucide":
      let monogram =
        try c.decodeIfPresent(String.self, forKey: .monogramText)
        ?? c.decodeIfPresent(String.self, forKey: .monogram)
      self = .lucide(
        name: try c.decode(String.self, forKey: .name), color: try c.decode(String.self, forKey: .color),
        monogram: monogram)
    case "emoji":
      self = .emoji(try c.decode(String.self, forKey: .emoji))
    case "monogram":
      self = .monogram(text: try c.decode(String.self, forKey: .text), color: try c.decode(String.self, forKey: .color))
    case let kind:
      self = .unknown(kind: kind)
    }
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    switch self {
    case .lucide(let name, let color, let monogram):
      try c.encode("lucide", forKey: .kind)
      try c.encode(name, forKey: .name)
      try c.encode(color, forKey: .color)
      try c.encodeIfPresent(monogram, forKey: .monogramText)
    case .emoji(let emoji):
      try c.encode("emoji", forKey: .kind)
      try c.encode(emoji, forKey: .emoji)
    case .monogram(let text, let color):
      try c.encode("monogram", forKey: .kind)
      try c.encode(text, forKey: .text)
      try c.encode(color, forKey: .color)
    case .unknown(let kind):
      try c.encode(kind, forKey: .kind)
    }
  }
}

public struct ProjectScript: Sendable, Hashable, Codable, Identifiable {
  public var id: String
  public var name: String
  public var command: String
  public var icon: WireEnum<Icon>
  public var runOnWorktreeCreate: Bool
  public var runOnSettle: Bool?
  public var stopOnSettle: Bool?
  public var async: Bool?
  public var previewUrl: String?
  public var autoOpenPreview: Bool?

  public enum Icon: String, Sendable { case play, test, lint, configure, build, debug }
}
