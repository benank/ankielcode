import Foundation

/// A text file split into lines, with highlighter tokens found once (off the main actor) and
/// applied per line as rows appear, so a 1 MiB file never becomes one giant attributed string.
public struct SourceDocument: Sendable {
  /// Files longer than this (in Characters) show as plain text: tokenizing them costs more than
  /// the colors are worth on a phone.
  public static let highlightLimit = 400_000

  public let lines: [Substring]
  public let language: String?
  /// Character offset where each line starts.
  let starts: [Int]
  /// Tokens in order, as Character offsets into the whole text.
  let tokens: [CodeToken]
  /// Characters in the longest line, for sizing an unwrapped monospaced column.
  public let longestLine: Int

  public init(text: String, language: String?) {
    var lines = text.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline)
    // A trailing newline ends the last line; it does not start an empty one.
    if lines.count > 1, lines.last?.isEmpty == true { lines.removeLast() }
    self.lines = lines
    self.language = language
    var starts: [Int] = []
    starts.reserveCapacity(lines.count)
    var offset = 0
    var longest = 0
    for line in lines {
      starts.append(offset)
      let count = line.count
      longest = max(longest, count)
      offset += count + 1
    }
    self.starts = starts
    longestLine = longest
    tokens = offset <= Self.highlightLimit ? CodeHighlighter.tokens(text, language: language) : []
  }

  public var lineCount: Int { lines.count }
  public var isHighlighted: Bool { !tokens.isEmpty }

  /// One line with its tokens styled.
  public func attributedLine(_ index: Int, style: [CodeToken.Kind: AttributeContainer]) -> AttributedString {
    let line = lines[index]
    var attributed = AttributedString(line)
    guard !tokens.isEmpty, !style.isEmpty, !line.isEmpty else { return attributed }
    let start = starts[index]
    let end = start + line.count
    var position = firstToken(endingAfter: start)
    while position < tokens.count, tokens[position].range.lowerBound < end {
      let token = tokens[position]
      position += 1
      guard let container = style[token.kind] else { continue }
      let lower = max(token.range.lowerBound, start) - start
      let upper = min(token.range.upperBound, end) - start
      guard lower < upper else { continue }
      let from = attributed.characters.index(attributed.startIndex, offsetBy: lower)
      let to = attributed.characters.index(from, offsetBy: upper - lower)
      attributed[from..<to].mergeAttributes(container)
    }
    return attributed
  }

  /// The first token whose range ends after `offset` (binary search; tokens do not overlap).
  func firstToken(endingAfter offset: Int) -> Int {
    var low = 0
    var high = tokens.count
    while low < high {
      let mid = (low + high) / 2
      if tokens[mid].range.upperBound <= offset { low = mid + 1 } else { high = mid }
    }
    return low
  }

  /// Lines containing `query`, ignoring case and diacritics.
  public func matches(_ query: String) -> [Int] {
    let needle = query.trimmingCharacters(in: .whitespaces)
    guard !needle.isEmpty else { return [] }
    return lines.indices.filter { lines[$0].range(of: needle, options: [.caseInsensitive, .diacriticInsensitive]) != nil }
  }
}

extension FileRead {
  /// The 1 MiB read limit, in bytes (`PROJECT_READ_FILE_MAX_BYTES`).
  public static let readLimit = 1024 * 1024
}
