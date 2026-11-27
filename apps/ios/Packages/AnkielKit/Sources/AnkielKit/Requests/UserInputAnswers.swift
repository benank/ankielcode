import Foundation

/// One question's draft (RN `PendingUserInputDraftAnswer`).
public struct UserInputDraft: Sendable, Hashable {
  public var selectedOptionValues: [String]?
  public var customAnswer: String?
  public var attachmentCount: Int
  /// Attachments are still preparing or uploading, so the answer cannot go yet.
  public var attachmentsBlocked: Bool

  public init(
    selectedOptionValues: [String]? = nil, customAnswer: String? = nil, attachmentCount: Int = 0, attachmentsBlocked: Bool = false
  ) {
    self.selectedOptionValues = selectedOptionValues
    self.customAnswer = customAnswer
    self.attachmentCount = attachmentCount
    self.attachmentsBlocked = attachmentsBlocked
  }
}

/// A question's answer on the wire: one string, or the chosen values of a multi-select.
public enum UserInputAnswer: Sendable, Hashable, Encodable {
  case text(String)
  case choices([String])

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .text(let text): try container.encode(text)
    case .choices(let values): try container.encode(values)
    }
  }
}

/// A port of `client-runtime/src/state/pendingUserInput.ts` plus `seedUserInputDraftAnswers`.
public enum UserInputAnswers {
  /// What tapping an option sends: its `value`, else its trimmed label.
  public static func optionValue(_ option: UserInputQuestion.Option) -> String {
    option.value ?? option.label.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private static func normalized(_ value: String?) -> String? {
    guard let value else { return nil }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }

  /// Provider values stay exact, whitespace included; only options without a value match by label.
  private static func resolve(_ question: UserInputQuestion, _ value: String) -> String? {
    let options = question.options.elements
    if options.contains(where: { $0.value == value }) { return value }
    let label = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !label.isEmpty,
      options.contains(where: { $0.value == nil && $0.label.trimmingCharacters(in: .whitespacesAndNewlines) == label })
    else { return nil }
    return label
  }

  /// The draft's selections that name an offered option, deduplicated, in selection order.
  public static func selectedValues(_ question: UserInputQuestion, _ values: [String]?) -> [String] {
    var seen = Set<String>()
    return (values ?? []).compactMap { resolve(question, $0) }.filter { seen.insert($0).inserted }
  }

  /// The answer to submit for one question, or nil while it is unanswered.
  public static func answer(_ question: UserInputQuestion, _ draft: UserInputDraft?) -> UserInputAnswer? {
    if draft?.attachmentsBlocked == true { return nil }
    let custom: String? =
      question.allowCustomAnswer == false
      ? nil
      : question.initialAnswer != nil ? draft?.customAnswer : normalized(draft?.customAnswer)
    if let custom, !custom.isEmpty { return .text(custom) }
    if question.required == false, question.options.elements.isEmpty { return .text("") }

    let selected = selectedValues(question, draft?.selectedOptionValues)
    let fallback: String? =
      custom ?? (question.allowCustomAnswer != false && (draft?.attachmentCount ?? 0) > 0 ? "" : nil)
    if question.multiSelect == true {
      // Checking nothing answers "none of these" unless the provider requires a choice.
      if !selected.isEmpty { return .choices(selected) }
      if let fallback { return .text(fallback) }
      return question.required == true ? nil : .choices([])
    }
    if let first = selected.first { return .text(first) }
    return fallback.map(UserInputAnswer.text)
  }

  public static func settingCustomAnswer(_ question: UserInputQuestion, _ draft: UserInputDraft?, _ text: String) -> UserInputDraft {
    guard question.allowCustomAnswer != false else { return draft ?? UserInputDraft() }
    let keep =
      question.initialAnswer != nil || !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      ? nil : selectedValues(question, draft?.selectedOptionValues)
    var next = UserInputDraft(customAnswer: text)
    if let keep, !keep.isEmpty { next.selectedOptionValues = keep }
    next.attachmentCount = draft?.attachmentCount ?? 0
    next.attachmentsBlocked = draft?.attachmentsBlocked ?? false
    return next
  }

  public static func isSelected(_ question: UserInputQuestion, _ draft: UserInputDraft?, _ value: String) -> Bool {
    if question.allowCustomAnswer != false, normalized(draft?.customAnswer) != nil { return false }
    guard let resolved = resolve(question, value) else { return false }
    return selectedValues(question, draft?.selectedOptionValues).contains(resolved)
  }

  /// Toggles an offered option; an unknown option leaves the draft as it was.
  public static func toggling(_ question: UserInputQuestion, _ draft: UserInputDraft?, _ value: String) -> UserInputDraft {
    guard let resolved = resolve(question, value) else { return draft ?? UserInputDraft() }
    var next = UserInputDraft(customAnswer: "")
    next.attachmentCount = draft?.attachmentCount ?? 0
    next.attachmentsBlocked = draft?.attachmentsBlocked ?? false
    if question.multiSelect == true {
      var selected = selectedValues(question, draft?.selectedOptionValues)
      if let index = selected.firstIndex(of: resolved) { selected.remove(at: index) } else { selected.append(resolved) }
      next.selectedOptionValues = selected.isEmpty ? nil : selected
    } else {
      next.selectedOptionValues = [resolved]
    }
    return next
  }

  /// Every question's answer keyed by id, or nil while any is unanswered.
  public static func answers(_ questions: [UserInputQuestion], _ drafts: [String: UserInputDraft]) -> [String: UserInputAnswer]? {
    var result: [String: UserInputAnswer] = [:]
    for question in questions {
      guard let answer = answer(question, drafts[question.id]) else { return nil }
      result[question.id] = answer
    }
    return result
  }

  /// Suggested answers show until the user edits them; only edits are stored.
  public static func seeded(_ questions: [UserInputQuestion], _ drafts: [String: UserInputDraft]) -> [String: UserInputDraft] {
    var result = drafts
    for question in questions where question.initialAnswer != nil && question.allowCustomAnswer != false && drafts[question.id] == nil {
      result[question.id] = UserInputDraft(customAnswer: question.initialAnswer)
    }
    return result
  }
}
