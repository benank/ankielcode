import Foundation
import Testing

@testable import AnkielKit

@Suite("Pull request query")
struct PullRequestQueryTests {
  typealias F = PullRequestListFilters

  @Test("keeps quoted values whole and separates negation")
  func quoted() {
    let parsed = PullRequestQuery.parse(#"label:"needs design" -label:wip Fix the parser"#)
    #expect(parsed.text == "Fix the parser")
    #expect(parsed.filters == F(labels: [["needs design"]], excludedLabels: ["wip"]))
    #expect(PullRequestQuery.parse(#"label:"needs design","wip""#).filters.labels == [["needs design", "wip"]])
    #expect(PullRequestQuery.parse("label:a,,b").filters.labels == [["a", "b"]])
    #expect(PullRequestQuery.parse(#"label:"needs,triage",wip"#).filters.labels == [["needs,triage", "wip"]])
  }

  @Test("each label qualifier is its own group")
  func groups() {
    #expect(PullRequestQuery.parse("label:bug label:a,b").filters.labels == [["bug"], ["a", "b"]])
  }

  @Test("reads the scalar qualifiers in GitHub's own spelling")
  func scalars() {
    #expect(
      PullRequestQuery.parse("author:octocat DRAFT:false review:changes_requested status:failure").filters
        == F(draft: .hide, review: .changesRequested, checks: .failing, author: "octocat"))
    #expect(PullRequestQuery.parse("-draft:true").filters == F(draft: .hide))
  }

  @Test("unknown values and stray colons stay text; unknown keys are scoped labels")
  func unknowns() {
    let parsed = PullRequestQuery.parse("milestone:v2 draft:maybe status: parser")
    #expect(parsed.filters == F(labels: [["milestone:v2"]]))
    #expect(parsed.text == "draft:maybe status: parser")
    #expect(PullRequestQuery.parse("review:constructor checks:__proto__").filters == F())
    #expect(PullRequestQuery.parse("size:S,XS").filters.labels == [["size:S", "size:XS"]])
    #expect(PullRequestQuery.parse("-size:XXL").filters.excludedLabels == ["size:XXL"])
  }

  @Test("GitHub's scope qualifiers are dropped; a pasted link is text")
  func scope() {
    let parsed = PullRequestQuery.parse("is:pr state:open archived:false repo:org/repo org:org user:alice sort:updated-desc -repo:org/fork fix")
    #expect(parsed.text == "fix")
    #expect(parsed.filters == F())
    let link = PullRequestQuery.parse("https://github.com/tidewater/tide-chart/pull/1")
    #expect(link.filters.labels == nil)
    #expect(link.text == "https://github.com/tidewater/tide-chart/pull/1")
  }

  @Test("two different authors set none; me and @me are one")
  func authors() {
    #expect(PullRequestQuery.parse("author:alice author:bob").filters == F())
    #expect(PullRequestQuery.parse("author:me author:@me").filters == F(author: "me"))
    #expect(PullRequestQuery.resolveAuthor("@me", viewer: "mira-dev") == "mira-dev")
    #expect(PullRequestQuery.resolveAuthor("me", viewer: nil) == "me")
  }

  @Test("changing the draft menu replaces a typed draft qualifier")
  func draftMenu() {
    let replaced = PullRequestQuery.applyDraftChange(query: #"draft:false fix label:"needs design""#, menu: F(), next: F(draft: .only))
    #expect(replaced.query == #"fix label:"needs design""#)
    #expect(replaced.filters == F(draft: .only))
    let kept = PullRequestQuery.applyDraftChange(query: "draft:false fix", menu: F(draft: .only), next: F(draft: .hide, checks: .passing))
    #expect(kept.query == "draft:false fix")
    #expect(kept.filters == F(draft: .only, checks: .passing))
  }
}

@Suite("Pull request list")
struct PullRequestListTests {
  static let items = PullRequestFixtures.entries.map { PullRequestListItem(environmentId: "mac", entry: $0) }

  @Test("the request carries the controls with the typed qualifiers on top")
  func request() {
    var controls = PullRequestListControls()
    controls.filters.draft = .only
    let request = PullRequestList.request(controls, query: "draft:false moon")
    #expect(request.filters?.draft == .hide)
    #expect(request.query == "moon")
    #expect(request.limit == 30)
  }

  @Test("filters by involvement, drafts, review, checks and labels on the device")
  func filter() {
    var controls = PullRequestListControls()
    controls.state = .all
    let all = PullRequestList.filter(Self.items, controls: controls, viewers: [:], query: "", localSearchHosts: [])
    #expect(all.count == 7)
    #expect(all.first?.entry.number == 128)
    controls.state = .open
    controls.involvement = .reviewing
    #expect(PullRequestList.filter(Self.items, controls: controls, viewers: [:], query: "", localSearchHosts: []).map(\.entry.number) == [127])
    controls.involvement = .authored
    let mine = PullRequestList.filter(Self.items, controls: controls, viewers: ["mac github.com": "mira-dev"], query: "", localSearchHosts: [])
    #expect(mine.map(\.entry.number) == [128, 125])
    controls.involvement = .all
    #expect(PullRequestList.filter(Self.items, controls: controls, viewers: [:], query: "draft:true", localSearchHosts: []).map(\.entry.number) == [126])
    #expect(PullRequestList.filter(Self.items, controls: controls, viewers: [:], query: "label:bug,docs", localSearchHosts: []).map(\.entry.number) == [127, 125])
    #expect(PullRequestList.filter(Self.items, controls: controls, viewers: [:], query: "-label:ui checks:failing", localSearchHosts: []).map(\.entry.number) == [127])
    #expect(PullRequestList.filter(Self.items, controls: controls, viewers: [:], query: "review:none", localSearchHosts: []).map(\.entry.number) == [126, 124])
  }

  @Test("text matches only where the host cannot search; oldest sorts ascending")
  func textAndSort() {
    var controls = PullRequestListControls()
    #expect(PullRequestList.filter(Self.items, controls: controls, viewers: [:], query: "moon", localSearchHosts: []).count == 5)
    #expect(PullRequestList.filter(Self.items, controls: controls, viewers: [:], query: "moon", localSearchHosts: ["mac github.com"]).map(\.entry.number) == [127])
    controls.sort = .oldest
    #expect(PullRequestList.filter(Self.items, controls: controls, viewers: [:], query: "", localSearchHosts: []).first?.entry.number == 124)
  }

  @Test("one row per pull request, a connected computer's copy first")
  func dedupe() {
    let entry = PullRequestFixtures.entries[0]
    let rows = [PullRequestListItem(environmentId: "off", entry: entry), PullRequestListItem(environmentId: "on", entry: entry)]
    let shown = PullRequestList.filter(rows, controls: PullRequestListControls(), viewers: [:], query: "", localSearchHosts: [], connected: ["on"])
    #expect(shown.map(\.environmentId) == ["on"])
  }

  @Test("pages by cursor, else by a growing limit while truncated")
  func paging() {
    var head = PullRequestListResult(entries: Array(PullRequestFixtures.entries.prefix(2)))
    head.nextCursors = ["github.com tidewater/tide-chart": "c1"]
    let request = PullRequestList.request(PullRequestListControls(), query: "")
    let pages = PullRequestListPages(head: head)
    #expect(PullRequestList.nextRequest(pages, after: request)?.cursors == ["github.com tidewater/tide-chart": "c1"])
    let appended = PullRequestList.append(pages, page: PullRequestListResult(entries: Array(PullRequestFixtures.entries.suffix(2))), request: request)
    #expect(appended.entries.count == 4)
    #expect(appended.continued)
    #expect(!PullRequestList.hasMore(appended))
    var truncated = PullRequestListPages(head: PullRequestListResult(entries: [], truncated: true))
    #expect(PullRequestList.nextRequest(truncated, after: request)?.limit == 60)
    truncated.limit = 500
    #expect(PullRequestList.nextRequest(truncated, after: request) == nil)
  }

  @Test("review badges and label colors")
  func badges() {
    #expect(PullRequestList.reviewBadge(decision: .known(.changesRequested), viewerReviewRequested: true) == .changesRequested)
    #expect(PullRequestList.reviewBadge(decision: nil, viewerReviewRequested: true) == .yourReview)
    #expect(PullRequestList.reviewBadge(decision: .known(.reviewRequired), viewerReviewRequested: false) == .reviewRequired)
    #expect(PullRequestList.labelColor("#0E8A16") == "#0E8A16")
    #expect(PullRequestList.labelColor("blue") == nil)
  }

  @Test("stats fill zero rows and drop when a row moves")
  func stats() {
    var cache = PullRequestStatsCache()
    var entry = PullRequestFixtures.entries[0]
    entry.additions = 0
    entry.deletions = 0
    _ = cache.listed([entry])
    #expect(cache.missing([entry]).count == 1)
    cache.answered([PullRequestDiffStat(projectId: entry.projectId, repository: entry.repository, number: entry.number, additions: 5, deletions: 2)])
    #expect(PullRequestList.withStats([entry], stats: cache.stats).first?.additions == 5)
    entry.updatedAt = WireTimestamp(rawValue: "2030-01-01T00:00:00.000Z")
    #expect(cache.listed([entry]).count == 1)
    #expect(cache.missing([entry]).count == 1)
  }
}

@Suite("Pull request links")
struct PullRequestLinkTests {
  @Test("reads GitHub and GitLab change request URLs")
  func parse() throws {
    let github = try #require(ChangeRequestLink.parse("https://GitHub.com/Tidewater/Tide-Chart/pull/123/files?w=1#diff"))
    #expect(github.host == "github.com")
    #expect(github.repository == "tidewater/tide-chart")
    #expect(github.number == 123)
    #expect(github.repositoryURL == "https://github.com/Tidewater/Tide-Chart")
    let enterprise = try #require(ChangeRequestLink.parse("https://ghe.example.com:8443/acme/web/pull/42/"))
    #expect(enterprise.refHost == "ghe.example.com:8443")
    let gitlab = try #require(ChangeRequestLink.parse("https://gitlab.com/group/sub/repo/-/merge_requests/7"))
    #expect(gitlab.kind == .gitlab)
    #expect(gitlab.repository == "group/sub/repo")
    #expect(ChangeRequestLink.parse("https://github.com/tidewater/tide-chart/issues/3") == nil)
  }

  @Test("a pasted reference resolves to the project that reads it")
  func resolve() {
    let identity = try! JSONDecoder().decode(
      RepositoryIdentity.self, from: Data(#"{"canonicalKey":"github.com/tidewater/tide-chart","provider":"github","owner":"tidewater","name":"tide-chart"}"#.utf8))
    let other = try! JSONDecoder().decode(RepositoryIdentity.self, from: Data(#"{"canonicalKey":"github.com/tidewater/charts-site","provider":"github"}"#.utf8))
    let projects = [
      PullRequestLinkInput.Project(environmentId: "mac", projectId: "site", identity: other),
      PullRequestLinkInput.Project(environmentId: "mac", projectId: "app", identity: identity),
    ]
    #expect(
      PullRequestLinkInput.resolve("https://github.com/tidewater/tide-chart/pull/9", projects: projects)
        == .open(environmentId: "mac", ref: PullRequestRef(projectId: "app", host: "github.com", repository: "tidewater/tide-chart", number: 9)))
    // Another repository on the host borrows any project there.
    #expect(
      PullRequestLinkInput.resolve("https://github.com/elsewhere/tool/pull/2", projects: projects)
        == .open(environmentId: "mac", ref: PullRequestRef(projectId: "site", host: "github.com", repository: "elsewhere/tool", number: 2)))
    #expect(PullRequestLinkInput.resolve("https://gitlab.com/a/b/-/merge_requests/2", projects: projects) == .noProject(host: "gitlab.com", repository: "a/b"))
    #expect(PullRequestLinkInput.resolve("#12", projects: projects) == .needsURL)
    #expect(
      PullRequestLinkInput.resolve("gh pr checkout 12", projects: projects, scope: projects[1])
        == .open(environmentId: "mac", ref: PullRequestRef(projectId: "app", host: "github.com", repository: "tidewater/tide-chart", number: 12)))
    #expect(PullRequestLinkInput.resolve("hello", projects: projects) == nil)
  }
}

@Suite("Pull request markdown")
struct PullRequestMarkdownTests {
  static let links = PullRequestMarkdown.LinkContext(webOrigin: "https://github.com", repository: "tidewater/tide-chart")

  @Test("standalone media lines become their own segments; code is left alone")
  func segments() {
    let body = """
      Intro
      https://example.invalid/shot.png

      ```
      https://example.invalid/in-code.png
      ```
      [clip](https://example.invalid/demo.mp4)
      https://github.com/user-attachments/assets/1a2b-3c
      Outro
      """
    let kinds = PullRequestMarkdown.segments(body).map(\.kindName)
    #expect(kinds == ["markdown", "image", "markdown", "video", "video", "markdown"])
  }

  @Test("emoji aliases become emoji, unknown aliases stay")
  func emoji() {
    #expect(PullRequestMarkdown.expandEmoji("Ship it :rocket: :not_an_emoji: :tada:tada:") == "Ship it 🚀 :not_an_emoji: 🎉tada:")
  }

  @Test("mentions and issue references link in prose only")
  func autolinks() {
    let text = PullRequestMarkdown.prepare("Thanks @jonas-k, fixes #97 and other/repo#3. `#5` [#6](x) email a@b.c", links: Self.links)
    #expect(text.contains("[@jonas-k](https://github.com/jonas-k)"))
    #expect(text.contains("[#97](https://github.com/tidewater/tide-chart/issues/97)"))
    #expect(text.contains("[other/repo#3](https://github.com/other/repo/issues/3)"))
    #expect(text.contains("`#5`"))
    #expect(text.contains("[#6](x)"))
    #expect(text.contains("a@b.c"))
    let fenced = PullRequestMarkdown.prepare("```\n@nobody #1\n```", links: Self.links)
    #expect(fenced == "```\n@nobody #1\n```")
  }

  @Test("credentialed media goes through the computer")
  func media() {
    #expect(SourceControlMedia.fetchURL("https://github.com/user-attachments/assets/abc-123") == "https://github.com/user-attachments/assets/abc-123")
    #expect(SourceControlMedia.fetchURL("https://github.com/tidewater/tide-chart/blob/main/docs/shot.png") == "https://github.com/tidewater/tide-chart/raw/main/docs/shot.png")
    #expect(SourceControlMedia.fetchURL("https://private-user-images.githubusercontent.com/x.png?jwt=1") == nil)
  }
}

@Suite("Thread pull request chip")
struct ThreadPullRequestTests {
  static func link(_ number: Int, state: String = "open", draft: Bool = false, head: String, base: String = "main", checks: String? = nil) -> ThreadShell.PullRequestLink {
    let json = """
      {"host":"github.com","repository":"tidewater/tide-chart","number":\(number),"url":"https://github.com/tidewater/tide-chart/pull/\(number)",
       "source":"agent","linkedAt":"2026-11-2\(number % 10)T10:00:00.000Z","stack":null,
       "snapshot":{"state":"\(state)","title":"PR \(number)","headBranch":"\(head)","baseBranch":"\(base)","isDraft":\(draft),
         "updatedAt":"2026-11-2\(number % 10)T11:00:00.000Z","syncedAt":"2026-11-27T10:00:00.000Z"\(checks.map { ",\"checksState\":\"\($0)\"" } ?? "")}}
      """
    return try! JSONDecoder().decode(ThreadShell.PullRequestLink.self, from: Data(json.utf8))
  }

  @Test("one link shows its number, state and checks")
  func single() throws {
    let badge = try #require(ThreadPullRequests.badge([Self.link(3, head: "a", checks: "failing")]))
    #expect(badge.kind == .single)
    #expect(badge.label == "#3")
    #expect(badge.state == .open)
    #expect(badge.checks == .failing)
    #expect(ThreadPullRequests.badge([Self.link(3, draft: true, head: "a")])?.state == .draft)
    #expect(ThreadPullRequests.badge([]) == nil)
  }

  @Test("a chain of branches is a stack; its top open layer opens")
  func stack() throws {
    let links = [Self.link(1, head: "base-layer"), Self.link(2, head: "middle", base: "base-layer"), Self.link(4, head: "top", base: "middle")]
    let badge = try #require(ThreadPullRequests.badge(links))
    #expect(badge.kind == .stack(layers: 3))
    #expect(badge.number == 4)
  }

  @Test("unrelated links are several; merged ones fall back to the open one")
  func several() throws {
    let badge = try #require(ThreadPullRequests.badge([Self.link(1, state: "merged", head: "x"), Self.link(2, head: "y")]))
    #expect(badge.kind == .several(count: 2))
    #expect(badge.number == 2)
    #expect(badge.state == .open)
    #expect(ThreadPullRequests.badge([Self.link(1, state: "merged", head: "x"), Self.link(2, state: "merged", head: "y")])?.state == .merged)
  }
}

@Suite("Pull request routing")
struct PullRequestRoutingTests {
  static func record(_ id: String, _ urls: [String], learned: [String] = []) -> EnvironmentRecord {
    var record = EnvironmentRecord(SavedEnvironment(environmentId: id, label: id, endpoint: EnvironmentEndpoint(URLComponents(string: urls[0])!)!, serverVersion: "0.1.11", pairedAt: .now))
    record.routes = urls.map { EnvironmentRoute(endpoint: EnvironmentEndpoint(URLComponents(string: $0)!)!) }
      + learned.map { EnvironmentRoute(endpoint: EnvironmentEndpoint(URLComponents(string: $0)!)!, learned: true) }
    return record
  }

  @Test("trust covers the saved addresses: learned ones and order do not matter, a new address revokes it")
  func trustKey() throws {
    let a = Self.record("a", ["https://a.example.invalid", "http://10.0.0.2:3773"])
    let reordered = Self.record("a", ["http://10.0.0.2:3773", "https://a.example.invalid"], learned: ["http://192.168.1.9:3773"])
    let changed = Self.record("a", ["https://a.example.invalid", "http://10.0.0.3:3773"])
    #expect(PullRequestRoutingRules.connectionKey(a) == PullRequestRoutingRules.connectionKey(reordered))
    #expect(PullRequestRoutingRules.connectionKey(a) != PullRequestRoutingRules.connectionKey(changed))
    let stored = try #require(PullRequestRoutingRules.setting(.readWrite, for: a, in: []))
    #expect(PullRequestRoutingRules.permission(reordered, in: stored) == .readWrite)
    #expect(PullRequestRoutingRules.permission(changed, in: stored) == .off)
    #expect(PullRequestRoutingRules.setting(.off, for: a, in: stored) == [])
  }

  @Test("reads need trust on both computers; writes need read-write on both")
  func allowed() throws {
    let a = Self.record("a", ["https://a.example.invalid"])
    let b = Self.record("b", ["https://b.example.invalid"])
    var stored = try #require(PullRequestRoutingRules.setting(.read, for: a, in: []))
    #expect(!PullRequestRoutingRules.allowed(origin: a, destination: b, write: false, stored: stored))
    stored = try #require(PullRequestRoutingRules.setting(.readWrite, for: b, in: stored))
    #expect(PullRequestRoutingRules.allowed(origin: a, destination: b, write: false, stored: stored))
    #expect(!PullRequestRoutingRules.allowed(origin: a, destination: b, write: true, stored: stored))
    var off = b
    off.enabled = false
    #expect(!PullRequestRoutingRules.allowed(origin: a, destination: off, write: false, stored: stored))
  }

  @Test("candidate order and the write retry rule")
  func order() {
    let alternatives = [(id: "remote", local: false), (id: "local", local: true)]
    #expect(PullRequestRoutingRules.candidates(origin: "o", originLocal: false, alternatives: alternatives, write: false) == ["local", "remote", "o"])
    #expect(PullRequestRoutingRules.candidates(origin: "o", originLocal: false, alternatives: alternatives, write: true) == ["local", "o", "remote"])
    #expect(PullRequestRoutingRules.candidates(origin: "o", originLocal: true, alternatives: alternatives, write: true) == ["o", "local", "remote"])
    // A write that may have run is never retried elsewhere: a retry would comment or merge twice.
    #expect(!PullRequestRoutingRules.shouldTryNext(after: .operation(detail: "x", notFound: false), write: true))
    #expect(!PullRequestRoutingRules.shouldTryNext(after: .failed("timeout"), write: true))
    #expect(PullRequestRoutingRules.shouldTryNext(after: .notConnected, write: true))
    #expect(PullRequestRoutingRules.shouldTryNext(after: .failed("timeout"), write: false))
  }

  @Test("an alternative answers only for the same host account")
  func account() throws {
    let identity = try JSONDecoder().decode(
      PullRequestRoutingResult.self, from: Data(#"{"accountId":"42","host":"github.com","provider":"github","viewer":"mira","projectTitle":"t","workspaceRoot":"/w"}"#.utf8))
    let same = try JSONDecoder().decode(PullRequestRoutingIdentityResult.self, from: Data(#"{"accountId":"42","host":"GitHub.com","provider":"github","viewer":"mira"}"#.utf8))
    let other = try JSONDecoder().decode(PullRequestRoutingIdentityResult.self, from: Data(#"{"accountId":"7","host":"github.com","provider":"github","viewer":"x"}"#.utf8))
    #expect(PullRequestRoutingRules.sameAccount(identity, same))
    #expect(!PullRequestRoutingRules.sameAccount(identity, other))
    #expect(!PullRequestRoutingRules.sameAccount(identity, nil))
  }
}

@Suite("Pull request diffs and status")
struct PullRequestDiffTests {
  @Test("threads sit on their line and side; unplaceable ones on the file")
  func placement() throws {
    let files = PullRequestDiffs.files([PullRequestFixtures.diff])
    #expect(files.count == 4)
    let cache = try #require(files.first { $0.path == "Sources/TideChart/TableCache.swift" })
    let rows = DiffRows.build(cache)
    let activity = PullRequestFixtures.activity(128)
    let draft = PullRequestReviewCommentDraft(path: cache.path, position: .added(newLine: 3), body: "Doc comment?")
    let placed = PullRequestDiffs.place(threads: activity.reviewThreads, drafts: [draft], path: cache.path, rows: rows)
    #expect(placed.count == 2)
    let row = try #require(rows.first { $0.line?.newNumber == 14 })
    #expect(placed.byRow[row.id]?.first?.id == "discussion:PRRT_fixture_1")
    let station = try #require(files.first { $0.path == "Sources/TideChart/StationView.swift" })
    let stationPlaced = PullRequestDiffs.place(threads: activity.reviewThreads, drafts: [], path: station.path, rows: DiffRows.build(station))
    let left = try #require(DiffRows.build(station).first { $0.line?.oldNumber == 10 && $0.line?.kind == .removed })
    #expect(stationPlaced.byRow[left.id]?.count == 1)
    var far = activity.reviewThreads[0]
    far.line = 900
    #expect(PullRequestDiffs.place(threads: [far], drafts: [], path: cache.path, rows: rows).fileLevel.count == 1)
  }

  @Test("folds: the reader's choice wins, then the bulk choice, then the viewed mark")
  func folds() {
    var folds = PullRequestDiffs.Folds()
    #expect(!folds.isCollapsed("a.ts", viewed: false))
    #expect(folds.isCollapsed("a.ts", viewed: true))
    folds.set("a.ts", collapsed: false)
    #expect(!folds.isCollapsed("a.ts", viewed: true))
    folds.setAll(.folded, hiddenTests: [])
    #expect(folds.isCollapsed("b.ts", viewed: false))
    #expect(!folds.isCollapsed("Tests/x.test.ts", viewed: false))
    folds.setAll(.expanded, hiddenTests: nil)
    #expect(!folds.isCollapsed("Tests/x.test.ts", viewed: true))
  }

  @Test("test files are recognized by path")
  func tests() {
    #expect(PullRequestDiffs.isTest("Tests/TideChartTests/TableCacheTests.swift"))
    #expect(PullRequestDiffs.isTest("src/__tests__/a.ts"))
    #expect(PullRequestDiffs.isTest("pkg/tide_test.go"))
    #expect(!PullRequestDiffs.isTest("Sources/TideChart/Table.swift"))
  }

  @Test("pending reactions apply over the host's, in order")
  func reactions() {
    let host = [PullRequestReaction(content: .rocket, count: 1, actors: ["jonas-k"]), PullRequestReaction(content: .thumbsUp, count: 1, viewerHasReacted: true)]
    let shown = PullRequestReactions.applying([.thumbsUp: false, .eyes: true, .rocket: true], to: host)
    #expect(shown.map(\.content) == [.known(.rocket), .known(.eyes)])
    #expect(shown[0].count == 2)
    #expect(PullRequestReactions.names(PullRequestReaction(content: .heart, count: 5, actors: ["a", "b"], viewerHasReacted: true), you: "You") == (["You", "a", "b"], 2))
  }

  @Test("selection sends only what still differs from the host")
  func selection() {
    var picks = PullRequestSelection<String>()
    picks.toggle("a", item: "a", host: false)
    picks.toggle("b", item: "b", host: true)
    picks.toggle("c", item: "c", host: false)
    picks.toggle("c", item: "c", host: false)
    let changes = picks.changes { key, _ in key == "a" ? true : key == "b" }
    #expect(changes.add.isEmpty)
    #expect(changes.remove == ["b"])
    #expect(PullRequestSelection<Int>.batches(Array(0..<60)).map(\.count) == [25, 25, 10])
  }

  @Test("checks, reviews and merge rules")
  func status() {
    let detail = PullRequestFixtures.detail(127)
    #expect(PullRequestStatus.checksSummary(detail.checks).state == .failing)
    #expect(PullRequestStatus.orderedChecks(detail.checks).first?.name == "Unit tests")
    let review = PullRequestStatus.reviewSummary(reviewers: detail.reviewers, activity: PullRequestFixtures.activity(127))
    #expect(review.tone == .changesRequested(count: 1))
    #expect(PullRequestStatus.reviewSummary(reviewers: [], activity: PullRequestFixtures.activity(128)).tone == .approved(count: 1, by: "jonas-k"))
    #expect(PullRequestStatus.canPerform(.merge, on: detail))
    #expect(!PullRequestStatus.canPerform(.reopen, on: detail))
    #expect(!PullRequestStatus.canPerform(.merge, on: PullRequestFixtures.detail(126)))
    #expect(PullRequestStatus.mergeBlock(PullRequestFixtures.detail(124), canWrite: true) == .conflicts)
    #expect(PullRequestStatus.mergeBlock(detail, canWrite: false) == .readOnly)
    #expect(PullRequestStatus.resolveMergeMethod(detail, selected: nil, projectDefault: nil, lastUsed: nil) == .squash)
    #expect(PullRequestStatus.resolveMergeMethod(detail, selected: .fastForward, projectDefault: .rebase, lastUsed: nil) == .rebase)
    let permissions = PullRequestPermissions(detail: detail, connected: true, sourceControlWrite: true)
    #expect(permissions.verdicts == [.comment, .approve, .requestChanges])
    #expect(permissions.canInlineComment)
    #expect(PullRequestPermissions(detail: detail, connected: true, sourceControlWrite: false) == PullRequestPermissions())
  }
}

@Suite("Pull request models")
@MainActor
struct PullRequestModelTests {
  @Test("the list loads every computer, fills stats and pages")
  func list() async {
    let source = FixturePullRequestSource(delay: .zero)
    let model = PullRequestListModel(
      source: source, targets: { [PullRequestTarget(environmentId: "mac", label: "Mac", connected: true)] },
      cache: PullRequestListCache(directory: nil), defaults: nil)
    model.reload()
    for _ in 0..<50 where model.phase != .loaded || model.items.contains(where: { $0.entry.number == 124 && $0.entry.additions == 0 }) {
      await Task.yield()
      try? await Task.sleep(for: .milliseconds(5))
    }
    #expect(model.items.map(\.entry.number) == [128, 127, 126, 125, 124])
    #expect(model.items.first { $0.entry.number == 124 }?.entry.additions == 12)
    await model.refresh()
    #expect(source.invalidations == 1)
    model.controls.state = .merged
    for _ in 0..<50 where model.items.count != 1 { try? await Task.sleep(for: .milliseconds(5)) }
    #expect(model.items.map(\.entry.number) == [121])
  }

  @Test("a signed-out computer reports why")
  func signedOut() async {
    let model = PullRequestListModel(
      source: FixturePullRequestSource(mode: .signedOut, delay: .zero),
      targets: { [PullRequestTarget(environmentId: "mac", label: "Mac", connected: true)] }, cache: PullRequestListCache(directory: nil),
      defaults: nil)
    model.reload()
    for _ in 0..<50 where model.failures.isEmpty { try? await Task.sleep(for: .milliseconds(5)) }
    guard case .unavailable(let unavailable)? = model.failures["mac"] else {
      Issue.record("no failure")
      return
    }
    #expect(unavailable.reason == .cliUnauthenticated)
  }

  @Test("writes reach the sink with the pending review comments, and reactions roll back on refusal")
  func writes() async throws {
    let sink = RecordingPullRequestSink(delay: .zero)
    let model = PullRequestDetailModel(
      environmentId: "mac", ref: PullRequestFixtures.ref(128), source: FixturePullRequestSource(delay: .zero), sink: sink)
    await model.load()
    #expect(model.value?.number == 128)
    model.addDraft(PullRequestReviewCommentDraft(path: "README.md", position: .added(newLine: 13), body: "Say how old."))
    #expect(await model.submitReview(.approve, body: "Ship it") == nil)
    guard case .review(_, let submission) = try #require(sink.sent.last).write else {
      Issue.record("not a review")
      return
    }
    #expect(submission.comments.count == 1)
    #expect(submission.expectedHeadSha == "3f2a9c1d7e5b4a6c8d0e2f4a6b8c0d2e4f6a8b0c")
    #expect(model.reviewDrafts.isEmpty)

    let reactions = model.activity.value?.reactions ?? []
    sink.mode = .refuse
    #expect(await model.react(.heart, on: nil, current: reactions) != nil)
    #expect(model.reactions(reactions, subjectId: nil) == reactions)
    sink.mode = .accept
    #expect(await model.react(.heart, on: nil, current: reactions) == nil)
    #expect(model.reactions(reactions, subjectId: nil).contains { $0.content == .known(.heart) && $0.viewerHasReacted })

    #expect(await model.run(.merge, mergeMethod: .squash) == nil)
    guard case .action(_, let action) = try #require(sink.sent.last).write else {
      Issue.record("not an action")
      return
    }
    #expect(action.mergeMethod == .squash)
    #expect(action.expectedHeadSha != nil)
  }
}
