import Foundation

/// Lines picked in a diff to comment on, and the block that carries the comment into the composer
/// (RN `reviewCommentSelection.ts`). The block is RN's text form, which the agents read as is and
/// RN still parses back (`parseReviewInlineComments`).
public struct ReviewCommentTarget: Sendable, Hashable {
  public var sectionId: String
  public var sectionTitle: String
  public var filePath: String
  /// The picked lines, in order.
  public var lines: [DiffLine]
  /// Indexes of the first and last picked line among the file's lines (RN `startIndex`/`endIndex`).
  public var startIndex: Int
  public var endIndex: Int

  public init(sectionId: String, sectionTitle: String, filePath: String, lines: [DiffLine], startIndex: Int, endIndex: Int) {
    self.sectionId = sectionId
    self.sectionTitle = sectionTitle
    self.filePath = filePath
    self.lines = lines
    self.startIndex = startIndex
    self.endIndex = endIndex
  }

  /// `+12`, `-3 to -7`, `4 to 9`, or `line` / `N lines` without numbers
  /// (`formatReviewSelectedRangeLabel`).
  public var rangeLabel: String {
    guard let first = lines.first, let last = lines.last else { return "line" }
    guard let firstNumber = first.newNumber ?? first.oldNumber, let lastNumber = last.newNumber ?? last.oldNumber else {
      return lines.count == 1 ? "line" : "\(lines.count) lines"
    }
    let marker = Self.marker(first.kind).trimmingCharacters(in: .whitespaces)
    let consistent = !marker.isEmpty && lines.allSatisfy { $0.kind == first.kind } ? marker : ""
    if firstNumber == lastNumber { return "\(consistent)\(firstNumber)" }
    return "\(consistent)\(firstNumber) to \(consistent)\(lastNumber)"
  }

  /// The picked lines as a one-hunk patch (`formatReviewSelectedDiff`).
  public var selectedDiff: String {
    func range(_ numbers: [Int]) -> (Int, Int) { numbers.first.map { ($0, numbers.count) } ?? (0, 0) }
    let old = range(lines.compactMap(\.oldNumber))
    let new = range(lines.compactMap(\.newNumber))
    let body = lines.map { "\(Self.marker($0.kind))\($0.text)" }.joined(separator: "\n")
    return "@@ -\(old.0),\(old.1) +\(new.0),\(new.1) @@\n\(body.isEmpty ? " " : body)"
  }

  /// The block appended to the composer draft (`formatReviewCommentContext`).
  public func block(comment: String) -> String {
    let diff = selectedDiff
    var longest = 0
    var run = 0
    for character in diff {
      run = character == "`" ? run + 1 : 0
      longest = max(longest, run)
    }
    let fence = String(repeating: "`", count: max(3, longest + 1))
    let opening = "<review_comment"
      + " sectionId=\"\(Self.escape(sectionId))\""
      + " sectionTitle=\"\(Self.escape(sectionTitle))\""
      + " filePath=\"\(Self.escape(filePath))\""
      + " startIndex=\"\(startIndex)\""
      + " endIndex=\"\(endIndex)\""
      + " rangeLabel=\"\(Self.escape(rangeLabel))\""
      + ">"
    return [opening, comment.trimmingCharacters(in: .whitespacesAndNewlines), "\(fence)diff", diff, fence, "</review_comment>"]
      .joined(separator: "\n")
  }

  static func marker(_ kind: DiffLine.Kind) -> String {
    switch kind {
    case .added: "+"
    case .removed: "-"
    case .context: " "
    }
  }

  static func escape(_ value: String) -> String {
    value.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "\"", with: "&quot;")
      .replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
  }

  /// How many review comments a draft carries (the review header counts them, like RN).
  public static func count(in draft: String) -> Int {
    draft.components(separatedBy: "<review_comment ").count - 1
  }

  /// Appends a block to a draft, on its own paragraph.
  public static func append(_ block: String, to draft: String) -> String {
    let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? block + "\n" : draft.trimmingCharacters(in: .newlines) + "\n\n" + block + "\n"
  }
}
