import AnkielKit
import SwiftUI
import UIKit

/// A text file with line numbers and the in-house highlighter. Rows are lazy and styled as they
/// appear, so a 1 MiB file opens at once. Unwrapped, the column is as wide as the longest line
/// (monospaced, so that is a multiplication, not a measurement) and scrolls sideways.
struct SourceTextView: View {
  let document: SourceDocument
  /// A line to scroll to and mark (from a `path:12` link).
  var targetLine: Int?
  /// Lines matching the find query, and the one selected.
  var matches: [Int] = []
  var currentMatch: Int?
  @Environment(\.codeAppearance) private var code
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize

  /// Longer lines are cut for display: a minified 1 MB line would stall text layout.
  static let maxLineLength = 2_000

  private var uiFont: UIFont {
    let size = code.fontSize.map { CGFloat($0) } ?? UIFont.preferredFont(forTextStyle: .footnote).pointSize
    return UIFont.monospacedSystemFont(ofSize: size, weight: .regular)
  }

  private var characterWidth: CGFloat {
    ("M" as NSString).size(withAttributes: [.font: uiFont]).width
  }

  private var gutterWidth: CGFloat {
    CGFloat(max(String(document.lineCount).count, 2)) * characterWidth + Spacing.md
  }

  private var columnWidth: CGFloat {
    gutterWidth + CGFloat(min(document.longestLine, Self.maxLineLength) + 1) * characterWidth + Spacing.lg * 2
  }

  private static let style = MarkdownStyle.thread.tokens

  var body: some View {
    ScrollViewReader { proxy in
      Group {
        if code.wraps {
          ScrollView(.vertical) { lines }
        } else {
          ScrollView([.vertical, .horizontal]) {
            lines.frame(width: columnWidth, alignment: .leading)
          }
        }
      }
      .scrollIndicators(.automatic)
      .onAppear {
        if let targetLine { proxy.scrollTo(max(targetLine - 4, 0), anchor: .topLeading) }
      }
      .onChange(of: currentMatch) { _, match in
        if let match { proxy.scrollTo(match, anchor: UnitPoint(x: 0, y: 0.4)) }
      }
    }
    .accessibilityIdentifier("file.source")
  }

  private var lines: some View {
    let matched = Set(matches)
    return LazyVStack(alignment: .leading, spacing: 0) {
      ForEach(0..<document.lineCount, id: \.self) { index in
        SourceLine(
          number: index + 1, text: text(index), gutterWidth: gutterWidth, font: Font(uiFont),
          mark: index + 1 == targetLine ? .target : index == currentMatch ? .current : matched.contains(index) ? .match : nil)
      }
    }
    .padding(.vertical, Spacing.md)
    .textSelection(.enabled)
  }

  private func text(_ index: Int) -> AttributedString {
    // An empty Text is shorter than a line of text; a space keeps every row one line tall.
    if document.lines[index].isEmpty { return AttributedString(" ") }
    if document.lines[index].count > Self.maxLineLength {
      return AttributedString(document.lines[index].prefix(Self.maxLineLength)) + AttributedString(" …")
    }
    return document.attributedLine(index, style: Self.style)
  }
}

private struct SourceLine: View {
  enum Mark { case target, match, current }

  let number: Int
  let text: AttributedString
  let gutterWidth: CGFloat
  let font: Font
  let mark: Mark?

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 0) {
      Text(verbatim: "\(number)")
        .font(font)
        .foregroundStyle(Palette.textTertiary)
        .frame(width: gutterWidth - Spacing.md, alignment: .trailing)
        .padding(.trailing, Spacing.md)
        .accessibilityHidden(true)
      Text(text)
        .font(font)
        .foregroundStyle(Palette.textPrimary)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    .padding(.horizontal, Spacing.lg)
    .padding(.vertical, 1)
    .background(background)
    .id(number - 1)
  }

  private var background: Color {
    switch mark {
    case .target: Palette.attention.opacity(0.16)
    case .current: Palette.working.opacity(0.22)
    case .match: Palette.working.opacity(0.09)
    case nil: .clear
    }
  }
}
