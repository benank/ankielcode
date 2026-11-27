import Foundation
import Testing

@testable import AnkielKit

/// Thread-list rules, ported from `features/threads/threadListV2.test.ts` and
/// `state/threadSettled` tests.
@Suite struct ThreadListTests {
  static let env = "env-1"
  static let nowRaw = "2026-06-02T00:00:00.000Z"
  var now: Date { WireTimestamp(rawValue: Self.nowRaw).date! }

  func ts(_ raw: String) -> WireTimestamp { WireTimestamp(rawValue: raw) }
  func at(_ minute: Int) -> WireTimestamp { ts(String(format: "2026-06-01T00:%02d:00.000Z", minute)) }

  func thread(
    _ id: String, project: String = "project-1", title: String? = nil, configure: (inout ThreadShell) -> Void = { _ in }
  ) throws -> ThreadShell {
    var row = try Fixture.thread(id, title: title ?? id)
    row.projectId = project
    row.lineage.rootThreadId = id
    row.createdAt = ts("2026-06-01T12:00:00.000Z")
    row.updatedAt = ts("2026-06-01T12:00:00.000Z")
    configure(&row)
    return row
  }

  func facts(_ row: ThreadShell, request: SubagentRequest? = nil) -> ThreadFacts {
    ThreadFacts(environmentId: Self.env, thread: row, pendingSubagentRequest: request)
  }

  func layout(
    _ threads: [ThreadShell], projects: [ProjectShell] = [], configure: (inout ThreadListInput) -> Void = { _ in }
  ) -> ThreadListLayout {
    var input = ThreadListInput(
      sources: [ThreadListSource(environmentId: Self.env, label: "Mac", threads: threads, projects: projects)], now: now)
    configure(&input)
    return ThreadListLayout.build(input)
  }

  func keys(_ layout: ThreadListLayout) -> [String] {
    layout.items.map { item in
      switch item {
      case .thread(let row): row.ref.threadId
      case .folder(let folder): "folder:\(folder.folderKey)"
      case .shelf(let shelf, _, _): "shelf:\(shelf.rawValue)"
      }
    }
  }

  func rows(_ layout: ThreadListLayout) -> [ThreadRow] {
    layout.items.compactMap { if case .thread(let row) = $0 { row } else { nil } }
  }

  // MARK: Status

  @Test func `presents thread waits as waiting while requests win`() throws {
    let raw = try thread("t") {
      $0.status = .known(.running)
      $0.activeRunId = "run-wait"
      $0.latestRunId = "run-wait"
    }
    #expect(ThreadRules.status(facts(raw)) == .working)
    var blocked = raw
    blocked.blockedOnThreadWait = true
    #expect(ThreadRules.status(facts(blocked)) == .waiting)
    var approval = facts(blocked)
    approval.hasPendingApprovals = true
    approval.hasPendingUserInput = true
    #expect(ThreadRules.status(approval) == .approval)
    var input = facts(blocked)
    input.hasPendingUserInput = true
    #expect(ThreadRules.status(input) == .input)
  }

  @Test func `lights a provider-native subagent while its own turn runs`() throws {
    let child = try thread("child") { $0.subagentTurnActive = true }
    #expect(facts(child).runtime == nil)
    #expect(ThreadRules.light(facts(child), wokeAt: nil) == .working)
    var idle = child
    idle.subagentTurnActive = false
    #expect(ThreadRules.light(facts(idle), wokeAt: nil) == nil)
  }

  @Test func `settles a failure the user opened to ready`() throws {
    let failed = try thread("t") {
      $0.status = .known(.failed)
      $0.latestRunId = "run-failed"
      $0.latestRunCompletedAt = self.ts("2026-06-01T23:59:00.000Z")
      $0.lastVisitedAt = self.ts(Self.nowRaw)
    }
    #expect(ThreadRules.status(facts(failed)) == .failed)
    #expect(ThreadRules.rowStatus(facts(failed)) == .ready)
    var unseen = facts(failed)
    unseen.lastVisitedAt = nil
    #expect(ThreadRules.rowStatus(unseen) == .failed)
  }

  @Test(arguments: [("command", false, ThreadListStatus.ready), ("monitor", false, .ready), ("command", true, .waiting)])
  func `background work parks a completion only when it holds it`(kind: String, awaited: Bool, status: ThreadListStatus)
    throws
  {
    let row = try thread("t") {
      $0.latestRunId = "run-bg"
      $0.status = .known(.completed)
      $0.latestRunCompletedAt = self.ts(Self.nowRaw)
      $0.lastVisitedAt = self.ts("2026-06-01T23:59:00.000Z")
      $0.pendingBackgroundTasks = [
        ThreadShell.PendingBackgroundTask(taskId: "bg", kind: .init(rawValue: kind), awaited: awaited)
      ]
    }
    #expect(ThreadRules.status(facts(row)) == status)
    #expect(ThreadRules.hasUnseenCompletion(facts(row)))
  }

  @Test(arguments: ["interrupted", "cancelled"])
  func `a stopped run is never an unseen completion`(status: String) throws {
    let row = try thread("t") {
      $0.latestRunId = "run"
      $0.status = .init(rawValue: status)
      $0.latestRunCompletedAt = self.ts(Self.nowRaw)
      $0.lastVisitedAt = self.ts("2026-06-01T23:59:00.000Z")
    }
    #expect(!ThreadRules.hasUnseenCompletion(facts(row)))
    #expect(ThreadRules.readToggle(facts(row), wokeAt: nil) == nil)
  }

  @Test func `a subagent approval rolls up to its parent`() throws {
    let parent = try thread("parent")
    let child = try thread("child") {
      $0.lineage = ThreadShell.Lineage(
        parentThreadId: "parent", relationshipToParent: .known(.subagent), rootThreadId: "parent")
      $0.activityRunStatus = .known(.running)
      $0.pendingRuntimeRequest = ThreadShell.PendingRuntimeRequest(
        id: "r", kind: .known(.command), createdAt: self.ts(Self.nowRaw))
    }
    let requests = SubagentRequestRollup.requests(in: [parent, child])
    #expect(requests["parent"] == .approval)
    let built = layout([parent, child])
    #expect(rows(built).first { $0.ref.threadId == "parent" }?.status == .approval)
    #expect(rows(built).first { $0.ref.threadId == "child" }?.depth == 1)
  }

  // MARK: Read toggle

  @Test(arguments: ["completed", "failed"])
  func `flips a run between read and unread and back`(status: String) throws {
    let completedAt = "2026-06-01T23:00:00.000Z"
    let unread = try thread("t") {
      $0.latestRunId = "run"
      $0.latestRunCompletedAt = self.ts(completedAt)
      $0.status = .init(rawValue: status)
      $0.lastVisitedAt = self.ts("2026-06-01T22:00:00.000Z")
    }
    #expect(ThreadRules.readToggle(facts(unread), wokeAt: nil) == .markRead(visitedAt: ts(completedAt)))
    var read = unread
    read.lastVisitedAt = ts(completedAt)
    #expect(ThreadRules.light(facts(read), wokeAt: nil) == nil)
    #expect(ThreadRules.readToggle(facts(read), wokeAt: nil) == .markUnread)
    var again = read
    again.lastVisitedAt = WireTimestamp(ts(completedAt).date!.addingTimeInterval(-0.001))
    #expect(ThreadRules.light(facts(again), wokeAt: nil) != nil)
    if case .markRead = ThreadRules.readToggle(facts(again), wokeAt: nil) {} else { Issue.record("expected mark read") }
  }

  @Test func `marks a woken thread read at its wake time`() throws {
    let completedAt = "2026-06-01T23:00:00.000Z"
    let row = try thread("t") {
      $0.latestRunId = "run"
      $0.latestRunCompletedAt = self.ts(completedAt)
      $0.status = .known(.completed)
      $0.lastVisitedAt = self.ts(completedAt)
    }
    let woke = ts("2026-06-01T23:30:00.000Z")
    #expect(ThreadRules.readToggle(facts(row), wokeAt: woke) == .markRead(visitedAt: woke))
  }

  @Test func `offers no read toggle while running`() throws {
    let row = try thread("t") {
      $0.latestRunId = "run"
      $0.latestRunCompletedAt = self.ts("2026-06-01T23:00:00.000Z")
      $0.status = .known(.running)
      $0.activeRunId = "run"
      $0.lastVisitedAt = self.ts(Self.nowRaw)
    }
    #expect(ThreadRules.readToggle(facts(row), wokeAt: nil) == nil)
  }

  // MARK: Snooze

  @Test func `snoozed threads leave the list and a woken one returns`() throws {
    let built = layout([
      try thread("active"),
      try thread("snoozed") {
        $0.snoozedUntil = self.ts("2026-06-03T09:00:00.000Z")
        $0.snoozedAt = self.ts("2026-06-01T12:00:00.000Z")
      },
      try thread("woken") {
        $0.snoozedUntil = self.ts("2026-06-01T18:00:00.000Z")
        $0.snoozedAt = self.ts("2026-06-01T12:00:00.000Z")
      },
    ])
    #expect(keys(built) == ["folder:env-1:project-1", "active", "woken", "shelf:snoozed"])
    #expect(built.nextSnoozeWakeAt == ts("2026-06-03T09:00:00.000Z").date)
  }

  @Test func `a snoozed pinned thread returns to the pinned block on wake`() throws {
    let threads = [
      try thread("active"),
      try thread("pinned") {
        $0.pinnedAt = self.ts("2026-06-01T12:00:00.000Z")
        $0.snoozedUntil = self.ts("2026-06-03T09:00:00.000Z")
        $0.snoozedAt = self.ts("2026-06-01T11:00:00.000Z")
      },
    ]
    #expect(keys(layout(threads)) == ["folder:env-1:project-1", "active", "shelf:snoozed"])
    let woke = layout(threads) { $0.now = self.ts("2026-06-03T10:00:00.000Z").date! }
    #expect(keys(woke) == ["pinned", "folder:env-1:project-1", "active"])
    #expect(rows(woke)[0].pinned)
  }

  @Test func `an approval ends a snooze early`() throws {
    let row = try thread("t") {
      $0.snoozedUntil = self.ts("2026-06-03T09:00:00.000Z")
      $0.snoozedAt = self.ts("2026-06-01T11:00:00.000Z")
      $0.pendingRuntimeRequest = ThreadShell.PendingRuntimeRequest(
        id: "r", kind: .known(.permission), createdAt: self.ts("2026-06-01T13:00:00.000Z"))
    }
    #expect(!ThreadRules.effectivelySnoozed(facts(row), now: now))
    #expect(!ThreadRules.canSnooze(facts(row), now: now))
  }

  @Test func `a question asked before the snooze keeps it snoozed`() throws {
    let row = try thread("t") {
      $0.snoozedUntil = self.ts("2026-06-03T09:00:00.000Z")
      $0.snoozedAt = self.ts("2026-06-01T12:00:00.000Z")
      $0.pendingRuntimeRequest = ThreadShell.PendingRuntimeRequest(
        id: "r", kind: .known(.userInput), createdAt: self.ts("2026-06-01T11:00:00.000Z"))
    }
    #expect(ThreadRules.effectivelySnoozed(facts(row), now: now))
    #expect(ThreadRules.canSnooze(facts(row), now: now))
  }

  @Test func `a just-sent message blocks snoozing for the grace window`() throws {
    let row = try thread("t") { $0.latestUserMessageAt = WireTimestamp(self.now.addingTimeInterval(-30)) }
    #expect(!ThreadRules.canSnooze(facts(row), now: now))
    #expect(ThreadRules.canSnooze(facts(row), now: now.addingTimeInterval(200)))
  }

  @Test func `snoozed rows swipe to wake`() {
    let swipe = SwipeActions.resolve(slim: true, settlementSupported: true, snoozeSupported: true, snoozable: true, snoozed: true)
    #expect(swipe == SwipeActions(primary: .unsnooze, snooze: false))
    let card = SwipeActions.resolve(slim: false, settlementSupported: true, snoozeSupported: true, snoozable: true, snoozed: false)
    #expect(card == SwipeActions(primary: .settle, snooze: true))
    let child = SwipeActions.resolve(slim: true, settlementSupported: false, snoozeSupported: false, snoozable: true, snoozed: false)
    #expect(child == SwipeActions(primary: .archive, snooze: false))
  }

  // MARK: Sections

  @Test func `a settled pinned thread moves to the settled shelf`() throws {
    let built = layout(
      [
        try thread("active"),
        try thread("pinned-settled") {
          $0.pinnedAt = self.ts("2026-06-01T12:00:00.000Z")
          $0.settledOverride = .known(.settled)
          $0.settledAt = self.ts("2026-06-01T12:00:00.000Z")
        },
      ], configure: { $0.settledExpanded = true })
    #expect(keys(built) == ["folder:env-1:project-1", "active", "shelf:settled", "folder:settled:env-1:project-1", "pinned-settled"])
    #expect(rows(built).map(\.pinned) == [false, false])
    #expect(built.settledCount == 1)
  }

  @Test func `a collapsed shelf keeps the open thread`() throws {
    let threads = [
      try thread("a") {
        $0.settledOverride = .known(.settled)
        $0.settledAt = self.ts("2026-06-01T12:00:00.000Z")
      },
      try thread("b") {
        $0.settledOverride = .known(.settled)
        $0.settledAt = self.ts("2026-06-01T13:00:00.000Z")
      },
    ]
    #expect(keys(layout(threads)) == ["shelf:settled"])
    let selected = layout(threads) { $0.selectedKey = "env-1:a" }
    #expect(keys(selected) == ["shelf:settled", "folder:settled:env-1:project-1", "a"])
  }

  @Test func `caps the settled shelf and counts what it hides`() throws {
    let threads = try (0..<15).map { index in
      try thread("s\(index)") {
        $0.settledOverride = .known(.settled)
        $0.settledAt = self.at(index)
      }
    }
    let built = layout(threads) { $0.settledExpanded = true }
    #expect(rows(built).count == 10)
    #expect(built.hiddenSettledCount == 5)
    #expect(rows(built).first?.ref.threadId == "s14")
    let more = layout(threads) {
      $0.settledExpanded = true
      $0.settledLimit = 10 + ThreadListLayout.settledPageCount
    }
    #expect(more.hiddenSettledCount == 0)
  }

  @Test func `counts older settled threads the shell left out and stops at the frontier`() throws {
    let threads = [
      try thread("new") {
        $0.settledOverride = .known(.settled)
        $0.settledAt = self.at(30)
      },
      try thread("below") {
        $0.settledOverride = .known(.settled)
        $0.settledAt = self.at(5)
      },
    ]
    let built = layout(threads) {
      $0.settledExpanded = true
      $0.unloadedSettledCount = 3
      $0.settledFrontier = OlderSettledCursor(settledAt: self.at(10))
    }
    #expect(built.settledCount == 5)
    #expect(rows(built).map(\.ref.threadId) == ["new"])
    #expect(built.hiddenSettledCount == 4)
  }

  @Test func `folds active rows under their project newest first with pins on top`() throws {
    func row(_ id: String, _ project: String, _ minute: Int) throws -> ThreadShell {
      try thread(id, project: project) {
        $0.createdAt = self.at(minute)
        $0.latestUserMessageAt = self.at(minute)
      }
    }
    var pin = try row("pin", "alpha", 1)
    pin.pinnedAt = at(1)
    let built = layout([pin, try row("a-old", "alpha", 2), try row("b", "beta", 9), try row("a-new", "alpha", 5)])
    #expect(keys(built) == ["pin", "folder:env-1:beta", "b", "folder:env-1:alpha", "a-new", "a-old"])
    #expect(rows(built).map(\.inFolder) == [false, true, true, true])
  }

  @Test func `a closed folder hides its rows but keeps the open one and shows the hidden light`() throws {
    let a = try thread("a", project: "alpha")
    let b = try thread("b", project: "alpha") {
      $0.pendingRuntimeRequest = ThreadShell.PendingRuntimeRequest(
        id: "r", kind: .known(.permission), createdAt: self.ts(Self.nowRaw))
    }
    let built = layout([a, b]) {
      $0.collapsedFolders = ["env-1:alpha"]
      $0.selectedKey = "env-1:a"
    }
    #expect(keys(built) == ["folder:env-1:alpha", "a"])
    guard case .folder(let folder) = built.items[0] else {
      Issue.record("no folder")
      return
    }
    #expect(folder.collapsed && folder.count == 2 && folder.hiddenLight == .attention)
  }

  @Test func `groups settled rows separately and keeps settlement order`() throws {
    func settle(_ id: String, _ project: String, _ activity: Int, _ settlement: Int) throws -> ThreadShell {
      try thread(id, project: project) {
        $0.createdAt = self.at(activity)
        $0.latestUserMessageAt = self.at(activity)
        $0.settledOverride = .known(.settled)
        $0.settledAt = self.at(settlement)
      }
    }
    let built = layout(
      [
        try thread("active", project: "alpha"), try settle("a-latest", "alpha", 2, 10), try settle("b", "beta", 5, 9),
        try settle("a-earlier", "alpha", 8, 8),
      ],
      configure: {
        $0.collapsedFolders = ["env-1:alpha"]
        $0.settledExpanded = true
      })
    #expect(
      keys(built) == [
        "folder:env-1:alpha", "shelf:settled", "folder:settled:env-1:alpha", "a-latest", "a-earlier",
        "folder:settled:env-1:beta", "b",
      ])
  }

  @Test func `subagents and archived rows stay out of the top level`() throws {
    let parent = try thread("parent")
    let child = try thread("child") {
      $0.lineage = ThreadShell.Lineage(parentThreadId: "parent", relationshipToParent: .known(.subagent), rootThreadId: "parent")
      $0.title = "Subagent: /root/work/fix_tests"
    }
    let archived = try thread("archived") { $0.archivedAt = self.ts(Self.nowRaw) }
    let built = layout([parent, child, archived])
    #expect(keys(built) == ["folder:env-1:project-1", "parent", "child"])
    let childRow = rows(built)[1]
    #expect(childRow.depth == 1 && childRow.title == "Fix Tests" && !childRow.isTopLevel)
    #expect(childRow.swipe.primary == .archive)
  }

  @Test func `dismissed rows are hidden while their command runs`() throws {
    let built = layout([try thread("a"), try thread("b")]) { $0.hiddenKeys = ["env-1:a"] }
    #expect(keys(built) == ["folder:env-1:project-1", "b"])
  }

  @Test func `the environment and project filters scope the list`() throws {
    let other = ThreadListSource(environmentId: "env-2", label: "Linux", threads: [try thread("x")], projects: [])
    var input = ThreadListInput(
      sources: [
        ThreadListSource(
          environmentId: Self.env, label: "Mac", threads: [try thread("a", project: "alpha"), try thread("b", project: "beta")],
          projects: []),
        other,
      ], now: now)
    #expect(rows(ThreadListLayout.build(input)).count == 3)
    #expect(rows(ThreadListLayout.build(input)).allSatisfy { $0.environmentLabel != nil })
    input.environmentFilter = "env-2"
    #expect(rows(ThreadListLayout.build(input)).map(\.ref.threadId) == ["x"])
    input.environmentFilter = nil
    input.projectFilter = ["env-1:beta", "env-2:project-1"]
    #expect(Set(rows(ThreadListLayout.build(input)).map(\.ref.threadId)) == ["b", "x"])
  }

  // MARK: Rows

  @Test func `a card shows its status instead of a time; a read row shows its time`() throws {
    let unread = try thread("unread") {
      $0.latestRunId = "run"
      $0.status = .known(.completed)
      $0.latestRunCompletedAt = self.ts("2026-06-01T23:00:00.000Z")
      $0.lastVisitedAt = self.ts("2026-06-01T22:00:00.000Z")
    }
    var read = unread
    read.id = "read"
    read.lastVisitedAt = ts("2026-06-01T23:30:00.000Z")
    let built = rows(layout([unread, read]))
    let unreadRow = try #require(built.first { $0.ref.threadId == "unread" })
    #expect(unreadRow.unread && unreadRow.statusLabel == .done && unreadRow.timeAt == nil && unreadRow.light == .done)
    let readRow = try #require(built.first { $0.ref.threadId == "read" })
    #expect(!readRow.unread && readRow.statusLabel == nil && readRow.timeAt == ts("2026-06-01T23:00:00.000Z").date)
  }

  // MARK: Search

  @Test func `search lists matches by rank across shelves, then message matches`() throws {
    let built = layout(
      [
        try thread("alpha", title: "Fix login bug"),
        try thread("beta", title: "Refactor login") {
          $0.settledOverride = .known(.settled)
          $0.settledAt = self.at(1)
        },
        try thread("gamma", title: "Unrelated"),
        try thread("delta", title: "Also unrelated"),
      ],
      configure: {
        $0.searchQuery = "login"
        $0.searchHits = [
          ThreadSearchHit(key: "env-1:delta", snippet: "…the login form…"),
          ThreadSearchHit(key: "env-1:alpha", snippet: "dup"),
        ]
      })
    #expect(keys(built) == ["alpha", "beta", "delta"])
    #expect(rows(built)[1].variant == .slim)
    #expect(rows(built)[2].searchHit?.snippet == "…the login form…")
    #expect(built.contentOnlyKeys == ["env-1:delta"])
  }

  @Test func `search folds case and accents and needs every word`() throws {
    let threads = [try thread("a", title: "Café menu"), try thread("b", title: "Cafe")]
    #expect(keys(layout(threads) { $0.searchQuery = "CAFE men" }) == ["a"])
    #expect(Set(keys(layout(threads) { $0.searchQuery = "cafe" })) == ["a", "b"])
  }

  @Test func `server search needs a long word, or two letters with older settled threads`() {
    #expect(!ThreadSearch.canSearchServer("ab", anyOlderSettled: false))
    #expect(ThreadSearch.canSearchServer("ab", anyOlderSettled: true))
    #expect(ThreadSearch.canSearchServer("fix ab", anyOlderSettled: false))
    #expect(ThreadSearch.canSearchServer("日本", anyOlderSettled: false))
    #expect(ThreadSearch.normalized("  " + String(repeating: "x", count: 300)).count == 200)
  }

  // MARK: Order keys

  @Test func `order keys sort between their neighbors`() {
    #expect(ThreadOrder.keyBetween(nil, nil) == "n")
    let top = ThreadOrder.keyBetween(nil, "n")!
    #expect(top < "n")
    let mid = ThreadOrder.keyBetween("b", "c")!
    #expect("b" < mid && mid < "c")
    #expect(ThreadOrder.keyBetween("c", "b") == nil)
    #expect(ThreadOrder.keyBetween(nil, "ba") == nil)
    #expect(ThreadOrder.keyBetween(nil, "bc") == "b")
    #expect(ThreadOrder.topOfPinned(["m", nil, "q"])! < "m")
    #expect(ThreadOrder.keyBetween("a", nil) == nil)
  }
}

@Suite struct ProjectGroupingTests {
  func project(_ id: String, title: String, root: String, identity: String? = nil, rootPath: String? = nil) throws
    -> ProjectShell
  {
    var project = try Fixture.project
    project.id = id
    project.title = title
    project.workspaceRoot = root
    project.repositoryIdentity = try identity.map {
      try decode(
        RepositoryIdentity.self,
        json: #"{"canonicalKey":"\#($0)","name":"\#($0.split(separator: "/").last!)","rootPath":"\#(rootPath ?? root)"}"#)
    }
    return project
  }

  @Test func `groups projects of one repository across computers and folders`() throws {
    let projects = [
      ScopedProject(environmentId: "mac", project: try project("p1", title: "ankielcode", root: "/src/ankielcode", identity: "github.com/me/ankielcode")),
      ScopedProject(
        environmentId: "mac",
        project: try project(
          "p2", title: "server", root: "/src/ankielcode/apps/server", identity: "github.com/me/ankielcode",
          rootPath: "/src/ankielcode")),
      ScopedProject(environmentId: "linux", project: try project("p3", title: "ankielcode", root: "/home/ankielcode", identity: "github.com/me/ankielcode")),
      ScopedProject(environmentId: "mac", project: try project("p4", title: "ml", root: "/src/ml")),
      ScopedProject(environmentId: "mac", project: try project("p5", title: "No project", root: "/scratch"), isScratch: true),
    ]
    let scopes = ProjectGrouping.scopes(projects)
    #expect(scopes.count == 3)
    let repo = try #require(scopes.first { $0.key == "github.com/me/ankielcode" })
    #expect(repo.projectKeys == ["mac:p1", "mac:p2", "linux:p3"])
    #expect(repo.title == "ankielcode")
    #expect(scopes.first { $0.key == ProjectGrouping.scratchKey }?.title == nil)
    #expect(scopes.first { $0.key == "mac:/src/ml" }?.title == "ml")
  }

  @Test func `filter choices drop archived groups and lead with pinned ones`() throws {
    var archived = try project("a", title: "old", root: "/old")
    archived.archivedAt = WireTimestamp(rawValue: "2026-01-01T00:00:00.000Z")
    var pinned = try project("p", title: "pinned", root: "/pinned")
    pinned.pinnedAt = WireTimestamp(rawValue: "2026-01-01T00:00:00.000Z")
    let busy = try project("b", title: "busy", root: "/busy")
    let projects = [archived, pinned, busy].map { ScopedProject(environmentId: "mac", project: $0) }
    var thread = try Fixture.thread("t")
    thread.projectId = "b"
    thread.latestUserAuthoredMessageAt = WireTimestamp(rawValue: "2027-01-01T00:00:00.000Z")
    let choices = ProjectGrouping.filterChoices(
      ProjectGrouping.scopes(projects), threads: [("mac", thread)], projects: projects)
    #expect(choices.map(\.title) == ["pinned", "busy"])
  }
}

@Suite struct SnoozePresetTests {
  var calendar: Calendar {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    return calendar
  }

  func date(_ raw: String) -> Date { WireTimestamp(rawValue: raw).date! }

  @Test func `presets are soonest first and skip a passed time today`() {
    // A Sunday, 10:00.
    let morning = SnoozePreset.resolve(now: date("2026-06-07T10:00:00.000Z"), calendar: calendar)
    // Monday 09:00 is tomorrow's 09:00 on a Sunday, so the menu shows it once.
    #expect(morning.map(\.label) == [.inHours(1), .inHours(3), .thisEvening, .tomorrow])
    let tuesday = SnoozePreset.resolve(now: date("2026-06-09T10:00:00.000Z"), calendar: calendar)
    #expect(tuesday.last?.label == .nextWeek && tuesday.last?.labelNamesDay == false)
    let evening = SnoozePreset.resolve(now: date("2026-06-07T19:00:00.000Z"), calendar: calendar)
    #expect(!evening.contains { $0.label == .thisEvening })
  }

  @Test func `monday on a sunday reads tomorrow and dedupes the same minute`() {
    let sunday = SnoozePreset.resolve(
      [.at(day: .tomorrow, hour: 9, minute: 0), .at(day: .monday, hour: 9, minute: 0)],
      now: date("2026-06-07T10:00:00.000Z"), calendar: calendar)
    #expect(sunday.count == 1)
    #expect(sunday[0].label == .tomorrow)
  }

  @Test func `a weekday a week away is next`() {
    let presets = SnoozePreset.resolve(
      [.at(day: .wednesday, hour: 9, minute: 0)], now: date("2026-06-10T10:00:00.000Z"), calendar: calendar)
    #expect(presets.first?.label == .weekday(4, next: true))
  }
}

@Suite struct ThreadCommandTests {
  func json(_ command: ThreadCommand) throws -> JSONValue {
    try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(command))
  }

  @Test func `encodes the housekeeping commands as the server expects`() throws {
    let id = CommandID("cmd-1")
    #expect(
      try json(ThreadCommand(.archive, threadId: "t", commandId: id))
        == .object(["type": .string("thread.archive"), "commandId": .string("cmd-1"), "threadId": .string("t")]))
    let unsnooze = try json(ThreadCommand(.unsnooze, threadId: "t", commandId: id))
    #expect(unsnooze["reason"]?.stringValue == "user")
    let rename = try json(ThreadCommand(.rename("New"), threadId: "t", commandId: id))
    #expect(rename["type"]?.stringValue == "thread.metadata.update" && rename["title"]?.stringValue == "New")
    let visit = try json(ThreadCommand(.markRead(visitedAt: WireTimestamp(rawValue: "2026-06-01T00:00:00.000Z")), threadId: "t"))
    #expect(visit["type"]?.stringValue == "thread.visit" && visit["visitedAt"]?.stringValue == "2026-06-01T00:00:00.000Z")
    let pin = try json(ThreadCommand(.pin(orderKey: nil), threadId: "t"))
    #expect(pin["orderKey"] == nil)
  }

  @Test func `unsettle distinguishes absent and null restore times`() throws {
    #expect(try json(ThreadCommand(.unsettle(), threadId: "t"))["restoreUnsettledAt"] == nil)
    #expect(try json(ThreadCommand(.unsettle(restoreUnsettledAt: .some(nil)), threadId: "t"))["restoreUnsettledAt"] == .null)
    let at = WireTimestamp(rawValue: "2026-06-01T00:00:00.000Z")
    #expect(try json(ThreadCommand(.unsettle(restoreUnsettledAt: at), threadId: "t"))["restoreUnsettledAt"]?.stringValue == at.rawValue)
  }

  @Test func `mints a fresh lowercase uuid per command`() {
    let a = CommandID(), b = CommandID()
    #expect(a != b && a.rawValue == a.rawValue.lowercased() && UUID(uuidString: a.rawValue) != nil)
  }

  @Test func `decodes search results and older settled pages leniently`() throws {
    let result = try decode(
      ThreadSearchResult.self,
      json: #"{"matches":[{"threadId":"t","projectId":"p","source":"user","snippet":"hi","messageCreatedAt":null},{"bad":1}]}"#)
    #expect(result.matches.map(\.threadId) == ["t"] && result.threads.isEmpty)
    let page = try decode(OlderSettledPage.self, json: #"{"snapshotSequence":4,"threads":[],"counts":[{"projectId":"p","count":2}]}"#)
    #expect(page.counts.first?.count == 2)
  }

  @Test func `older settled pages advance their frontier and count what is unloaded`() throws {
    let cut = ShellSnapshot.OlderSettled(
      before: WireTimestamp(rawValue: "2026-06-01T00:00:00.000Z"), asOfSequence: 1,
      counts: [.init(projectId: "p", count: 30)])
    var pages = OlderSettledPages(cut: cut)
    #expect(pages.frontier?.settledAt == cut.before)
    let rows = try (0..<25).map { index in
      var row = try Fixture.thread("old-\(index)")
      row.projectId = "p"
      row.settledOverride = .known(.settled)
      row.settledAt = WireTimestamp(rawValue: String(format: "2026-05-01T00:%02d:00.000Z", 59 - index))
      return row
    }
    pages.append(OlderSettledPage(snapshotSequence: 2, threads: rows))
    #expect(pages.frontier == OlderSettledCursor(settledAt: rows.last!.settledAt!, threadId: "old-24"))
    #expect(pages.unloaded(projectIds: nil, held: rows) == 5)
    pages.append(OlderSettledPage(snapshotSequence: 3, threads: []))
    #expect(pages.frontier == nil)
    #expect(OlderSettledPages.shelfFrontier([pages]) == nil)
  }
}

@Suite struct ThreadLinkTests {
  @Test(arguments: [
    "ankielcode-native://thread/env-1/thread-9", "ankielcode://threads/env-1/thread-9",
    "ankielcode-dev://threads/env-1/thread-9?x=1", "ankiel-thread://v2/env-1/thread-9",
  ])
  func `opens app and reference links`(link: String) throws {
    #expect(ThreadLink.parse(try #require(URL(string: link))) == ThreadRef(environmentId: "env-1", threadId: "thread-9"))
  }

  @Test(arguments: ["ankiel-thread://v1/thread-9", "ankielcode-native://pair?pairingUrl=x", "https://thread/a/b", "ankielcode://threads/env-1"])
  func `ignores links that name no scoped thread`(link: String) throws {
    #expect(ThreadLink.parse(try #require(URL(string: link))) == nil)
  }

  @Test func `round trips ids with colons and escapes`() throws {
    let ref = ThreadRef(environmentId: "env 1", threadId: "thread:project:a b")
    let url = try #require(ThreadLink.appURL(ref))
    #expect(ThreadLink.parse(url) == ref)
    #expect(ThreadLink.reference(ThreadRef(environmentId: "e", threadId: "t")) == "<ankiel-thread://v2/e/t>")
  }
}
