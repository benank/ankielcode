import Foundation

/// `orchestration.getArchivedShellSnapshot {}`: the input is an empty struct, so the server has
/// no paging or search for archived threads. The client filters and pages the one answer.
public struct ArchivedShellRequest: Sendable, Hashable, Encodable {
  public init() {}

  public static let rpcTag = "orchestration.getArchivedShellSnapshot"
}

/// `OrchestrationV2ArchivedShellSnapshot`: archived rows and the projects they belong to.
public struct ArchivedShellSnapshot: Sendable, Hashable, Decodable {
  public var snapshotSequence: Int
  public var projects: [ProjectShell]
  public var threads: [ThreadShell]

  enum CodingKeys: String, CodingKey { case snapshotSequence, projects, threads }

  public init(snapshotSequence: Int = 0, projects: [ProjectShell] = [], threads: [ThreadShell] = []) {
    self.snapshotSequence = snapshotSequence
    self.projects = projects
    self.threads = threads
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    snapshotSequence = try c.decodeIfPresent(Int.self, forKey: .snapshotSequence) ?? 0
    projects = (try c.decodeIfPresent(LossyArray<ProjectShell>.self, forKey: .projects))?.elements ?? []
    threads = (try c.decodeIfPresent(LossyArray<ThreadShell>.self, forKey: .threads))?.elements ?? []
  }
}

/// The Archived screen's rows (RN `archivedThreadList.ts`): one group per computer and project,
/// filtered by computer and search, sorted by archive time.
public enum ArchivedThreadList {
  public enum SortOrder: String, Sendable, Hashable, CaseIterable { case newest, oldest }

  public struct Source: Sendable, Hashable {
    public var environmentId: String
    public var label: String
    public var snapshot: ArchivedShellSnapshot

    public init(environmentId: String, label: String, snapshot: ArchivedShellSnapshot) {
      self.environmentId = environmentId
      self.label = label
      self.snapshot = snapshot
    }
  }

  public struct Row: Sendable, Hashable, Identifiable {
    public var ref: ThreadRef
    public var title: String
    public var branch: String?
    public var environmentLabel: String
    public var archivedAt: Date
    public var id: String { ref.key }
  }

  public struct Group: Sendable, Hashable, Identifiable {
    public var id: String
    public var environmentId: String
    public var environmentLabel: String
    public var projectTitle: String
    public var rows: [Row]
  }

  public static func groups(
    _ sources: [Source], environmentId: String? = nil, query: String = "", order: SortOrder = .newest,
    hidden: Set<String> = []
  ) -> [Group] {
    let words = fold(query).split(separator: " ").map(String.init)
    func matches(_ fields: String?...) -> Bool {
      guard !words.isEmpty else { return true }
      let haystack = fields.compactMap { $0 }.map(fold).joined(separator: " ")
      return words.allSatisfy { haystack.contains($0) }
    }
    func newerFirst(_ l: Date, _ r: Date) -> Bool { order == .newest ? l > r : l < r }

    var groups: [Group] = []
    for source in sources where environmentId == nil || source.environmentId == environmentId {
      var byProject: [String: [ThreadShell]] = [:]
      for thread in source.snapshot.threads where thread.archivedAt != nil {
        guard !hidden.contains("\(source.environmentId):\(thread.id)") else { continue }
        byProject[thread.projectId, default: []].append(thread)
      }
      for project in source.snapshot.projects {
        guard let threads = byProject[project.id] else { continue }
        let groupMatches = matches(project.title, project.workspaceRoot, source.label)
        let rows = threads.filter { groupMatches || matches($0.title, $0.branch) }.map { thread in
          Row(
            ref: ThreadRef(environmentId: source.environmentId, threadId: thread.id), title: thread.title,
            branch: thread.branch, environmentLabel: source.label,
            archivedAt: (thread.archivedAt ?? thread.updatedAt).date ?? .distantPast)
        }
        .sorted { l, r in
          if l.archivedAt != r.archivedAt { return newerFirst(l.archivedAt, r.archivedAt) }
          if l.title != r.title { return l.title < r.title }
          return l.id < r.id
        }
        guard !rows.isEmpty else { continue }
        groups.append(
          Group(
            id: "\(source.environmentId):\(project.id)", environmentId: source.environmentId,
            environmentLabel: source.label, projectTitle: project.title, rows: rows))
      }
    }
    return groups.sorted { l, r in
      let lt = l.rows[0].archivedAt
      let rt = r.rows[0].archivedAt
      if lt != rt { return newerFirst(lt, rt) }
      if l.projectTitle != r.projectTitle { return l.projectTitle < r.projectTitle }
      return l.id < r.id
    }
  }

  static func fold(_ text: String) -> String {
    text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
      .trimmingCharacters(in: .whitespacesAndNewlines)
  }
}

extension EnvironmentRegistry {
  /// One computer's archived threads (scope `orchestration:read`).
  public func archivedSnapshot(in environmentId: String) async throws(EnvironmentRequestError) -> ArchivedShellSnapshot {
    try await request(environmentId) { session in
      try await session.call(ArchivedShellRequest.rpcTag, payload: ArchivedShellRequest(), as: ArchivedShellSnapshot.self)
    }
  }
}
