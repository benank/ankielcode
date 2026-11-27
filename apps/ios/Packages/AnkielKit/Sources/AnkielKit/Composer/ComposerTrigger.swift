import Foundation

/// What the word before the caret asks the composer to complete (`shared/composerTrigger.ts`).
/// Offsets are UTF-16, like the JS ranges RN sends and `NSRange` in UIKit.
public struct ComposerTrigger: Sendable, Hashable {
  public enum Kind: String, Sendable {
    case path, pullRequest, slashCommand, skill
  }

  public var kind: Kind
  public var query: String
  public var rangeStart: Int
  public var rangeEnd: Int

  public init(kind: Kind, query: String, rangeStart: Int, rangeEnd: Int) {
    self.kind = kind
    self.query = query
    self.rangeStart = rangeStart
    self.rangeEnd = rangeEnd
  }

  /// `detectComposerTrigger`: the token from the last whitespace to the caret.
  public static func detect(_ text: String, cursor: Int) -> ComposerTrigger? {
    let source = text as NSString
    let cursor = max(0, min(source.length, cursor))
    var index = cursor - 1
    while index >= 0, !isWhitespace(source.character(at: index)) { index -= 1 }
    let tokenStart = index + 1
    let token = source.substring(with: NSRange(location: tokenStart, length: cursor - tokenStart))
    if token.hasPrefix("/") {
      if isPathWord(source, wordStart: tokenStart, cursor: cursor) { return nil }
      return ComposerTrigger(kind: .slashCommand, query: String(token.dropFirst()), rangeStart: tokenStart, rangeEnd: cursor)
    }
    if let pullRequest = pullRequestTrigger(token, cursor: cursor) { return pullRequest }
    if let prefix = token.unicodeScalars.first, prefix.properties.generalCategory == .currencySymbol {
      let query = String(token.unicodeScalars.dropFirst())
      if isCurrencyAmount(query) { return nil }
      return ComposerTrigger(kind: .skill, query: query, rangeStart: tokenStart, rangeEnd: cursor)
    }
    guard token.hasPrefix("@") else { return nil }
    return ComposerTrigger(kind: .path, query: String(token.dropFirst()), rangeStart: tokenStart, rangeEnd: cursor)
  }

  /// `replaceTextRange`: the new text and the caret just after the replacement.
  public static func replace(_ text: String, start: Int, end: Int, with replacement: String) -> (text: String, cursor: Int) {
    let source = text as NSString
    let safeStart = max(0, min(source.length, start))
    let safeEnd = max(safeStart, min(source.length, end))
    let next = source.replacingCharacters(in: NSRange(location: safeStart, length: safeEnd - safeStart), with: replacement)
    return (next, safeStart + (replacement as NSString).length)
  }

  static func isWhitespace(_ unit: unichar) -> Bool {
    unit == 0x20 || unit == 0x0A || unit == 0x09 || unit == 0x0D
  }

  /// A second slash or backslash makes the whole word a path, even when the caret precedes it.
  static func isPathWord(_ text: NSString, wordStart: Int, cursor: Int) -> Bool {
    var end = cursor
    while end < text.length, !isWhitespace(text.character(at: end)) { end += 1 }
    guard end > wordStart + 1 else { return false }
    let rest = text.substring(with: NSRange(location: wordStart + 1, length: end - wordStart - 1))
    return rest.contains("/") || rest.contains("\\")
  }

  /// `$5`, `€9.99` and `$10k` are money, not skills.
  static func isCurrencyAmount(_ query: String) -> Bool {
    query.range(of: #"^\.?[0-9][0-9,._]*(?:[kKmMbBtT]|[eE][0-9]+)?[.,;:!?)]*$"#, options: .regularExpression) != nil
  }

  static func pullRequestTrigger(_ token: String, cursor: Int) -> ComposerTrigger? {
    if token.hasPrefix("@") { return nil }
    if let first = token.unicodeScalars.first, first.properties.generalCategory == .currencySymbol { return nil }
    let regex = try! NSRegularExpression(pattern: #"(?:^|\p{Ps})#([\p{L}\p{N}][\p{L}\p{N}_-]*)?$"#)
    let ns = token as NSString
    guard let match = regex.firstMatch(in: token, range: NSRange(location: 0, length: ns.length)) else { return nil }
    let group = match.range(at: 1)
    let query = group.location == NSNotFound ? "" : ns.substring(with: group)
    return ComposerTrigger(
      kind: .pullRequest, query: query, rangeStart: cursor - (query as NSString).length - 1, rangeEnd: cursor)
  }
}

/// Composer commands typed as the whole message (`composerTrigger.ts`).
public enum ComposerCommandText {
  /// A message that only invokes a slash command, such as `/context all`, not a path like `/src/a.ts`.
  public static func isSlashCommand(_ text: String, attachmentCount: Int) -> Bool {
    attachmentCount == 0
      && text.trimmingCharacters(in: .whitespacesAndNewlines).range(of: #"^/[\w:-]+(?:\s|$)"#, options: .regularExpression) != nil
  }

  /// `/clear` as the whole message arms a fresh session instead of sending.
  public static func isClear(_ text: String) -> Bool {
    text.trimmingCharacters(in: .whitespacesAndNewlines).range(of: #"^/clear\s*$"#, options: [.regularExpression, .caseInsensitive]) != nil
  }

  /// `/side [prompt]`, or its alias `/btw [prompt]`, as the whole message.
  public static func sideChatPrompt(_ text: String) -> String? {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    let regex = try! NSRegularExpression(pattern: #"^/(?:side|btw)(?:\s+([\s\S]*))?$"#, options: .caseInsensitive)
    let ns = trimmed as NSString
    guard let match = regex.firstMatch(in: trimmed, range: NSRange(location: 0, length: ns.length)) else { return nil }
    let group = match.range(at: 1)
    return group.location == NSNotFound ? "" : ns.substring(with: group).trimmingCharacters(in: .whitespacesAndNewlines)
  }
}
