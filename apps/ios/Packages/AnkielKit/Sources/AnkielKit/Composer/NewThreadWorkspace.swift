import Foundation

/// Where a new thread works (RN `ComposerDraftWorkspaceSelection` and `new-task-context-presentation`):
/// the project's current checkout, or a new worktree started from a base branch.
public struct NewThreadWorkspace: Sendable, Hashable, Codable {
  public enum Mode: String, Sendable, Hashable, Codable { case local, worktree }

  public var mode: Mode
  /// The worktree's base branch; nil follows the default branch.
  public var baseBranch: String?
  /// The user's own "Start from remote" choice; nil follows `newWorktreesStartFromOrigin`.
  public var startFromOrigin: Bool?

  public init(mode: Mode, baseBranch: String? = nil, startFromOrigin: Bool? = nil) {
    self.mode = mode
    self.baseBranch = baseBranch
    self.startFromOrigin = startFromOrigin
  }

  /// A project's default (RN `resolveNewThreadEnvMode` without `ankiel.json`): the project's own
  /// setting, else the computer's, else the current checkout.
  public static func defaultMode(project: ProjectShell.ThreadEnvMode?, settings: ProjectShell.ThreadEnvMode?) -> Mode {
    (project ?? settings) == .worktree ? .worktree : .local
  }

  /// What a new thread in this project starts with: the draft's choice, else the one remembered for
  /// the project, else its default. A project that is not a Git checkout only works in place.
  public static func resolve(
    draft: NewThreadWorkspace?, remembered: NewThreadWorkspace?, defaultMode: Mode, isGitRepo: Bool, refs: [WorkspaceRef],
    settingsStartFromOrigin: Bool
  ) -> Resolved {
    let chosen = draft ?? remembered ?? NewThreadWorkspace(mode: defaultMode)
    guard isGitRepo else { return Resolved(mode: .local, branch: refs.first(where: \.current)?.name, startFromOrigin: false) }
    switch chosen.mode {
    case .worktree:
      // The default may exist only as origin/<default>, so remote refs count too.
      let base = chosen.baseBranch ?? (refs.first(where: \.isDefault) ?? refs.first { !$0.isRemote && $0.current })?.name
      return Resolved(mode: .worktree, branch: base, startFromOrigin: chosen.startFromOrigin ?? settingsStartFromOrigin)
    case .local:
      return Resolved(mode: .local, branch: refs.first { !$0.isRemote && $0.current }?.name, startFromOrigin: false)
    }
  }

  public struct Resolved: Sendable, Hashable {
    public var mode: Mode
    /// The base branch for a worktree, the checked-out branch in place (nil until refs load).
    public var branch: String?
    public var startFromOrigin: Bool

    /// What `orchestration.launchThread` gets; nil while a worktree has no base yet.
    public var launch: LaunchWorkspace? {
      switch mode {
      case .local: .root
      case .worktree: branch.map { .worktree(baseRef: $0, startFromOrigin: startFromOrigin) }
      }
    }
  }

  /// RN `filterNewTaskBranches`.
  public static func filter(_ refs: [WorkspaceRef], query: String) -> [WorkspaceRef] {
    let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    return needle.isEmpty ? refs : refs.filter { $0.name.lowercased().contains(needle) }
  }
}

/// `orchestration.launchThread`'s `workspaceStrategy`.
public enum LaunchWorkspace: Sendable, Hashable, Codable {
  case root
  case worktree(baseRef: String, startFromOrigin: Bool)
}

/// One branch from `vcs.listRefs`.
public struct WorkspaceRef: Sendable, Hashable, Decodable, Identifiable {
  public var name: String
  public var current: Bool
  public var isDefault: Bool
  public var isRemote: Bool
  public var worktreePath: String?

  public var id: String { name }

  public init(name: String, current: Bool = false, isDefault: Bool = false, isRemote: Bool = false, worktreePath: String? = nil) {
    self.name = name
    self.current = current
    self.isDefault = isDefault
    self.isRemote = isRemote
    self.worktreePath = worktreePath
  }

  enum CodingKeys: String, CodingKey { case name, current, isDefault, isRemote, worktreePath }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    name = try c.decode(String.self, forKey: .name)
    current = c.loose(Bool.self, .current) ?? false
    isDefault = c.loose(Bool.self, .isDefault) ?? false
    isRemote = c.loose(Bool.self, .isRemote) ?? false
    worktreePath = c.loose(String.self, .worktreePath)
  }
}

public struct WorkspaceRefList: Sendable, Decodable {
  public var refs: [WorkspaceRef]
  /// The server answered for a folder that is a Git checkout (`isRepo`; older servers omit it).
  public var isRepo: Bool?

  enum CodingKeys: String, CodingKey { case refs, isRepo }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    refs = c.loose(LossyArray<WorkspaceRef>.self, .refs)?.elements ?? []
    isRepo = c.loose(Bool.self, .isRepo)
  }

  public static func list(cwd: String, via caller: some UnaryCaller) async throws -> WorkspaceRefList {
    try await caller.call(ListRefsRequest.rpcTag, payload: ListRefsRequest(cwd: cwd), as: WorkspaceRefList.self)
  }
}

extension EnvironmentRegistry {
  /// The project's branches for the new-thread workspace choice.
  public func workspaceRefs(cwd: String, in environmentId: String) async throws(EnvironmentRequestError) -> WorkspaceRefList {
    try await request(environmentId) { try await WorkspaceRefList.list(cwd: cwd, via: SessionCaller(session: $0)) }
  }
}
