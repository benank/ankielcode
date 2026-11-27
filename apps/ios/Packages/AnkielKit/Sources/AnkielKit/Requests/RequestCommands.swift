import Foundation

/// Answers to a pending request (`orchestration.dispatchCommand`, spec §7.6).
public struct RequestCommand: Sendable, Hashable, Encodable {
  public var commandId: CommandID
  public var threadId: String
  public var requestId: String
  public var reply: Reply

  public enum Reply: Sendable, Hashable {
    /// `runtime-request.respond` with a `ProviderApprovalDecision` and optional feedback.
    case decision(String, feedback: String? = nil)
    /// `runtime-request.respond` with answers keyed by question id.
    case answers([String: UserInputAnswer], attachments: [String: [ChatAttachment]] = [:])
    /// `thread.user-input.dismiss`: a message-mode question closed without an answer.
    case dismiss
  }

  public init(_ reply: Reply, threadId: String, requestId: String, commandId: CommandID = CommandID()) {
    self.reply = reply
    self.threadId = threadId
    self.requestId = requestId
    self.commandId = commandId
  }

  enum CodingKeys: String, CodingKey {
    case type, commandId, threadId, requestId, decision, feedback, answers, attachmentsByQuestionId
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    switch reply {
    case .dismiss: try c.encode("thread.user-input.dismiss", forKey: .type)
    case .decision, .answers: try c.encode("runtime-request.respond", forKey: .type)
    }
    try c.encode(commandId, forKey: .commandId)
    try c.encode(threadId, forKey: .threadId)
    try c.encode(requestId, forKey: .requestId)
    switch reply {
    case .decision(let decision, let feedback):
      try c.encode(decision, forKey: .decision)
      try c.encodeIfPresent(feedback, forKey: .feedback)
    case .answers(let answers, let attachments):
      try c.encode(answers, forKey: .answers)
      if !attachments.isEmpty { try c.encode(attachments, forKey: .attachmentsByQuestionId) }
    case .dismiss:
      break
    }
  }
}

/// `secrets.answerRequest` (`SecretRequestAnswerInput`). The value never reaches logs: this type
/// has no `description` that prints it and the RPC layer only traces method names.
public struct SecretAnswer: Sendable, Hashable, Encodable, CustomStringConvertible, CustomDebugStringConvertible {
  public var threadId: String
  public var turnItemId: String
  public var reply: Reply

  public enum Reply: Sendable, Hashable {
    /// A request without `fields`.
    case secret(String)
    /// A request with `fields`: one value per field name.
    case values([String: String])
    case decline
  }

  public init(threadId: String, turnItemId: String, reply: Reply) {
    self.threadId = threadId
    self.turnItemId = turnItemId
    self.reply = reply
  }

  public var description: String { "SecretAnswer(\(turnItemId))" }
  public var debugDescription: String { description }

  enum CodingKeys: String, CodingKey { case threadId, turnItemId, answer }
  enum AnswerKeys: String, CodingKey { case type, secret, values }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(threadId, forKey: .threadId)
    try c.encode(turnItemId, forKey: .turnItemId)
    var answer = c.nestedContainer(keyedBy: AnswerKeys.self, forKey: .answer)
    switch reply {
    case .secret(let secret):
      try answer.encode("save", forKey: .type)
      try answer.encode(secret, forKey: .secret)
    case .values(let values):
      try answer.encode("save", forKey: .type)
      try answer.encode(values, forKey: .values)
    case .decline:
      try answer.encode("decline", forKey: .type)
    }
  }

  public static let rpcTag = "secrets.answerRequest"
}

/// A port of `client-runtime/src/secretRequest.ts`: inputs, the answer, the privacy note.
public enum SecretRequestForm {
  public struct Input: Sendable, Hashable, Identifiable {
    /// The field name, or "" for a request without fields.
    public var key: String
    public var label: String
    public var placeholder: String?
    /// Masked, with a control to show it.
    public var secret: Bool
    public var id: String { key }
  }

  public static func inputs(_ request: PendingSecret) -> [Input] {
    guard let fields = request.fields else {
      return [Input(key: "", label: request.label, placeholder: request.placeholder, secret: true)]
    }
    return fields.map { Input(key: $0.name, label: $0.label, placeholder: $0.placeholder, secret: $0.secret != false) }
  }

  /// nil until every input has a value.
  public static func answer(_ request: PendingSecret, values: [String: String]) -> SecretAnswer? {
    let entries = inputs(request).map { ($0.key, (values[$0.key] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)) }
    guard !entries.contains(where: { $0.1.isEmpty }) else { return nil }
    let reply: SecretAnswer.Reply =
      request.fields == nil
      ? .secret(entries.first?.1 ?? "")
      : .values(Dictionary(entries, uniquingKeysWith: { first, _ in first }))
    return SecretAnswer(threadId: request.threadId, turnItemId: request.itemId, reply: reply)
  }

  public static func decline(_ request: PendingSecret) -> SecretAnswer {
    SecretAnswer(threadId: request.threadId, turnItemId: request.itemId, reply: .decline)
  }

  public enum Privacy: Sendable { case neverShown, fileOne, fileMany }

  /// A `file` request lets the agent's commands read the value, so the card must not promise more.
  public static func privacy(_ request: PendingSecret) -> Privacy {
    request.delivery != "file" ? .neverShown : request.fields == nil ? .fileOne : .fileMany
  }

  /// Only http(s), so an agent cannot make the card open another scheme. Falls back to the one
  /// distinct link in `reason`, for agents that put it there.
  public static func link(_ request: PendingSecret) -> URL? {
    if let raw = request.url { return web(URL(string: raw.trimmingCharacters(in: .whitespacesAndNewlines))) }
    guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else { return nil }
    let text = request.reason
    let links = detector.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap { web($0.url) }
    let distinct = Set(links.map { $0.absoluteString.hasSuffix("/") ? String($0.absoluteString.dropLast()) : $0.absoluteString })
    return distinct.count == 1 ? links.first : nil
  }

  private static func web(_ url: URL?) -> URL? {
    guard let url, let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https", url.host != nil else { return nil }
    return url
  }
}

extension EnvironmentRequestError {
  /// The server's message for a refused secret answer, only for the refusals RN shows as they are
  /// (`secretRequestFailureMessage`). Anything else could echo the typed value, so it gets none.
  public var secretRefusalMessage: String? {
    guard case .rejected(let message?, let tag?) = self, Self.secretRefusalTags.contains(tag) else { return nil }
    return message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : message
  }

  static let secretRefusalTags: Set<String> = ["SecretRequestError", "EnvironmentAuthorizationError"]
}
