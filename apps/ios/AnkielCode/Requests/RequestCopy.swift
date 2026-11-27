import AnkielKit
import Foundation

/// User-facing words for pending requests, reusing the RN app's copy where it has some.
enum RequestCopy {
  /// RN `APPROVAL_REQUEST_LABEL`.
  static func approvalTitle(_ kind: String) -> String {
    switch kind {
    case "command": String(localized: "Command approval")
    case "file-change": String(localized: "File change approval")
    case "file-read": String(localized: "File read approval")
    case "permission": String(localized: "App permission approval")
    case "mcp-elicitation": String(localized: "App access approval")
    default: String(localized: "Approval requested")
    }
  }

  static func approvalSymbol(_ kind: String) -> String {
    switch kind {
    case "command": "terminal"
    case "file-change": "pencil.line"
    case "file-read": "doc.text.magnifyingglass"
    case "permission": "lock.shield"
    case "mcp-elicitation": "puzzlepiece.extension"
    default: "hand.raised"
    }
  }

  static var labels: ApprovalChoices.Labels {
    ApprovalChoices.Labels(
      allowOnce: String(localized: "Allow once"), allowSession: String(localized: "Allow session"),
      decline: String(localized: "Decline", comment: "verb, rejects the approval request"))
  }

  static let fullAccessQuestion = String(localized: "Why am I being asked this?")

  static func fullAccessExplanation(_ override: String) -> String {
    override == "ask_rule"
      ? String(localized: "Full access skips approvals, but an ask rule in the agent's own settings matches this action, so it still asks. Remove or narrow that rule to stop these prompts.")
      : String(localized: "Full access skips approvals, but the agent still stops for a few safety checks of its own that no setting can skip, such as a delete whose path it can't verify. Ankiel Code can't turn these off, so check the request and approve it if it's what you expect.")
  }

  static let notResumable = String(localized: "The provider process for this request is no longer available. Interrupt or restart the run to continue.")

  static func failure(_ error: EnvironmentRequestError, fallback: String) -> String {
    switch error {
    case .notConnected: String(localized: "Not connected to the computer. Try again when it is back.")
    case .rejected(let message, _): message.flatMap { $0.isEmpty ? nil : $0 } ?? fallback
    case .failed: fallback
    }
  }

  static func notice(_ outcome: RequestOutcome) -> String {
    switch outcome {
    case .resolved: String(localized: "Answered on another device")
    case .expired: String(localized: "This request expired")
    case .cancelled: String(localized: "This request was cancelled")
    }
  }

  static func confirmation(_ kind: PendingRequestController.Confirmation.Kind) -> (title: String, detail: String?, symbol: String) {
    switch kind {
    case .allowed(let label): (String(localized: "Allowed"), label.isEmpty ? nil : label, "checkmark.circle.fill")
    case .declined: (String(localized: "Declined", comment: "an approval was declined"), nil, "xmark.circle.fill")
    case .answered: (String(localized: "Answer sent"), nil, "checkmark.circle.fill")
    case .dismissed: (String(localized: "Dismissed"), nil, "minus.circle.fill")
    case .saved: (String(localized: "Saved securely and kept private"), nil, "checkmark.shield.fill")
    case .secretDeclined: (String(localized: "Declined", comment: "a secret request was declined"), nil, "minus.circle.fill")
    }
  }
}
