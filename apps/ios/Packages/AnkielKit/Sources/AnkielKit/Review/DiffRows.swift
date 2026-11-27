import Foundation

/// One row of a file's diff as the screen draws it.
public struct DiffRow: Sendable, Hashable, Identifiable {
  public var id: String
  public var content: Content

  public enum Content: Sendable, Hashable {
    case hunk(header: String, context: String?)
    case line(DiffLine, changed: [Range<Int>])
    /// Unchanged lines left out of the patch. `count` is nil past the last hunk, where only the
    /// file's contents tell how many there are.
    case gap(Gap)
  }

  public var line: DiffLine? {
    if case .line(let line, _) = content { line } else { nil }
  }
}

public struct Gap: Sendable, Hashable {
  /// Which gap: 0 before the first hunk, `i` before hunk `i`, `hunks.count` after the last.
  public var index: Int
  public var newStart: Int
  public var oldStart: Int
  public var count: Int?
}

public enum DiffRows {
  /// Rows for one file. With `contents`, the gaps in `expanded` show their unchanged lines and the
  /// trailing gap gets its count. An `expandable` file without contents yet shows the trailing gap
  /// with no count (only the contents tell whether the file goes on).
  public static func build(_ file: DiffFile, contents: [String]? = nil, expanded: Set<Int> = [], expandable: Bool = false) -> [DiffRow] {
    var rows: [DiffRow] = []
    rows.reserveCapacity(file.lineCount + file.hunks.count * 2)
    var oldNext = 1
    var newNext = 1
    for (index, hunk) in file.hunks.enumerated() {
      let newStart = hunk.newCount == 0 ? hunk.newStart + 1 : hunk.newStart
      let count = newStart - newNext
      if count > 0 {
        appendGap(
          Gap(index: index, newStart: newNext, oldStart: oldNext, count: count), file: file, contents: contents,
          expanded: expanded, into: &rows)
      }
      rows.append(DiffRow(id: "\(file.id)#h\(index)", content: .hunk(header: hunk.header, context: hunk.context)))
      let changed = WordDiff.pairs(hunk.lines)
      for (offset, line) in hunk.lines.enumerated() {
        rows.append(DiffRow(id: "\(file.id)#h\(index)l\(offset)", content: .line(line, changed: changed[offset] ?? [])))
      }
      oldNext = (hunk.oldCount == 0 ? hunk.oldStart + 1 : hunk.oldStart) + hunk.oldCount
      newNext = newStart + hunk.newCount
    }
    guard !file.hunks.isEmpty, file.status != .added, file.status != .deleted else { return rows }
    let trailing = contents.map { max(0, $0.count - newNext + 1) }
    if trailing.map({ $0 > 0 }) ?? expandable {
      appendGap(
        Gap(index: file.hunks.count, newStart: newNext, oldStart: oldNext, count: trailing), file: file,
        contents: contents, expanded: expanded, into: &rows)
    }
    return rows
  }

  private static func appendGap(
    _ gap: Gap, file: DiffFile, contents: [String]?, expanded: Set<Int>, into rows: inout [DiffRow]
  ) {
    guard let contents, expanded.contains(gap.index), let count = gap.count else {
      rows.append(DiffRow(id: "\(file.id)#g\(gap.index)", content: .gap(gap)))
      return
    }
    for offset in 0..<count {
      let newNumber = gap.newStart + offset
      guard newNumber - 1 < contents.count else { break }
      let line = DiffLine(kind: .context, text: contents[newNumber - 1], oldNumber: gap.oldStart + offset, newNumber: newNumber)
      rows.append(DiffRow(id: "\(file.id)#g\(gap.index)l\(offset)", content: .line(line, changed: [])))
    }
  }

  /// The new file's lines, when `contents` reproduces the patch (web `reproducesPatch`): every
  /// context and added line must sit at its number in the new side, every context and removed
  /// line in the old. Nil means the file changed since the diff was read.
  public static func verifiedLines(_ file: DiffFile, contents: DiffFileContents) -> [String]? {
    let old = lines(contents.oldContents)
    let new = lines(contents.newContents)
    for hunk in file.hunks {
      for line in hunk.lines {
        if let number = line.newNumber, line.kind != .removed {
          guard number - 1 < new.count, new[number - 1] == line.text else { return nil }
        }
        if let number = line.oldNumber, line.kind != .added {
          guard number - 1 < old.count, old[number - 1] == line.text else { return nil }
        }
      }
    }
    return new
  }

  /// Lines without endings (a trailing newline ends the last line, it does not start another).
  public static func lines(_ text: String) -> [String] {
    var result = UnifiedDiff.splitLines(text).map { line in
      line.unicodeScalars.last == "\r" ? String(line.unicodeScalars.dropLast()) : String(line)
    }
    if result.last == "" { result.removeLast() }
    return result
  }
}

/// Word-level changes between paired removed and added lines (RN `reviewWordDiffs`): in each run
/// of removals followed by additions, the i-th removed line pairs with the i-th added one.
public enum WordDiff {
  /// Longer lines are not compared.
  static let maxLineLength = 1_000

  /// Changed Character ranges by line index within the hunk.
  public static func pairs(_ lines: [DiffLine]) -> [Int: [Range<Int>]] {
    var result: [Int: [Range<Int>]] = [:]
    var index = 0
    while index < lines.count {
      guard lines[index].kind == .removed else {
        index += 1
        continue
      }
      let removedStart = index
      while index < lines.count, lines[index].kind == .removed { index += 1 }
      let addedStart = index
      while index < lines.count, lines[index].kind == .added { index += 1 }
      let pairs = min(addedStart - removedStart, index - addedStart)
      for offset in 0..<pairs {
        let old = lines[removedStart + offset].text
        let new = lines[addedStart + offset].text
        guard let (oldRanges, newRanges) = changes(old, new) else { continue }
        if !oldRanges.isEmpty { result[removedStart + offset] = oldRanges }
        if !newRanges.isEmpty { result[addedStart + offset] = newRanges }
      }
    }
    return result
  }

  /// The changed ranges of each side, or nil when the lines are too long or share nothing worth
  /// marking (a rewrite reads better as whole lines).
  public static func changes(_ old: String, _ new: String) -> ([Range<Int>], [Range<Int>])? {
    guard old.count <= maxLineLength, new.count <= maxLineLength, old != new else { return nil }
    let a = tokens(old)
    let b = tokens(new)
    guard a.count * b.count <= 160_000 else { return nil }
    // LCS over tokens.
    let n = a.count
    let m = b.count
    var table = [Int](repeating: 0, count: (n + 1) * (m + 1))
    for i in stride(from: n - 1, through: 0, by: -1) {
      for j in stride(from: m - 1, through: 0, by: -1) {
        table[i * (m + 1) + j] =
          a[i].text == b[j].text ? table[(i + 1) * (m + 1) + j + 1] + 1 : max(table[(i + 1) * (m + 1) + j], table[i * (m + 1) + j + 1])
      }
    }
    var keptA = [Bool](repeating: false, count: n)
    var keptB = [Bool](repeating: false, count: m)
    var i = 0
    var j = 0
    while i < n, j < m {
      if a[i].text == b[j].text {
        keptA[i] = true
        keptB[j] = true
        i += 1
        j += 1
      } else if table[(i + 1) * (m + 1) + j] >= table[i * (m + 1) + j + 1] {
        i += 1
      } else {
        j += 1
      }
    }
    // Nothing in common but whitespace: whole-line change.
    let common = a.indices.filter { keptA[$0] && !a[$0].isSpace }.count
    guard common > 0 else { return nil }
    return (ranges(a, kept: keptA), ranges(b, kept: keptB))
  }

  struct Token {
    var text: Substring
    var start: Int
    var isSpace: Bool
  }

  /// Words, runs of whitespace, and single other characters.
  static func tokens(_ line: String) -> [Token] {
    var result: [Token] = []
    var offset = 0
    var index = line.startIndex
    func isWord(_ c: Character) -> Bool { c.isLetter || c.isNumber || c == "_" }
    while index < line.endIndex {
      let c = line[index]
      var end = line.index(after: index)
      var length = 1
      if isWord(c) {
        while end < line.endIndex, isWord(line[end]) {
          end = line.index(after: end)
          length += 1
        }
      } else if c.isWhitespace {
        while end < line.endIndex, line[end].isWhitespace {
          end = line.index(after: end)
          length += 1
        }
      }
      result.append(Token(text: line[index..<end], start: offset, isSpace: c.isWhitespace))
      offset += length
      index = end
    }
    return result
  }

  /// Unkept tokens as ranges; ranges one character apart merge (`mergeNearbyRanges`).
  static func ranges(_ tokens: [Token], kept: [Bool]) -> [Range<Int>] {
    var result: [Range<Int>] = []
    for (index, token) in tokens.enumerated() where !kept[index] {
      let range = token.start..<(token.start + token.text.count)
      if let last = result.last, range.lowerBound - last.upperBound <= 1 {
        result[result.count - 1] = last.lowerBound..<range.upperBound
      } else {
        result.append(range)
      }
    }
    return result
  }
}
