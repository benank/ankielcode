import AnkielKit
import SwiftUI
import UIKit

extension Palette {
  /// Diff rows: quiet tints so code stays readable; the changed words are marked stronger.
  static let diffAddedRow = Color(light: 0xE9F6EE, dark: 0x13261B)
  static let diffRemovedRow = Color(light: 0xFCECEB, dark: 0x2C1716)
  static let diffAddedWord = Color(light: 0xBFE6CC, dark: 0x1F4A30)
  static let diffRemovedWord = Color(light: 0xF6C9C6, dark: 0x5A2623)
  static let diffHunk = Color(light: 0xEEF1F6, dark: 0x171A20)
  static let diffSelected = Color(light: 0xDCE7FB, dark: 0x1D2B45)
  static let diffGutter = Color(light: 0x8A8F98, dark: 0x6E737C)
}

/// What a line gesture means (RN `onPressLine`): a tap comments on the line (or ends a range), a
/// long press starts a range.
enum DiffLineGesture { case tap, longPress }

/// A file's diff rows: virtualized (`LazyVStack`), one `Text` per line, no per-row geometry.
/// Unwrapped, the column is as wide as the longest line (monospaced, so a multiplication) and
/// scrolls sideways with its gutter.
struct DiffLinesView: View {
  let rows: [DiffRow]
  let language: String?
  let columns: Int
  let wraps: Bool
  let expandable: Bool
  let expanding: Bool
  let selected: Set<String>
  let onLine: (DiffRow, DiffLineGesture) -> Void
  let onExpand: (Gap) -> Void
  @Environment(\.codeAppearance) private var code
  @State private var viewport: CGFloat = 0

  private var metrics: DiffMetrics { DiffMetrics(fontSize: code.fontSize, columns: columns, maxNumber: maxNumber) }

  private var maxNumber: Int {
    rows.last(where: { $0.line != nil })?.line.map { max($0.oldNumber ?? 0, $0.newNumber ?? 0) } ?? 0
  }

  var body: some View {
    let metrics = metrics
    ScrollView(wraps ? .vertical : [.vertical, .horizontal]) {
      LazyVStack(alignment: .leading, spacing: 0) {
        ForEach(rows) { row in
          DiffRowView(
            row: row, language: language, metrics: metrics, wraps: wraps, expandable: expandable, expanding: expanding,
            selected: selected.contains(row.id), onLine: onLine, onExpand: onExpand
          )
          .equatable()
        }
      }
      .padding(.vertical, Spacing.sm)
      .frame(width: wraps ? nil : max(metrics.contentWidth, viewport), alignment: .leading)
    }
    .scrollIndicators(.automatic)
    .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { viewport = $0 }
    .accessibilityIdentifier("review.diff")
  }
}

/// Font and widths, computed once per file.
nonisolated struct DiffMetrics: Equatable {
  let font: UIFont
  let characterWidth: CGFloat
  let numberWidth: CGFloat
  let contentWidth: CGFloat

  init(fontSize: Double?, columns: Int, maxNumber: Int) {
    let size = fontSize.map { CGFloat($0) } ?? UIFont.preferredFont(forTextStyle: .footnote).pointSize
    font = UIFont.monospacedSystemFont(ofSize: size, weight: .regular)
    characterWidth = ("M" as NSString).size(withAttributes: [.font: font]).width
    // Spacing.sm and Spacing.lg (the design tokens are main-actor isolated).
    numberWidth = CGFloat(max(String(maxNumber).count, 2)) * characterWidth + 8
    contentWidth = numberWidth * 2 + characterWidth * CGFloat(min(columns, DiffText.maxLineLength) + 4) + 16 * 2
  }

  var gutterWidth: CGFloat { numberWidth * 2 + characterWidth * 2 }
}

private struct DiffRowView: View, Equatable {
  let row: DiffRow
  let language: String?
  let metrics: DiffMetrics
  let wraps: Bool
  let expandable: Bool
  let expanding: Bool
  let selected: Bool
  let onLine: (DiffRow, DiffLineGesture) -> Void
  let onExpand: (Gap) -> Void

  nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
    lhs.row == rhs.row && lhs.metrics == rhs.metrics && lhs.wraps == rhs.wraps && lhs.selected == rhs.selected
      && lhs.expandable == rhs.expandable && lhs.expanding == rhs.expanding && lhs.language == rhs.language
  }

  var body: some View {
    switch row.content {
    case .line(let line, let changed): lineRow(line, changed: changed)
    case .hunk(let header, let context): hunkRow(header, context: context)
    case .gap(let gap): gapRow(gap)
    }
  }

  private var font: Font { Font(metrics.font) }

  private func lineRow(_ line: DiffLine, changed: [Range<Int>]) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 0) {
      number(line.oldNumber)
      number(line.newNumber)
      Text(verbatim: marker(line.kind))
        .foregroundStyle(markerColor(line.kind))
        .frame(width: metrics.characterWidth * 2)
      Text(DiffText.attributed(line.text, language: language, kind: line.kind, changed: changed))
        .lineLimit(wraps ? nil : 1)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.trailing, Spacing.lg)
    }
    .font(font)
    .padding(.vertical, 1)
    .background(background(line.kind))
    .contentShape(.rect)
    // One gesture, the long press first: separate tap and long-press modifiers let the tap win.
    .gesture(
      LongPressGesture(minimumDuration: 0.35).onEnded { _ in onLine(row, .longPress) }
        .exclusively(before: TapGesture().onEnded { onLine(row, .tap) }))
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(DiffText.accessibilityLabel(line))
    .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    .accessibilityHint(Text("Adds a comment on this line"))
    .accessibilityAction(named: Text("Select range")) { onLine(row, .longPress) }
    .accessibilityIdentifier("review.line")
  }

  private func number(_ value: Int?) -> some View {
    Text(verbatim: value.map(String.init) ?? "")
      .foregroundStyle(Palette.diffGutter)
      .frame(width: metrics.numberWidth, alignment: .trailing)
  }

  private func marker(_ kind: DiffLine.Kind) -> String {
    switch kind {
    case .added: "+"
    case .removed: "−"
    case .context: " "
    }
  }

  private func markerColor(_ kind: DiffLine.Kind) -> Color {
    switch kind {
    case .added: Palette.diffAdded
    case .removed: Palette.diffRemoved
    case .context: Palette.diffGutter
    }
  }

  private func background(_ kind: DiffLine.Kind) -> Color {
    if selected { return Palette.diffSelected }
    switch kind {
    case .added: return Palette.diffAddedRow
    case .removed: return Palette.diffRemovedRow
    case .context: return .clear
    }
  }

  private func hunkRow(_ header: String, context: String?) -> some View {
    HStack(spacing: Spacing.sm) {
      Text(verbatim: header).foregroundStyle(Palette.working)
      if let context { Text(verbatim: context).foregroundStyle(Palette.textSecondary) }
    }
    .font(font)
    .lineLimit(1)
    .padding(.leading, metrics.gutterWidth)
    .padding(.vertical, Spacing.xs + 1)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Palette.diffHunk)
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("review.hunk")
  }

  @ViewBuilder
  private func gapRow(_ gap: Gap) -> some View {
    let label: String =
      if let count = gap.count { String(localized: "\(count) unchanged lines") } else { String(localized: "Show more lines") }
    if expandable {
      Button {
        onExpand(gap)
      } label: {
        HStack(spacing: Spacing.sm) {
          if expanding {
            ProgressView().controlSize(.mini)
          } else {
            Image(systemName: "arrow.up.and.down").imageScale(.small)
          }
          Text(verbatim: label)
        }
        .font(Typography.footnote.weight(.medium))
        .foregroundStyle(Palette.working)
        .padding(.leading, metrics.gutterWidth)
        .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
        .contentShape(.rect)
      }
      .buttonStyle(.plain)
      .accessibilityHint(Text("Shows the unchanged lines"))
      .accessibilityIdentifier("review.expand")
    } else if gap.count != nil {
      Text(verbatim: label)
        .font(Typography.caption)
        .foregroundStyle(Palette.textTertiary)
        .padding(.leading, metrics.gutterWidth)
        .frame(maxWidth: .infinity, minHeight: 28, alignment: .leading)
    }
  }
}

/// Line text: highlighted, changed words marked, tabs expanded, very long lines cut.
enum DiffText {
  nonisolated static let maxLineLength = 2_000
  nonisolated static let tabWidth = 4
  private static let tokens = MarkdownStyle.thread.tokens

  static func attributed(_ raw: String, language: String?, kind: DiffLine.Kind, changed: [Range<Int>]) -> AttributedString {
    let (text, offsets) = expandTabs(raw)
    guard !text.isEmpty else { return AttributedString(" ") }
    let cut = text.count > maxLineLength
    var attributed = CodeHighlighter(style: tokens).highlight(cut ? String(text.prefix(maxLineLength)) : text, language: language)
    if !changed.isEmpty {
      let mark = kind == .added ? Palette.diffAddedWord : Palette.diffRemovedWord
      let count = attributed.characters.count
      for range in changed {
        let lower = min(offsets(range.lowerBound), count)
        let upper = min(offsets(range.upperBound), count)
        guard lower < upper else { continue }
        let start = attributed.characters.index(attributed.startIndex, offsetBy: lower)
        let end = attributed.characters.index(start, offsetBy: upper - lower)
        attributed[start..<end].backgroundColor = mark
      }
    }
    if cut { attributed += AttributedString(" …") }
    return attributed
  }

  /// Tabs as spaces to the next stop, and where each original offset landed.
  nonisolated static func expandTabs(_ text: String) -> (String, (Int) -> Int) {
    guard text.contains("\t") else { return (text, { $0 }) }
    var result = ""
    var map: [Int] = []
    var column = 0
    for character in text {
      map.append(column)
      if character == "\t" {
        let spaces = tabWidth - column % tabWidth
        result += String(repeating: " ", count: spaces)
        column += spaces
      } else {
        result.append(character)
        column += 1
      }
    }
    map.append(column)
    return (result, { offset in map[min(max(offset, 0), map.count - 1)] })
  }

  /// The widest line, in columns.
  nonisolated static func columns(_ rows: [DiffRow]) -> Int {
    var widest = 0
    for row in rows {
      guard let line = row.line else { continue }
      var width = 0
      for character in line.text { width += character == "\t" ? tabWidth - width % tabWidth : 1 }
      widest = max(widest, width)
    }
    return widest
  }

  static func accessibilityLabel(_ line: DiffLine) -> Text {
    let text = line.text.isEmpty ? String(localized: "Empty line") : line.text
    switch line.kind {
    case .added: return Text("Line \(line.newNumber ?? 0), added: \(text)")
    case .removed: return Text("Line \(line.oldNumber ?? 0), removed: \(text)")
    case .context: return Text("Line \(line.newNumber ?? 0): \(text)")
    }
  }

  /// The highlighter's language for a path, by extension.
  static func language(_ path: String) -> String? {
    let ext = (path as NSString).pathExtension.lowercased()
    return ext.isEmpty ? nil : ext
  }
}
