import Foundation

/// How inline code, links and code tokens look. Built by the app (SwiftUI colors live there) and
/// merged into the attributed text once, at parse time, so views never restyle per render.
public struct MarkdownStyle: Sendable {
  public var inlineCode: AttributeContainer
  public var link: AttributeContainer
  public var tokens: [CodeToken.Kind: AttributeContainer]

  public init(
    inlineCode: AttributeContainer = AttributeContainer(), link: AttributeContainer = AttributeContainer(),
    tokens: [CodeToken.Kind: AttributeContainer] = [:]
  ) {
    self.inlineCode = inlineCode
    self.link = link
    self.tokens = tokens
  }
}

/// A block parser for the CommonMark/GFM subset agents write: ATX headings, paragraphs, bullet,
/// ordered, nested and task lists, block quotes, fenced code (unterminated fences run to the end,
/// so a streaming reply renders as it arrives), pipe tables, thematic breaks and image-only
/// paragraphs. Inline styles come from Foundation (`AttributedString(markdown:)`), plus bare-URL
/// autolinks. Not supported: setext headings, indented code, HTML blocks, footnotes, reference
/// links. Inline parses and highlighted code are cached by source, so re-parsing a growing message
/// only parses its last block again. Not `Sendable`: one parser per actor.
public final class MarkdownParser {
  private let style: MarkdownStyle
  private let highlighter: CodeHighlighter
  private var inlineCache: [String: InlineText] = [:]
  private var codeCache: [String: AttributedString] = [:]
  private let cacheLimit: Int
  private let linkDetector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)

  public init(style: MarkdownStyle = MarkdownStyle(), cacheLimit: Int = 4000) {
    self.style = style
    highlighter = CodeHighlighter(style: style.tokens)
    self.cacheLimit = cacheLimit
  }

  public func parse(_ text: String) -> MarkdownDocument {
    if inlineCache.count > cacheLimit { inlineCache.removeAll(keepingCapacity: true) }
    if codeCache.count > cacheLimit / 4 { codeCache.removeAll(keepingCapacity: true) }
    let lines = text.split(separator: "\n", omittingEmptySubsequences: false).map { line in
      line.last == "\r" ? line.dropLast() : line
    }
    return MarkdownDocument(blocks: blocks(lines[...], path: ""))
  }

  // MARK: Blocks

  private func blocks(_ lines: ArraySlice<Substring>, path: String) -> [MarkdownBlock] {
    var result: [MarkdownBlock] = []
    var index = lines.startIndex
    func id() -> String { path.isEmpty ? "\(result.count)" : "\(path).\(result.count)" }
    while index < lines.endIndex {
      let line = lines[index]
      if Self.isBlank(line) {
        index += 1
        continue
      }
      if let fence = Self.fenceOpen(line) {
        var body: [Substring] = []
        var cursor = index + 1
        var closed = false
        while cursor < lines.endIndex {
          if Self.closesFence(lines[cursor], fence) {
            closed = true
            break
          }
          body.append(Self.strip(lines[cursor], indent: fence.indent))
          cursor += 1
        }
        let code = body.joined(separator: "\n")
        result.append(MarkdownBlock(id: id(), kind: .code(codeBlock(code, language: fence.language, closed: closed))))
        index = closed ? cursor + 1 : cursor
        continue
      }
      if let heading = Self.heading(line) {
        result.append(MarkdownBlock(id: id(), kind: .heading(level: heading.level, inline(heading.text))))
        index += 1
        continue
      }
      if Self.isThematicBreak(line) {
        result.append(MarkdownBlock(id: id(), kind: .thematicBreak))
        index += 1
        continue
      }
      if Self.quoteContent(line) != nil {
        var inner: [Substring] = []
        while index < lines.endIndex, let content = Self.quoteContent(lines[index]) {
          inner.append(content)
          index += 1
        }
        let blockId = id()
        result.append(MarkdownBlock(id: blockId, kind: .quote(blocks(inner[...], path: blockId))))
        continue
      }
      if Self.listMarker(line) != nil {
        let blockId = id()
        let (list, next) = parseList(lines, from: index, path: blockId)
        result.append(MarkdownBlock(id: blockId, kind: .list(list)))
        index = next
        continue
      }
      if index + 1 < lines.endIndex, line.contains("|"), let alignments = Self.delimiterRow(lines[index + 1]) {
        let header = Self.cells(line)
        if header.count == alignments.count || header.count > 0 {
          var rows: [[InlineText]] = []
          var cursor = index + 2
          while cursor < lines.endIndex, !Self.isBlank(lines[cursor]), lines[cursor].contains("|") {
            rows.append(Self.fit(Self.cells(lines[cursor]), to: alignments.count).map(inline))
            cursor += 1
          }
          let table = MarkdownTable(
            alignments: alignments, header: Self.fit(header, to: alignments.count).map(inline), rows: rows)
          result.append(MarkdownBlock(id: id(), kind: .table(table)))
          index = cursor
          continue
        }
      }
      // A paragraph runs until a blank line or the start of another block.
      var paragraph: [Substring] = [line]
      index += 1
      while index < lines.endIndex, !Self.isBlank(lines[index]), !Self.interruptsParagraph(lines, at: index) {
        paragraph.append(lines[index])
        index += 1
      }
      let text = paragraph.map { $0.drop { $0 == " " || $0 == "\t" } }.joined(separator: "\n")
      if let image = Self.imageOnly(text) {
        result.append(MarkdownBlock(id: id(), kind: .image(alt: image.alt, source: image.source)))
      } else {
        result.append(MarkdownBlock(id: id(), kind: .paragraph(inline(text))))
      }
    }
    return result
  }

  private func parseList(_ lines: ArraySlice<Substring>, from start: Int, path: String) -> (MarkdownList, Int) {
    guard let first = Self.listMarker(lines[start]) else { return (MarkdownList(start: nil, items: []), start + 1) }
    var items: [MarkdownList.Item] = []
    var index = start
    while index < lines.endIndex, let marker = Self.listMarker(lines[index]), marker.sameList(as: first),
      marker.indent < first.contentIndent
    {
      var body: [Substring] = [Self.itemContent(lines[index], marker)]
      index += 1
      var pendingBlank = 0
      while index < lines.endIndex {
        let line = lines[index]
        if Self.isBlank(line) {
          pendingBlank += 1
          index += 1
          continue
        }
        let indent = Self.indentWidth(line)
        if let next = Self.listMarker(line), next.indent <= marker.indent { break }
        if indent >= marker.contentIndent || (indent > marker.indent && Self.listMarker(line) != nil) {
          body.append(contentsOf: Array(repeating: "", count: pendingBlank))
          body.append(Self.strip(line, indent: min(indent, marker.contentIndent)))
          pendingBlank = 0
          index += 1
          continue
        }
        // Lazy continuation of the item's last paragraph.
        if pendingBlank == 0, !Self.interruptsParagraph(lines, at: index) {
          body.append(line.drop { $0 == " " || $0 == "\t" })
          index += 1
          continue
        }
        break
      }
      var checked: Bool?
      if let firstLine = body.first, let task = firstLine.firstMatch(of: /^\[([ xX])\][ \t]+/) {
        checked = task.1 != " "
        body[0] = firstLine[task.range.upperBound...]
      }
      let itemId = "\(path).\(items.count)"
      items.append(MarkdownList.Item(id: itemId, checked: checked, blocks: blocks(body[...], path: itemId)))
    }
    return (MarkdownList(start: first.ordinal, items: items), index)
  }

  // MARK: Inline

  public func inline(_ source: String) -> InlineText {
    if let cached = inlineCache[source] { return cached }
    let options = AttributedString.MarkdownParsingOptions(
      allowsExtendedAttributes: false, interpretedSyntax: .inlineOnlyPreservingWhitespace,
      failurePolicy: .returnPartiallyParsedIfPossible)
    var attributed = (try? AttributedString(markdown: source, options: options)) ?? AttributedString(source)
    var codeRanges: [Range<AttributedString.Index>] = []
    var linkRanges: [Range<AttributedString.Index>] = []
    for run in attributed.runs {
      if run.inlinePresentationIntent?.contains(.code) == true { codeRanges.append(run.range) }
      if run.link != nil { linkRanges.append(run.range) }
    }
    for range in codeRanges { attributed[range].mergeAttributes(style.inlineCode) }
    let plain = String(attributed.characters)
    if let linkDetector, plain.contains("://") || plain.contains("www.") {
      let matches = linkDetector.matches(in: plain, range: NSRange(plain.startIndex..., in: plain))
      for match in matches {
        guard let url = match.url, let range = Range(match.range, in: attributed),
          !codeRanges.contains(where: { $0.overlaps(range) }), !linkRanges.contains(where: { $0.overlaps(range) })
        else { continue }
        attributed[range].link = url
        linkRanges.append(range)
      }
    }
    for range in linkRanges { attributed[range].mergeAttributes(style.link) }
    let text = InlineText(attributed: attributed)
    inlineCache[source] = text
    return text
  }

  private func codeBlock(_ code: String, language: String?, closed: Bool) -> CodeBlock {
    let key = "\(language ?? "")\u{1}\(code)"
    let highlighted: AttributedString
    if let cached = codeCache[key] {
      highlighted = cached
    } else {
      highlighted = highlighter.highlight(code, language: language)
      codeCache[key] = highlighted
    }
    return CodeBlock(language: language, code: code, highlighted: highlighted, closed: closed)
  }

  // MARK: Line classification

  struct Fence {
    var marker: Character
    var length: Int
    var indent: Int
    var language: String?
  }

  struct ListMarker {
    var indent: Int
    var bullet: Character?
    var ordinal: Int?
    var delimiter: Character?
    var markerWidth: Int
    var contentIndent: Int

    func sameList(as other: ListMarker) -> Bool {
      bullet == other.bullet && delimiter == other.delimiter && (ordinal == nil) == (other.ordinal == nil)
    }
  }

  static func isBlank(_ line: Substring) -> Bool {
    line.allSatisfy { $0 == " " || $0 == "\t" }
  }

  static func indentWidth(_ line: Substring) -> Int {
    var width = 0
    for character in line {
      if character == " " { width += 1 } else if character == "\t" { width += 4 } else { break }
    }
    return width
  }

  /// Drops up to `indent` columns of leading whitespace.
  static func strip(_ line: Substring, indent: Int) -> Substring {
    var remaining = indent
    var index = line.startIndex
    while remaining > 0, index < line.endIndex, line[index] == " " || line[index] == "\t" {
      remaining -= line[index] == "\t" ? 4 : 1
      index = line.index(after: index)
    }
    return line[index...]
  }

  static func fenceOpen(_ line: Substring) -> Fence? {
    let indent = indentWidth(line)
    guard indent <= 3 else { return nil }
    let rest = line.drop { $0 == " " }
    guard let marker = rest.first, marker == "`" || marker == "~" else { return nil }
    let run = rest.prefix { $0 == marker }
    guard run.count >= 3 else { return nil }
    let info = rest.dropFirst(run.count).trimmingCharacters(in: .whitespaces)
    if marker == "`", info.contains("`") { return nil }
    let language = info.split(separator: " ").first.map { String($0).lowercased() }
    return Fence(marker: marker, length: run.count, indent: indent, language: language?.nilIfEmpty)
  }

  static func closesFence(_ line: Substring, _ fence: Fence) -> Bool {
    guard indentWidth(line) <= 3 else { return false }
    let rest = line.drop { $0 == " " }
    let run = rest.prefix { $0 == fence.marker }
    return run.count >= fence.length && rest.dropFirst(run.count).allSatisfy { $0 == " " || $0 == "\t" }
  }

  static func heading(_ line: Substring) -> (level: Int, text: String)? {
    guard indentWidth(line) <= 3 else { return nil }
    let rest = line.drop { $0 == " " }
    let hashes = rest.prefix { $0 == "#" }
    guard (1...6).contains(hashes.count) else { return nil }
    let after = rest.dropFirst(hashes.count)
    guard after.isEmpty || after.first == " " || after.first == "\t" else { return nil }
    var text = after.trimmingCharacters(in: .whitespaces)
    if let closing = text.firstMatch(of: /(?:^|\s)#+\s*$/) { text = String(text[..<closing.range.lowerBound]) }
    return (hashes.count, text.trimmingCharacters(in: .whitespaces))
  }

  static func isThematicBreak(_ line: Substring) -> Bool {
    guard indentWidth(line) <= 3 else { return false }
    let marks = line.filter { $0 != " " && $0 != "\t" }
    guard let first = marks.first, first == "-" || first == "*" || first == "_" else { return false }
    return marks.count >= 3 && marks.allSatisfy { $0 == first }
  }

  static func quoteContent(_ line: Substring) -> Substring? {
    guard indentWidth(line) <= 3 else { return nil }
    let rest = line.drop { $0 == " " }
    guard rest.first == ">" else { return nil }
    let content = rest.dropFirst()
    return content.first == " " ? content.dropFirst() : content
  }

  static func listMarker(_ line: Substring) -> ListMarker? {
    let indent = indentWidth(line)
    let rest = line.drop { $0 == " " || $0 == "\t" }
    guard let first = rest.first else { return nil }
    let markerWidth: Int
    var bullet: Character?
    var ordinal: Int?
    var delimiter: Character?
    if first == "-" || first == "*" || first == "+" {
      markerWidth = 1
      bullet = first
    } else {
      let digits = rest.prefix { $0.isASCII && $0.isNumber }
      guard (1...9).contains(digits.count), let value = Int(digits) else { return nil }
      let after = rest.dropFirst(digits.count)
      guard let mark = after.first, mark == "." || mark == ")" else { return nil }
      markerWidth = digits.count + 1
      ordinal = value
      delimiter = mark
    }
    let afterMarker = rest.dropFirst(markerWidth)
    if afterMarker.isEmpty {
      return ListMarker(
        indent: indent, bullet: bullet, ordinal: ordinal, delimiter: delimiter, markerWidth: markerWidth,
        contentIndent: indent + markerWidth + 1)
    }
    let spaces = afterMarker.prefix { $0 == " " || $0 == "\t" }.count
    guard spaces > 0 else { return nil }
    // A bullet followed by a thematic break pattern is a rule, not a list.
    if bullet != nil, isThematicBreak(line) { return nil }
    let padding = spaces > 4 ? 1 : spaces
    return ListMarker(
      indent: indent, bullet: bullet, ordinal: ordinal, delimiter: delimiter, markerWidth: markerWidth,
      contentIndent: indent + markerWidth + padding)
  }

  /// The first line of a list item after its marker and padding.
  static func itemContent(_ line: Substring, _ marker: ListMarker) -> Substring {
    let rest = line.drop { $0 == " " || $0 == "\t" }
    let afterMarker = rest.dropFirst(marker.markerWidth)
    let padding = afterMarker.prefix { $0 == " " || $0 == "\t" }.count
    return afterMarker.dropFirst(padding > 4 ? 1 : padding)
  }

  static func interruptsParagraph(_ lines: ArraySlice<Substring>, at index: Int) -> Bool {
    let line = lines[index]
    if fenceOpen(line) != nil || heading(line) != nil || isThematicBreak(line) || quoteContent(line) != nil {
      return true
    }
    if let marker = listMarker(line), indentWidth(line) <= 3 {
      // An ordered list interrupts a paragraph only when it starts at 1, and an empty item never does.
      return !itemContent(line, marker).isEmpty && (marker.ordinal == nil || marker.ordinal == 1)
    }
    if line.contains("|"), index + 1 < lines.endIndex, delimiterRow(lines[index + 1]) != nil { return true }
    return false
  }

  static func cells(_ line: Substring) -> [String] {
    var text = line.trimmingCharacters(in: .whitespaces)
    if text.hasPrefix("|") { text.removeFirst() }
    if text.hasSuffix("|"), !text.hasSuffix("\\|") { text.removeLast() }
    var cells: [String] = []
    var current = ""
    var inCode = false
    var escaped = false
    for character in text {
      if escaped {
        if character != "|" { current.append("\\") }
        current.append(character)
        escaped = false
      } else if character == "\\" {
        escaped = true
      } else if character == "`" {
        inCode.toggle()
        current.append(character)
      } else if character == "|", !inCode {
        cells.append(current.trimmingCharacters(in: .whitespaces))
        current = ""
      } else {
        current.append(character)
      }
    }
    if escaped { current.append("\\") }
    cells.append(current.trimmingCharacters(in: .whitespaces))
    return cells
  }

  static func delimiterRow(_ line: Substring) -> [MarkdownTable.Alignment]? {
    guard line.contains("-"), indentWidth(line) <= 3 else { return nil }
    let parts = cells(line)
    guard !parts.isEmpty, line.contains("|") || parts.count > 1 else { return nil }
    var alignments: [MarkdownTable.Alignment] = []
    for part in parts {
      guard part.wholeMatch(of: /:?-+:?/) != nil else { return nil }
      let leading = part.hasPrefix(":")
      let trailing = part.hasSuffix(":")
      alignments.append(leading && trailing ? .center : trailing ? .trailing : .leading)
    }
    return alignments
  }

  static func fit(_ cells: [String], to count: Int) -> [String] {
    cells.count >= count ? Array(cells.prefix(count)) : cells + Array(repeating: "", count: count - cells.count)
  }

  static func imageOnly(_ text: String) -> (alt: String, source: String)? {
    guard let match = text.wholeMatch(of: /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/) else { return nil }
    return (String(match.1), String(match.2))
  }
}
