import Foundation

/// One file of a patch.
public struct DiffFile: Sendable, Hashable, Identifiable {
  /// Stable within one patch: the path plus its occurrence (a type change is a delete and an add
  /// under one path).
  public var id: String
  /// The new path (the old one for a deletion).
  public var path: String
  /// Set for renames and copies.
  public var previousPath: String?
  public var status: Status
  public var isBinary: Bool
  public var oldMode: String?
  public var newMode: String?
  public var similarity: Int?
  public var hunks: [DiffHunk]
  public var additions: Int
  public var deletions: Int

  public enum Status: String, Sendable, Hashable {
    case added, modified, deleted, renamed, copied
  }

  /// The server's `ReviewDiffChangeType` for this file.
  public var changeType: String {
    switch status {
    case .added: "new"
    case .deleted: "deleted"
    case .renamed, .copied: hunks.isEmpty ? "rename-pure" : "rename-changed"
    case .modified: "change"
    }
  }

  /// A mode change only (`old mode 100644` → `new mode 100755`).
  public var modeChanged: Bool { oldMode != nil && newMode != nil && oldMode != newMode }

  public var lineCount: Int { hunks.reduce(0) { $0 + $1.lines.count } }

  public init(
    id: String, path: String, previousPath: String? = nil, status: Status, isBinary: Bool = false, hunks: [DiffHunk] = []
  ) {
    self.id = id
    self.path = path
    self.previousPath = previousPath
    self.status = status
    self.isBinary = isBinary
    self.hunks = hunks
    additions = hunks.reduce(0) { $0 + $1.lines.count { $0.kind == .added } }
    deletions = hunks.reduce(0) { $0 + $1.lines.count { $0.kind == .removed } }
  }
}

public struct DiffHunk: Sendable, Hashable {
  public var oldStart: Int
  public var oldCount: Int
  public var newStart: Int
  public var newCount: Int
  /// The function or section name git prints after the header.
  public var context: String?
  public var lines: [DiffLine]

  public var header: String { "@@ -\(oldStart),\(oldCount) +\(newStart),\(newCount) @@" }
}

public struct DiffLine: Sendable, Hashable {
  public var kind: Kind
  /// Without the marker, the line ending, or a trailing CR.
  public var text: String
  public var oldNumber: Int?
  public var newNumber: Int?
  /// `\ No newline at end of file` follows this line.
  public var noNewline = false
  /// The line ended in CRLF.
  public var crlf = false

  public enum Kind: Sendable, Hashable { case context, added, removed }

  public init(kind: Kind, text: String, oldNumber: Int?, newNumber: Int?) {
    self.kind = kind
    self.text = text
    self.oldNumber = oldNumber
    self.newNumber = newNumber
  }
}

/// A parsed patch: its files, or the reason it could not be read as one.
public struct ParsedDiff: Sendable, Hashable {
  public var files: [DiffFile]
  /// The server cut the patch at its size limit (`[truncated]`).
  public var truncated: Bool

  public var additions: Int { files.reduce(0) { $0 + $1.additions } }
  public var deletions: Int { files.reduce(0) { $0 + $1.deletions } }
}

/// A git unified-diff parser. Hunks are read by their line counts, so a content line that looks
/// like a header (`--- a`, `diff --git`) inside a hunk stays content.
public enum UnifiedDiff {
  public static let truncationMarker = "\n\n[truncated]"

  public static func parse(_ text: String) -> ParsedDiff {
    var body = Substring(text)
    var truncated = false
    let trimmed = body.reversed().drop { $0.isWhitespace }
    if String(trimmed.prefix(11).reversed()) == "[truncated]" {
      truncated = true
      body = body.dropLast(body.count - trimmed.count + 11)
    }
    var parser = Parser(lines: splitLines(body))
    parser.run()
    return ParsedDiff(files: parser.files, truncated: truncated)
  }

  /// Lines split at every LF. Swift treats CRLF as one Character, so splitting a String at "\n"
  /// would keep CRLF lines together; this splits on the scalar instead and keeps the CR.
  public static func splitLines(_ text: some StringProtocol) -> [Substring] {
    var lines: [Substring] = []
    let string = String(text)
    var start = string.startIndex
    let scalars = string.unicodeScalars
    var index = scalars.startIndex
    while index < scalars.endIndex {
      if scalars[index] == "\n" {
        lines.append(Substring(scalars[start..<index]))
        start = scalars.index(after: index)
      }
      index = scalars.index(after: index)
    }
    lines.append(Substring(scalars[start...]))
    return lines
  }

  private struct Parser {
    let lines: [Substring]
    var index = 0
    var files: [DiffFile] = []
    var occurrences: [String: Int] = [:]

    init(lines: [Substring]) { self.lines = lines }

    mutating func run() {
      while index < lines.count {
        let line = lines[index]
        if line.hasPrefix("diff --git ") || line.hasPrefix("--- ") && next(startsWith: "+++ ") {
          parseFile()
        } else {
          index += 1
        }
      }
    }

    func next(startsWith prefix: String) -> Bool {
      index + 1 < lines.count && lines[index + 1].hasPrefix(prefix)
    }

    mutating func parseFile() {
      var oldPath: String?
      var newPath: String?
      var status = DiffFile.Status.modified
      var isBinary = false
      var oldMode: String?
      var newMode: String?
      var similarity: Int?
      var renameFrom: String?
      var renameTo: String?
      var copied = false

      if lines[index].hasPrefix("diff --git ") {
        if let paths = Self.headerPaths(String(lines[index].dropFirst(11))) {
          oldPath = Self.strip(paths.0, side: "a/")
          newPath = Self.strip(paths.1, side: "b/")
        }
        index += 1
      }
      // Extended header lines, until the first hunk or the next file.
      header: while index < lines.count {
        let line = Self.chomp(lines[index])
        if line.hasPrefix("@@ ") || line.hasPrefix("diff --git ") { break }
        if line.hasPrefix("--- ") {
          let path = Self.pathToken(line.dropFirst(4))
          if path != "/dev/null" { oldPath = Self.strip(path, side: "a/") } else { status = .added }
        } else if line.hasPrefix("+++ ") {
          let path = Self.pathToken(line.dropFirst(4))
          if path != "/dev/null" { newPath = Self.strip(path, side: "b/") } else { status = .deleted }
          index += 1
          break header
        } else if line.hasPrefix("new file mode ") {
          status = .added
          newMode = String(line.dropFirst(14))
        } else if line.hasPrefix("deleted file mode ") {
          status = .deleted
          oldMode = String(line.dropFirst(18))
        } else if line.hasPrefix("old mode ") {
          oldMode = String(line.dropFirst(9))
        } else if line.hasPrefix("new mode ") {
          newMode = String(line.dropFirst(9))
        } else if line.hasPrefix("similarity index ") {
          similarity = Int(line.dropFirst(17).dropLast())
        } else if line.hasPrefix("rename from ") {
          renameFrom = Self.unquote(String(line.dropFirst(12)))
        } else if line.hasPrefix("rename to ") {
          renameTo = Self.unquote(String(line.dropFirst(10)))
        } else if line.hasPrefix("copy from ") {
          renameFrom = Self.unquote(String(line.dropFirst(10)))
          copied = true
        } else if line.hasPrefix("copy to ") {
          renameTo = Self.unquote(String(line.dropFirst(8)))
          copied = true
        } else if line.hasPrefix("Binary files ") || line == "GIT binary patch" {
          isBinary = true
        } else if !(line.hasPrefix("index ") || line.hasPrefix("dissimilarity index ")) {
          // Not a header line (a plain `---`/`+++` patch has none): stop.
          if oldPath == nil && newPath == nil { index += 1 }
          break header
        }
        index += 1
      }
      if let renameFrom { oldPath = renameFrom }
      if let renameTo { newPath = renameTo }
      if renameFrom != nil || renameTo != nil, status == .modified { status = copied ? .copied : .renamed }

      var hunks: [DiffHunk] = []
      while index < lines.count, lines[index].hasPrefix("@@ ") {
        guard let hunk = parseHunk() else { break }
        hunks.append(hunk)
      }
      // Skip a binary patch body.
      while index < lines.count, !lines[index].hasPrefix("diff --git "), !lines[index].hasPrefix("@@ "),
        !(lines[index].hasPrefix("--- ") && next(startsWith: "+++ "))
      {
        index += 1
      }

      let path = (status == .deleted ? oldPath : newPath) ?? oldPath ?? ""
      guard !path.isEmpty else { return }
      let occurrence = occurrences[path, default: 0]
      occurrences[path] = occurrence + 1
      var file = DiffFile(
        id: "\(occurrence):\(path)", path: path,
        previousPath: status == .renamed || status == .copied ? oldPath : nil, status: status, isBinary: isBinary,
        hunks: hunks)
      file.oldMode = oldMode
      file.newMode = newMode
      file.similarity = similarity
      files.append(file)
    }

    mutating func parseHunk() -> DiffHunk? {
      guard let header = Self.hunkHeader(lines[index]) else {
        index += 1
        return nil
      }
      index += 1
      var hunk = DiffHunk(
        oldStart: header.oldStart, oldCount: header.oldCount, newStart: header.newStart, newCount: header.newCount,
        context: header.context, lines: [])
      var oldLeft = header.oldCount
      var newLeft = header.newCount
      var oldNumber = header.oldStart
      var newNumber = header.newStart
      hunk.lines.reserveCapacity(header.oldCount + header.newCount)
      while index < lines.count {
        let raw = lines[index]
        if raw.hasPrefix("\\") {
          if !hunk.lines.isEmpty { hunk.lines[hunk.lines.count - 1].noNewline = true }
          index += 1
          continue
        }
        guard oldLeft > 0 || newLeft > 0 else { break }
        let marker = raw.first
        var content = raw.isEmpty ? Substring("") : raw.dropFirst()
        let crlf = content.last == "\r"
        if crlf { content = content.dropLast() }
        var line: DiffLine
        switch marker {
        case "+" where newLeft > 0:
          line = DiffLine(kind: .added, text: String(content), oldNumber: nil, newNumber: newNumber)
          newNumber += 1
          newLeft -= 1
        case "-" where oldLeft > 0:
          line = DiffLine(kind: .removed, text: String(content), oldNumber: oldNumber, newNumber: nil)
          oldNumber += 1
          oldLeft -= 1
        case " ", nil:
          // An empty line is a context line whose space an editor trimmed.
          guard oldLeft > 0, newLeft > 0 else { return hunk }
          line = DiffLine(kind: .context, text: String(content), oldNumber: oldNumber, newNumber: newNumber)
          oldNumber += 1
          newNumber += 1
          oldLeft -= 1
          newLeft -= 1
        default:
          // A malformed hunk (cut short): stop reading it.
          return hunk
        }
        line.crlf = crlf
        hunk.lines.append(line)
        index += 1
      }
      return hunk
    }

    static func hunkHeader(_ line: Substring) -> (oldStart: Int, oldCount: Int, newStart: Int, newCount: Int, context: String?)? {
      // @@ -a[,b] +c[,d] @@[ context]
      let parts = line.split(separator: " ", maxSplits: 3, omittingEmptySubsequences: true)
      guard parts.count >= 3, parts[0] == "@@", parts[1].hasPrefix("-"), parts[2].hasPrefix("+") else { return nil }
      func range(_ token: Substring) -> (Int, Int)? {
        let numbers = token.dropFirst().split(separator: ",", omittingEmptySubsequences: false)
        guard let start = Int(numbers[0]) else { return nil }
        let count = numbers.count > 1 ? Int(numbers[1]) : 1
        guard let count else { return nil }
        return (start, count)
      }
      guard let old = range(parts[1]), let new = range(parts[2]) else { return nil }
      var context: String?
      if parts.count == 4 {
        let rest = parts[3]
        if rest.hasPrefix("@@") {
          let text = rest.dropFirst(2).trimmingCharacters(in: .whitespaces)
          context = text.isEmpty ? nil : chomp(Substring(text)).description
        }
      }
      return (old.0, old.1, new.0, new.1, context)
    }

    static func chomp(_ line: Substring) -> Substring { line.last == "\r" ? line.dropLast() : line }

    /// The two paths of `diff --git`: an unchanged name repeats, which settles where a name with
    /// " b/" in it ends (RN `gitHeaderPaths`); quoted names are unquoted.
    static func headerPaths(_ value: String) -> (String, String)? {
      let value = String(chomp(Substring(value)))
      if value.hasPrefix("\"") {
        guard let (first, rest) = quotedToken(value) else { return nil }
        let second = rest.trimmingCharacters(in: .whitespaces)
        return (first, second.hasPrefix("\"") ? (quotedToken(second)?.0 ?? second) : second)
      }
      let characters = Array(value)
      if characters.count % 2 == 1 {
        let middle = (characters.count - 1) / 2
        let left = String(characters[..<middle])
        let right = String(characters[(middle + 1)...])
        if left.hasPrefix("a/"), right.hasPrefix("b/"), left.dropFirst(2) == right.dropFirst(2) { return (left, right) }
      }
      if let range = value.range(of: " \"b/") {
        return (String(value[..<range.lowerBound]), unquote(String(value[value.index(after: range.lowerBound)...])))
      }
      guard let range = value.range(of: " b/") else { return nil }
      return (String(value[..<range.lowerBound]), String(value[value.index(after: range.lowerBound)...]))
    }

    /// `--- a/path` (possibly quoted, possibly with a trailing tab and timestamp).
    static func pathToken(_ value: Substring) -> String {
      let value = chomp(value)
      if value.hasPrefix("\"") { return quotedToken(String(value))?.0 ?? String(value) }
      if let tab = value.firstIndex(of: "\t") { return String(value[..<tab]) }
      return String(value)
    }

    static func strip(_ path: String, side: String) -> String {
      path.hasPrefix(side) ? String(path.dropFirst(side.count)) : path
    }

    static func unquote(_ value: String) -> String {
      value.hasPrefix("\"") ? (quotedToken(value)?.0 ?? value) : value
    }

    /// A C-style quoted git path and what follows it. Octal escapes are UTF-8 bytes.
    static func quotedToken(_ value: String) -> (String, String)? {
      var bytes: [UInt8] = []
      let all = Array(value.utf8)
      guard all.first == UInt8(ascii: "\"") else { return nil }
      var i = 1
      while i < all.count {
        let byte = all[i]
        if byte == UInt8(ascii: "\"") {
          let rest = String(decoding: all[(i + 1)...], as: UTF8.self)
          return (String(decoding: bytes, as: UTF8.self), rest)
        }
        if byte == UInt8(ascii: "\\"), i + 1 < all.count {
          let next = all[i + 1]
          switch next {
          case UInt8(ascii: "n"): bytes.append(0x0A)
          case UInt8(ascii: "t"): bytes.append(0x09)
          case UInt8(ascii: "r"): bytes.append(0x0D)
          case UInt8(ascii: "\""): bytes.append(next)
          case UInt8(ascii: "\\"): bytes.append(next)
          case UInt8(ascii: "a"): bytes.append(0x07)
          case UInt8(ascii: "b"): bytes.append(0x08)
          case UInt8(ascii: "f"): bytes.append(0x0C)
          case UInt8(ascii: "v"): bytes.append(0x0B)
          case UInt8(ascii: "0")...UInt8(ascii: "7"):
            var octal = 0
            var length = 0
            while length < 3, i + 1 + length < all.count, (UInt8(ascii: "0")...UInt8(ascii: "7")).contains(all[i + 1 + length]) {
              octal = octal * 8 + Int(all[i + 1 + length] - UInt8(ascii: "0"))
              length += 1
            }
            bytes.append(UInt8(truncatingIfNeeded: octal))
            i += 1 + length
            continue
          default: bytes.append(next)
          }
          i += 2
          continue
        }
        bytes.append(byte)
        i += 1
      }
      return nil
    }
  }

  // MARK: Paths

  /// Git's quoting for a path that needs it (`quoteGitPatchPath`).
  public static func quote(_ path: String) -> String {
    let needs = path.unicodeScalars.contains { $0 == "\"" || $0 == "\\" || $0.value < 0x20 || $0.value == 0x7F }
    guard needs else { return path }
    var result = "\""
    for scalar in path.unicodeScalars {
      switch scalar {
      case "\"": result += "\\\""
      case "\\": result += "\\\\"
      case "\n": result += "\\n"
      case "\t": result += "\\t"
      case "\r": result += "\\r"
      default:
        if scalar.value < 0x20 || scalar.value == 0x7F {
          result += String(format: "\\%03o", scalar.value)
        } else {
          result.unicodeScalars.append(scalar)
        }
      }
    }
    return result + "\""
  }

  /// A repository's patch with every path moved under `folder` (RN `patchInFolder`).
  public static func prefixPaths(_ patch: String, folder: String) -> String {
    func moved(_ token: String, side: String) -> String {
      let path = token.hasPrefix("\"") ? Parser.unquote(token) : token
      guard path != "/dev/null", path.hasPrefix(side) else { return token }
      return quote("\(side)\(folder)/\(path.dropFirst(side.count))")
    }
    let leads: [(String, String)] = [
      ("--- ", "a/"), ("+++ ", "b/"), ("rename from ", ""), ("rename to ", ""), ("copy from ", ""), ("copy to ", ""),
    ]
    var inHeader = false
    return splitLines(patch).map { raw -> String in
      let line = String(raw)
      if line.hasPrefix("diff --git ") {
        inHeader = true
        guard let paths = Parser.headerPaths(String(line.dropFirst(11))) else { return line }
        return "diff --git \(moved(paths.0, side: "a/")) \(moved(paths.1, side: "b/"))"
      }
      guard inHeader else { return line }
      if line.hasPrefix("@@") || line == "GIT binary patch" {
        inHeader = false
        return line
      }
      for (lead, side) in leads where line.hasPrefix(lead) {
        let tab = line.hasSuffix("\t") ? "\t" : ""
        let token = String(line.dropFirst(lead.count).dropLast(tab.count))
        return "\(lead)\(moved(token, side: side))\(tab)"
      }
      if line.hasPrefix("Binary files "), line.hasSuffix(" differ") {
        let middle = line.dropFirst(13).dropLast(7)
        if let range = middle.range(of: " and ") {
          return "Binary files \(moved(String(middle[..<range.lowerBound]), side: "a/")) and \(moved(String(middle[range.upperBound...]), side: "b/")) differ"
        }
      }
      return line
    }.joined(separator: "\n")
  }
}
