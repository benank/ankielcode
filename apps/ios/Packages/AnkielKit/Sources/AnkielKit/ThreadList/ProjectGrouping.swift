import Foundation

/// A project in one environment.
public struct ScopedProject: Sendable, Hashable {
  public var environmentId: String
  public var project: ProjectShell
  /// The server's scratch folder ("No project").
  public var isScratch: Bool

  public init(environmentId: String, project: ProjectShell, isScratch: Bool = false) {
    self.environmentId = environmentId
    self.project = project
    self.isScratch = isScratch
  }

  public var key: String { "\(environmentId):\(project.id)" }
}

/// A project filter choice: projects that share a repository across computers
/// (`buildProjectGroups` in repository mode with scratch projects grouped, `state/projectGrouping.ts`).
public struct ProjectScope: Sendable, Hashable, Identifiable {
  public var id: String { key }
  public var key: String
  /// nil for the scratch group, which the app names "No project".
  public var title: String?
  public var projectKeys: Set<String>
  public var pinned: Bool
  public var archived: Bool
}

public enum ProjectGrouping {
  static let scratchKey = "\u{0}no-project"

  static func normalizedPath(_ path: String) -> String {
    var path = path.trimmingCharacters(in: .whitespaces)
    while path.count > 1, path.hasSuffix("/") { path.removeLast() }
    return path
  }

  static func isRepositoryRoot(_ project: ProjectShell) -> Bool {
    guard let root = project.repositoryIdentity?.rootPath?.trimmingCharacters(in: .whitespaces), !root.isEmpty else {
      return false
    }
    return normalizedPath(project.workspaceRoot) == normalizedPath(root)
  }

  static func logicalKey(_ scoped: ScopedProject) -> String {
    if scoped.isScratch { return scratchKey }
    if let key = scoped.project.repositoryIdentity?.groupingKey, !key.contains("\u{0}") { return key }
    return "\(scoped.environmentId):\(normalizedPath(scoped.project.workspaceRoot))"
  }

  static func freshness(_ project: ProjectShell) -> Date {
    project.updatedAt.date ?? project.createdAt.date ?? .distantPast
  }

  /// The scopes the filter menu offers, unsorted.
  public static func scopes(_ projects: [ScopedProject]) -> [ProjectScope] {
    // One winner per physical folder (the freshest), then group winners by logical key.
    var physical: [String: [ScopedProject]] = [:]
    var physicalOrder: [String] = []
    for scoped in projects {
      let key = "\(scoped.environmentId):\(normalizedPath(scoped.project.workspaceRoot))"
      if physical[key] == nil { physicalOrder.append(key) }
      physical[key, default: []].append(scoped)
    }
    var groups: [String: [ScopedProject]] = [:]
    var groupOrder: [String] = []
    var logicalByPhysical: [String: String] = [:]
    for key in physicalOrder {
      let members = physical[key]!
      let winner = members.dropFirst().reduce(members[0]) { current, candidate in
        let delta = freshness(candidate.project).timeIntervalSince(freshness(current.project))
        return delta > 0 || (delta == 0 && candidate.project.id > current.project.id) ? candidate : current
      }
      let identitySource =
        winner.project.repositoryIdentity != nil
        ? winner : (members.filter { $0.project.repositoryIdentity != nil }.max { freshness($0.project) < freshness($1.project) } ?? winner)
      var keyed = identitySource
      keyed.isScratch = winner.isScratch
      let logical = logicalKey(keyed)
      logicalByPhysical[key] = logical
      if groups[logical] == nil { groupOrder.append(logical) }
      groups[logical, default: []].append(winner)
    }
    var keysByGroup: [String: Set<String>] = [:]
    for scoped in projects {
      let physicalKey = "\(scoped.environmentId):\(normalizedPath(scoped.project.workspaceRoot))"
      keysByGroup[logicalByPhysical[physicalKey] ?? logicalKey(scoped), default: []].insert(scoped.key)
    }
    return groupOrder.map { key in
      let members = groups[key]!
      let representative = members.first { isRepositoryRoot($0.project) } ?? members[0]
      let title: String? =
        representative.isScratch ? nil : (members.count > 1 ? label(key: key, representative: representative, members: members) : representative.project.title)
      return ProjectScope(
        key: key, title: title, projectKeys: keysByGroup[key] ?? [],
        pinned: members.contains { $0.project.pinnedAt != nil },
        archived: !members.contains { $0.project.archivedAt == nil })
    }
  }

  /// `deriveProjectGroupLabel`: a shared chosen title, else the repository's name.
  static func label(key: String, representative: ScopedProject, members: [ScopedProject]) -> String {
    func unique(_ values: [String?]) -> [String] {
      var seen = Set<String>()
      return values.compactMap { $0?.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty && seen.insert($0).inserted }
    }
    func displayName(_ identity: RepositoryIdentity) -> String? {
      identity.origin.map { $0.displayName ?? $0.canonicalKey } ?? identity.displayName
    }
    let titles = unique(members.map(\.project.title))
    let displayNames = unique(members.map { $0.project.repositoryIdentity.flatMap(displayName) })
    let names = unique(members.map { $0.project.repositoryIdentity?.name })
    if titles.count == 1, let title = titles.first,
      members.contains(where: { $0.project.hasCustomTitle == true }) || (!displayNames.contains(title) && !names.contains(title))
    {
      return title
    }
    if displayNames.count == 1 { return displayNames[0] }
    if names.count == 1 { return names[0] }
    if let identity = representative.project.repositoryIdentity, key == identity.groupingKey {
      return displayName(identity) ?? identity.name ?? representative.project.title
    }
    return representative.project.title
  }

  /// Archived scopes left out, pinned first, each part ordered by its latest thread activity
  /// (`sortHomeProjectScopes` with `updated_at`, then `pickableProjectGroups`).
  public static func filterChoices(
    _ scopes: [ProjectScope], threads: [(environmentId: String, thread: ThreadShell)], projects: [ScopedProject]
  ) -> [ProjectScope] {
    var scopeByProject: [String: String] = [:]
    for scope in scopes { for key in scope.projectKeys { scopeByProject[key] = scope.key } }
    var latest: [String: Date] = [:]
    for (environmentId, thread) in threads where thread.archivedAt == nil {
      guard let scope = scopeByProject["\(environmentId):\(thread.projectId)"] else { continue }
      let at = ThreadOrder.userActivityAt(ThreadFacts(environmentId: environmentId, thread: thread))
      latest[scope] = max(latest[scope] ?? .distantPast, at)
    }
    let freshnessByProject = Dictionary(projects.map { ($0.key, freshness($0.project)) }, uniquingKeysWith: max)
    func timestamp(_ scope: ProjectScope) -> Date {
      latest[scope.key] ?? scope.projectKeys.compactMap { freshnessByProject[$0] }.max() ?? .distantPast
    }
    let sorted = scopes.sorted { l, r in
      let left = timestamp(l), right = timestamp(r)
      if left != right { return left > right }
      if (l.title ?? "") != (r.title ?? "") { return (l.title ?? "") < (r.title ?? "") }
      return l.key < r.key
    }
    let open = sorted.filter { !$0.archived }
    return open.filter(\.pinned) + open.filter { !$0.pinned }
  }

  /// A scratch project is the server's scratch folder.
  public static func isScratch(_ project: ProjectShell, scratchRoot: String?) -> Bool {
    guard let scratchRoot else { return false }
    return normalizedPath(project.workspaceRoot) == normalizedPath(scratchRoot)
  }
}
