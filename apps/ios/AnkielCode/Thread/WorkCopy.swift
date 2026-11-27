import AnkielKit
import Foundation

/// The thread screen's words for kit values. RN's English copy (`threadActivity.ts`,
/// `work-log/presentation.ts`) where it exists.
extension WorkActivity {
  var isReasoningRow: Bool { type == "reasoning" }
}

enum WorkCopy {
  static func display(_ display: Display) -> String {
    switch display {
    case .activity(let label): activity(label)
    case .summary(let summary): self.summary(summary)
    }
  }

  static func activity(_ label: ActivityLabel) -> String {
    switch label {
    case .command(let command): command
    case .program(let program, let lifecycle):
      switch lifecycle {
      case .inProgress: String(localized: "Running \(program)")
      case .failed: String(localized: "Failed \(program)")
      case .stopped: String(localized: "Stopped \(program)")
      case .completed, .idle: String(localized: "Ran \(program)")
      }
    case .thought(let line?, _): line
    case .thought(nil, let live):
      live ? String(localized: "Thinking") : String(localized: "Thought", comment: "noun, a reasoning step")
    case .changedFile(let path): String(localized: "Changed \(fileName(path))")
    case .changedFiles(let count): count == 1 ? String(localized: "Changed 1 file") : String(localized: "Changed \(count) files")
    case .read(let path?): String(localized: "Read \(fileName(path))")
    case .read(nil): String(localized: "Read a file")
    case .searchedCode(let pattern?): String(localized: "Searched for \(pattern)")
    case .searchedCode(nil): String(localized: "Searched files")
    case .searchedWeb(let query?): String(localized: "Searched the web for \(query)")
    case .searchedWeb(nil): String(localized: "Searched the web")
    case .tool(let name): name.isEmpty ? String(localized: "Tool call") : name
    case .titled(let title): title
    case .approvalRequested: String(localized: "Approval requested")
    case .inputRequested: String(localized: "Input requested")
    case .interruptRequested: String(localized: "Interrupt requested")
    case .interrupted: String(localized: "Run interrupted")
    case .checkpoint: String(localized: "Checkpoint captured")
    case .plan: String(localized: "Proposed plan")
    case .todo: String(localized: "Plan updated")
    case .providerError: String(localized: "Provider error")
    case .usageLimit: String(localized: "Usage limit reached")
    case .notice(let message): message
    case .compaction(let before?, let after?):
      String(localized: "Context compacted · \(tokens(before)) → \(tokens(after)) tokens")
    case .compaction: String(localized: "Context compacted")
    case .handoff(let model?): String(localized: "Context handed off to \(model)")
    case .handoff(nil): String(localized: "Context handed off")
    case .forked: String(localized: "Thread forked")
    case .threadCreated: String(localized: "Thread created")
    case .secret(let label): String(localized: "Secret requested: \(label)")
    case .link(let reason): reason
    case .subagent(let title?): title
    case .subagent(nil): String(localized: "Subagent")
    case .unknown(_, let title?): title
    case .unknown(let type, nil): String(localized: "Unsupported item (\(type))")
    }
  }

  /// `summarizeToolGroup`: up to two clauses, then "performed N other actions".
  static func summary(_ summary: WorkSummary) -> String {
    if let thoughts = summary.thoughts {
      return thoughts == 1
        ? String(localized: "Thought", comment: "noun, a reasoning step")
        : String(localized: "Thought (×\(thoughts))")
    }
    var labels = summary.clauses.map { clause($0.action, $0.count) }
    if summary.otherCount > 0 {
      labels.append(
        summary.otherCount == 1
          ? String(localized: "Performed 1 other action")
          : String(localized: "Performed \(summary.otherCount) other actions"))
    }
    let sentence = labels.enumerated().map { index, label in
      index == 0 ? label : label.prefix(1).lowercased() + label.dropFirst()
    }
    return ListFormatter.localizedString(byJoining: sentence)
  }

  static func clause(_ action: WorkAction, _ count: Int) -> String {
    let one = count == 1
    return switch action {
    case .read: one ? String(localized: "Read 1 file") : String(localized: "Read \(count) files")
    case .edit: one ? String(localized: "Changed 1 file") : String(localized: "Changed \(count) files")
    case .command: one ? String(localized: "Ran 1 command") : String(localized: "Ran \(count) commands")
    case .search:
      one ? String(localized: "Searched the web 1 time") : String(localized: "Searched the web \(count) times")
    case .codeSearch: one ? String(localized: "Searched code 1 time") : String(localized: "Searched code \(count) times")
    case .threadCreate: one ? String(localized: "Created 1 thread") : String(localized: "Created \(count) threads")
    case .other: one ? String(localized: "Used 1 tool") : String(localized: "Used \(count) tools")
    case .update: one ? String(localized: "Received 1 update") : String(localized: "Received \(count) updates")
    }
  }

  static func fold(_ label: RunFoldRow.Label) -> String {
    switch label {
    case .worked(let seconds?): String(localized: "Worked for \(duration(seconds))")
    case .worked(nil): String(localized: "Worked")
    case .stopped(let seconds?): String(localized: "You stopped after \(duration(seconds))")
    case .stopped(nil): String(localized: "You stopped this response")
    case .earlierWork: String(localized: "Earlier work")
    }
  }

  /// "45s", "2m 4s", "1h 3m".
  static func duration(_ seconds: Int) -> String {
    Duration.seconds(max(0, seconds)).formatted(
      .units(allowed: [.hours, .minutes, .seconds], width: .narrow, maximumUnitCount: 2))
  }

  /// "549K", "16.8K", "1.2M".
  static func tokens(_ count: Int) -> String {
    count.formatted(.number.notation(.compactName).precision(.significantDigits(1...3)))
  }

  static func fileName(_ path: String) -> String {
    path.split(separator: "/").last.map(String.init) ?? path
  }

  static func status(_ status: ThreadDetailStatus) -> String? {
    switch status {
    case .idle: nil
    case .working: String(localized: "Working", comment: "thread status")
    case .waiting: String(localized: "Waiting", comment: "thread status")
    case .failed: String(localized: "Failed", comment: "thread status")
    case .stopped: String(localized: "Stopped", comment: "thread status, the user stopped the turn")
    }
  }

  static func symbol(_ kind: WorkKind) -> String {
    switch kind {
    case .command: "terminal"
    case .edit: "pencil"
    case .read: "doc.text"
    case .search: "magnifyingglass"
    case .web: "globe"
    case .tool: "wrench.and.screwdriver"
    case .thinking: "lightbulb"
    case .agent: "person.2"
    case .approval: "hand.raised"
    case .question: "questionmark.bubble"
    case .notice: "info.circle"
    case .warning: "exclamationmark.triangle"
    case .error: "exclamationmark.octagon"
    case .stop: "stop.circle"
    case .check: "checkmark.circle"
    case .plan: "list.bullet.clipboard"
    case .link: "link"
    case .lock: "lock"
    case .unknown: "square.dashed"
    }
  }
}
