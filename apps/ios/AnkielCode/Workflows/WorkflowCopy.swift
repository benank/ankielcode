import AnkielKit
import SwiftUI

/// RN's workflow copy (`client-runtime/workflows.ts`, `features/workflows`).
enum WorkflowCopy {
  static func word(_ word: WorkflowRunWord) -> String {
    switch word {
    case .needsYou: String(localized: "Needs you", comment: "workflow run status: it waits on a person")
    case .paused: String(localized: "Paused", comment: "workflow run status")
    case .working: String(localized: "Working", comment: "workflow run status")
    case .sleeping: String(localized: "Sleeping", comment: "workflow run status")
    case .waiting: String(localized: "Waiting", comment: "workflow run status")
    case .done: String(localized: "Done", comment: "workflow run status")
    case .stopped: String(localized: "Stopped", comment: "workflow run status")
    case .skipped: String(localized: "Skipped", comment: "workflow run status")
    case .cancelled: String(localized: "Cancelled", comment: "workflow run status")
    case .unknown: String(localized: "Unknown", comment: "workflow run status")
    }
  }

  static func now(_ now: WorkflowRunNow) -> String {
    switch now {
    case .asks(let question, let more):
      more > 0 ? String(localized: "Asks: \(question) and \(more) more") : String(localized: "Asks: \(question)")
    case .detail(let text), .result(let text): text
    case .stepFailed: String(localized: "A step failed")
    case .runningOwnSteps: String(localized: "Running its own steps")
    case .child(let title, let inner): "\(title): \(Self.now(inner))"
    case .agentWorking(let step): String(localized: "\(step) is working")
    case .sleepingAt(let step): String(localized: "Sleeping at \(step)")
    case .runsOne(let title): String(localized: "Runs \(title)")
    case .runsMany(let count): String(localized: "\(count) runs under way")
    case .waiting: String(localized: "Waiting", comment: "what a workflow run is doing now")
    case .waitingFor(let step): String(localized: "Waiting for \(step)")
    case .finished: String(localized: "Finished", comment: "what a workflow run is doing now")
    case .endedEarly: String(localized: "Ended early")
    }
  }

  static func tab(_ tab: WorkflowListTab) -> String {
    switch tab {
    case .needsYou: String(localized: "Needs you", comment: "tab, workflow runs waiting on the user")
    case .running: String(localized: "Running", comment: "tab, workflow runs under way")
    case .all: String(localized: "All", comment: "tab, all workflow runs")
    }
  }

  static func nothing(_ tab: WorkflowListTab) -> String {
    switch tab {
    case .needsYou: String(localized: "Nothing waits on you.")
    case .running: String(localized: "Nothing is running.")
    case .all: String(localized: "No runs yet.")
    }
  }

  static func tone(_ tone: WorkflowRunTone) -> Color? {
    switch tone {
    case .input: Palette.attention
    case .failed: Palette.danger
    case .working: Palette.working
    case .quiet, .done: nil
    }
  }

  static func describe(_ error: EnvironmentRequestError) -> String {
    switch error {
    case .notConnected: String(localized: "Not connected to this computer.")
    case .rejected(let message, _): message ?? String(localized: "The computer refused this.")
    case .failed(let message): message
    }
  }

  static func relative(_ stamp: WireTimestamp) -> String {
    stamp.date.map { $0.formatted(.relative(presentation: .named)) } ?? ""
  }
}

/// A workflow's two-letter mark.
struct WorkflowChip: View {
  let name: String

  var body: some View {
    Text(Workflows.chip(name))
      .font(Typography.caption2.weight(.bold))
      .foregroundStyle(Palette.textSecondary)
      .padding(.horizontal, Spacing.xs)
      .frame(minWidth: 24, minHeight: 20)
      .background(Palette.fill, in: .rect(cornerRadius: Radius.small - 2, style: .continuous))
      .accessibilityHidden(true)
  }
}

/// A run's state word with the thread list's light for it.
struct WorkflowStateWord: View {
  let state: (word: WorkflowRunWord, tone: WorkflowRunTone)
  var large = false

  var body: some View {
    HStack(spacing: Spacing.xs + 2) {
      if let color = WorkflowCopy.tone(state.tone) {
        Circle().fill(color).frame(width: 7, height: 7).accessibilityHidden(true)
      }
      Text(WorkflowCopy.word(state.word))
        .font((large ? Typography.subheadline : Typography.caption).weight(.medium))
        .foregroundStyle(Palette.textSecondary)
    }
  }
}
