import Foundation

/// A mention or skill the composer draws as a chip (`shared/composerInlineTokens.ts`). The draft
/// stays plain text; tokens are found in it again after every edit. Offsets are UTF-16.
public struct ComposerInlineToken: Sendable, Hashable {
  public enum Kind: String, Sendable { case mention, skill, model }

  public var kind: Kind
  /// The path for a mention, the name for a skill, `<instance>/<slug>` for a model.
  public var value: String
  /// The exact text the chip stands for.
  public var source: String
  public var start: Int
  public var end: Int

  public init(kind: Kind, value: String, source: String, start: Int, end: Int) {
    self.kind = kind
    self.value = value
    self.source = source
    self.start = start
    self.end = end
  }
}

public enum ComposerInlineTokens {
  /// `collectComposerInlineTokens`. A token counts only once whitespace follows it, so typing
  /// `@README.md` stays text until the space; `preserveTrailing` keeps a chip that ends the text
  /// after only its trailing space was deleted. TeX formulas are not detected here (RN masks them).
  public static func collect(_ text: String, preserveTrailing: [ComposerInlineToken] = []) -> [ComposerInlineToken] {
    let ns = text as NSString
    var matches = mentions(text)
    let full = NSRange(location: 0, length: ns.length)
    for match in skillToken.matches(in: text, range: full) {
      let valueRange = match.range(at: 2)
      guard valueRange.location != NSNotFound, valueRange.length > 0 else { continue }
      let prefix = match.range(at: 1).length
      let start = match.range.location + prefix
      let end = NSMaxRange(match.range)
      matches.append(ComposerInlineToken(
        kind: .skill, value: ns.substring(with: valueRange), source: ns.substring(with: NSRange(location: start, length: end - start)),
        start: start, end: end))
    }
    for token in preserveTrailing where token.end == ns.length && token.start >= 0 && token.start <= token.end {
      let current = ns.substring(with: NSRange(location: token.start, length: token.end - token.start))
      guard current == token.source,
        !matches.contains(where: { $0.kind == token.kind && $0.start == token.start && $0.end == token.end })
      else { continue }
      matches.append(token)
    }
    return matches.sorted { $0.start < $1.start }
  }

  /// What the editor draws as chips: mentions and skills, plus `model:` references to models the
  /// computer lists (`known` holds `<instance>/<slug>`), where they overlap nothing else.
  public static func editorTokens(_ text: String, preserveTrailing: [ComposerInlineToken] = [], knownModels: Set<String>) -> [ComposerInlineToken] {
    var tokens = collect(text, preserveTrailing: preserveTrailing.filter { $0.kind != .model })
    for occurrence in ComposerModelMentions.collect(text) where knownModels.contains("\(occurrence.instanceId)/\(occurrence.model)") {
      guard !tokens.contains(where: { $0.start < occurrence.end && occurrence.start < $0.end }) else { continue }
      tokens.append(ComposerInlineToken(
        kind: .model, value: "\(occurrence.instanceId)/\(occurrence.model)", source: occurrence.source, start: occurrence.start,
        end: occurrence.end))
    }
    return tokens.sorted { $0.start < $1.start }
  }

  /// `composerFileLinksToPlainText`: each file link shown by its file name, for one-line previews.
  public static func plainText(_ text: String) -> String {
    let ns = text as NSString
    var result = ""
    var cursor = 0
    for token in mentions(text + " ") where token.source.hasPrefix("[") {
      result += ns.substring(with: NSRange(location: cursor, length: token.start - cursor)) + displayName(token.value)
      cursor = token.end
    }
    return result + ns.substring(from: cursor)
  }

  /// Text split into plain runs and file mentions (by file name, with the path), for a sent
  /// message that shows its mentions as file links (RN renders user messages as Markdown).
  public static func runs(_ text: String) -> [(text: String, path: String?)] {
    let ns = text as NSString
    var result: [(text: String, path: String?)] = []
    var cursor = 0
    for token in mentions(text + " ").sorted(by: { $0.start < $1.start }) where token.start >= cursor {
      if token.start > cursor { result.append((ns.substring(with: NSRange(location: cursor, length: token.start - cursor)), nil)) }
      result.append((displayName(token.value), token.value))
      cursor = token.end
    }
    if cursor < ns.length { result.append((ns.substring(from: cursor), nil)) }
    return result
  }

  /// The chip's label: a path's last segment, composed to NFC (macOS stores many names in NFD).
  public static func displayName(_ path: String) -> String {
    var trimmed = path
    while trimmed.hasSuffix("/") || trimmed.hasSuffix("\\") { trimmed.removeLast() }
    if trimmed.isEmpty { return path }
    return ComposerFileLink.basename(trimmed).precomposedStringWithCanonicalMapping
  }

  static func mentions(_ text: String) -> [ComposerInlineToken] {
    let ns = text as NSString
    let full = NSRange(location: 0, length: ns.length)
    var result: [ComposerInlineToken] = []
    for match in fileLinkToken.matches(in: text, range: full) {
      let prefix = match.range(at: 1).length
      let label = unescape(ns.substring(with: match.range(at: 2)))
      let encoded = ns.substring(with: match.range(at: 3))
      let path = ComposerFileLink.path(encoded: encoded, decoded: ComposerFileLink.decode(encoded))
      let hasScheme = path.range(of: #"^[A-Za-z][A-Za-z0-9+.-]*:"#, options: .regularExpression) != nil
        && path.range(of: #"^[A-Za-z]:[\\/]"#, options: .regularExpression) == nil
      guard !path.isEmpty, !hasScheme, label == ComposerFileLink.basename(path) else { continue }
      let start = match.range.location + prefix
      let end = NSMaxRange(match.range)
      result.append(ComposerInlineToken(
        kind: .mention, value: path, source: ns.substring(with: NSRange(location: start, length: end - start)), start: start, end: end))
    }
    for match in mentionToken.matches(in: text, range: full) {
      let prefix = match.range(at: 1).length
      let quoted = match.range(at: 2)
      let path: String
      if quoted.location != NSNotFound {
        path = unescape(ns.substring(with: quoted))
      } else {
        path = ns.substring(with: match.range(at: 3))
        let whole = NSRange(location: 0, length: (path as NSString).length)
        if scopedPackage.firstMatch(in: path, range: whole) != nil || decoratorCall.firstMatch(in: path, range: whole) != nil {
          continue
        }
      }
      guard !path.isEmpty else { continue }
      let start = match.range.location + prefix
      let end = NSMaxRange(match.range)
      result.append(ComposerInlineToken(
        kind: .mention, value: path, source: ns.substring(with: NSRange(location: start, length: end - start)), start: start, end: end))
    }
    return result
  }

  static func unescape(_ value: String) -> String {
    value.replacingOccurrences(of: #"\\(.)"#, with: "$1", options: .regularExpression)
  }

  // A JS `(?=\s)` lookahead; ICU's `\s` also covers the same whitespace.
  private static let skillToken = try! NSRegularExpression(
    pattern: #"(^|\s)\p{Sc}(?![0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?(?:\s|$))(?=[a-zA-Z0-9:_-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s)"#)
  private static let mentionToken = try! NSRegularExpression(pattern: #"(^|\s)@(?:"((?:\\.|[^"\\])*)"|([^\s@"]+))(?=\s)"#)
  private static let fileLinkToken = try! NSRegularExpression(
    pattern: #"(^|\s)\[((?:\\.|[^\]\\]){0,512})\]\(([^)\s]+)\)(?=\s)"#)
  private static let scopedPackage = try! NSRegularExpression(pattern: #"^[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*(?:/[^\s@"]+)*$"#)
  private static let decoratorCall = try! NSRegularExpression(pattern: #"^[\p{ID_Start}_$][\p{ID_Continue}.$\u200c\u200d]*\("#)
}
