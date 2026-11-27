import AnkielKit
import SwiftUI
import UIKit

extension MarkdownStyle {
  /// The thread screen's markdown look. Colors are dynamic, so one parse serves both appearances.
  static var thread: MarkdownStyle {
    func color(_ color: Color) -> AttributeContainer {
      var container = AttributeContainer()
      container.swiftUI.foregroundColor = color
      return container
    }
    var inlineCode = AttributeContainer()
    inlineCode.swiftUI.backgroundColor = Palette.inlineCode
    var link = AttributeContainer()
    link.swiftUI.foregroundColor = Palette.working
    link.swiftUI.underlineStyle = .init(pattern: .solid, color: Palette.working.opacity(0.35))
    return MarkdownStyle(
      inlineCode: inlineCode, link: link,
      tokens: [
        .keyword: color(Palette.codeKeyword), .string: color(Palette.codeString), .comment: color(Palette.codeComment),
        .number: color(Palette.codeNumber), .type: color(Palette.codeType), .property: color(Palette.codeProperty),
        .tag: color(Palette.codeKeyword), .attribute: color(Palette.codeProperty), .added: color(Palette.diffAdded),
        .removed: color(Palette.diffRemoved), .hunk: color(Palette.codeType), .meta: color(Palette.codeComment),
      ])
  }
}

/// A parsed markdown message. Blocks are equatable, so a streaming reply re-renders only the block
/// still being written.
struct MarkdownView: View {
  let document: MarkdownDocument
  var images: ThreadImages = .none
  /// The reply is still being written: its last paragraph fades new text in.
  var streaming = false

  var body: some View {
    VStack(alignment: .leading, spacing: Spacing.md) {
      ForEach(document.blocks) { block in
        if streaming, block.id == document.blocks.last?.id, case .paragraph(let text) = block.kind {
          StreamingParagraph(text: text)
        } else {
          MarkdownBlockView(block: block, images: images)
            .equatable()
        }
      }
    }
  }
}

struct MarkdownBlockView: View, Equatable {
  let block: MarkdownBlock
  let images: ThreadImages

  nonisolated static func == (lhs: Self, rhs: Self) -> Bool { lhs.block == rhs.block }

  var body: some View {
    switch block.kind {
    case .heading(let level, let text):
      Text(text.attributed)
        .font(Self.headingFont(level))
        .foregroundStyle(Palette.textPrimary)
        .padding(.top, level <= 2 ? Spacing.xs : 0)
        .accessibilityAddTraits(.isHeader)
        .textSelection(.enabled)
    case .paragraph(let text):
      Text(text.attributed)
        .font(Typography.body)
        .lineSpacing(3)
        .foregroundStyle(Palette.textPrimary)
        .fixedSize(horizontal: false, vertical: true)
        .textSelection(.enabled)
    case .list(let list):
      ListBlockView(list: list, images: images)
    case .quote(let blocks):
      HStack(alignment: .top, spacing: Spacing.md) {
        Capsule().fill(Palette.quoteBar).frame(width: 3)
        VStack(alignment: .leading, spacing: Spacing.sm) {
          ForEach(blocks) { MarkdownBlockView(block: $0, images: images) }
        }
        .foregroundStyle(Palette.textSecondary)
      }
      .fixedSize(horizontal: false, vertical: true)
    case .code(let code):
      CodeBlockView(code: code)
    case .table(let table):
      TableBlockView(table: table)
    case .image(let alt, let source):
      MarkdownImageView(alt: alt, source: source, images: images)
    case .thematicBreak:
      Rectangle().fill(Palette.separator).frame(height: 1).padding(.vertical, Spacing.xs)
        .accessibilityHidden(true)
    }
  }

  static func headingFont(_ level: Int) -> Font {
    switch level {
    case 1: .title3.weight(.semibold)
    case 2: .headline
    default: .subheadline.weight(.semibold)
    }
  }
}

private struct ListBlockView: View {
  let list: MarkdownList
  let images: ThreadImages
  @ScaledMetric(relativeTo: .body) private var markerWidth: CGFloat = 18

  var body: some View {
    VStack(alignment: .leading, spacing: Spacing.sm) {
      ForEach(Array(list.items.enumerated()), id: \.element.id) { index, item in
        HStack(alignment: .firstTextBaseline, spacing: Spacing.sm) {
          marker(index: index, item: item)
            .frame(minWidth: markerWidth, alignment: .trailing)
          VStack(alignment: .leading, spacing: Spacing.sm) {
            ForEach(item.blocks) { MarkdownBlockView(block: $0, images: images) }
          }
        }
      }
    }
  }

  @ViewBuilder
  private func marker(index: Int, item: MarkdownList.Item) -> some View {
    if let checked = item.checked {
      Image(systemName: checked ? "checkmark.square.fill" : "square")
        .font(Typography.subheadline)
        .foregroundStyle(checked ? Palette.textPrimary : Palette.textTertiary)
        .accessibilityLabel(checked ? Text("Done") : Text("Not done"))
    } else if let start = list.start {
      Text(verbatim: "\(start + index).")
        .font(Typography.body.monospacedDigit())
        .foregroundStyle(Palette.textSecondary)
    } else {
      Text(verbatim: "•")
        .font(Typography.body.weight(.bold))
        .foregroundStyle(Palette.textTertiary)
    }
  }
}

/// A fenced block: language label, copy, and horizontal scroll for long lines.
struct CodeBlockView: View {
  let code: CodeBlock
  @State private var copied = 0
  @Environment(\.codeAppearance) private var codeAppearance

  private var codeText: some View {
    Text(code.highlighted)
      .font(codeAppearance.font)
      .foregroundStyle(Palette.textPrimary)
      .lineSpacing(2)
      .textSelection(.enabled)
      .padding(Spacing.md)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack {
        Text(code.language ?? String(localized: "Code", comment: "label of a code block with no language"))
          .font(Typography.caption.monospaced())
          .foregroundStyle(Palette.textSecondary)
        Spacer()
        Button {
          UIPasteboard.general.string = code.code
          copied += 1
        } label: {
          Image(systemName: copied > 0 ? "checkmark" : "doc.on.doc")
            .contentTransition(.symbolEffect(.replace))
            .font(Typography.footnote)
            .foregroundStyle(Palette.textSecondary)
            .frame(width: 44, height: 36)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text("Copy code"))
        .sensoryFeedback(.success, trigger: copied)
      }
      .padding(.leading, Spacing.md)
      .background(Palette.codeHeader)
      if codeAppearance.wraps {
        codeText
          .fixedSize(horizontal: false, vertical: true)
          .frame(maxWidth: .infinity, alignment: .leading)
      } else {
        ScrollView(.horizontal) {
          codeText.fixedSize(horizontal: true, vertical: true)
        }
        .scrollIndicators(.hidden)
        .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
      }
    }
    .background(Palette.codeBackground, in: .rect(cornerRadius: Radius.medium, style: .continuous))
    .clipShape(.rect(cornerRadius: Radius.medium, style: .continuous))
    .overlay {
      RoundedRectangle(cornerRadius: Radius.medium, style: .continuous).strokeBorder(Palette.separator, lineWidth: 0.5)
    }
  }
}

private struct TableBlockView: View {
  let table: MarkdownTable
  @ScaledMetric(relativeTo: .subheadline) private var maxColumn: CGFloat = 240

  var body: some View {
    ScrollView(.horizontal) {
      Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
        GridRow {
          ForEach(Array(table.header.enumerated()), id: \.offset) { column, cell in
            cellView(cell, column: column).font(Typography.subheadline.weight(.semibold))
          }
        }
        .background(Palette.codeHeader)
        ForEach(Array(table.rows.enumerated()), id: \.offset) { _, row in
          Divider().gridCellUnsizedAxes(.horizontal)
          GridRow {
            ForEach(Array(row.enumerated()), id: \.offset) { column, cell in
              cellView(cell, column: column).font(Typography.subheadline)
            }
          }
        }
      }
      .clipShape(.rect(cornerRadius: Radius.small, style: .continuous))
      .overlay {
        RoundedRectangle(cornerRadius: Radius.small, style: .continuous).strokeBorder(Palette.separator, lineWidth: 0.5)
      }
    }
    .scrollIndicators(.hidden)
    .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
  }

  private func cellView(_ cell: InlineText, column: Int) -> some View {
    let alignment: Alignment =
      switch table.alignments[safe: column] ?? .leading {
      case .leading: .leading
      case .center: .center
      case .trailing: .trailing
      }
    return Text(cell.attributed)
      .foregroundStyle(Palette.textPrimary)
      .fixedSize(horizontal: false, vertical: true)
      .frame(minWidth: 44, maxWidth: maxColumn, alignment: alignment)
      .padding(.horizontal, Spacing.md)
      .padding(.vertical, Spacing.sm)
      .gridColumnAlignment(alignment.horizontal)
  }
}

private struct MarkdownImageView: View {
  let alt: String
  let source: String
  let images: ThreadImages

  var body: some View {
    RemoteImage(source: .markdown(source), images: images, maxPixel: 1600) {
      Label(alt.isEmpty ? source : alt, systemImage: "photo")
        .font(Typography.footnote)
        .foregroundStyle(Palette.textSecondary)
        .frame(maxWidth: .infinity, minHeight: 72)
        .background(Palette.codeBackground, in: .rect(cornerRadius: Radius.medium, style: .continuous))
    }
    .frame(maxWidth: .infinity, maxHeight: 360, alignment: .leading)
    .clipShape(.rect(cornerRadius: Radius.medium, style: .continuous))
    .accessibilityLabel(alt.isEmpty ? Text("Image") : Text(alt))
  }
}

extension Array {
  subscript(safe index: Int) -> Element? { indices.contains(index) ? self[index] : nil }
}
