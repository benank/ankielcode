import AnkielKit
import Observation
import SwiftUI

#if DEBUG
  /// Debug launch variables for the pull request screens (`apps/ios/README.md`). Fixtures are
  /// synthetic; every write goes to a fake sink that records it and never reaches a server.
  struct PullRequestDebug {
    /// `ANKIEL_DEBUG_PULL_REQUESTS`: `fixture`, `empty`, `signed-out`, `failing`, `readonly`.
    var fixture: String?
    /// `ANKIEL_DEBUG_PR_WRITES`: `fake` (accept), `fail`, `slow`, `refuse` (live reads, no writes).
    var writes: String?
    /// `ANKIEL_DEBUG_PR_OPEN`: what to open at launch.
    var open: String?

    static let current: PullRequestDebug? = {
      let environment = ProcessInfo.processInfo.environment
      let debug = PullRequestDebug(
        fixture: environment["ANKIEL_DEBUG_PULL_REQUESTS"], writes: environment["ANKIEL_DEBUG_PR_WRITES"],
        open: environment["ANKIEL_DEBUG_PR_OPEN"])
      return debug.fixture == nil && debug.writes == nil && debug.open == nil ? nil : debug
    }()

    var readOnly: Bool { fixture == "readonly" }

    @MainActor
    var fixtureSource: FixturePullRequestSource? {
      switch fixture {
      case "fixture", "readonly": FixturePullRequestSource()
      case "empty": FixturePullRequestSource(mode: .empty)
      case "signed-out": FixturePullRequestSource(mode: .signedOut)
      case "failing": FixturePullRequestSource(mode: .failing)
      default: nil
      }
    }

    /// Fixtures always write to a fake; live reads only with `refuse` (so nothing can be sent).
    @MainActor
    var sink: (any PullRequestSink)? {
      switch writes {
      case "fail": DebugPullRequestSink(mode: .refuse)
      case "slow": DebugPullRequestSink(mode: .hang)
      case "refuse": RefusingPullRequestSink()
      case "fake": DebugPullRequestSink(mode: .accept)
      default: fixture != nil ? DebugPullRequestSink(mode: .accept) : nil
      }
    }
  }

  /// Records writes like `RecordingPullRequestSink` and shows the last one (UI tests read it).
  @MainActor
  @Observable
  final class DebugPullRequestSink: PullRequestSink {
    private(set) var lastSent: String?
    private(set) var count = 0
    @ObservationIgnored private let recorder: RecordingPullRequestSink

    init(mode: RecordingPullRequestSink.Mode) {
      recorder = RecordingPullRequestSink(mode: mode)
    }

    func send(_ write: PullRequestWrite, in environmentId: String) async throws(PullRequestError) -> PullRequestSummary? {
      count += 1
      lastSent = "\(write.rpcTag) \(String(decoding: (try? write.payload()) ?? Data(), as: UTF8.self))"
      return try await recorder.send(write, in: environmentId)
    }
  }

  /// Refuses every write before it leaves the device: live reads against a real host account.
  @MainActor
  final class RefusingPullRequestSink: PullRequestSink {
    func send(_ write: PullRequestWrite, in environmentId: String) async throws(PullRequestError) -> PullRequestSummary? {
      throw .rejected(message: String(localized: "Writes are turned off in this debug launch.", comment: "debug: refusing sink"), tag: "Debug")
    }
  }

  /// The debug pill with the last write a fake sink recorded.
  struct PullRequestDebugSentPill: View {
    let sink: any PullRequestSink

    var body: some View {
      if let debug = sink as? DebugPullRequestSink, let sent = debug.lastSent {
        Text(verbatim: "\(debug.count) · \(sent)")
          .font(.caption2.monospaced())
          .lineLimit(1)
          .truncationMode(.tail)
          .padding(.horizontal, Spacing.sm)
          .padding(.vertical, Spacing.xxs)
          .background(Palette.fill, in: .capsule)
          .accessibilityIdentifier("pr.debug.sent")
          .accessibilityLabel(Text(verbatim: sent))
      }
    }
  }

  extension PullRequestFeature {
    /// Applies `ANKIEL_DEBUG_PR_OPEN` once the list exists: `list`, `pr:<n>`, `files:<n>`,
    /// `file:<n>:<path>`, `review:<n>`, `merge:<n>`, `comment:<n>`, `edit:<n>`, `reviewers:<n>`,
    /// `thread:<n>:<id>`, `link:<url>`, `routing`.
    func applyDebugOpen(app: AppModel) {
      guard let open = PullRequestDebug.current?.open else { return }
      let parts = open.split(separator: ":", maxSplits: 2).map(String.init)
      let environmentId = isFixture ? PullRequestFixtures.environmentId : (targets.first?.environmentId ?? "")
      func target(_ number: String?) -> PullRequestTarget? {
        guard let number = number.flatMap(Int.init) else { return nil }
        return PullRequestTarget(
          environmentId: environmentId, ref: PullRequestFixtures.ref(number),
          preview: PullRequestFixtures.entries.first { $0.number == number })
      }
      switch parts.first {
      case "list": openList()
      case "routing":
        openList()
        debugSheet = .routing
      case "link":
        openList()
        debugLink = String(open.dropFirst("link:".count))
      default:
        guard let target = target(parts.count > 1 ? parts[1] : nil) else { return }
        self.open(target)
        debugPreset = parts[0] == "pr" ? nil : (parts[0], parts.count > 2 ? parts[2] : nil)
      }
    }
  }
#endif
