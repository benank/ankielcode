import AnkielKit
import Foundation

/// Debug-only review and git state (README, "Review"). `ANKIEL_DEBUG_REVIEW=fixture` (or
/// `readonly`, a session that may not write) gives every thread canned turns, comparisons and a
/// fake checkout about a made-up tide-chart app; nothing reaches a server. `ANKIEL_DEBUG_REVIEW_OPEN`
/// opens, once per launch, in the thread the launch shows: `review`, `review:<section id>`,
/// `file:<path>`, `git`, `commit` or `confirm`; live threads too.
@MainActor
enum ReviewDebug {
  #if DEBUG
    static var environment: [String: String] { ProcessInfo.processInfo.environment }
    static var readOnly: Bool { environment["ANKIEL_DEBUG_REVIEW"] == "readonly" }
    private static var applied = false
    private static var fixtures: [String: Fixture] = [:]

    struct Fixture {
      let turns: [TurnChange]
      let cwd: String
      let review: FixtureReviewSource
      let git: FixtureGitSource
    }

    static func fixture(_ ref: ThreadRef) -> Fixture? {
      guard let mode = environment["ANKIEL_DEBUG_REVIEW"], mode == "fixture" || mode == "readonly" else { return nil }
      if let fixture = fixtures[ref.key] { return fixture }
      let fixture = Fixture(
        turns: ReviewFixtures.turns, cwd: "/Users/dev/tide-chart", review: FixtureReviewSource(), git: FixtureGitSource())
      fixtures[ref.key] = fixture
      return fixture
    }

    static var openConfirm: Bool { environment["ANKIEL_DEBUG_REVIEW_OPEN"] == "confirm" }
    static var openCommit: Bool { environment["ANKIEL_DEBUG_REVIEW_OPEN"] == "commit" }
    /// `ANKIEL_DEBUG_REVIEW_EXPAND=1`: a git section's file opens with every gap expanded.
    static var expandAll: Bool { environment["ANKIEL_DEBUG_REVIEW_EXPAND"] == "1" }

    static func apply(to presenter: ReviewPresenter) {
      guard !applied, let value = environment["ANKIEL_DEBUG_REVIEW_OPEN"] else { return }
      applied = true
      Task {
        // A live thread's turns and checkout arrive with its stream and the shell.
        for _ in 0..<50 where presenter.review.turns.isEmpty && presenter.review.cwd == nil {
          try? await Task.sleep(for: .milliseconds(100))
        }
        if value == "review" {
          presenter.openReview()
        } else if value.hasPrefix("review:") {
          presenter.openReview(section: ReviewSectionID(rawValue: String(value.dropFirst(7))))
        } else if value.hasPrefix("file:") {
          // `file:<path>` or `file:<path>@<section id>`.
          let parts = value.dropFirst(5).split(separator: "@", maxSplits: 1).map(String.init)
          let section = parts.count > 1 ? ReviewSectionID(rawValue: parts[1]) : ReviewFixtures.section(containing: parts[0])
          presenter.openReview(section: section, path: parts[0])
        } else if value == "git" || value == "commit" || value == "confirm" {
          presenter.openGit()
        }
      }
    }
  #else
    static let readOnly = false
    static let openConfirm = false
    static let openCommit = false
    static let expandAll = false
  #endif
}

#if DEBUG
  /// Turns and comparisons of the fixture checkout.
  @MainActor
  final class FixtureReviewSource: ReviewSource {
    func turnDiff(threadId: String, turn: Int) async throws -> ThreadTurnDiff {
      try? await Task.sleep(for: .milliseconds(150))
      return ThreadTurnDiff(threadId: threadId, fromTurnCount: turn - 1, toTurnCount: turn, diff: ReviewFixtures.turnDiffs[turn] ?? "")
    }

    func preview(
      cwd: String, kind: ReviewGitKind, partial: @escaping @Sendable (DiffPreviewResult) async -> Void
    ) async throws -> DiffPreviewResult {
      try? await Task.sleep(for: .milliseconds(200))
      let source: DiffPreviewSource =
        switch kind {
        case .workingTree:
          DiffPreviewSource(
            id: "working-tree", kind: .workingTree, title: "Uncommitted", baseRef: "HEAD", diff: ReviewFixtures.workingTree,
            diffHash: "fixture-wt")
        case .branchRange:
          DiffPreviewSource(
            id: "branch-range", kind: .branchRange, title: "Changes vs origin/main", baseRef: "origin/main", headRef: "main",
            diff: ReviewFixtures.workingTree + ReviewFixtures.turnThreeRest, diffHash: "fixture-br")
        }
      return DiffPreviewResult(cwd: cwd, sources: [source])
    }

    func filePatch(cwd: String, source: DiffPreviewSource, file: DiffPreviewSource.FileStat) async throws -> DiffPreviewSource? { nil }

    func fileContents(cwd: String, source: DiffPreviewSource, file: DiffFile) async throws -> DiffFileContents? {
      try? await Task.sleep(for: .milliseconds(250))
      guard file.path == ReviewFixtures.chartPath else { return nil }
      return DiffFileContents(
        oldContents: ReviewFixtures.chartOld.joined(separator: "\n") + "\n", newContents: ReviewFixtures.chartNew.joined(separator: "\n") + "\n")
    }
  }

  /// A checkout on its default branch with uncommitted changes: Commit & push asks first.
  @MainActor
  final class FixtureGitSource: GitSource {
    var current = VcsStatus(
      refName: "main", isDefaultRef: true,
      workingTree: .init(files: [
        .init(path: ReviewFixtures.chartPath, insertions: 6, deletions: 4),
        .init(path: "Sources/TideKit/Moon.swift", insertions: 22, deletions: 0),
        .init(path: "README.md", insertions: 2, deletions: 1),
      ]), hasUpstream: true, aheadCount: 0, behindCount: 0)

    func status(cwd: String) async throws -> VcsStatus { current }

    func pull(cwd: String) async throws -> VcsPullResult {
      try? await Task.sleep(for: .milliseconds(600))
      current.behindCount = 0
      return try JSONDecoder().decode(VcsPullResult.self, from: Data(#"{"status":"pulled","refName":"main"}"#.utf8))
    }

    func run(_ request: GitStackedActionRequest) async throws -> AsyncThrowingStream<GitActionProgress, any Error> {
      let action = request.action
      let branch = request.featureBranch == true ? "feature/update" : nil
      return AsyncThrowingStream { continuation in
        Task { @MainActor in
          continuation.yield(.started(phases: ["commit", "push"]))
          for label in ["Committing…", "Pushing…"] {
            continuation.yield(.phaseStarted(phase: "commit", label: label))
            try? await Task.sleep(for: .milliseconds(700))
          }
          if action.includesCommit { self.current.workingTree = .init() ; self.current.hasWorkingTreeChanges = false }
          continuation.yield(
            .finished(
              GitStackedActionResult(
                action: action, branchCreated: branch,
                toast: .init(title: action.includesCommit ? "Committed 3f2a91c" : "Pushed main", description: "Fix the tide chart scale"))))
          continuation.finish()
        }
      }
    }

    func localBranches(cwd: String) async throws -> [String] { ["main"] }
    func createBranch(cwd: String, name: String) async throws -> String { name }
    func setThreadBranch(threadId: String, branch: String, worktreePath: String?) async throws { current.refName = branch }
  }

  /// Synthetic patches about a made-up tide-chart app (no real project).
  enum ReviewFixtures {
    static let chartPath = "Sources/TideKit/TideChart.swift"

    static let turns: [TurnChange] = [
      TurnChange(
        turnCount: 3, runId: "fixture-run-3", checkpointId: "c3", status: "ready",
        files: [.init(path: chartPath, additions: 6, deletions: 4)], filesTotal: .init(count: 8, additions: 70, deletions: 21),
        repositories: []),
      TurnChange(
        turnCount: 2, runId: "fixture-run-2", checkpointId: "c2", status: "ready",
        files: [.init(path: "Data/stations.csv", additions: 5000, deletions: 0)], filesTotal: nil, repositories: []),
      TurnChange(
        turnCount: 1, runId: "fixture-run-1", checkpointId: "c1", status: "ready",
        files: [.init(path: "README.md", additions: 2, deletions: 1)], filesTotal: nil, repositories: []),
    ]

    static func section(containing path: String) -> ReviewSectionID? {
      for (turn, diff) in turnDiffs.sorted(by: { $0.key > $1.key }) where diff.contains("b/\(path)") { return .turn(turn) }
      return nil
    }

    // The chart file, before and after: changes at lines 9-11, 41 and 78.
    static let chartOld: [String] = (1...96).map { chartLine($0) }
    static let chartNew: [String] = {
      var lines = chartOld
      lines[77] = "    return points.map { CGPoint(x: $0.time, y: $0.height * scale) }"
      lines.insert("  /// Metres per point at the current zoom.", at: 41)
      lines[40] = "  var scale: Double = 1.5"
      lines.replaceSubrange(8...10, with: [
        "  let stations: [Station]", "  let range: ClosedRange<Date>", "  let units: HeightUnit = .metres", "  let datum: Datum",
      ])
      return lines
    }()

    static func chartLine(_ number: Int) -> String {
      switch number {
      case 1: "import SwiftUI"
      case 3: "/// Draws a station's tides for a day."
      case 4: "struct TideChart: View {"
      case 9: "  let station: Station"
      case 10: "  let range: ClosedRange<Date>"
      case 11: "  let units: HeightUnit = .feet"
      case 41: "  var scale: Double = 1.0"
      case 78: "    return points.map { CGPoint(x: $0.time, y: $0.height) }"
      case 96: "}"
      default: number % 7 == 0 ? "" : "  // tide step \(number): interpolate between readings"
      }
    }

    /// A unified diff of `chartOld` → `chartNew`, built from the same edits.
    static var chartDiff: String {
      """
      diff --git a/\(chartPath) b/\(chartPath)
      index 4b1c2d3..9e8f7a6 100644
      --- a/\(chartPath)
      +++ b/\(chartPath)
      @@ -6,9 +6,10 @@ struct TideChart: View {
       \(chartOld[5])
       \(chartOld[6])
       \(chartOld[7])
      -\(chartOld[8])
      -\(chartOld[9])
      -\(chartOld[10])
      +\(chartNew[8])
      +\(chartNew[9])
      +\(chartNew[10])
      +\(chartNew[11])
       \(chartOld[11])
       \(chartOld[12])
       \(chartOld[13])
      @@ -38,7 +39,8 @@ struct TideChart: View {
       \(chartOld[37])
       \(chartOld[38])
       \(chartOld[39])
      -\(chartOld[40])
      +\(chartNew[41])
      +\(chartNew[42])
       \(chartOld[41])
       \(chartOld[42])
       \(chartOld[43])
      @@ -75,7 +77,7 @@ func points(for readings: [Reading]) -> [CGPoint] {
       \(chartOld[74])
       \(chartOld[75])
       \(chartOld[76])
      -\(chartOld[77])
      +\(chartNew[79])
       \(chartOld[78])
       \(chartOld[79])
       \(chartOld[80])

      """
    }

    static var workingTree: String {
      chartDiff + """
        diff --git a/README.md b/README.md
        index 1111111..2222222 100644
        --- a/README.md
        +++ b/README.md
        @@ -1,4 +1,5 @@
         # Tide chart
        -Shows tides for one station.
        +Shows tides for every station you follow.
        +Heights are in metres by default.

         ## Build

        """
    }

    /// Turn 3 without the chart file (the branch comparison adds it from the working tree).
    static var turnThreeRest: String { String(turnDiffs[3, default: ""].dropFirst(chartDiff.count)) }

    static let turnDiffs: [Int: String] = [
      3: chartDiff + """
        diff --git a/Sources/TideKit/Moon.swift b/Sources/TideKit/Moon.swift
        new file mode 100644
        index 0000000..a1b2c3d
        --- /dev/null
        +++ b/Sources/TideKit/Moon.swift
        @@ -0,0 +1,22 @@
        +import Foundation
        +
        +/// The moon's phase drives spring and neap tides.
        +enum MoonPhase: CaseIterable {
        +  case new, waxingCrescent, firstQuarter, waxingGibbous
        +  case full, waningGibbous, lastQuarter, waningCrescent
        +
        +  /// Days into the synodic month.
        +  static func phase(on date: Date) -> MoonPhase {
        +    let days = date.timeIntervalSince(reference) / 86_400
        +    let age = days.truncatingRemainder(dividingBy: synodicMonth)
        +    let index = Int((age / synodicMonth) * 8) % 8
        +    return allCases[index]
        +  }
        +
        +  static let synodicMonth = 29.530588
        +  static let reference = Date(timeIntervalSince1970: 947_182_440)
        +
        +  var isSpringTide: Bool { self == .new || self == .full }
        +  var isNeapTide: Bool { self == .firstQuarter || self == .lastQuarter }
        +}
        +
        diff --git a/Sources/TideKit/Legacy.swift b/Sources/TideKit/Legacy.swift
        deleted file mode 100644
        index 5d6e7f8..0000000
        --- a/Sources/TideKit/Legacy.swift
        +++ /dev/null
        @@ -1,6 +0,0 @@
        -// Kept for the old widget.
        -struct LegacyTide {
        -  var feet: Double
        -  var metres: Double { feet * 0.3048 }
        -}
        -
        diff --git a/Sources/TideKit/Station.swift b/Sources/TideKit/Harbor.swift
        similarity index 82%
        rename from Sources/TideKit/Station.swift
        rename to Sources/TideKit/Harbor.swift
        index 0a0a0a0..0b0b0b0 100644
        --- a/Sources/TideKit/Station.swift
        +++ b/Sources/TideKit/Harbor.swift
        @@ -1,5 +1,5 @@
        -struct Station: Identifiable {
        +struct Harbor: Identifiable {
           let id: String
           let name: String
        -  let latitude: Double
        +  let coordinate: Coordinate
         }
        diff --git a/Assets/icon.png b/Assets/icon.png
        new file mode 100644
        index 0000000..7f7f7f7
        Binary files /dev/null and b/Assets/icon.png differ
        diff --git a/scripts/build.sh b/scripts/build.sh
        old mode 100644
        new mode 100755
        diff --git a/Tests/TideKitTests/TideChartTests.swift b/Tests/TideKitTests/TideChartTests.swift
        index 3c3c3c3..4d4d4d4 100644
        --- a/Tests/TideKitTests/TideChartTests.swift
        +++ b/Tests/TideKitTests/TideChartTests.swift
        @@ -10,4 +10,4 @@ struct TideChartTests {
           @Test func scale() {
        -    #expect(TideChart.preview.scale == 1.0)
        +    #expect(TideChart.preview.scale == 1.5)
           }
         }
        diff --git a/web/pnpm-lock.yaml b/web/pnpm-lock.yaml
        index 1212121..3434343 100644
        --- a/web/pnpm-lock.yaml
        +++ b/web/pnpm-lock.yaml
        @@ -1,3 +1,3 @@
         lockfileVersion: '9.0'
        -  tide-chart: 1.0.0
        +  tide-chart: 1.1.0
         settings: {}

        """,
      2: largeDiff,
      1: """
        diff --git a/README.md b/README.md
        index 0000001..1111111 100644
        --- a/README.md
        +++ b/README.md
        @@ -1,3 +1,4 @@
         # Tide chart
        -Shows tides.
        +Shows tides for one station.
        +
         ## Build

        """,
    ]

    /// 5,000 added lines: the large-diff placeholder and the scrolling check.
    static let largeDiff: String = {
      var text = """
        diff --git a/Data/stations.csv b/Data/stations.csv
        new file mode 100644
        index 0000000..5a5a5a5
        --- /dev/null
        +++ b/Data/stations.csv
        @@ -0,0 +1,5000 @@

        """
      text.reserveCapacity(400_000)
      for index in 1...5000 {
        let latitude = Double(index % 180) - 89.5
        let longitude = Double(index * 7 % 360) - 179.5
        text += "+station-\(index),Harbor \(index),\(latitude),\(longitude),\(index % 3 == 0 ? "semidiurnal" : "diurnal"),\(Double(index % 97) / 10)\n"
      }
      return text
    }()
  }
#endif
