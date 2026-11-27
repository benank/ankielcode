import Foundation

/// One environment's rows as the thread list reads them.
public struct ThreadListSource: Sendable, Hashable {
  public var environmentId: String
  public var label: String
  public var threads: [ThreadShell]
  public var projects: [ProjectShell]

  public init(environmentId: String, label: String, threads: [ThreadShell], projects: [ProjectShell]) {
    self.environmentId = environmentId
    self.label = label
    self.threads = threads
    self.projects = projects
  }
}

/// A message match from the server search, for a row listed because of its messages.
public struct ThreadSearchHit: Sendable, Hashable {
  /// The thread's key (`environmentId:threadId`).
  public var key: String
  public var snippet: String
  public var messageId: String?

  public init(key: String, snippet: String, messageId: String? = nil) {
    self.key = key
    self.snippet = snippet
    self.messageId = messageId
  }
}

/// Everything the list depends on. A pure value: equal inputs give equal layouts.
public struct ThreadListInput: Sendable, Hashable {
  public var sources: [ThreadListSource]
  public var now: Date
  /// nil lists every environment.
  public var environmentFilter: String?
  /// Scoped project keys (`environmentId:projectId`) of the chosen project group; nil lists all.
  public var projectFilter: Set<String>?
  public var searchQuery = ""
  /// Server message matches by thread key, in the server's order.
  public var searchHits: [ThreadSearchHit] = []
  public var settledLimit = ThreadListLayout.settledInitialCount
  public var snoozedExpanded = false
  public var settledExpanded = false
  /// Folder keys (`env:project`, or `settled:env:project`) the user closed.
  public var collapsedFolders: Set<String> = []
  /// The open thread stays visible inside closed folders and shelves.
  public var selectedKey: String?
  /// Rows dismissed while their command is in flight.
  public var hiddenKeys: Set<String> = []
  /// Older settled threads the shelf may list only down to this cursor (older pages not loaded).
  public var settledFrontier: OlderSettledCursor?
  /// Older settled threads in scope that are not loaded.
  public var unloadedSettledCount = 0

  public init(sources: [ThreadListSource], now: Date) {
    self.sources = sources
    self.now = now
  }

}

/// What a row's meta text says when it is not a time (`STATUS_LABEL_BY_STATUS`).
public enum ThreadStatusLabel: Sendable, Hashable {
  case approval, input, failed, limited, done, woke, working, waiting, goal
}

/// One thread row, everything a row view needs (value-driven, `Equatable`).
public struct ThreadRow: Sendable, Hashable, Identifiable {
  public enum Variant: Sendable, Hashable { case card, slim }

  public var id: String { ref.key }
  public var ref: ThreadRef
  public var title: String
  public var projectId: String
  /// Shown when the row is not under its project's folder.
  public var projectTitle: String?
  /// Shown when more than one computer is saved.
  public var environmentLabel: String?
  public var variant: Variant
  public var snoozed: Bool
  public var pinned: Bool
  /// 0 for a listed thread; 1… for subagents and side chats under it.
  public var depth: Int
  public var inFolder: Bool
  public var status: ThreadListStatus
  public var light: ThreadLight?
  public var wokeAt: WireTimestamp?
  /// A finished run not seen yet (bold title).
  public var unread: Bool
  /// The status word the meta slot shows instead of a time; nil shows `timeAt`.
  public var statusLabel: ThreadStatusLabel?
  public var timeAt: Date?
  public var snoozeWakeAt: Date?
  public var swipe: SwipeActions
  public var readToggle: ReadToggle?
  public var canArchive: Bool
  /// Top-level rows take settle, snooze and pin; nested rows only archive and delete.
  public var isTopLevel: Bool
  public var regeneratingTitle: Bool
  public var searchHit: ThreadSearchHit?
  public var hasPendingApprovals: Bool
}

public struct ProjectFolder: Sendable, Hashable, Identifiable {
  public var id: String { "folder:\(folderKey)" }
  public var folderKey: String
  public var environmentId: String
  public var projectId: String
  public var title: String
  public var count: Int
  public var collapsed: Bool
  /// The most urgent light among the rows a closed folder hides.
  public var hiddenLight: ThreadLight?
}

public enum ThreadShelf: String, Sendable, Hashable { case snoozed, settled }

public enum ThreadListItem: Sendable, Hashable, Identifiable {
  case thread(ThreadRow)
  case folder(ProjectFolder)
  case shelf(ThreadShelf, count: Int, expanded: Bool)

  public var id: String {
    switch self {
    case .thread(let row): row.id
    case .folder(let folder): folder.id
    case .shelf(let shelf, _, _): "shelf:\(shelf.rawValue)"
    }
  }
}

/// The thread list, ported from `buildThreadListV2Items` + `buildThreadListV2ListItems`
/// (`features/threads/threadListV2.ts`) with the mobile defaults: project folders on, the working
/// shelf off, no pending tasks.
public struct ThreadListLayout: Sendable, Hashable {
  public static let settledInitialCount = 10
  public static let settledPageCount = 25

  public var items: [ThreadListItem] = []
  /// Settled rows past the shelf's limit ("Show more").
  public var hiddenSettledCount = 0
  /// Every settled row in scope, loaded or not.
  public var settledCount = 0
  /// Settled rows the shelf may list (before its limit).
  public var listedSettledCount = 0
  /// Re-lay out here: a snooze ends.
  public var nextSnoozeWakeAt: Date?
  /// Any listed, unarchived thread in scope (for the empty states).
  public var hasAnyThreads = false
  /// Listed because their messages match the search.
  public var contentOnlyKeys: Set<String> = []

  public init() {}

  public static func build(_ input: ThreadListInput) -> ThreadListLayout {
    var layout = ThreadListLayout()
    let now = input.now
    let multipleEnvironments = input.sources.count > 1
    var projectTitles: [String: String] = [:]
    var environmentLabels: [String: String] = [:]
    var all: [ThreadFacts] = []
    for source in input.sources {
      environmentLabels[source.environmentId] = source.label
      for project in source.projects { projectTitles["\(source.environmentId):\(project.id)"] = project.title }
      let requests = SubagentRequestRollup.requests(in: source.threads)
      for thread in source.threads where thread.deletedAt == nil {
        all.append(ThreadFacts(environmentId: source.environmentId, thread: thread, pendingSubagentRequest: requests[thread.id]))
      }
    }
    let query = input.searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
    let searching = !query.isEmpty
    let tree = searching ? nil : ThreadTree(all)

    let listed = all.filter { facts in
      facts.thread.archivedAt == nil && facts.thread.lineage.isListed && !input.hiddenKeys.contains(facts.key)
        && (input.environmentFilter == nil || facts.ref.environmentId == input.environmentFilter)
        && (input.projectFilter?.contains("\(facts.ref.environmentId):\(facts.thread.projectId)") ?? true)
    }

    func row(
      _ facts: ThreadFacts, variant: ThreadRow.Variant, snoozed: Bool, pinned: Bool, depth: Int = 0,
      inFolder: Bool = false, hit: ThreadSearchHit? = nil
    ) -> ThreadRow {
      let wokeAt = variant == .slim || depth > 0 ? nil : ThreadRules.listWokeAt(facts, now: now)
      let status = ThreadRules.rowStatus(facts)
      let unseen = ThreadRules.hasUnseenCompletion(facts)
      let unread = status == .ready && unseen
      let label: ThreadStatusLabel? =
        switch status {
        case .approval: .approval
        case .input: .input
        case .failed: .failed
        case .limited: .limited
        case .working: facts.thread.goal?.status == .known(.active) ? .goal : .working
        case .waiting: .waiting
        case .ready: wokeAt != nil ? .woke : (unread ? .done : nil)
        }
      let topLevel = depth == 0
      let snoozeLabelAt = snoozed ? facts.snoozedUntil : nil
      let showsTime =
        snoozeLabelAt == nil && !(variant == .card && (status != .ready || wokeAt != nil || unseen))
      let timeAt =
        showsTime
        ? ((variant == .slim && !snoozed ? facts.settledSortAt : nil) ?? facts.activityAt ?? facts.createdAt) : nil
      return ThreadRow(
        ref: facts.ref, title: facts.title, projectId: facts.thread.projectId,
        projectTitle: projectTitles["\(facts.ref.environmentId):\(facts.thread.projectId)"],
        environmentLabel: multipleEnvironments ? environmentLabels[facts.ref.environmentId] : nil,
        variant: variant, snoozed: snoozed, pinned: pinned, depth: depth, inFolder: inFolder, status: status,
        light: ThreadRules.light(facts, wokeAt: wokeAt), wokeAt: wokeAt, unread: unread,
        statusLabel: variant == .slim ? nil : label, timeAt: timeAt, snoozeWakeAt: snoozeLabelAt,
        swipe: SwipeActions.resolve(
          slim: variant == .slim, settlementSupported: topLevel, snoozeSupported: topLevel,
          snoozable: ThreadRules.canSnooze(facts, now: now), snoozed: snoozed),
        readToggle: ThreadRules.readToggle(facts, wokeAt: wokeAt), canArchive: facts.canArchive,
        isTopLevel: topLevel, regeneratingTitle: facts.thread.titleRegeneration != nil, searchHit: hit,
        hasPendingApprovals: facts.hasPendingApprovals)
    }

    var pinned: [ThreadFacts] = []
    var active: [ThreadFacts] = []
    var settled: [ThreadFacts] = []
    var snoozed: [ThreadFacts] = []
    for facts in listed {
      if ThreadRules.effectivelySnoozed(facts, now: now) {
        snoozed.append(facts)
        if let wake = facts.snoozedUntil, wake < (layout.nextSnoozeWakeAt ?? .distantFuture) {
          layout.nextSnoozeWakeAt = wake
        }
      } else if facts.isSettled {
        settled.append(facts)
      } else if facts.isPinned {
        pinned.append(facts)
      } else {
        active.append(facts)
      }
    }
    layout.hasAnyThreads = !listed.isEmpty || input.unloadedSettledCount > 0

    if searching {
      let ranked = ThreadSearch.rank(
        query, in: listed,
        projectTitle: { projectTitles["\($0.ref.environmentId):\($0.thread.projectId)"] },
        environmentLabel: { multipleEnvironments ? environmentLabels[$0.ref.environmentId] : nil })
      let rankedKeys = Set(ranked.map(\.key))
      let byKey = Dictionary(listed.map { ($0.key, $0) }, uniquingKeysWith: { first, _ in first })
      let slim = Set((snoozed + settled).map(\.key))
      let snoozedKeys = Set(snoozed.map(\.key))
      let pinnedKeys = Set(pinned.map(\.key))
      var results = ranked.map { ($0, nil as ThreadSearchHit?) }
      for hit in input.searchHits where !rankedKeys.contains(hit.key) && !layout.contentOnlyKeys.contains(hit.key) {
        guard let facts = byKey[hit.key] else { continue }
        layout.contentOnlyKeys.insert(hit.key)
        results.append((facts, hit))
      }
      layout.items = results.map { facts, hit in
        .thread(
          row(
            facts, variant: slim.contains(facts.key) ? .slim : .card, snoozed: snoozedKeys.contains(facts.key),
            pinned: pinnedKeys.contains(facts.key), hit: hit))
      }
      return layout
    }

    let selected = input.selectedKey
    let orderedSnoozed = snoozed.sorted { ($0.snoozedUntil ?? .distantPast) < ($1.snoozedUntil ?? .distantPast) }
    let orderedSettled = ThreadOrder.sortSettled(settled)
    let listedSettled = orderedSettled.filter { input.settledFrontier?.isAtOrAbove($0) ?? true }
    let settledTotal = orderedSettled.count + input.unloadedSettledCount
    let limited = Array(listedSettled.prefix(input.settledLimit))
    var paged = limited
    if let selected, !limited.contains(where: { $0.key == selected }),
      let selectedSettled = orderedSettled.first(where: { $0.key == selected })
    {
      paged.append(selectedSettled)
    }
    layout.settledCount = settledTotal
    layout.listedSettledCount = listedSettled.count
    layout.hiddenSettledCount = max(0, settledTotal - paged.count)

    func folders(_ entries: [ThreadFacts], section: ThreadShelf?) -> [ThreadListItem] {
      func activity(_ facts: ThreadFacts) -> Date {
        var latest = facts.activityOrCreation
        for child in tree?.rowsByRoot[facts.key] ?? [] { latest = max(latest, child.facts.activityOrCreation) }
        return latest
      }
      var order: [String] = []
      var byProject: [String: (rows: [ThreadFacts], latest: Date)] = [:]
      for facts in entries {
        let key = "\(facts.ref.environmentId):\(facts.thread.projectId)"
        if byProject[key] == nil { order.append(key) }
        var folder = byProject[key] ?? ([], .distantPast)
        folder.rows.append(facts)
        if section == nil { folder.latest = max(folder.latest, activity(facts)) }
        byProject[key] = folder
      }
      if section == nil {
        order.sort { l, r in
          let left = byProject[l]!.latest, right = byProject[r]!.latest
          return left != right ? left > right : l < r
        }
      }
      var items: [ThreadListItem] = []
      for key in order {
        var rows = byProject[key]!.rows
        if section == nil {
          rows.sort { l, r in
            let left = activity(l), right = activity(r)
            return left != right ? left > right : l.key < r.key
          }
        }
        let folderKey = section == .settled ? "settled:\(key)" : key
        let collapsed = input.collapsedFolders.contains(folderKey)
        let shown = collapsed ? rows.filter { $0.key == selected } : rows
        var hiddenLight: ThreadLight?
        if collapsed {
          for facts in rows where facts.key != selected {
            let woke = section == nil ? ThreadRules.listWokeAt(facts, now: now) : nil
            if let light = ThreadRules.light(facts, wokeAt: woke), light > (hiddenLight ?? .waiting) || hiddenLight == nil {
              hiddenLight = light
            }
          }
        }
        let first = rows[0]
        items.append(
          .folder(
            ProjectFolder(
              folderKey: folderKey, environmentId: first.ref.environmentId, projectId: first.thread.projectId,
              title: projectTitles[key] ?? "", count: rows.count, collapsed: collapsed, hiddenLight: hiddenLight)))
        for facts in shown {
          items.append(
            .thread(row(facts, variant: section == .settled ? .slim : .card, snoozed: false, pinned: false, inFolder: true)))
        }
      }
      return items
    }

    var items: [ThreadListItem] = ThreadOrder.sortPinned(pinned).map {
      .thread(row($0, variant: .card, snoozed: false, pinned: true))
    }
    items += folders(active, section: nil)
    if !orderedSnoozed.isEmpty {
      items.append(.shelf(.snoozed, count: orderedSnoozed.count, expanded: input.snoozedExpanded))
      let visible = input.snoozedExpanded ? orderedSnoozed : orderedSnoozed.filter { $0.key == selected }
      items += visible.map { .thread(row($0, variant: .slim, snoozed: true, pinned: false)) }
    }
    if settledTotal > 0 {
      items.append(.shelf(.settled, count: settledTotal, expanded: input.settledExpanded))
      let visible = input.settledExpanded ? paged : paged.filter { $0.key == selected }
      items += folders(visible, section: .settled)
    }

    // Subagents and side chats follow their root, wherever it is listed.
    if let tree, !tree.rowsByRoot.isEmpty {
      items = items.flatMap { item -> [ThreadListItem] in
        guard case .thread(let parent) = item, let children = tree.rowsByRoot[parent.id] else { return [item] }
        return [item]
          + children.filter { !input.hiddenKeys.contains($0.facts.key) }.map {
            .thread(row($0.facts, variant: .slim, snoozed: false, pinned: false, depth: $0.depth, inFolder: parent.inFolder))
          }
      }
    }
    if !input.settledExpanded { layout.hiddenSettledCount = 0 }
    layout.items = items
    return layout
  }
}

/// A position in the server's older-settled order (settle time descending, then id ascending).
public struct OlderSettledCursor: Sendable, Hashable, Codable {
  public var settledAt: WireTimestamp
  public var threadId: String?

  public init(settledAt: WireTimestamp, threadId: String? = nil) {
    self.settledAt = settledAt
    self.threadId = threadId
  }

  /// `atOrAboveCursor`: the row sorts at or before this cursor.
  func isAtOrAbove(_ facts: ThreadFacts) -> Bool {
    guard let settledAt = facts.thread.settledAt?.date, let cursor = self.settledAt.date else { return true }
    if settledAt < cursor { return false }
    if let threadId, settledAt == cursor, facts.thread.id > threadId { return false }
    return true
  }
}
