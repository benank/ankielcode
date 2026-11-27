import AnkielKit
import SwiftUI

/// "Worked for 2m 4s ›": a settled turn's work, folded.
struct RunFoldView: View, Equatable {
  let fold: RunFoldRow
  let expanded: Bool
  let toggle: () -> Void

  nonisolated static func == (lhs: Self, rhs: Self) -> Bool { lhs.fold == rhs.fold && lhs.expanded == rhs.expanded }

  var body: some View {
    Button(action: toggle) {
      HStack(spacing: Spacing.xs) {
        Text(WorkCopy.fold(fold.label))
          .font(Typography.footnote.weight(.medium))
          .foregroundStyle(Palette.textSecondary)
        DisclosureChevron(expanded: expanded)
        Spacer(minLength: 0)
      }
      .frame(minHeight: 44)
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .accessibilityValue(expanded ? Text("Expanded") : Text("Collapsed"))
    .accessibilityHint(Text("Shows the work behind this reply"))
  }
}

/// A collapsed run of tool calls: one icon and a one-line summary.
struct WorkGroupView: View, Equatable {
  let group: WorkGroupRow
  let expanded: Bool
  let toggle: () -> Void

  nonisolated static func == (lhs: Self, rhs: Self) -> Bool { lhs.group == rhs.group && lhs.expanded == rhs.expanded }

  var body: some View {
    Button(action: toggle) {
      HStack(alignment: .firstTextBaseline, spacing: Spacing.sm + 2) {
        WorkIcon(kind: group.kind, live: group.live)
        Text(WorkCopy.display(group.label))
          .font(Typography.subheadline)
          .foregroundStyle(group.live ? Palette.textPrimary : Palette.textSecondary)
          .lineLimit(1)
          .truncationMode(.tail)
        if group.hasFailure { FailureMark() }
        DisclosureChevron(expanded: expanded)
        Spacer(minLength: 0)
      }
      .frame(minHeight: 36)
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .accessibilityValue(expanded ? Text("Expanded") : Text("Collapsed"))
  }
}

/// One tool call: label on one line; tapping opens its detail (command and output, files,
/// reasoning text).
struct WorkRowView: View, Equatable {
  let row: WorkRow
  let expanded: Bool
  let load: ThreadDetailModel.DetailLoad?
  let toggle: () -> Void
  let loadDetail: () -> Void

  nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
    lhs.row == rhs.row && lhs.expanded == rhs.expanded && lhs.load == rhs.load
  }

  @ScaledMetric(relativeTo: .footnote) private var indent: CGFloat = 28
  @Environment(\.filePresenter) private var files
  @Environment(\.reviewPresenter) private var review

  private var activity: WorkActivity { row.activity }

  /// The file a read or single-file change names, for opening it in the viewer.
  private var filePath: String? {
    switch activity.label {
    case .read(let path?), .changedFile(let path): files?.canBrowse == true ? path : nil
    default: nil
    }
  }
  private var isCommandText: Bool { if case .activity(.command) = row.label { true } else { false } }

  /// An open thought shows its text below, so its label becomes "Thought" (`workEntryRowLabel`).
  private var label: String {
    if expanded, activity.isReasoningRow {
      return activity.lifecycle == .inProgress
        ? String(localized: "Thinking") : String(localized: "Thought", comment: "noun, a reasoning step")
    }
    return WorkCopy.display(row.label)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: Spacing.xs) {
      Button {
        if activity.detail == nil, let filePath { files?.open(path: filePath) } else { toggle() }
      } label: {
        HStack(alignment: .firstTextBaseline, spacing: Spacing.sm + 2) {
          WorkIcon(kind: activity.kind, live: row.live)
          Text(label)
            .font(isCommandText ? Typography.monoSmall : Typography.subheadline)
            .foregroundStyle(row.live ? Palette.textPrimary : Palette.textSecondary)
            .lineLimit(expanded ? 6 : 1)
            .truncationMode(.tail)
          if activity.outcome == .failure { FailureMark() }
          if activity.detail != nil { DisclosureChevron(expanded: expanded) }
          Spacer(minLength: 0)
        }
        .frame(minHeight: 32)
        .contentShape(.rect)
      }
      .buttonStyle(.plain)
      .disabled(activity.detail == nil && filePath == nil)
      .accessibilityValue(activity.detail == nil ? Text("") : expanded ? Text("Expanded") : Text("Collapsed"))
      if expanded, let detail = activity.detail {
        WorkDetailView(detail: detail, load: load, filePath: filePath)
          .padding(.leading, indent)
          .padding(.bottom, Spacing.xs)
          .task(id: activity.revision) {
            if case .command(_, _, nil, true) = detail { loadDetail() }
            // A tool's images (screenshots, image reads) are only in the full item.
            if activity.type == "dynamic_tool", load == nil { loadDetail() }
          }
      }
      if expanded, !activity.changedFiles.isEmpty, let review {
        ReviewChangesLink(review: review, runId: activity.runId, files: activity.changedFiles)
          .padding(.leading, indent)
      }
    }
    .padding(.leading, row.inGroup ? indent : 0)
  }
}

private struct WorkDetailView: View {
  let detail: WorkDetail
  let load: ThreadDetailModel.DetailLoad?
  var filePath: String?
  @Environment(\.filePresenter) private var files

  var body: some View {
    switch detail {
    case .command(let input, let exitCode, let output, let omitted):
      VStack(alignment: .leading, spacing: 0) {
        HStack(alignment: .firstTextBaseline) {
          Text(verbatim: "$ \(input)")
            .font(Typography.monoSmall)
            .foregroundStyle(Palette.textPrimary)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
          Spacer(minLength: Spacing.sm)
          if let exitCode, exitCode != 0 {
            Text("exit \(exitCode)")
              .font(Typography.caption.monospacedDigit())
              .foregroundStyle(Palette.danger)
          }
        }
        .padding(Spacing.md)
        let shown = output ?? loadedOutput
        if let shown, !shown.isEmpty {
          Divider()
          ScrollView(.horizontal) {
            Text(Self.tail(shown))
              .font(Typography.monoSmall)
              .foregroundStyle(Palette.textSecondary)
              .fixedSize(horizontal: true, vertical: true)
              .textSelection(.enabled)
              .padding(Spacing.md)
          }
          .scrollIndicators(.hidden)
        } else if omitted {
          Divider()
          Group {
            switch load {
            case .failed(let message)?: Text(message)
            case .offline?: Text("Connect to the computer to see the output.")
            case .missing?, .loaded?: Text("No output")
            default: Text("Loading output…")
            }
          }
          .font(Typography.caption)
          .foregroundStyle(Palette.textTertiary)
          .padding(Spacing.md)
        }
      }
      .background(Palette.codeBackground, in: .rect(cornerRadius: Radius.small, style: .continuous))
    case .files(let files, let additions, let deletions):
      VStack(alignment: .leading, spacing: Spacing.xs) {
        if additions != nil || deletions != nil {
          DiffCounts(additions: additions, deletions: deletions)
        }
        ForEach(files, id: \.path) { file in
          Button { self.files?.open(path: file.path) } label: {
            HStack(spacing: Spacing.sm) {
              Text(file.path)
                .font(Typography.monoSmall)
                .foregroundStyle(self.files?.canBrowse == true ? Palette.working : Palette.textSecondary)
                .lineLimit(1)
                .truncationMode(.middle)
              if let operation = file.operation, operation != "update" {
                Text(operation)
                  .font(Typography.caption)
                  .foregroundStyle(Palette.textTertiary)
              }
              Spacer(minLength: 0)
            }
            .frame(minHeight: 44)
            .contentShape(.rect)
          }
          .buttonStyle(.plain)
          .disabled(self.files?.canBrowse != true || file.operation == "delete")
          .accessibilityHint(Text("Opens the file"))
        }
      }
    case .text(let text):
      Text(Self.inlineMarkdown(text))
        .font(Typography.footnote)
        .foregroundStyle(Palette.textSecondary)
        .lineSpacing(2)
        .fixedSize(horizontal: false, vertical: true)
        .textSelection(.enabled)
    case .search(let patterns, let results):
      VStack(alignment: .leading, spacing: Spacing.xs) {
        ForEach(patterns, id: \.self) { Text($0).font(Typography.monoSmall).foregroundStyle(Palette.textPrimary) }
        ForEach(results.prefix(12), id: \.self) {
          Text($0).font(Typography.caption).foregroundStyle(Palette.textSecondary).lineLimit(1).truncationMode(.middle)
        }
      }
    case .tool(let name, let input):
      VStack(alignment: .leading, spacing: Spacing.xs) {
        if let name { Text(name).font(Typography.monoSmall).foregroundStyle(Palette.textPrimary) }
        if let input {
          Text(input)
            .font(Typography.monoSmall)
            .foregroundStyle(Palette.textSecondary)
            .lineLimit(12)
            .textSelection(.enabled)
        }
        if let filePath {
          Button { files?.open(path: filePath) } label: {
            Label("Open \(WorkspacePath.basename(filePath))", systemImage: "doc.text.magnifyingglass")
              .font(Typography.footnote.weight(.medium))
              .frame(minHeight: 44)
              .contentShape(.rect)
          }
          .buttonStyle(.plain)
          .foregroundStyle(Palette.working)
          .accessibilityIdentifier("work.openFile")
        }
        if case .loaded(let item)? = load, case .dynamicTool(let tool) = item.body {
          let count = ToolOutputImages.count(tool.output)
          if count > 0 { ToolImageStrip(itemId: item.id, count: count).padding(.top, Spacing.xs) }
        }
      }
    }
  }

  private var loadedOutput: String? {
    guard case .loaded(let item)? = load, case .commandExecution(let command) = item.body else { return nil }
    return command.output
  }

  /// The last 60 lines; command output is read from the end.
  static func tail(_ output: String) -> String {
    let lines = output.split(separator: "\n", omittingEmptySubsequences: false)
    return lines.count > 60 ? "…\n" + lines.suffix(60).joined(separator: "\n") : output
  }

  static func inlineMarkdown(_ text: String) -> AttributedString {
    (try? AttributedString(
      markdown: text,
      options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace, failurePolicy: .returnPartiallyParsedIfPossible)))
      ?? AttributedString(text)
  }
}

struct DiffCounts: View {
  let additions: Int?
  let deletions: Int?

  var body: some View {
    HStack(spacing: Spacing.sm) {
      if let additions { Text(verbatim: "+\(additions)").foregroundStyle(Palette.diffAdded) }
      if let deletions { Text(verbatim: "−\(deletions)").foregroundStyle(Palette.diffRemoved) }
    }
    .font(Typography.caption.monospacedDigit().weight(.medium))
  }
}

/// The tail of an active run: what it is doing and for how long. The spinner is the system's; the
/// clock is a system timer text, so nothing here drives its own repaint loop.
struct WorkingRowView: View, Equatable {
  let row: WorkingRow

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: Spacing.sm + 2) {
      ProgressView()
        .controlSize(.small)
        .frame(width: 18)
      VStack(alignment: .leading, spacing: 2) {
        HStack(spacing: Spacing.xs) {
          Text(row.waitingOnSubagents > 0 ? waitingLabel : String(localized: "Working"))
            .font(Typography.subheadline.weight(.medium))
            .foregroundStyle(Palette.textPrimary)
          if let start = row.startedAt.date {
            Text(timerInterval: start...Date.distantFuture, countsDown: false)
              .font(Typography.subheadline.monospacedDigit())
              .foregroundStyle(Palette.textTertiary)
          }
        }
        if let activity = row.activity {
          Text(WorkCopy.activity(activity))
            .font(Typography.footnote)
            .foregroundStyle(Palette.textSecondary)
            .lineLimit(1)
        }
      }
      Spacer(minLength: 0)
    }
    .frame(minHeight: 36)
    .accessibilityElement(children: .combine)
  }

  private var waitingLabel: String {
    row.waitingOnSubagents == 1
      ? String(localized: "Waiting on 1 agent") : String(localized: "Waiting on \(row.waitingOnSubagents) agents")
  }
}

/// A subagent the run started; opens its child thread.
struct SubagentRowView: View, Equatable {
  let row: SubagentRow
  let open: (() -> Void)?

  nonisolated static func == (lhs: Self, rhs: Self) -> Bool { lhs.row == rhs.row }

  var body: some View {
    Button {
      open?()
    } label: {
      HStack(alignment: .top, spacing: Spacing.md) {
        Image(systemName: "person.2")
          .font(Typography.footnote)
          .foregroundStyle(Palette.textSecondary)
          .frame(width: 30, height: 30)
          .background(Palette.fill, in: .circle)
        VStack(alignment: .leading, spacing: 2) {
          HStack(spacing: Spacing.xs) {
            Text(row.title ?? String(localized: "Subagent"))
              .font(Typography.subheadline.weight(.medium))
              .foregroundStyle(Palette.textPrimary)
              .lineLimit(1)
            statusMark
          }
          if let preview = row.preview {
            Text(preview)
              .font(Typography.footnote)
              .foregroundStyle(Palette.textSecondary)
              .lineLimit(2)
          }
        }
        Spacer(minLength: 0)
        if open != nil {
          Image(systemName: "chevron.right")
            .font(Typography.caption.weight(.semibold))
            .foregroundStyle(Palette.textTertiary)
            .padding(.top, Spacing.sm)
        }
      }
      .padding(Spacing.md)
      .background(Palette.surface, in: .rect(cornerRadius: Radius.medium, style: .continuous))
      .overlay {
        RoundedRectangle(cornerRadius: Radius.medium, style: .continuous).strokeBorder(Palette.separator, lineWidth: 0.5)
      }
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .disabled(open == nil)
    .accessibilityHint(open == nil ? Text("") : Text("Opens the subagent's thread"))
  }

  @ViewBuilder
  private var statusMark: some View {
    switch row.status.known {
    case .running, .pending, .waiting:
      ProgressView().controlSize(.mini)
    case .completed:
      Image(systemName: "checkmark").font(Typography.caption.weight(.semibold)).foregroundStyle(Palette.success)
        .accessibilityLabel(Text("Done"))
    case .failed:
      Image(systemName: "xmark").font(Typography.caption.weight(.semibold)).foregroundStyle(Palette.danger)
        .accessibilityLabel(Text("Failed"))
    default:
      EmptyView()
    }
  }
}

/// Errors, warnings and markers between messages.
struct NoticeRowView: View, Equatable {
  let row: NoticeRow

  var body: some View {
    switch row.label {
    case .compaction, .handoff, .forked, .threadCreated, .interrupted:
      ContextDivider(label: WorkCopy.activity(row.label), systemImage: WorkCopy.symbol(row.kind))
        .padding(.vertical, Spacing.xs)
    default:
      if row.tone == .quiet {
        HStack(alignment: .firstTextBaseline, spacing: Spacing.sm + 2) {
          Image(systemName: WorkCopy.symbol(row.kind))
            .font(Typography.footnote)
            .foregroundStyle(Palette.textTertiary)
            .frame(width: 18)
          VStack(alignment: .leading, spacing: 2) {
            Text(WorkCopy.activity(row.label)).font(Typography.subheadline).foregroundStyle(Palette.textSecondary)
            if let detail = row.detail {
              Text(detail).font(Typography.footnote).foregroundStyle(Palette.textTertiary).lineLimit(3)
            }
          }
          Spacer(minLength: 0)
        }
        .frame(minHeight: 32)
      } else {
        let tint = row.tone == .error ? Palette.danger : Palette.attention
        HStack(alignment: .top, spacing: Spacing.md) {
          Image(systemName: WorkCopy.symbol(row.kind))
            .font(Typography.subheadline)
            .foregroundStyle(tint)
          VStack(alignment: .leading, spacing: Spacing.xs) {
            Text(WorkCopy.activity(row.label))
              .font(Typography.subheadline.weight(.semibold))
              .foregroundStyle(Palette.textPrimary)
            if let detail = row.detail {
              Text(detail)
                .font(Typography.footnote)
                .foregroundStyle(Palette.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            }
            if let reset = row.resetAt?.date {
              Text("Resets \(reset.formatted(date: .omitted, time: .shortened))")
                .font(Typography.footnote)
                .foregroundStyle(Palette.textSecondary)
            }
          }
          Spacer(minLength: 0)
        }
        .padding(Spacing.md)
        .background(tint.opacity(0.08), in: .rect(cornerRadius: Radius.medium, style: .continuous))
        .accessibilityElement(children: .combine)
      }
    }
  }
}

/// A proposed plan.
struct PlanRowView: View, Equatable {
  let row: PlanRow

  var body: some View {
    VStack(alignment: .leading, spacing: Spacing.md) {
      Label("Proposed plan", systemImage: "list.bullet.clipboard")
        .font(Typography.footnote.weight(.semibold))
        .foregroundStyle(Palette.textSecondary)
      MarkdownView(document: row.document)
    }
    .padding(Spacing.lg)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Palette.surface, in: .rect(cornerRadius: Radius.large, style: .continuous))
    .overlay {
      RoundedRectangle(cornerRadius: Radius.large, style: .continuous).strokeBorder(Palette.separator, lineWidth: 0.5)
    }
  }
}

/// A question the user already answered.
struct AnsweredRowView: View, Equatable {
  let row: AnsweredRow

  /// Questions are markdown; the answered row shows their inline styling, not the asterisks.
  static func inline(_ text: String) -> AttributedString {
    (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
      ?? AttributedString(text)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: Spacing.sm) {
      Label("Answered", systemImage: "questionmark.bubble")
        .font(Typography.footnote.weight(.medium))
        .foregroundStyle(Palette.textSecondary)
      ForEach(Array(row.pairs.enumerated()), id: \.offset) { _, pair in
        VStack(alignment: .leading, spacing: 2) {
          Text(Self.inline(pair.question)).font(Typography.footnote).foregroundStyle(Palette.textSecondary)
          Text(pair.answer ?? "—").font(Typography.subheadline.weight(.medium)).foregroundStyle(Palette.textPrimary)
        }
      }
    }
    .padding(Spacing.md)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Palette.surface, in: .rect(cornerRadius: Radius.medium, style: .continuous))
  }
}

struct WorkIcon: View {
  let kind: WorkKind
  let live: Bool
  @ScaledMetric(relativeTo: .footnote) private var width: CGFloat = 18

  var body: some View {
    Group {
      if live {
        ProgressView().controlSize(.mini)
      } else {
        Image(systemName: WorkCopy.symbol(kind))
          .font(Typography.footnote)
          .foregroundStyle(Palette.textTertiary)
      }
    }
    .frame(width: width)
    .accessibilityHidden(true)
  }
}

struct DisclosureChevron: View {
  let expanded: Bool

  var body: some View {
    Image(systemName: "chevron.right")
      .font(Typography.caption2.weight(.semibold))
      .foregroundStyle(Palette.textTertiary)
      .rotationEffect(.degrees(expanded ? 90 : 0))
      .motion(Motion.micro, value: expanded)
      .accessibilityHidden(true)
  }
}

private struct FailureMark: View {
  var body: some View {
    Image(systemName: "exclamationmark.circle.fill")
      .font(Typography.caption)
      .foregroundStyle(Palette.danger)
      .accessibilityLabel(Text("Failed"))
  }
}
