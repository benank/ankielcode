import Foundation

/// A pending approval as the dock shows it (RN `ThreadPendingApproval`).
public struct PendingApproval: Sendable, Hashable, Identifiable {
  public var requestId: String
  /// `command`, `file-read`, `file-change`, `mcp-elicitation`, `permission`, or a newer kind.
  public var requestKind: String
  public var createdAt: WireTimestamp?
  /// What is being asked: the command line, the path, the tool call.
  public var detail: String?
  public var reason: String?
  /// `ask_rule` or `provider_check`: why full access still asked.
  public var fullAccessOverride: String?
  public var appName: String?
  /// The provider's choices. nil means it named none (use `ApprovalChoices.defaults`); an
  /// empty list means it offers none.
  public var options: [ApprovalOption]?
  /// Only a live provider session can take the answer.
  public var isLive: Bool
  public var supportsFeedback: Bool

  public var id: String { requestId }

  public init(
    requestId: String, requestKind: String, createdAt: WireTimestamp? = nil, detail: String? = nil, reason: String? = nil,
    fullAccessOverride: String? = nil, appName: String? = nil, options: [ApprovalOption]? = nil, isLive: Bool = true,
    supportsFeedback: Bool = false
  ) {
    self.requestId = requestId
    self.requestKind = requestKind
    self.createdAt = createdAt
    self.detail = detail
    self.reason = reason
    self.fullAccessOverride = fullAccessOverride
    self.appName = appName
    self.options = options
    self.isLive = isLive
    self.supportsFeedback = supportsFeedback
  }
}

/// A pending question set (RN `ThreadPendingUserInput`).
public struct PendingUserInput: Sendable, Hashable, Identifiable {
  public var requestId: String
  public var createdAt: WireTimestamp?
  public var questions: [UserInputQuestion]
  /// `live`, `message` or `not_resumable`.
  public var responseCapability: String
  /// The answer arrives as a message, so the user may dismiss the card instead of answering.
  public var dismissible: Bool

  public var id: String { requestId }
  public var canRespond: Bool { responseCapability != "not_resumable" }

  public init(
    requestId: String, createdAt: WireTimestamp? = nil, questions: [UserInputQuestion], responseCapability: String = "live",
    dismissible: Bool = false
  ) {
    self.requestId = requestId
    self.createdAt = createdAt
    self.questions = questions
    self.responseCapability = responseCapability
    self.dismissible = dismissible
  }
}

/// A pending secret prompt (`secret_request` item), answered with `secrets.answerRequest`.
public struct PendingSecret: Sendable, Hashable, Identifiable {
  public var itemId: String
  public var threadId: String
  public var label: String
  public var reason: String
  public var url: String?
  public var placeholder: String?
  public var delivery: String?
  public var fields: [TurnItemBody.SecretRequest.Field]?

  public var id: String { itemId }
}

/// Everything a thread waits on the user for.
public struct PendingThreadRequests: Sendable, Hashable {
  public var approvals: [PendingApproval]
  public var userInputs: [PendingUserInput]
  public var secrets: [PendingSecret]

  public init(approvals: [PendingApproval] = [], userInputs: [PendingUserInput] = [], secrets: [PendingSecret] = []) {
    self.approvals = approvals
    self.userInputs = userInputs
    self.secrets = secrets
  }

  public static let none = PendingThreadRequests()

  public var isEmpty: Bool { approvals.isEmpty && userInputs.isEmpty && secrets.isEmpty }
  public var count: Int { approvals.count + userInputs.count + secrets.count }
  public var requestIds: Set<String> { Set(approvals.map(\.requestId) + userInputs.map(\.requestId)) }
}

public enum PendingRequestDerivation {
  /// A port of `derivePendingThreadRequests`: every pending runtime request, in the projection's
  /// order, joined to its latest request item. An approval without an item still shows.
  public static func derive(_ projection: ThreadProjection) -> PendingThreadRequests {
    var result = PendingThreadRequests()
    let pending = projection.runtimeRequests.filter { $0.status == .pending }
    if !pending.isEmpty {
      var approvalItems: [String: TurnItemBody.ApprovalRequest] = [:]
      var inputItems: [String: TurnItemBody.UserInputRequest] = [:]
      for item in projection.turnItems {
        switch item.body {
        case .approvalRequest(let request): approvalItems[request.requestId] = request
        case .userInputRequest(let request): inputItems[request.requestId] = request
        default: continue
        }
      }
      for request in pending {
        let capability = request.responseCapability?.type ?? "not_resumable"
        if request.kind == "user_input" {
          guard let item = inputItems[request.id] else { continue }
          let message = item.responseMode == "message" || capability == "message"
          result.userInputs.append(PendingUserInput(
            requestId: request.id, createdAt: request.createdAt, questions: item.questions.elements,
            responseCapability: capability, dismissible: message))
          continue
        }
        if request.kind == "auth_refresh" || request.kind == "dynamic_tool_call" { continue }
        let item = approvalItems[request.id]
        result.approvals.append(PendingApproval(
          requestId: request.id, requestKind: request.kind, createdAt: request.createdAt,
          detail: item?.prompt?.nilIfBlank, reason: item?.reason?.nilIfBlank,
          fullAccessOverride: item?.fullAccessOverride, appName: item?.appName?.nilIfBlank,
          options: item?.options?.elements, isLive: capability == "live",
          supportsFeedback: capability == "live" && request.responseCapability?.supportsFeedback == true))
      }
    }
    for row in projection.visibleTurnItems where row.isLocal {
      guard case .secretRequest(let secret) = row.item.body, secret.secretStatus == "pending" else { continue }
      result.secrets.append(PendingSecret(
        itemId: row.item.id, threadId: row.item.threadId, label: secret.label, reason: secret.reason, url: secret.url,
        placeholder: secret.placeholder, delivery: secret.delivery, fields: secret.fields?.elements))
    }
    return result
  }

  /// How each request that left pending ended.
  public static func outcomes(_ projection: ThreadProjection) -> [String: RequestOutcome] {
    var outcomes: [String: RequestOutcome] = [:]
    for request in projection.runtimeRequests {
      switch request.status.known {
      case .pending?: continue
      case .resolved?: outcomes[request.id] = .resolved(decision: request.decision)
      case .expired?: outcomes[request.id] = .expired
      case .cancelled?: outcomes[request.id] = .cancelled
      case nil: outcomes[request.id] = .cancelled
      }
    }
    return outcomes
  }
}

/// How a request left pending.
public enum RequestOutcome: Sendable, Hashable {
  case resolved(decision: String?)
  case expired
  case cancelled
}

/// The choices an approval card offers.
public enum ApprovalChoices {
  /// RN's in-app defaults when the provider names none (`PendingApprovalCard`), which is also
  /// what `planAgentNotificationAction` checks a button against.
  public static let defaultDecisions = ["accept", "acceptForSession", "decline"]

  public static func options(_ approval: PendingApproval, labels: Labels = Labels()) -> [ApprovalOption] {
    approval.options ?? [
      ApprovalOption(decision: "accept", label: labels.allowOnce),
      ApprovalOption(decision: "acceptForSession", label: labels.allowSession),
      ApprovalOption(decision: "decline", label: labels.decline),
    ]
  }

  /// The first warning any option carries (RN shows one, above the buttons).
  public static func warning(_ options: [ApprovalOption]) -> String? {
    options.lazy.compactMap { $0.warning?.nilIfBlank }.first
  }

  public static func isAllow(_ decision: String) -> Bool { decision.hasPrefix("accept") }

  public struct Labels: Sendable {
    public var allowOnce = "Allow once"
    public var allowSession = "Allow session"
    public var decline = "Decline"
    public init(allowOnce: String = "Allow once", allowSession: String = "Allow session", decline: String = "Decline") {
      self.allowOnce = allowOnce
      self.allowSession = allowSession
      self.decline = decline
    }
  }
}

extension String {
  var nilIfBlank: String? { trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : self }
}
