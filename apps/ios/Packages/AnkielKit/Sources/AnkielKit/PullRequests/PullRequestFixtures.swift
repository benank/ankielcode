import Foundation

// Debug launches and tests only: Release builds leave the synthetic data out.
#if DEBUG

/// Synthetic pull requests for tests and debug launches: an invented repository
/// (`tidewater/tide-chart`, the made-up app the thread fixtures talk about), invented people and
/// text. Nothing here comes from a real pull request.
public enum PullRequestFixtures {
  public static let environmentId = "fixture-mac"
  public static let projectId = "proj-tide-chart"
  public static let repository = "tidewater/tide-chart"
  public static let host = "github.com"

  static let mira = PullRequestActor(login: "mira-dev", name: "Mira Okafor")
  static let jonas = PullRequestActor(login: "jonas-k", name: "Jonas Kirby")
  static let ollie = PullRequestActor(login: "ollie-ci", name: nil, isBot: true)
  static let viewer = "mira-dev"

  static func time(_ hoursAgo: Double) -> WireTimestamp {
    WireTimestamp(Date(timeIntervalSinceNow: -hoursAgo * 3600))
  }

  static func url(_ number: Int) -> String { "https://github.com/\(repository)/pull/\(number)" }

  struct Spec {
    var number: Int
    var title: String
    var author: PullRequestActor
    var head: String
    var state: PullRequestState = .open
    var draft = false
    var hours: Double
    var labels: [PullRequestLabel] = []
    var checks: PullRequestChecksState?
    var review: PullRequestReviewDecision?
    var requested = false
    var additions = 0
    var deletions = 0
    var mergeability: PullRequestMergeability = .mergeable
  }

  static let bug = PullRequestLabel(name: "bug", color: "d73a4a")
  static let offline = PullRequestLabel(name: "offline", color: "0e8a16")
  static let docs = PullRequestLabel(name: "docs", color: "0075ca")
  static let ui = PullRequestLabel(name: "ui", color: "a2eeef")

  static let specs: [Spec] = [
    Spec(number: 128, title: "Cache the last tide table for offline use", author: mira, head: "offline-tables", hours: 1.5,
         labels: [offline, ui], checks: .passing, review: .approved, additions: 214, deletions: 37),
    Spec(number: 127, title: "Fix the moon phase drifting a day in leap years", author: jonas, head: "fix-moon-leap", hours: 4,
         labels: [bug], checks: .failing, review: .changesRequested, requested: true, additions: 18, deletions: 6),
    Spec(number: 126, title: "Draw the tide curve with one path per day", author: jonas, head: "tide-curve-path", draft: true, hours: 9,
         labels: [ui], checks: .pending, additions: 96, deletions: 140),
    Spec(number: 125, title: "Explain station offsets in the README", author: mira, head: "docs-offsets", hours: 26,
         labels: [docs], checks: .passing, review: .reviewRequired, requested: false, additions: 41, deletions: 3),
    Spec(number: 124, title: "Bump the chart library to 4.2", author: ollie, head: "deps/chart-4.2", hours: 30,
         checks: .passing, additions: 12, deletions: 12, mergeability: .conflicting),
    Spec(number: 121, title: "Show sunrise and sunset beside the high tides", author: mira, head: "sun-times", state: .merged, hours: 75,
         labels: [ui], checks: .passing, review: .approved, additions: 160, deletions: 22),
    Spec(number: 119, title: "Try a darker palette for night mode", author: jonas, head: "night-palette", state: .closed, hours: 120,
         labels: [ui], additions: 30, deletions: 30),
  ]

  static func entry(_ spec: Spec) -> PullRequestListEntry {
    let json: JSONValue = [
      "provider": "github", "host": .string(host), "projectId": .string(projectId), "projectTitle": "tide-chart",
      "repository": .string(repository), "number": .number(Double(spec.number)), "title": .string(spec.title),
      "url": .string(url(spec.number)),
      "author": ["login": .string(spec.author.login), "name": spec.author.name.map(JSONValue.string) ?? .null, "avatarUrl": .null, "isBot": .bool(spec.author.isBot == true)],
      "headBranch": .string(spec.head), "baseBranch": "main", "state": .string(spec.state.rawValue), "isDraft": .bool(spec.draft),
      "mergeability": .string(spec.mergeability.rawValue), "additions": .number(Double(spec.additions)),
      "deletions": .number(Double(spec.deletions)), "createdAt": .string(time(spec.hours + 40).rawValue),
      "updatedAt": .string(time(spec.hours).rawValue), "viewerReviewRequested": .bool(spec.requested),
      "labels": .array(spec.labels.map { ["name": .string($0.name), "color": .string($0.color ?? "")] }),
      "checksState": spec.checks.map { .string($0.rawValue) } ?? .null,
      "reviewDecision": spec.review.map { .string($0.rawValue) } ?? .null,
    ]
    return try! JSONDecoder().decode(PullRequestListEntry.self, from: JSONEncoder().encode(json))
  }

  public static var entries: [PullRequestListEntry] { specs.map(entry) }

  public static func ref(_ number: Int) -> PullRequestRef {
    PullRequestRef(projectId: projectId, host: host, repository: repository, number: number)
  }

  public static func list(_ request: PullRequestListRequest) -> PullRequestListResult {
    let state = request.state
    let rows = entries.filter { state == .all || $0.state.rawValue == state.rawValue }
    return PullRequestListResult(
      viewers: [host: viewer],
      providers: [
        try! JSONDecoder().decode(
          PullRequestProviderSummary.self,
          from: Data(#"{"host":"github.com","kind":"github","searchesOnHost":false,"projectCount":1,"configured":true,"detail":null}"#.utf8))
      ],
      entries: rows)
  }

  static let body = """
    Keeps the last tide table a station loaded, so the chart still opens on a boat with no signal.

    ## What changed
    - The table is written to disk after each successful load :sailboat:
    - Opening a station with no network shows the saved table with its age
    - [x] Unit tests for the cache
    - [ ] Clear the cache from Settings

    Fixes #97, follows up on tidewater/tide-chart#88. Thanks @jonas-k for the station list.

    ```swift
    let table = try cache.table(for: station)
    ```
    """

  public static func detail(_ number: Int) -> PullRequestDetail {
    let spec = specs.first { $0.number == number } ?? specs[0]
    let checks: [JSONValue] = [
      ["name": "Build (iOS)", "status": "success", "description": "Built in 4m 12s", "url": "https://example.invalid/ci/1", "required": true],
      ["name": "Unit tests", "status": spec.checks == .failing ? "failure" : "success", "description": spec.checks == .failing ? "2 tests failed" : "312 passed", "url": "https://example.invalid/ci/2", "required": true],
      ["name": "Lint", "status": spec.checks == .pending ? "pending" : "success", "description": nil, "url": nil],
      ["name": "Screenshot diff", "status": "skipped", "description": "No UI changes", "url": nil],
    ]
    let json: JSONValue = [
      "provider": "github",
      "capabilities": [
        "diff": true, "comment": true,
        "actions": ["merge", "ready", "draft", "close", "reopen", "delete-branch", "update-branch", "enable-auto-merge", "disable-auto-merge"],
        "mergeMethods": ["squash", "merge", "rebase"], "deleteBranch": true, "updateMethods": ["merge", "rebase"], "search": true,
        "reactions": true, "viewedFiles": "host",
        "review": ["inlineComment": true, "rangeComment": true, "reply": true, "resolve": true, "verdicts": ["comment", "approve", "request-changes"]],
        "reviewers": ["request": true, "listCandidates": true, "searchCandidates": true],
        "edit": ["changeRequest": true, "comment": true], "labels": true, "mentions": true,
      ],
      "viewerPermissions": [
        "actions": ["merge", "ready", "draft", "close", "reopen", "delete-branch", "update-branch", "enable-auto-merge", "disable-auto-merge"],
        "comment": true, "resolve": true, "verdicts": ["comment", "approve", "request-changes"], "requestReviewers": true,
        "updateMethods": ["merge", "rebase"], "editChangeRequest": true,
      ],
      "projectId": .string(projectId), "projectTitle": "tide-chart", "workspaceRoot": "/Users/dev/tide-chart",
      "repository": .string(repository), "number": .number(Double(spec.number)), "title": .string(spec.title), "body": .string(body),
      "url": .string(url(spec.number)),
      "author": ["login": .string(spec.author.login), "name": spec.author.name.map(JSONValue.string) ?? .null, "avatarUrl": .null],
      "state": .string(spec.state.rawValue), "isDraft": .bool(spec.draft), "mergeability": .string(spec.mergeability.rawValue),
      "additions": .number(Double(spec.additions)), "deletions": .number(Double(spec.deletions)), "changedFiles": 4,
      "headBranch": .string(spec.head), "headSha": "3f2a9c1d7e5b4a6c8d0e2f4a6b8c0d2e4f6a8b0c", "baseBranch": "main",
      "createdAt": .string(time(spec.hours + 40).rawValue), "updatedAt": .string(time(spec.hours).rawValue),
      "mergedAt": spec.state == .merged ? .string(time(spec.hours).rawValue) : .null, "closedAt": spec.state == .open ? .null : .string(time(spec.hours).rawValue),
      "reviewers": [["login": "jonas-k", "name": "Jonas Kirby", "avatarUrl": nil]],
      "labels": .array(spec.labels.map { ["name": .string($0.name), "color": .string($0.color ?? ""), "description": nil] }),
      "checks": .array(checks),
      "mergeCapabilities": ["merge": true, "squash": true, "rebase": true],
      "viewer": .string(viewer), "baseComparison": "up-to-date", "autoMergeEnabled": false,
    ]
    return try! JSONDecoder().decode(PullRequestDetail.self, from: JSONEncoder().encode(json))
  }

  public static func activity(_ number: Int) -> PullRequestActivity {
    let reactions = [
      PullRequestReaction(content: .thumbsUp, count: 2, actors: ["jonas-k"], viewerHasReacted: true),
      PullRequestReaction(content: .rocket, count: 1, actors: ["jonas-k"]),
    ]
    var comments = [
      PullRequestComment(
        id: "IC_fixture_1", kind: .issueComment, author: jonas,
        body: "Nice. Does the saved table show its age anywhere? On a boat you want to know it's from yesterday.",
        createdAt: time(20), reactions: [PullRequestReaction(content: .eyes, count: 1, actors: ["mira-dev"])]),
      PullRequestComment(
        id: "IC_fixture_2", kind: .issueComment, author: mira, body: "Yes, the header now says “Saved 14 h ago”. Screenshot in the description.",
        createdAt: time(18)),
      PullRequestComment(
        id: "PRR_fixture_1", kind: .review, author: jonas, body: "One question about the cache key, otherwise good.",
        createdAt: time(6), reviewState: "COMMENTED"),
      PullRequestComment(id: "PRR_fixture_2", kind: .review, author: jonas, body: "", createdAt: time(2), reviewState: "APPROVED"),
    ]
    if number == 127 {
      comments.append(
        PullRequestComment(
          id: "PRR_fixture_3", kind: .review, author: mira, body: "The leap day still lands on the wrong side of midnight in UTC+13.",
          createdAt: time(3), reviewState: "CHANGES_REQUESTED"))
    }
    let threads = [
      PullRequestReviewThread(
        id: "PRRT_fixture_1", path: "Sources/TideChart/TableCache.swift", line: 14, comments: [
          PullRequestThreadComment(id: "RC_fixture_1", author: jonas, body: "Should the key include the station's time zone?", createdAt: time(6)),
          PullRequestThreadComment(id: "RC_fixture_2", author: mira, body: "Good catch, added it.", createdAt: time(5)),
        ]),
      PullRequestReviewThread(
        id: "PRRT_fixture_2", path: "Sources/TideChart/StationView.swift", line: 10, side: .left, isResolved: true, comments: [
          PullRequestThreadComment(id: "RC_fixture_3", author: jonas, body: "This label was too long on small phones.", createdAt: time(5))
        ]),
    ]
    let commits = [
      PullRequestCommit(oid: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", messageHeadline: "Write the tide table to disk after each load", committedDate: time(22), authors: [mira]),
      PullRequestCommit(oid: "b2c3d4e5f60718293a4b5c6d7e8f901234567890", messageHeadline: "Show the saved table's age in the header", committedDate: time(19), authors: [mira]),
      PullRequestCommit(oid: "c3d4e5f60718293a4b5c6d7e8f90123456789012", messageHeadline: "Key the cache by station and time zone", committedDate: time(4), authors: [mira]),
    ]
    return PullRequestActivity(comments: comments, reviewThreads: threads, commits: commits, reactions: reactions)
  }

  public static let patch = """
    diff --git a/Sources/TideChart/TableCache.swift b/Sources/TideChart/TableCache.swift
    new file mode 100644
    index 0000000..4b1e2a9
    --- /dev/null
    +++ b/Sources/TideChart/TableCache.swift
    @@ -0,0 +1,22 @@
    +import Foundation
    +
    +/// The last tide table each station loaded, kept on disk.
    +struct TableCache {
    +  let directory: URL
    +
    +  func save(_ table: TideTable, for station: Station) throws {
    +    let data = try JSONEncoder().encode(table)
    +    try data.write(to: url(for: station), options: .atomic)
    +  }
    +
    +  func table(for station: Station) throws -> TideTable? {
    +    guard let data = try? Data(contentsOf: url(for: station)) else { return nil }
    +    return try JSONDecoder().decode(TideTable.self, from: data)
    +  }
    +
    +  private func url(for station: Station) -> URL {
    +    directory.appending(path: "\\(station.id)-\\(station.timeZone.identifier).json")
    +  }
    +}
    +
    +extension TideTable: Codable {}
    diff --git a/Sources/TideChart/StationView.swift b/Sources/TideChart/StationView.swift
    index 2c9d1e0..7f3a8b4 100644
    --- a/Sources/TideChart/StationView.swift
    +++ b/Sources/TideChart/StationView.swift
    @@ -4,12 +4,15 @@ import SwiftUI
     struct StationView: View {
       let station: Station
       @State private var table: TideTable?
    -  @State private var failed = false
    +  @State private var savedAt: Date?

       var body: some View {
    -    Text("Tide table for \\(station.name), loaded from the network")
    +    Text(station.name)
    +    if let savedAt {
    +      Text("Saved \\(savedAt, format: .relative(presentation: .named))")
    +    }
         TideCurve(table: table)
    -      .opacity(failed ? 0.4 : 1)
    +      .opacity(table == nil ? 0.4 : 1)
       }
     }
    diff --git a/Tests/TideChartTests/TableCacheTests.swift b/Tests/TideChartTests/TableCacheTests.swift
    new file mode 100644
    index 0000000..9e8d7c6
    --- /dev/null
    +++ b/Tests/TideChartTests/TableCacheTests.swift
    @@ -0,0 +1,9 @@
    +import Testing
    +@testable import TideChart
    +
    +@Test func roundTrips() throws {
    +  let cache = TableCache(directory: .temporaryDirectory)
    +  try cache.save(.sample, for: .harbor)
    +  #expect(try cache.table(for: .harbor) == .sample)
    +}
    +
    diff --git a/README.md b/README.md
    index 1a2b3c4..5d6e7f8 100644
    --- a/README.md
    +++ b/README.md
    @@ -10,3 +10,5 @@ Tide Chart shows the tides for any station.
     ## Offline

    -The chart needs a connection.
    +The chart keeps the last table each station loaded,
    +so it still opens with no signal. The header says
    +how old the saved table is.
    """

  public static var diff: PullRequestDiffResult { PullRequestDiffResult(patch: patch) }

  public static var viewed: PullRequestFilesViewedResult {
    try! JSONDecoder().decode(
      PullRequestFilesViewedResult.self, from: Data(#"{"files":[{"path":"README.md","state":"viewed"}],"truncated":false}"#.utf8))
  }

  public static var reviewers: PullRequestReviewerCandidateList {
    try! JSONDecoder().decode(
      PullRequestReviewerCandidateList.self,
      from: Data(
        #"""
        {"candidates":[{"login":"jonas-k","name":"Jonas Kirby","avatarUrl":null,"id":"U_fixture_jonas","kind":"user","isRequested":true},
        {"login":"ana-lund","name":"Ana Lund","avatarUrl":null,"id":"U_fixture_ana","kind":"user","isRequested":false},
        {"login":"docs-team","name":"Docs","avatarUrl":null,"id":"T_fixture_docs","kind":"team","isRequested":false}],"truncated":false}
        """#.utf8))
  }
}

/// Answers every read from `PullRequestFixtures`, after a short pause like a computer would.
@MainActor
public final class FixturePullRequestSource: PullRequestSource {
  public enum Mode: Sendable { case normal, empty, signedOut, failing }
  public var mode: Mode
  public var delay: Duration
  public private(set) var invalidations = 0

  public init(mode: Mode = .normal, delay: Duration = .milliseconds(120)) {
    self.mode = mode
    self.delay = delay
  }

  private func pause() async throws(PullRequestError) {
    try? await Task.sleep(for: delay)
    switch mode {
    case .signedOut:
      throw .unavailable(.init(reason: .known(.cliUnauthenticated), requirement: "Sign in to GitHub on this computer with gh auth login."))
    case .failing: throw .operation(detail: "GitHub did not answer in time.", notFound: false)
    case .normal, .empty: break
    }
  }

  public func list(_ request: PullRequestListRequest, in environmentId: String) async throws(PullRequestError) -> PullRequestListResult {
    try await pause()
    if mode == .empty { return PullRequestListResult(viewers: [PullRequestFixtures.host: "mira-dev"], entries: []) }
    var result = PullRequestFixtures.list(request)
    // Stats arrive separately on GitHub; leave two rows at zero so the stats read shows.
    result.entries = result.entries.map { entry in
      var entry = entry
      if entry.number == 125 || entry.number == 124 {
        entry.additions = 0
        entry.deletions = 0
      }
      return entry
    }
    return result
  }

  public func stats(_ refs: [PullRequestRef], in environmentId: String) async throws(PullRequestError) -> [PullRequestDiffStat] {
    try await pause()
    return refs.compactMap { ref in
      PullRequestFixtures.entries.first { $0.number == ref.number }.map {
        PullRequestDiffStat(projectId: ref.projectId, repository: ref.repository, number: ref.number, additions: $0.additions, deletions: $0.deletions)
      }
    }
  }

  public func detail(_ ref: PullRequestRef, in environmentId: String) async throws(PullRequestError) -> PullRequestDetail {
    try await pause()
    return PullRequestFixtures.detail(ref.number)
  }

  public func activity(_ ref: PullRequestRef, in environmentId: String) async throws(PullRequestError) -> PullRequestActivity {
    try await pause()
    return PullRequestFixtures.activity(ref.number)
  }

  public func checks(_ ref: PullRequestRef, in environmentId: String) async throws(PullRequestError) -> PullRequestChecks {
    try await pause()
    let detail = PullRequestFixtures.detail(ref.number)
    return try! JSONDecoder().decode(
      PullRequestChecks.self,
      from: JSONEncoder().encode(["state": JSONValue.string(detail.state.rawValue), "checks": try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(detail.checks))]))
  }

  public func diff(_ request: PullRequestDiffRequest, in environmentId: String) async throws(PullRequestError) -> PullRequestDiffResult {
    try await pause()
    return PullRequestFixtures.diff
  }

  public func filesViewed(_ ref: PullRequestRef, in environmentId: String) async throws(PullRequestError) -> PullRequestFilesViewedResult {
    try await pause()
    return PullRequestFixtures.viewed
  }

  public func linkedThreads(_ ref: PullRequestRef, in environmentId: String) async throws(PullRequestError) -> PullRequestLinkedThreadsResult {
    PullRequestLinkedThreadsResult(threads: [])
  }

  public func reviewerCandidates(_ ref: PullRequestRef, query: String?, in environmentId: String) async throws(PullRequestError) -> PullRequestReviewerCandidateList {
    try await pause()
    return PullRequestFixtures.reviewers
  }

  public func invalidate(_ ref: PullRequestRef?, in environmentId: String) async {
    invalidations += 1
  }
}
#endif
