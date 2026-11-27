import Foundation

/// Files changed: the diff's pages parsed into files, which are tests, which are folded, and
/// where review threads and pending comments sit on their lines.
public enum PullRequestDiffs {
  /// Test files, judged from their path (RN `pullRequestFileFilters`).
  public static func isTest(_ path: String) -> Bool {
    let lower = path.lowercased()
    let name = lower.split(separator: "/").last.map(String.init) ?? lower
    if lower.contains("/__tests__/") || lower.hasPrefix("__tests__/") { return true }
    if lower.split(separator: "/").dropLast().contains(where: { ["test", "tests", "spec", "specs", "__snapshots__"].contains($0) }) {
      return true
    }
    if name.contains(".test.") || name.contains(".spec.") || name.hasSuffix("_test.go") || name.hasSuffix("_test.py")
      || name.hasPrefix("test_") || name.hasSuffix("tests.swift") || name.hasSuffix("test.swift") || name.hasSuffix("test.kt")
      || name.hasSuffix("test.java")
    {
      return true
    }
    return false
  }

  /// Every page's files, in review order, the later page's copy winning for a repeated path.
  public static func files(_ pages: [PullRequestDiffResult]) -> [DiffFile] {
    var byPath: [String: DiffFile] = [:]
    var order: [String] = []
    for page in pages {
      for file in UnifiedDiff.parse(page.patch).files {
        if byPath[file.path] == nil { order.append(file.path) }
        byPath[file.path] = file
      }
    }
    return DiffFileOrder.order(order.compactMap { byPath[$0] })
  }

  // MARK: Folds (client-runtime `pullRequestDiffFold.ts`)

  public enum FoldOverride: Sendable, Hashable { case expanded, folded }

  public struct FoldGroup: Sendable, Hashable {
    public var override: FoldOverride?
    /// The reader's own choice per file. Absolute, so a viewed mark loading later keeps it.
    public var choices: [String: Bool] = [:]
    public init(override: FoldOverride? = nil, choices: [String: Bool] = [:]) {
      self.override = override
      self.choices = choices
    }
  }

  /// Test files keep their own group, so a bulk fold while they are hidden leaves them be.
  public struct Folds: Sendable, Hashable {
    public var source = FoldGroup()
    public var test = FoldGroup()
    public init() {}

    public func isCollapsed(_ path: String, viewed: Bool) -> Bool {
      let group = PullRequestDiffs.isTest(path) ? test : source
      return group.choices[path] ?? (group.override.map { $0 == .folded } ?? viewed)
    }

    public mutating func set(_ path: String, collapsed: Bool?) {
      let isTest = PullRequestDiffs.isTest(path)
      var group = isTest ? test : source
      group.choices[path] = collapsed
      if isTest { test = group } else { source = group }
    }

    /// Expands or folds every file. While tests are hidden, only the shown ones follow.
    public mutating func setAll(_ override: FoldOverride, hiddenTests shownTestPaths: [String]?) {
      source = FoldGroup(override: override)
      guard let shown = shownTestPaths else {
        test = FoldGroup(override: override)
        return
      }
      for path in shown { test.choices[path] = override == .folded }
    }
  }

  // MARK: Comments on lines (RN `annotatePullRequestDiff`)

  public struct Note: Sendable, Hashable, Identifiable {
    public enum Kind: Sendable, Hashable {
      case thread(PullRequestReviewThread)
      case draft(PullRequestReviewCommentDraft)
    }
    public var id: String
    public var kind: Kind
  }

  public struct Placement: Sendable, Hashable {
    /// Notes after a line row, by `DiffRow.id`.
    public var byRow: [String: [Note]] = [:]
    /// Threads on the whole file (`line` nil) or on lines outside the shown hunks.
    public var fileLevel: [Note] = []
    public var count: Int { byRow.values.reduce(0) { $0 + $1.count } + fileLevel.count }
  }

  /// Places a file's current (not outdated) threads and pending comments on their rows.
  public static func place(
    threads: [PullRequestReviewThread], drafts: [PullRequestReviewCommentDraft], path: String, rows: [DiffRow]
  ) -> Placement {
    var lines: [String: String] = [:]
    for row in rows {
      guard let line = row.line else { continue }
      if let old = line.oldNumber, line.kind != .added { lines["left:\(old)"] = row.id }
      if let new = line.newNumber, line.kind != .removed { lines["right:\(new)"] = row.id }
    }
    var placement = Placement()
    func attach(_ note: Note, side: PullRequestDiffSide?, line: Int?) {
      if let side, let line, let row = lines["\(side.rawValue):\(line)"] {
        placement.byRow[row, default: []].append(note)
      } else {
        placement.fileLevel.append(note)
      }
    }
    for thread in threads where thread.path == path && !thread.isOutdated {
      attach(Note(id: "discussion:\(thread.id)", kind: .thread(thread)), side: thread.side.known ?? .right, line: thread.line)
    }
    for draft in drafts where draft.path == path {
      let anchor = draft.position.anchor
      attach(Note(id: "draft:\(draft.id)", kind: .draft(draft)), side: anchor.side, line: anchor.line)
    }
    return placement
  }

  /// Open threads per file path, for the file list's counts.
  public static func threadCounts(_ threads: [PullRequestReviewThread]) -> [String: Int] {
    var counts: [String: Int] = [:]
    for thread in threads where !thread.isOutdated && !thread.isResolved {
      if let path = thread.path { counts[path, default: 0] += 1 }
    }
    return counts
  }

  // MARK: Viewed marks (RN `pullRequestFilesViewed.ts`)

  /// The host's viewed paths with presses it has not caught up with laid over them.
  public static func viewed(host: PullRequestFilesViewedResult?, presses: [String: Bool]) -> Set<String> {
    var viewed = Set(host?.files.filter { $0.state == .viewed }.map(\.path) ?? [])
    for (path, pressed) in presses {
      if pressed { viewed.insert(path) } else { viewed.remove(path) }
    }
    return viewed
  }
}

// MARK: Reactions (client-runtime `pullRequestReactions.ts`)

public enum PullRequestReactions {
  public static let order: [PullRequestReactionContent] = PullRequestReactionContent.allCases

  public static func emoji(_ content: PullRequestReactionContent) -> String {
    switch content {
    case .thumbsUp: "👍"
    case .thumbsDown: "👎"
    case .laugh: "😄"
    case .hooray: "🎉"
    case .confused: "😕"
    case .heart: "❤️"
    case .rocket: "🚀"
    case .eyes: "👀"
    }
  }

  /// The host's reactions with this device's unanswered toggles applied, in GitHub's order.
  public static func applying(_ pending: [PullRequestReactionContent: Bool], to reactions: [PullRequestReaction]) -> [PullRequestReaction] {
    guard !pending.isEmpty else { return reactions }
    var byContent: [PullRequestReactionContent: PullRequestReaction] = [:]
    for reaction in reactions { if let content = reaction.content.known { byContent[content] = reaction } }
    for (content, reacted) in pending {
      guard var current = byContent[content] else {
        if reacted { byContent[content] = PullRequestReaction(content: content, count: 1, viewerHasReacted: true) }
        continue
      }
      guard current.viewerHasReacted != reacted else { continue }
      current.count += reacted ? 1 : -1
      current.viewerHasReacted = reacted
      byContent[content] = current.count <= 0 ? nil : current
    }
    return order.compactMap { byContent[$0] }
  }

  /// Who reacted, with the viewer first when the count has room for them (hosts omit the viewer).
  public static func names(_ reaction: PullRequestReaction, you: String, limit: Int = 3) -> (shown: [String], others: Int) {
    let names = reaction.viewerHasReacted && reaction.actors.count < reaction.count ? [you] + reaction.actors : reaction.actors
    let shown = Array(names.prefix(min(limit, reaction.count)))
    return (shown, max(0, reaction.count - shown.count))
  }

  /// Comment reactions are not offered on GitCafe reviews.
  public static func canReact(provider: String, capabilities: PullRequestCapabilities, kind: WireEnum<PullRequestCommentKind>?) -> Bool {
    capabilities.reactions == true && !(provider == "gitcafe" && kind == .review)
  }
}

// MARK: Picker drafts (client-runtime `pullRequestSelection.ts`)

/// Picks that differ from the host, keyed by candidate. Nothing is sent until the picker closes,
/// and then only what still differs from the host's latest state.
public struct PullRequestSelection<Item: Sendable & Hashable>: Sendable, Hashable {
  public private(set) var picks: [String: (item: Item, selected: Bool)] = [:]

  public init() {}

  public func isSelected(_ key: String, host: Bool) -> Bool { picks[key]?.selected ?? host }

  public mutating func toggle(_ key: String, item: Item, host: Bool) {
    let selected = !isSelected(key, host: host)
    if selected == host { picks[key] = nil } else { picks[key] = (item, selected) }
  }

  public func changes(host: (String, Item) -> Bool) -> (add: [Item], remove: [Item]) {
    var add: [Item] = []
    var remove: [Item] = []
    for key in picks.keys.sorted() {
      guard let pick = picks[key], pick.selected != host(key, pick.item) else { continue }
      if pick.selected { add.append(pick.item) } else { remove.append(pick.item) }
    }
    return (add, remove)
  }

  /// Writes the contract accepts (at most 25 changes each).
  public static func batches(_ items: [Item], size: Int = 25) -> [[Item]] {
    stride(from: 0, to: items.count, by: size).map { Array(items[$0..<min($0 + size, items.count)]) }
  }

  public static func == (lhs: Self, rhs: Self) -> Bool {
    lhs.picks.mapValues(\.selected) == rhs.picks.mapValues(\.selected)
  }

  public func hash(into hasher: inout Hasher) { hasher.combine(picks.mapValues(\.selected)) }
}
