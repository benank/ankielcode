import AnkielKit
import Observation
import SwiftUI

/// The open suggestion list of one composer: what the word at the caret asks for, the rows that
/// answer it, and the highlighted row (RN `useComposerCommandMenu`). `@` searches the workspace on
/// the computer after a 200 ms pause, like RN.
@MainActor
@Observable
final class ComposerSuggestions {
  private(set) var trigger: ComposerTrigger?
  private(set) var items: [ComposerMenuItem] = []
  private(set) var loading = false
  /// Why the list has no path rows, when the reason is not "nothing matched".
  private(set) var notice: String?
  var highlighted = 0

  /// Escape closes the list until the word at the caret changes.
  private var dismissed: ComposerTrigger?
  private var pathRows: [ComposerMenuItem] = []
  private var searchedQuery: String?
  private var search: Task<Void, Never>?

  var isOpen: Bool { trigger != nil && (!items.isEmpty || loading || notice != nil) }

  /// Where `@` searches and how; nil when the composer has no workspace.
  struct Source {
    var context: FileContext?
    var canRead: Bool
    var search: @MainActor (String, FileContext) async throws -> [WorkspaceEntry]
    /// Rows other than paths for the trigger (slash commands, skills, models), already filtered.
    var otherItems: @MainActor (ComposerTrigger) -> [ComposerMenuItem] = { _ in [] }
  }

  func update(text: String, selection: (start: Int, end: Int), enabled: Bool, source: Source) {
    let next = enabled && selection.start == selection.end ? ComposerTrigger.detect(text, cursor: selection.end) : nil
    if let dismissed, let next, dismissed.rangeStart == next.rangeStart, dismissed.kind == next.kind, next.query.hasPrefix(dismissed.query) {
      close(keepDismissal: true)
      return
    }
    dismissed = nil
    guard let next else {
      close(keepDismissal: false)
      return
    }
    let changed = next != trigger
    trigger = next
    if next.kind == .path {
      if !source.canRead || source.context == nil {
        pathRows = []
        notice = source.context == nil ? nil : String(localized: "This device cannot read this computer's files.")
      } else {
        notice = nil
        searchPaths(next.query.trimmingCharacters(in: .whitespacesAndNewlines), source: source)
      }
    } else {
      pathRows = []
      notice = nil
      search?.cancel()
      loading = false
      searchedQuery = nil
    }
    let others = source.otherItems(next)
    items = others + (next.kind == .path ? pathRows : [])
    if changed { highlighted = 0 }
    highlighted = min(highlighted, max(0, items.count - 1))
  }

  private func searchPaths(_ query: String, source: Source) {
    guard query != searchedQuery, let context = source.context else { return }
    searchedQuery = query
    search?.cancel()
    loading = true
    search = Task { [weak self] in
      try? await Task.sleep(for: .milliseconds(200))
      guard !Task.isCancelled else { return }
      let entries = try? await source.search(query, context)
      guard !Task.isCancelled, let self else { return }
      self.loading = false
      self.pathRows = ComposerMenu.pathItems(entries ?? [])
      if let trigger = self.trigger, trigger.kind == .path {
        self.items = source.otherItems(trigger) + self.pathRows
        self.highlighted = min(self.highlighted, max(0, self.items.count - 1))
      }
    }
  }

  func move(_ delta: Int) {
    guard !items.isEmpty else { return }
    highlighted = (highlighted + delta + items.count) % items.count
  }

  var current: ComposerMenuItem? { items.indices.contains(highlighted) ? items[highlighted] : nil }

  func dismiss() {
    dismissed = trigger
    close(keepDismissal: true)
  }

  func close(keepDismissal: Bool) {
    if !keepDismissal { dismissed = nil }
    trigger = nil
    items = []
    pathRows = []
    notice = nil
    loading = false
    searchedQuery = nil
    search?.cancel()
  }
}

/// The floating list above the composer card.
struct ComposerSuggestionList: View {
  let suggestions: ComposerSuggestions
  let pick: (ComposerMenuItem) -> Void

  @Environment(\.dynamicTypeSize) private var typeSize

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if suggestions.items.isEmpty {
        HStack(spacing: Spacing.sm) {
          if suggestions.loading {
            ProgressView().controlSize(.small)
            Text("Searching…")
          } else if let notice = suggestions.notice {
            Text(notice)
          }
        }
        .font(Typography.footnote)
        .foregroundStyle(Palette.textSecondary)
        .padding(Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
      } else {
        ScrollViewReader { proxy in
          ScrollView {
            LazyVStack(spacing: 2) {
              ForEach(Array(suggestions.items.enumerated()), id: \.element.id) { index, item in
                row(item, highlighted: index == suggestions.highlighted)
                  .id(item.id)
              }
            }
            .padding(Spacing.xs)
          }
          .scrollBounceBehavior(.basedOnSize)
          .frame(maxHeight: typeSize.isAccessibilitySize ? 320 : 264)
          .onChange(of: suggestions.highlighted) { _, index in
            if suggestions.items.indices.contains(index) { proxy.scrollTo(suggestions.items[index].id) }
          }
        }
      }
    }
    .fixedSize(horizontal: false, vertical: true)
    .glassEffect(.regular, in: .rect(cornerRadius: Radius.field + 4, style: .continuous))
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("composer.suggestions")
  }

  private func row(_ item: ComposerMenuItem, highlighted: Bool) -> some View {
    Button {
      pick(item)
    } label: {
      HStack(spacing: Spacing.sm) {
        Image(systemName: icon(item))
          .font(Typography.footnote.weight(.medium))
          .foregroundStyle(Palette.textSecondary)
          .frame(width: 20)
        VStack(alignment: .leading, spacing: 1) {
          Text(item.label)
            .font(Typography.subheadline.weight(.medium))
            .foregroundStyle(Palette.textPrimary)
            .lineLimit(1)
            .truncationMode(.middle)
          if !item.detail.isEmpty {
            Text(item.detail)
              .font(Typography.caption)
              .foregroundStyle(Palette.textSecondary)
              .lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
              .truncationMode(.head)
          }
        }
        Spacer(minLength: 0)
      }
      .padding(.horizontal, Spacing.sm)
      .padding(.vertical, Spacing.xs + 2)
      .frame(minHeight: 44)
      .background(highlighted ? Palette.fill : .clear, in: .rect(cornerRadius: Radius.field, style: .continuous))
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .accessibilityLabel(Text(item.detail.isEmpty ? item.label : "\(item.label), \(item.detail)"))
    .accessibilityAddTraits(highlighted ? .isSelected : [])
    .accessibilityIdentifier("composer.suggestion.\(item.label)")
  }

  private func icon(_ item: ComposerMenuItem) -> String {
    switch item.action {
    case .path(_, let isDirectory): isDirectory ? "folder" : "doc.text"
    case .command, .providerCommand: "command"
    case .skill: "sparkles"
    case .model: "cpu"
    }
  }
}
