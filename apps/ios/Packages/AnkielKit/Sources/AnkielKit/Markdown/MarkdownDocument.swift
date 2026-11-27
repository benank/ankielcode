import Foundation

/// A parsed markdown message: block structure from `MarkdownParser`, inline styles from
/// Foundation's markdown parser (`inlinePresentationIntent` and `link` attributes, which SwiftUI
/// `Text` renders natively).
public struct MarkdownDocument: Sendable, Hashable {
  public var blocks: [MarkdownBlock]

  public init(blocks: [MarkdownBlock]) {
    self.blocks = blocks
  }

  public static let empty = MarkdownDocument(blocks: [])
}

/// One block. `id` is its position path (`"3"`, `"3.1.0"`): stable while a streaming message
/// grows, so SwiftUI keeps finished blocks and diffs only the one still being written.
public struct MarkdownBlock: Sendable, Hashable, Identifiable {
  public var id: String
  public var kind: Kind

  public enum Kind: Sendable, Hashable {
    case heading(level: Int, InlineText)
    case paragraph(InlineText)
    case list(MarkdownList)
    case quote([MarkdownBlock])
    case code(CodeBlock)
    case table(MarkdownTable)
    case image(alt: String, source: String)
    case thematicBreak
  }
}

/// Styled inline text. `plain` is the text without markup, for copying and accessibility.
public struct InlineText: Sendable, Hashable {
  public var attributed: AttributedString
  public var plain: String

  public init(attributed: AttributedString) {
    self.attributed = attributed
    plain = String(attributed.characters)
  }
}

public struct MarkdownList: Sendable, Hashable {
  /// The first number of an ordered list; nil for bullets.
  public var start: Int?
  public var items: [Item]

  public struct Item: Sendable, Hashable, Identifiable {
    public var id: String
    /// `[ ]` / `[x]` task items.
    public var checked: Bool?
    public var blocks: [MarkdownBlock]
  }
}

public struct CodeBlock: Sendable, Hashable {
  public var language: String?
  public var code: String
  public var highlighted: AttributedString
  /// False while a streaming fence has not closed yet.
  public var closed: Bool
}

public struct MarkdownTable: Sendable, Hashable {
  public var alignments: [Alignment]
  public var header: [InlineText]
  public var rows: [[InlineText]]

  public enum Alignment: Sendable, Hashable {
    case leading, center, trailing
  }
}

extension MarkdownDocument {
  /// The text without markup, blocks separated by blank lines.
  public var plainText: String {
    blocks.map(\.plainText).joined(separator: "\n\n")
  }
}

extension MarkdownBlock {
  public var plainText: String {
    switch kind {
    case .heading(_, let text), .paragraph(let text): text.plain
    case .list(let list):
      list.items.enumerated().map { index, item in
        let marker = list.start.map { "\($0 + index)." } ?? "•"
        return "\(marker) " + item.blocks.map(\.plainText).joined(separator: "\n")
      }.joined(separator: "\n")
    case .quote(let blocks): blocks.map(\.plainText).joined(separator: "\n")
    case .code(let code): code.code
    case .table(let table):
      ([table.header] + table.rows).map { $0.map(\.plain).joined(separator: "\t") }.joined(separator: "\n")
    case .image(let alt, _): alt
    case .thematicBreak: "—"
    }
  }
}
