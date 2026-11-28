import Foundation
import Testing

@testable import AnkielKit

/// Diff review: the unified-diff parser, display rows and context expansion, word diffs, the
/// review order and git rules against TypeScript goldens, request encoding against
/// `Fixtures/commands/review-*.json` (checked by `check-schemas.mjs`), and the models.
@Suite("Review")
struct ReviewTests {
  // MARK: Parser

  @Test("a modified file: hunks, numbers, counts and the function context")
  func modified() {
    let diff = UnifiedDiff.parse(
      """
      diff --git a/Sources/Tide.swift b/Sources/Tide.swift
      index 1a2b3c4..5d6e7f8 100644
      --- a/Sources/Tide.swift
      +++ b/Sources/Tide.swift
      @@ -3,4 +3,5 @@ struct Tide {
         let height: Double
      -  let time: Date
      +  let time: Date?
      +  let station: String
         var isHigh: Bool
         }
      @@ -20,2 +21,2 @@ func load() {
      -  return []
      +  return tides
         }

      """)
    #expect(diff.files.count == 1)
    let file = diff.files[0]
    #expect(file.status == .modified)
    #expect(file.path == "Sources/Tide.swift")
    #expect(file.additions == 3 && file.deletions == 2)
    #expect(file.hunks.count == 2)
    #expect(file.hunks[0].context == "struct Tide {")
    let lines = file.hunks[0].lines
    #expect(lines.map(\.kind) == [.context, .removed, .added, .added, .context, .context])
    #expect(lines[0].oldNumber == 3 && lines[0].newNumber == 3)
    #expect(lines[1].oldNumber == 4 && lines[1].newNumber == nil)
    #expect(lines[3].newNumber == 5)
    #expect(lines[4].oldNumber == 5 && lines[4].newNumber == 6)
    #expect(file.hunks[1].lines.last?.newNumber == 22)
  }

  @Test("renames: pure, with changes, and quoted names with spaces and unicode")
  func renames() {
    let diff = UnifiedDiff.parse(
      #"""
      diff --git a/old name.txt b/new name.txt
      similarity index 100%
      rename from old name.txt
      rename to new name.txt
      diff --git a/src/a.ts b/src/b.ts
      similarity index 90%
      rename from src/a.ts
      rename to src/b.ts
      index 111..222 100644
      --- a/src/a.ts
      +++ b/src/b.ts
      @@ -1 +1 @@
      -export const a = 1;
      +export const b = 1;
      diff --git "a/caf\303\251 \"x\".md" "b/caf\303\251 \"x\".md"
      index 1..2 100644
      --- "a/caf\303\251 \"x\".md"
      +++ "b/caf\303\251 \"x\".md"
      @@ -1 +1 @@
      -a
      +b
      """#)
    #expect(diff.files.count == 3)
    #expect(diff.files[0].status == .renamed)
    #expect(diff.files[0].previousPath == "old name.txt" && diff.files[0].path == "new name.txt")
    #expect(diff.files[0].hunks.isEmpty && diff.files[0].changeType == "rename-pure")
    #expect(diff.files[0].similarity == 100)
    #expect(diff.files[1].status == .renamed && diff.files[1].changeType == "rename-changed")
    #expect(diff.files[1].previousPath == "src/a.ts" && diff.files[1].path == "src/b.ts")
    #expect(diff.files[2].path == "café \"x\".md")
  }

  @Test("added, deleted, binary and mode-only files")
  func kinds() {
    let diff = UnifiedDiff.parse(
      """
      diff --git a/new.txt b/new.txt
      new file mode 100644
      index 0000000..e69de29
      --- /dev/null
      +++ b/new.txt
      @@ -0,0 +1,2 @@
      +one
      +two
      diff --git a/gone.txt b/gone.txt
      deleted file mode 100644
      index e69de29..0000000
      --- a/gone.txt
      +++ /dev/null
      @@ -1 +0,0 @@
      -bye
      diff --git a/logo.png b/logo.png
      new file mode 100644
      index 0000000..1234567
      Binary files /dev/null and b/logo.png differ
      diff --git a/run.sh b/run.sh
      old mode 100644
      new mode 100755
      diff --git a/icon.bin b/icon.bin
      index 1..2 100644
      GIT binary patch
      literal 12
      Tcmeyu
      literal 0
      HcmV?d00001
      diff --git a/tail.txt b/tail.txt
      index 1..2 100644
      --- a/tail.txt
      +++ b/tail.txt
      @@ -1 +1 @@
      -x
      +y
      """)
    #expect(diff.files.map(\.path) == ["new.txt", "gone.txt", "logo.png", "run.sh", "icon.bin", "tail.txt"])
    #expect(diff.files[0].status == .added && diff.files[0].additions == 2 && diff.files[0].changeType == "new")
    #expect(diff.files[1].status == .deleted && diff.files[1].deletions == 1 && diff.files[1].changeType == "deleted")
    #expect(diff.files[2].isBinary && diff.files[2].status == .added && diff.files[2].hunks.isEmpty)
    #expect(diff.files[3].modeChanged && diff.files[3].oldMode == "100644" && diff.files[3].newMode == "100755")
    #expect(diff.files[4].isBinary && diff.files[4].status == .modified)
    #expect(diff.files[5].additions == 1 && diff.files[5].deletions == 1)
  }

  @Test("no newline at end of file marks the line, on either side")
  func noNewline() {
    let diff = UnifiedDiff.parse(
      """
      diff --git a/a.txt b/a.txt
      --- a/a.txt
      +++ b/a.txt
      @@ -1,2 +1,2 @@
       keep
      -old
      \\ No newline at end of file
      +new
      \\ No newline at end of file
      """)
    let lines = diff.files[0].hunks[0].lines
    #expect(lines.count == 3)
    #expect(lines[1].noNewline && lines[2].noNewline && !lines[0].noNewline)
  }

  @Test("CRLF line endings are stripped and remembered")
  func crlf() {
    let diff = UnifiedDiff.parse("diff --git a/w.txt b/w.txt\r\n--- a/w.txt\r\n+++ b/w.txt\r\n@@ -1,2 +1,2 @@\r\n same\r\n-old\r\n+new\r\n")
    #expect(diff.files.first?.path == "w.txt")
    let lines = diff.files[0].hunks[0].lines
    #expect(lines.map(\.text) == ["same", "old", "new"])
    #expect(lines.allSatisfy { $0.crlf })
  }

  @Test("content that looks like headers stays content inside a counted hunk")
  func headerLookalikes() {
    let diff = UnifiedDiff.parse(
      """
      diff --git a/notes.md b/notes.md
      --- a/notes.md
      +++ b/notes.md
      @@ -1,3 +1,3 @@
      --- a/x
      +++ b/x
      -diff --git a/y b/y
      +@@ not a hunk @@
       end
      diff --git a/next.md b/next.md
      --- a/next.md
      +++ b/next.md
      @@ -1 +1 @@
      -1
      +2
      """)
    #expect(diff.files.map(\.path) == ["notes.md", "next.md"])
    #expect(diff.files[0].hunks[0].lines.map(\.text) == ["-- a/x", "++ b/x", "diff --git a/y b/y", "@@ not a hunk @@", "end"])
  }

  @Test("a 5,000-line hunk parses, with numbers to the end")
  func hugeHunk() {
    var text = "diff --git a/big.txt b/big.txt\nnew file mode 100644\n--- /dev/null\n+++ b/big.txt\n@@ -0,0 +1,5000 @@\n"
    for index in 1...5000 { text += "+line \(index)\n" }
    let started = ContinuousClock.now
    let diff = UnifiedDiff.parse(text)
    let rows = DiffRows.build(diff.files[0])
    #expect(diff.files[0].additions == 5000)
    #expect(diff.files[0].hunks[0].lines.last?.newNumber == 5000)
    #expect(rows.count == 5001)
    #expect(ContinuousClock.now - started < .seconds(2))
  }

  @Test("a truncated patch keeps what it has and says so")
  func truncated() {
    let diff = UnifiedDiff.parse("diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,3 +1,3 @@\n x\n-y\n\n[truncated]")
    #expect(diff.truncated)
    #expect(diff.files.count == 1)
    #expect(diff.files[0].deletions == 1)
  }

  @Test("repository patches move under their folder")
  func prefixPaths() {
    let moved = UnifiedDiff.prefixPaths(
      "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b", folder: "packages/tide")
    #expect(moved.hasPrefix("diff --git a/packages/tide/x.ts b/packages/tide/x.ts\n--- a/packages/tide/x.ts\n+++ b/packages/tide/x.ts\n"))
    let turn = ThreadTurnDiff(
      threadId: "t", fromTurnCount: 0, toTurnCount: 1, diff: "diff --git a/r.md b/r.md\n--- a/r.md\n+++ b/r.md\n@@ -1 +1 @@\n-a\n+b\n",
      repositories: [.init(name: "tide", repositoryPath: "/w/tide", relativePath: "tide", diff: "diff --git a/r.md b/r.md\n--- a/r.md\n+++ b/r.md\n@@ -1 +1 @@\n-c\n+d\n")])
    #expect(UnifiedDiff.parse(turn.reviewText).files.map(\.path) == ["r.md", "tide/r.md"])
  }

  // MARK: Rows and context

  static let twoHunks = UnifiedDiff.parse(
    """
    diff --git a/f.txt b/f.txt
    --- a/f.txt
    +++ b/f.txt
    @@ -3,3 +3,3 @@
     c
    -d
    +D
     e
    @@ -10,2 +10,3 @@
     j
    +J
     k
    """
  ).files[0]

  static let contents = DiffFileContents(
    oldContents: (["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m"]).joined(separator: "\n") + "\n",
    newContents: (["a", "b", "c", "D", "e", "f", "g", "h", "i", "j", "J", "k", "l", "m"]).joined(separator: "\n") + "\n")

  @Test("gaps sit before, between and after hunks with the unchanged line counts")
  func gaps() throws {
    let rows = DiffRows.build(Self.twoHunks)
    let gaps = rows.compactMap { if case .gap(let gap) = $0.content { gap } else { nil } }
    #expect(gaps.map(\.count) == [2, 4])
    #expect(gaps.map(\.index) == [0, 1])
    let lines = try #require(DiffRows.verifiedLines(Self.twoHunks, contents: Self.contents))
    let withContents = DiffRows.build(Self.twoHunks, contents: lines)
    let tail = withContents.compactMap { if case .gap(let gap) = $0.content { gap } else { nil } }
    #expect(tail.map(\.count) == [2, 4, 2])
  }

  @Test("expanding a gap shows its lines with both numbers")
  func expand() throws {
    let lines = try #require(DiffRows.verifiedLines(Self.twoHunks, contents: Self.contents))
    let rows = DiffRows.build(Self.twoHunks, contents: lines, expanded: [1, 2])
    let shown = rows.compactMap(\.line).filter { $0.kind == .context }
    #expect(shown.map(\.text) == ["c", "e", "f", "g", "h", "i", "j", "k", "l", "m"])
    let f = try #require(shown.first { $0.text == "f" })
    #expect(f.oldNumber == 6 && f.newNumber == 6)
    let l = try #require(shown.first { $0.text == "l" })
    #expect(l.oldNumber == 12 && l.newNumber == 13)
    #expect(Set(rows.map(\.id)).count == rows.count)
  }

  @Test("contents that no longer match the patch are refused")
  func staleContents() {
    let changed = DiffFileContents(oldContents: Self.contents.oldContents, newContents: "a\nb\nc\nX\ne\n")
    #expect(DiffRows.verifiedLines(Self.twoHunks, contents: changed) == nil)
  }

  @Test("word diffs mark the changed words of paired lines only")
  func wordDiff() throws {
    let file = UnifiedDiff.parse(
      "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,2 +1,3 @@\n-let tide = high(now)\n-gone\n+let tide = low(now)\n+fresh\n+extra\n"
    ).files[0]
    let rows = DiffRows.build(file)
    func changed(_ text: String) -> [Range<Int>]? {
      for row in rows {
        if case .line(let line, let ranges) = row.content, line.text == text { return ranges }
      }
      return nil
    }
    #expect(changed("let tide = high(now)") == [11..<15])
    #expect(changed("let tide = low(now)") == [11..<14])
    // No word in common: whole-line change, no marks.
    #expect(changed("gone") == [])
    #expect(changed("extra") == [])
  }

  // MARK: Goldens

  struct Golden: Decodable {
    var tests: [String: Bool]
    var git: [String: GitCase]
    struct GitCase: Decodable {
      var status: JSONValue
      var busy: Bool
      var quick: Quick
      var items: [Item]
      var confirm: [String]
      struct Quick: Decodable {
        var kind: String
        var action: String?
        var hint: String?
        var label: String
      }
      struct Item: Decodable {
        var id: String
        var kind: String
        var disabled: Bool
        var reason: String?
      }
    }
  }

  static var golden: Golden {
    get throws {
      let url = URL(filePath: #filePath).deletingLastPathComponent().appending(path: "Fixtures/review/review-golden.json")
      return try JSONDecoder().decode(Golden.self, from: Data(contentsOf: url))
    }
  }

  @Test("hide test files matches isTestChangedFile")
  func testFiles() throws {
    for (path, isTest) in try Self.golden.tests {
      #expect(ReviewFileKind.isTest(path) == isTest, "\(path)")
    }
  }

  @Test("lock files, build output and snapshots fold")
  func foldedFiles() {
    for path in ["pnpm-lock.yaml", "dist/bundle.min.js", "a/__snapshots__/b.snap", "web/build/app.js", "x.generated.ts"] {
      #expect(ReviewFileKind.isFolded(path), "\(path)")
    }
    for path in ["src/tide.ts", "src/build.ts", "README.md"] {
      #expect(!ReviewFileKind.isFolded(path), "\(path)")
    }
  }

  static let hintText: [GitActionRules.Hint: String] = [
    .inProgress: "Git action in progress.", .statusUnavailable: "Git status is unavailable.",
    .noBranch: "Create and checkout a branch before pushing.",
    .noOriginRemote: "Add an \"origin\" remote before pushing.",
    .noLocalCommits: "No local commits to push.", .diverged: "Branch has diverged from upstream. Rebase/merge first.",
    .upToDate: "Branch is up to date. No action needed.",
  ]

  static let reasonText: [GitActionRules.DisabledReason: String] = [
    .inProgress: "Git action in progress.", .statusUnavailable: "Git status is unavailable.",
    .commitClean: "Worktree is clean. Make changes before committing.", .commitUnavailable: "Commit is currently unavailable.",
    .pushDetached: "Detached HEAD: checkout a branch before pushing.", .pushDirty: "Commit or stash local changes before pushing.",
    .pushBehind: "Branch is behind upstream. Pull/rebase before pushing.", .pushNoOrigin: "Add an \"origin\" remote before pushing.",
    .pushNothing: "No local commits to push.", .pushUnavailable: "Push is currently unavailable.",
  ]

  @Test("git rules match buildMenuItems, resolveQuickAction, getGitActionDisabledReason and the confirmation")
  func gitRules() throws {
    for (name, sample) in try Self.golden.git {
      let status = sample.status.isNull ? nil : try JSONDecoder().decode(VcsStatus.self, from: JSONEncoder().encode(sample.status))
      let quick = GitActionRules.quickAction(status, busy: sample.busy)
      switch quick {
      case .run(let action):
        #expect(sample.quick.kind == "run_action" && sample.quick.action == action.rawValue, "\(name)")
      case .pull: #expect(sample.quick.kind == "run_pull", "\(name)")
      case .hint(let hint, _): #expect(sample.quick.kind == "show_hint" && sample.quick.hint == Self.hintText[hint], "\(name)")
      }
      let items = GitActionRules.menuItems(status, busy: sample.busy)
      #expect(items.map(\.id.rawValue) == sample.items.map(\.id), "\(name)")
      for (item, expected) in zip(items, sample.items) {
        #expect(item.disabled == expected.disabled, "\(name) \(item.id)")
        let reason = GitActionRules.disabledReason(item, status: status, busy: sample.busy)
        #expect(reason.flatMap { Self.reasonText[$0] } == expected.reason, "\(name) \(item.id)")
      }
      let confirm = GitStackedAction.allCases.filter { GitActionRules.needsDefaultBranchConfirmation($0, status: status) }
      #expect(confirm.map(\.rawValue).sorted() == sample.confirm.sorted(), "\(name)")
    }
  }

  @Test("feature branch names skip taken ones")
  func featureBranchName() {
    #expect(GitActionRules.autoFeatureBranchName(existing: ["main"]) == "feature/update")
    #expect(GitActionRules.autoFeatureBranchName(existing: ["main", "feature/update"]) == "feature/update-2")
    #expect(GitActionRules.autoFeatureBranchName(existing: ["feature/update", "Feature/Update-2"]) == "feature/update-3")
    #expect(GitActionRules.autoFeatureBranchName(existing: ["feature/update/x"]) == "feature/update-2")
  }

  // MARK: Requests

  static let cwd = "/Users/dev/tide-chart"
  static let samples: [(name: String, schema: String, value: any Encodable & Sendable)] = [
    ("review-turn-diff", "turnDiff", TurnDiffRequest(threadId: "0b7e4f2a-9c1d-4e8b-a6f3-5d2c1b0a9e87", fromTurnCount: 2, toTurnCount: 3)),
    ("review-preview-tracked", "diffPreview", DiffPreviewRequest(cwd: cwd, sourceKind: .workingTree, trackedOnly: true)),
    ("review-preview-complete", "diffPreview", DiffPreviewRequest(cwd: cwd, sourceKind: .branchRange, completionToken: "tok_7f3a")),
    (
      "review-preview-file", "diffPreview",
      DiffPreviewRequest(
        cwd: cwd, baseRef: "origin/main", mergeBase: String(repeating: "a", count: 40),
        file: .init(path: "Sources/Tide.swift", previousPath: nil, sourceKind: .branchRange, changeType: "change"))
    ),
    (
      "review-preview-file-renamed", "diffPreview",
      DiffPreviewRequest(cwd: cwd, file: .init(path: "Sources/Moon.swift", previousPath: "Sources/Luna.swift", sourceKind: .workingTree))
    ),
    (
      "review-file-contents", "diffFileContents",
      DiffFileContentsRequest(
        cwd: cwd, sourceKind: .workingTree, changeType: "change", baseRef: nil, headRef: nil, oldPath: "Sources/Tide.swift",
        newPath: "Sources/Tide.swift")
    ),
    (
      "review-file-contents-branch", "diffFileContents",
      DiffFileContentsRequest(
        cwd: cwd, sourceKind: .branchRange, changeType: "rename-changed", baseRef: "origin/main", headRef: "feature/tides",
        oldPath: "a.swift", newPath: "b.swift")
    ),
    ("vcs-refresh-status", "vcsRefreshStatus", VcsRefreshStatusRequest(cwd: cwd)),
    ("vcs-pull", "vcsPull", VcsPullRequest(cwd: cwd)),
    ("vcs-list-refs", "vcsListRefs", ListRefsRequest(cwd: cwd)),
    ("vcs-create-ref", "vcsCreateRef", CreateRefRequest(cwd: cwd, refName: "feature/update")),
    (
      "git-action-commit", "gitAction",
      GitStackedActionRequest(
        actionId: "act-1", cwd: cwd, action: .commit, commitMessage: "  Fix tides  ", filePaths: ["a.swift", "b.swift"],
        threadId: "0b7e4f2a-9c1d-4e8b-a6f3-5d2c1b0a9e87")
    ),
    (
      "git-action-push-bare", "gitAction",
      GitStackedActionRequest(actionId: "act-2", cwd: cwd, action: .push, commitMessage: "   ", filePaths: [])
    ),
    (
      "git-action-feature-branch", "gitAction",
      GitStackedActionRequest(actionId: "act-3", cwd: cwd, action: .commitPush, featureBranch: true)
    ),
    (
      "thread-branch-update", "command",
      ThreadBranchUpdate(commandId: "cmd-1", threadId: "0b7e4f2a-9c1d-4e8b-a6f3-5d2c1b0a9e87", branch: "feature/update", worktreePath: nil)
    ),
  ]

  static var commands: URL {
    URL(filePath: #filePath).deletingLastPathComponent().appending(path: "Fixtures/commands", directoryHint: .isDirectory)
  }

  @Test("each request encodes exactly as its checked-in fixture", arguments: samples.map(\.name))
  func matchesFixture(_ name: String) throws {
    let sample = try #require(Self.samples.first { $0.name == name })
    let encoded = try JSONEncoder.wire.encode(sample.value)
    let url = Self.commands.appending(path: "\(name).json")
    if ProcessInfo.processInfo.environment["ANKIEL_WRITE_COMMAND_FIXTURES"] == "1" {
      let pretty = JSONEncoder()
      pretty.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
      let value = try JSONDecoder().decode(JSONValue.self, from: encoded)
      let document: JSONValue = ["schema": .string(sample.schema), "value": value]
      try pretty.encode(document).write(to: url)
    }
    let fixture = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url))
    #expect(fixture["schema"] == .string(sample.schema))
    #expect(try JSONDecoder().decode(JSONValue.self, from: encoded) == fixture["value"])
  }

  @Test("progress events decode without throwing, unknown kinds and an older server's pull request step included")
  func progressDecoding() throws {
    let json = #"""
      [{"kind":"action_started","actionId":"a","cwd":"/w","action":"commit","phases":["commit"]},
       {"kind":"phase_started","actionId":"a","cwd":"/w","action":"commit","phase":"commit","label":"Committing…"},
       {"kind":"hook_output","actionId":"a","cwd":"/w","action":"commit","hookName":null,"stream":"stdout","text":"lint ok"},
       {"kind":"brand_new","actionId":"a"},
       {"kind":"action_finished","actionId":"a","cwd":"/w","action":"commit","result":{"action":"commit","branch":{"status":"skipped_not_requested"},"commit":{"status":"created"},"push":{"status":"skipped_not_requested"},"pr":{"status":"created","url":"https://example.com/pr/1","number":1},"toast":{"title":"Committed abc1234","cta":{"kind":"open_pr","label":"View PR","url":"https://example.com/pr/1"}}}},
       {"kind":"action_failed","actionId":"a","cwd":"/w","action":"push","phase":"push","message":"Rejected"},
       42]
      """#
    let events = try JSONDecoder().decode([GitActionProgress].self, from: Data(json.utf8))
    #expect(events.count == 7)
    #expect(events[1] == .phaseStarted(phase: "commit", label: "Committing…"))
    #expect(events[2] == .hookOutput(text: "lint ok"))
    #expect(events[3] == .unknown && events[6] == .unknown)
    guard case .finished(let result) = events[4] else { Issue.record("no result"); return }
    #expect(result.toast == .init(title: "Committed abc1234") && result.action == "commit")
    #expect(events[5] == .failed(phase: "push", message: "Rejected"))
  }

  @Test("status decodes absent fields as their defaults and ignores an older server's pull request")
  func statusDecoding() throws {
    let status = try decode(
      VcsStatus.self,
      from: Data(#"{"isRepo":true,"hasPrimaryRemote":true,"isDefaultRef":false,"refName":"x","hasWorkingTreeChanges":true,"workingTree":{"files":[{"path":"a","insertions":1,"deletions":2}],"insertions":1,"deletions":2},"hasUpstream":false,"aheadCount":1,"behindCount":0,"pr":{"number":3,"title":"T","url":"u","baseRef":"main","headRef":"x","state":"open"},"extra":1}"#.utf8))
    #expect(status.workingTree.files.count == 1)
    #expect(status.aheadCount == 1 && status.refName == "x")
    #expect(GitActionRules.quickAction(status, busy: false) == .run(.commitPush))
  }

  @Test("a review comment block matches RN's formatReviewCommentContext")
  func commentBlock() {
    let lines = [
      DiffLine(kind: .added, text: "let a = `x`", oldNumber: nil, newNumber: 12),
      DiffLine(kind: .added, text: "let b = 2", oldNumber: nil, newNumber: 13),
    ]
    let target = ReviewCommentTarget(
      sectionId: "turn:3", sectionTitle: "Turn \"3\"", filePath: "Sources/A.swift", lines: lines, startIndex: 4, endIndex: 5)
    #expect(target.rangeLabel == "+12 to +13")
    #expect(
      target.block(comment: "  Why?  ")
        == "<review_comment sectionId=\"turn:3\" sectionTitle=\"Turn &quot;3&quot;\" filePath=\"Sources/A.swift\" startIndex=\"4\" endIndex=\"5\" rangeLabel=\"+12 to +13\">\nWhy?\n```diff\n@@ -0,0 +12,2 @@\n+let a = `x`\n+let b = 2\n```\n</review_comment>")
    let mixed = ReviewCommentTarget(
      sectionId: "s", sectionTitle: "T", filePath: "f",
      lines: [DiffLine(kind: .removed, text: "a", oldNumber: 4, newNumber: nil), DiffLine(kind: .context, text: "b", oldNumber: 5, newNumber: 5)],
      startIndex: 0, endIndex: 1)
    #expect(mixed.rangeLabel == "4 to 5")
    #expect(ReviewCommentTarget.count(in: ReviewCommentTarget.append(target.block(comment: "x"), to: "Hello")) == 1)
  }

  // MARK: Turns

  @Test("turns come from the thread folder's checkpoints, newest first, with repositories")
  func turnChanges() {
    var projection = ThreadProjection(thread: AppThread(id: "t", projectId: "p", title: "T"), updatedAt: WireTimestamp(Date(timeIntervalSince1970: 0)))
    projection.checkpointScopes = [
      CheckpointScope(id: "root", parentScopeId: nil, kind: "root_run", cwd: "/w", label: nil, repositoryPath: nil),
      CheckpointScope(id: "repo", parentScopeId: "root", kind: "root_run", cwd: "/w/tide", label: "tide", repositoryPath: "/w/tide"),
    ]
    projection.checkpoints = [
      Checkpoint(id: "c0", scopeId: "root", runId: "r0", appRunOrdinal: nil, files: []),
      Checkpoint(id: "c1", scopeId: "root", runId: "r1", appRunOrdinal: 1, files: [.init(path: "a", additions: 2, deletions: 1)]),
      Checkpoint(id: "c2", scopeId: "root", runId: "r2", appRunOrdinal: 2, status: "missing", files: []),
      Checkpoint(id: "c3", scopeId: "root", runId: "r3", appRunOrdinal: 3, files: []),
      Checkpoint(id: "x3", scopeId: "repo", runId: "r3", appRunOrdinal: 3, files: [.init(path: "b", additions: 5, deletions: 0)]),
    ]
    let turns = TurnChange.derive(projection)
    #expect(turns.map(\.turnCount) == [3, 1])
    #expect(turns[0].repositories.map(\.name) == ["tide"])
    #expect(turns[0].totals == Checkpoint.Totals(count: 1, additions: 5, deletions: 0))
    #expect(turns[1].totals == Checkpoint.Totals(count: 1, additions: 2, deletions: 1))
  }

  @Test("checkpoint events reach the projection")
  func checkpointEvents() throws {
    var projection = ThreadProjection(thread: AppThread(id: "t", projectId: "p", title: "T"), updatedAt: WireTimestamp(Date(timeIntervalSince1970: 0)))
    let event = try decode(
      ThreadEvent.self,
      from: Data(#"{"id":"e","type":"checkpoint.captured","threadId":"t","occurredAt":"2026-01-01T00:00:00.000Z","payload":{"id":"c1","threadId":"t","scopeId":"s","runId":"r","nodeId":"n","parentCheckpointId":null,"ordinalWithinScope":1,"appRunOrdinal":1,"ref":"refs/x","status":"ready","files":[{"path":"a","kind":"modified","additions":1,"deletions":0}],"capturedAt":"2026-01-01T00:00:00.000Z"}}"#.utf8))
    #expect(ThreadReducer.apply(event, to: &projection))
    #expect(projection.checkpoints.map(\.id) == ["c1"])
    #expect(TurnChange.derive(projection).map(\.turnCount) == [1])
  }

  @Test("sections: turns, then uncommitted and changes; Changes is the default")
  func sections() {
    let turn = TurnChange(turnCount: 2, runId: "r", checkpointId: "c", status: "ready", files: [.init(path: "a", additions: 1, deletions: 0)], filesTotal: nil, repositories: [])
    let changes = DiffPreviewSource(id: "b", kind: .branchRange, title: "Changes", diff: "", diffHash: "h")
    let sections = ReviewSection.build(turns: [turn], sources: [.branchRange: changes], states: [.workingTree: .loading])
    #expect(sections.map(\.id) == [.turn(2), .git(.workingTree), .git(.branchRange)])
    #expect(ReviewSection.resolve(sections, picked: nil) == .git(.branchRange))
    #expect(ReviewSection.resolve(sections, picked: .turn(2)) == .turn(2))
    #expect(ReviewSection.resolve(sections, picked: .turn(9)) == .git(.branchRange))
    #expect(ReviewSectionID(rawValue: "git:working-tree") == .git(.workingTree))
  }
}

// MARK: Models

@MainActor
final class FakeReviewSource: ReviewSource {
  var turns: [Int: ThreadTurnDiff] = [:]
  var previews: [ReviewGitKind: DiffPreviewResult] = [:]
  var contents: DiffFileContents?
  var patch: DiffPreviewSource?
  var previewReads = 0

  func turnDiff(threadId: String, turn: Int) async throws -> ThreadTurnDiff {
    guard let diff = turns[turn] else { throw EnvironmentRequestError.notConnected }
    return diff
  }

  func preview(cwd: String, kind: ReviewGitKind, partial: @escaping @Sendable (DiffPreviewResult) async -> Void) async throws -> DiffPreviewResult {
    previewReads += 1
    return previews[kind] ?? DiffPreviewResult(cwd: cwd, sources: [])
  }

  func filePatch(cwd: String, source: DiffPreviewSource, file: DiffPreviewSource.FileStat) async throws -> DiffPreviewSource? { patch }
  func fileContents(cwd: String, source: DiffPreviewSource, file: DiffFile) async throws -> DiffFileContents? { contents }
}

@MainActor
final class FakeGitSource: GitSource {
  var current: VcsStatus
  var events: [GitActionProgress] = []
  var requests: [GitStackedActionRequest] = []
  var branches: [String] = ["main"]
  var created: [String] = []
  var threadBranches: [String] = []

  init(_ status: VcsStatus) { current = status }

  func status(cwd: String) async throws -> VcsStatus { current }
  func pull(cwd: String) async throws -> VcsPullResult { try decode(VcsPullResult.self, from: Data(#"{"status":"pulled","refName":"main"}"#.utf8)) }
  func run(_ request: GitStackedActionRequest) async throws -> AsyncThrowingStream<GitActionProgress, any Error> {
    requests.append(request)
    let events = events
    return AsyncThrowingStream { continuation in
      for event in events { continuation.yield(event) }
      continuation.finish()
    }
  }
  func localBranches(cwd: String) async throws -> [String] { branches }
  func createBranch(cwd: String, name: String) async throws -> String {
    created.append(name)
    return name
  }
  func setThreadBranch(threadId: String, branch: String, worktreePath: String?) async throws { threadBranches.append(branch) }
}

@Suite("Review models")
@MainActor
struct ReviewModelTests {
  static let ref = ThreadRef(environmentId: "env", threadId: "t")

  func settle(_ condition: () -> Bool) async {
    for _ in 0..<200 where !condition() { await Task.yield() }
  }

  @Test("a turn section loads and parses its diff in the server's order; viewed marks stick per section")
  func turnSection() async throws {
    let source = FakeReviewSource()
    source.turns[1] = ThreadTurnDiff(
      threadId: "t", fromTurnCount: 0, toTurnCount: 1,
      diff: "diff --git a/b.test.ts b/b.test.ts\n--- a/b.test.ts\n+++ b/b.test.ts\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-a\n+b\n")
    let model = ReviewModel(ref: Self.ref, source: source)
    let turn = TurnChange(turnCount: 1, runId: "r", checkpointId: "c", status: "ready", files: [], filesTotal: nil, repositories: [])
    model.update(turns: [turn], cwd: nil)
    model.load()
    await settle { model.selectedDiff?.value != nil }
    let diff = try #require(model.selectedDiff?.value)
    #expect(diff.files.map(\.path) == ["b.test.ts", "b.ts"])
    model.toggleViewed(diff.files[0])
    #expect(model.isViewed(diff.files[0]))
    #expect(!model.isViewed(diff.files[1]))
  }

  @Test("a truncated git section lists every file and reads one patch on demand; context expands")
  func lazyGitSection() async throws {
    let source = FakeReviewSource()
    let stats = [DiffPreviewSource.FileStat(path: "f.txt", additions: 2, deletions: 1)]
    source.previews[.workingTree] = DiffPreviewResult(
      cwd: "/w",
      sources: [DiffPreviewSource(id: "w", kind: .workingTree, title: "Uncommitted", baseRef: "HEAD", diff: "", diffHash: "h", truncated: true, files: stats)])
    source.patch = DiffPreviewSource(
      id: "w", kind: .workingTree, title: "Uncommitted", diff: "diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -3,3 +3,3 @@\n c\n-d\n+D\n e\n@@ -10,2 +10,3 @@\n j\n+J\n k\n",
      diffHash: "p")
    source.contents = ReviewTests.contents
    let model = ReviewModel(ref: Self.ref, source: source)
    model.update(turns: [], cwd: "/w")
    model.select(.git(.workingTree))
    await settle { model.selectedDiff?.value != nil }
    let file = try #require(model.selectedDiff?.value?.files.first)
    #expect(file.diff == nil && file.additions == 2)
    model.loadPatch(file)
    await settle { model.patch(file).value != nil }
    #expect(model.patch(file).value?.hunks.count == 2)
    #expect(model.canExpand)
    model.expand(1, in: file)
    await settle { model.fileContents(file)?.value != nil }
    #expect(model.fileContents(file)?.value?.count == 14)
    #expect(model.expandedGaps(file) == [1])
  }

  @Test("a refresh with a new diff drops the old patch, contents and expansion")
  func refreshDropsFileState() async throws {
    let source = FakeReviewSource()
    let stats = [DiffPreviewSource.FileStat(path: "f.txt", additions: 2, deletions: 1)]
    func preview(_ hash: String) -> DiffPreviewResult {
      DiffPreviewResult(
        cwd: "/w",
        sources: [DiffPreviewSource(id: "w", kind: .workingTree, title: "U", diff: "", diffHash: hash, truncated: true, files: stats)])
    }
    source.previews[.workingTree] = preview("one")
    source.patch = DiffPreviewSource(id: "w", kind: .workingTree, title: "U", diff: ReviewModelTests.patch, diffHash: "p")
    source.contents = ReviewTests.contents
    let model = ReviewModel(ref: Self.ref, source: source)
    model.update(turns: [], cwd: "/w")
    model.select(.git(.workingTree))
    await settle { model.selectedDiff?.value != nil }
    let file = try #require(model.selectedDiff?.value?.files.first)
    model.loadPatch(file)
    await settle { model.patch(file).value != nil }
    model.expand(1, in: file)
    await settle { model.fileContents(file)?.value != nil }
    source.previews[.workingTree] = preview("two")
    await model.refresh()
    await settle { model.selectedDiff?.value != nil }
    #expect(model.patch(file) == .loading)
    #expect(model.fileContents(file) == nil)
    #expect(model.expandedGaps(file).isEmpty)
  }

  static let patch =
    "diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -3,3 +3,3 @@\n c\n-d\n+D\n e\n@@ -10,2 +10,3 @@\n j\n+J\n k\n"

  @Test("a commit runs the stream, records a created branch and ends with the server's toast")
  func commit() async {
    let fake = FakeGitSource(VcsStatus(refName: "main", isDefaultRef: true, workingTree: .init(files: [.init(path: "a", insertions: 1, deletions: 0)])))
    fake.events = [
      .started(phases: ["branch", "commit"]), .phaseStarted(phase: "commit", label: "Committing"),
      .finished(GitStackedActionResult(action: .commit, branchCreated: "feature/update", toast: .init(title: "Committed"))),
    ]
    let model = GitModel(ref: Self.ref, source: fake, makeId: { "id-1" })
    model.update(cwd: "/w", worktreePath: nil)
    await model.refresh()
    #expect(model.quickAction == .run(.commitPush))
    #expect(GitActionRules.needsDefaultBranchConfirmation(.commitPush, status: model.status))
    await model.run(GitActionInput(.commit, commitMessage: "Tides", filePaths: ["a"], featureBranch: true))
    #expect(fake.requests.first?.featureBranch == true && fake.requests.first?.commitMessage == "Tides")
    #expect(fake.threadBranches == ["feature/update"])
    #expect(model.progress == .succeeded(.action(title: "Committed", description: nil)))
  }

  @Test("a failed action shows the server's message; a refused session runs nothing")
  func failure() async {
    let fake = FakeGitSource(VcsStatus(refName: "x", aheadCount: 1))
    fake.events = [.failed(phase: "push", message: "Rejected by remote")]
    let model = GitModel(ref: Self.ref, source: fake)
    model.update(cwd: "/w", worktreePath: nil)
    await model.run(GitActionInput(.push))
    #expect(model.progress == .failed(message: "Rejected by remote"))
    model.canWrite = false
    await model.run(GitActionInput(.push))
    #expect(fake.requests.count == 1)
  }

  @Test("feature branch then push: names a free branch, switches the thread, then pushes")
  func featureBranchPush() async {
    let fake = FakeGitSource(VcsStatus(refName: "main", isDefaultRef: true, aheadCount: 2))
    fake.branches = ["main", "feature/update"]
    fake.events = [.finished(GitStackedActionResult(action: .push, toast: .init(title: "Pushed")))]
    let model = GitModel(ref: Self.ref, source: fake)
    model.update(cwd: "/w", worktreePath: "/w")
    await model.runOnFeatureBranch(.push)
    #expect(fake.created == ["feature/update-2"])
    #expect(fake.threadBranches == ["feature/update-2"])
    #expect(fake.requests.map(\.action) == [.push])
  }
}
