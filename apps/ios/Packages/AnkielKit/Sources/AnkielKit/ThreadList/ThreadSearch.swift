import Foundation

/// Search over loaded rows, and the rules for asking the server.
///
/// Local ranking is a simplified port of `scoreThreadSearch` (`shared/paletteSearch.ts`): every
/// word must appear in the title, branch, project or computer name (case and accent folded); title
/// matches rank above the rest, a title prefix above a word prefix above a substring, then the
/// most recent activity. The RN ranking's typo tolerance and open-history boost are not ported.
public enum ThreadSearch {
  /// `THREAD_SEARCH_QUERY_MAX_LENGTH`.
  public static let maxQueryLength = 200
  /// `THREAD_SEARCH_DEBOUNCE_MS`.
  public static let debounce: Duration = .milliseconds(120)
  /// `MESSAGE_TOKEN_MIN_LENGTH`.
  static let messageTokenMinLength = 3

  public static func fold(_ text: String) -> String {
    text.folding(options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive], locale: nil)
  }

  /// The query the server gets: trimmed and cut to 200 characters.
  public static func normalized(_ query: String) -> String {
    String(query.trimmingCharacters(in: .whitespacesAndNewlines).prefix(maxQueryLength))
      .trimmingCharacters(in: .whitespacesAndNewlines)
  }

  /// Messages need a word of three or more letters (two CJK characters); older settled titles match
  /// from two characters when some computer cut its shell.
  public static func canSearchServer(_ query: String, anyOlderSettled: Bool) -> Bool {
    let words = query.lowercased().split(whereSeparator: \.isWhitespace)
    let hasLong = words.contains { word in
      word.count >= messageTokenMinLength || (word.count == 2 && word.unicodeScalars.contains(where: isCJK))
    }
    return hasLong || (anyOlderSettled && query.count >= 2)
  }

  private static func isCJK(_ scalar: Unicode.Scalar) -> Bool {
    switch scalar.value {
    case 0x3040...0x30FF, 0x3400...0x4DBF, 0x4E00...0x9FFF, 0xAC00...0xD7AF, 0xF900...0xFAFF: true
    default: false
    }
  }

  static func rank(
    _ query: String, in threads: [ThreadFacts], projectTitle: (ThreadFacts) -> String?,
    environmentLabel: (ThreadFacts) -> String?
  ) -> [ThreadFacts] {
    let words = fold(query).split(whereSeparator: \.isWhitespace).map(String.init)
    guard !words.isEmpty else { return [] }
    var scored: [(facts: ThreadFacts, score: Int, at: Date)] = []
    for facts in threads {
      let title = fold(facts.title)
      let others = [facts.thread.branch, projectTitle(facts), environmentLabel(facts)].compactMap(\.self).map(fold)
      var score = 0
      var matchedAll = true
      for word in words {
        if title.hasPrefix(word) {
          score += 30
        } else if title.split(whereSeparator: { !$0.isLetter && !$0.isNumber }).contains(where: { $0.hasPrefix(word) }) {
          score += 20
        } else if title.contains(word) {
          score += 10
        } else if others.contains(where: { $0.contains(word) }) {
          score += 3
        } else {
          matchedAll = false
          break
        }
      }
      if matchedAll { scored.append((facts, score, facts.activityAt ?? facts.createdAt)) }
    }
    return scored.sorted { l, r in
      if l.score != r.score { return l.score > r.score }
      if l.at != r.at { return l.at > r.at }
      return l.facts.key < r.facts.key
    }.map(\.facts)
  }
}

/// `orchestration.searchThreads` input.
public struct ThreadSearchRequest: Sendable, Hashable, Encodable {
  public var query: String
  public var limit: Int?
  public var olderSettledBefore: String?
  public var projectIds: [String]?

  public init(query: String, limit: Int? = nil, olderSettledBefore: String? = nil, projectIds: [String]? = nil) {
    self.query = query
    self.limit = limit
    self.olderSettledBefore = olderSettledBefore
    self.projectIds = projectIds
  }

  public static let rpcTag = "orchestration.searchThreads"
}

/// `OrchestrationV2SearchThreadsResult`.
public struct ThreadSearchResult: Sendable, Hashable, Decodable {
  public struct Match: Sendable, Hashable, Decodable {
    public var threadId: String
    public var projectId: String
    public var snippet: String
    public var messageId: String?
  }

  public var matches: [Match]
  /// Older settled rows the shell left out, for matches among them.
  public var threads: [ThreadShell]

  enum CodingKeys: String, CodingKey { case matches, threads }

  public init(matches: [Match] = [], threads: [ThreadShell] = []) {
    self.matches = matches
    self.threads = threads
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    matches = (try c.decodeIfPresent(LossyArray<Match>.self, forKey: .matches))?.elements ?? []
    threads = (try? c.decodeIfPresent(LossyArray<ThreadShell>.self, forKey: .threads))??.elements ?? []
  }
}

/// `orchestration.getOlderSettledThreads` input.
public struct OlderSettledRequest: Sendable, Hashable, Encodable {
  public var before: OlderSettledCursor
  public var projectIds: [String]?
  public var limit: Int

  public init(before: OlderSettledCursor, projectIds: [String]? = nil, limit: Int) {
    self.before = before
    self.projectIds = projectIds
    self.limit = limit
  }

  public static let rpcTag = "orchestration.getOlderSettledThreads"
  /// `OLDER_SETTLED_PAGE_SIZE`.
  public static let pageSize = 25
}

/// `OrchestrationV2OlderSettledThreadsPage`.
public struct OlderSettledPage: Sendable, Hashable, Decodable {
  public var snapshotSequence: Int
  public var threads: [ThreadShell]
  public var counts: [ShellSnapshot.OlderSettled.Count]

  enum CodingKeys: String, CodingKey { case snapshotSequence, threads, counts }

  public init(snapshotSequence: Int, threads: [ThreadShell], counts: [ShellSnapshot.OlderSettled.Count] = []) {
    self.snapshotSequence = snapshotSequence
    self.threads = threads
    self.counts = counts
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    snapshotSequence = try c.decodeIfPresent(Int.self, forKey: .snapshotSequence) ?? 0
    threads = (try c.decodeIfPresent(LossyArray<ThreadShell>.self, forKey: .threads))?.elements ?? []
    counts = (try? c.decodeIfPresent([ShellSnapshot.OlderSettled.Count].self, forKey: .counts)) ?? []
  }
}

/// One environment's older settled pages (`state/olderSettledThreads.ts`, simplified to pages
/// held in memory for the session). Rows at or above `frontier` are local; below it the shelf
/// waits for the next page.
public struct OlderSettledPages: Sendable, Hashable {
  public enum Status: Sendable, Hashable { case ready, loading, failed }

  public var before: WireTimestamp
  public var counts: [String: Int]
  public var rows: [ThreadShell] = []
  /// nil: nothing older remains to load.
  public var frontier: OlderSettledCursor?
  public var status: Status = .ready

  public init(cut: ShellSnapshot.OlderSettled) {
    before = cut.before
    counts = Dictionary(cut.counts.map { ($0.projectId, $0.count) }, uniquingKeysWith: +)
    frontier = counts.values.reduce(0, +) > 0 ? OlderSettledCursor(settledAt: cut.before) : nil
  }

  /// Applies a page read from `frontier`.
  public mutating func append(_ page: OlderSettledPage) {
    let known = Set(rows.map(\.id))
    rows += page.threads.filter { !known.contains($0.id) }
    if page.threads.count < OlderSettledRequest.pageSize { frontier = nil }
    else if let last = page.threads.last, let settledAt = last.settledAt {
      frontier = OlderSettledCursor(settledAt: settledAt, threadId: last.id)
    } else {
      frontier = nil
    }
    status = .ready
  }

  /// Older settled threads in scope the client does not hold (`unloadedOlderSettledCount`).
  public func unloaded(projectIds: Set<String>?, held: [ThreadShell]) -> Int {
    guard let cut = before.date else { return 0 }
    var count = counts.filter { projectIds?.contains($0.key) ?? true }.values.reduce(0, +)
    for thread in held where projectIds?.contains(thread.projectId) ?? true {
      if thread.lineage.isListed, thread.settledOverride == .known(.settled), let settled = thread.settledAt?.date,
        settled < cut
      {
        count -= 1
      }
    }
    return max(0, count)
  }

  /// `settledShelfFrontier`: the highest frontier of environments that can still load.
  public static func shelfFrontier(_ pages: some Sequence<OlderSettledPages>) -> OlderSettledCursor? {
    var highest: OlderSettledCursor?
    for page in pages where page.status != .failed {
      guard let frontier = page.frontier, let date = frontier.settledAt.date else { continue }
      guard let current = highest, let currentDate = current.settledAt.date else {
        highest = frontier
        continue
      }
      if date > currentDate
        || (date == currentDate && frontier.threadId != nil
          && (current.threadId == nil || frontier.threadId! < current.threadId!))
      {
        highest = frontier
      }
    }
    return highest
  }
}
