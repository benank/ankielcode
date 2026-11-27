import AnkielKit
import SwiftUI

/// The thread checkout's git state and actions (RN `GitOverviewSheet`): commit, push, create or
/// view the change request, pull when behind, review changes, and the worktree path.
struct GitSheet: View {
  let presenter: ReviewPresenter
  @Environment(\.dismiss) private var dismiss
  @Environment(\.openURL) private var openURL
  @State private var confirming: GitStackedAction?
  @State private var committing = false

  private var git: GitModel { presenter.git }
  private var status: VcsStatus? { git.status }
  private var term: GitActionRules.ChangeRequestTerm { GitActionRules.term(status) }

  var body: some View {
    NavigationStack {
      List {
        if status?.isRepo ?? true {
          actions
        }
        Section {
          Button {
            dismiss()
            presenter.openReview()
          } label: {
            row(
              "Review changes", symbol: "text.bubble",
              detail: String(localized: "Inspect changes, uncommitted edits, and turn diffs"))
          }
          .disabled(git.busy || !(status?.isRepo ?? true))
          .accessibilityIdentifier("git.review")
        }
        if let worktree = git.worktreePath {
          Section("Worktree") {
            Text(verbatim: worktree)
              .font(Typography.footnote)
              .foregroundStyle(Palette.textSecondary)
              .textSelection(.enabled)
          }
        }
        if let error = git.statusError {
          Section {
            Label { Text(verbatim: ReviewCopy.failure(error)) } icon: { Image(systemName: "exclamationmark.triangle") }
              .foregroundStyle(Palette.attention)
          }
        }
      }
      .listStyle(.insetGrouped)
      .refreshable { await git.refresh() }
      .navigationTitle(Text(verbatim: status?.refName ?? String(localized: "Detached HEAD")))
      .navigationSubtitle(ReviewCopy.statusSummary(status))
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Done") { dismiss() }
            .accessibilityIdentifier("git.done")
        }
        ToolbarItem(placement: .primaryAction) {
          Button {
            Task { await git.refresh(quiet: false) }
          } label: {
            Label("Refresh repository status", systemImage: "arrow.clockwise")
          }
          .disabled(git.busy)
        }
      }
      .navigationDestination(isPresented: $committing) {
        CommitSheet(git: git) { input in
          dismiss()
          Task { await git.run(input) }
        }
      }
      .gitConfirmation($confirming, git: git)
      .task { await git.refresh() }
      .onAppear {
        if ReviewDebug.openConfirm { confirming = .commitPush }
        if ReviewDebug.openCommit { committing = true }
      }
    }
    .presentationDetents([.medium, .large])
    .presentationDragIndicator(.visible)
    .accessibilityIdentifier("git.sheet")
  }

  @ViewBuilder
  private var actions: some View {
    let items = git.menuItems
    let behind = status?.behindCount ?? 0
    if !items.isEmpty || behind > 0 {
      Section {
        ForEach(items) { item in
          let blocked = !git.canWrite && !item.opensExisting
          Button {
            press(item)
          } label: {
            row(
              LocalizedStringKey(ReviewCopy.menuLabel(item, term: term)), symbol: ReviewCopy.menuSymbol(item.id),
              detail: blocked
                ? String(localized: "This connection cannot change source control.")
                : GitActionRules.disabledReason(item, status: status, busy: git.busy).map { ReviewCopy.reason($0, term: term) }
                  ?? detail(item))
          }
          .disabled(item.disabled || blocked)
          .accessibilityIdentifier("git.action.\(item.id.rawValue)")
        }
        if behind > 0 {
          Button {
            dismiss()
            Task { await git.pull() }
          } label: {
            row(
              "Pull latest", symbol: "arrow.down.circle",
              detail: git.canWrite
                ? String(localized: "\(behind) commits behind upstream")
                : String(localized: "This connection cannot change source control."))
          }
          .disabled(!git.canWrite || git.busy)
          .accessibilityIdentifier("git.pull")
        }
      }
    }
  }

  /// RN `rowStatusDetail`.
  private func detail(_ item: GitActionRules.MenuItem) -> String? {
    guard let status else { return nil }
    switch item.id {
    case .commit where status.hasWorkingTreeChanges: return String(localized: "\(status.workingTree.files.count) files changed")
    case .push where status.aheadCount > 0: return String(localized: "\(status.aheadCount) commits ahead")
    case .pr:
      guard let pr = status.pr else { return nil }
      return term == .mr ? String(localized: "MR #\(pr.number) \(pr.state)") : String(localized: "PR #\(pr.number) \(pr.state)")
    default: return nil
    }
  }

  private func row(_ title: LocalizedStringKey, symbol: String, detail: String?) -> some View {
    Label {
      VStack(alignment: .leading, spacing: 2) {
        Text(title).foregroundStyle(Palette.textPrimary)
        if let detail {
          Text(verbatim: detail)
            .font(Typography.footnote)
            .foregroundStyle(Palette.textSecondary)
        }
      }
    } icon: {
      Image(systemName: symbol)
    }
    .frame(minHeight: 44)
  }

  private func press(_ item: GitActionRules.MenuItem) {
    if item.opensExisting {
      if let url = status?.openChangeRequest.flatMap({ URL(string: $0.url) }) { openURL(url) }
      return
    }
    guard git.canWrite else { return }
    switch item.id {
    case .commit:
      committing = true
    case .push: publish(.push)
    case .pr: publish(.createPR)
    }
  }

  /// RN `runActionWithPrompt`: the default branch asks first; otherwise the sheet closes so the
  /// thread shows the action's progress.
  private func publish(_ action: GitStackedAction) {
    if GitActionRules.needsDefaultBranchConfirmation(action, status: status) {
      confirming = action
      return
    }
    dismiss()
    Task { await git.run(GitActionInput(action)) }
  }
}

/// "Commit changes" (RN `GitCommitSheet`): an optional message and which changed files to commit.
struct CommitSheet: View {
  let git: GitModel
  let commit: (GitActionInput) -> Void
  @State private var message = ""
  @State private var excluded: Set<String> = []

  private var files: [VcsStatus.WorkingTree.File] { git.status?.workingTree.files ?? [] }
  private var selected: [VcsStatus.WorkingTree.File] { files.filter { !excluded.contains($0.path) } }

  var body: some View {
    let selected = selected
    List {
      if git.status?.isDefaultRef == true {
        Section {
          Text("You’re on the default branch. You can create a new branch when committing.")
            .font(Typography.footnote)
            .foregroundStyle(Palette.textSecondary)
        }
      }
      Section {
        TextField("Describe your changes…", text: $message, axis: .vertical)
          .lineLimit(3...8)
          .accessibilityLabel(Text("Commit message"))
          .accessibilityIdentifier("git.commit.message")
      } header: {
        Text("Commit message")
      } footer: {
        Text("Leave empty to generate a message automatically.")
      }
      Section {
        if files.isEmpty {
          Text("No changed files to commit.").foregroundStyle(Palette.textSecondary)
        }
        ForEach(files, id: \.path) { file in
          let included = !excluded.contains(file.path)
          Button {
            if included { excluded.insert(file.path) } else { excluded.remove(file.path) }
          } label: {
            HStack(spacing: Spacing.md) {
              Image(systemName: included ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(included ? Palette.accent : Palette.textTertiary)
                .contentTransition(.symbolEffect(.replace))
              VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: WorkspacePath.basename(file.path))
                  .font(Typography.subheadline.weight(.medium))
                  .foregroundStyle(Palette.textPrimary)
                  .lineLimit(1)
                  .truncationMode(.middle)
                if let slash = file.path.lastIndex(of: "/") {
                  Text(verbatim: String(file.path[..<slash]))
                    .font(Typography.caption)
                    .foregroundStyle(Palette.textTertiary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                }
              }
              Spacer(minLength: Spacing.sm)
              DiffCounts(additions: file.insertions, deletions: file.deletions)
            }
            .frame(minHeight: 44)
          }
          .accessibilityLabel(Text(verbatim: file.path))
          .accessibilityAddTraits(included ? .isSelected : [])
          .accessibilityIdentifier("git.commit.file")
        }
      } header: {
        HStack {
          Text("\(selected.count) of \(files.count) selected · +\(selected.reduce(0) { $0 + $1.insertions }) −\(selected.reduce(0) { $0 + $1.deletions })")
            .textCase(nil)
          Spacer()
          if !files.isEmpty {
            Button(excluded.isEmpty ? "Deselect all" : String(localized: "Select all", comment: "selects every changed file to commit")) {
              excluded = excluded.isEmpty ? Set(files.map(\.path)) : []
            }
            .font(Typography.footnote.weight(.medium))
            .textCase(nil)
          }
        }
      }
      Section {
        Button {
          run(featureBranch: false)
        } label: {
          Label("Commit changes", systemImage: "checkmark").frame(maxWidth: .infinity, minHeight: 36)
        }
        .buttonStyle(.glassProminent)
        .disabled(!git.canWrite || selected.isEmpty || git.busy)
        .accessibilityIdentifier("git.commit.submit")
        Button {
          run(featureBranch: true)
        } label: {
          Label("Commit on a new branch", systemImage: "arrow.branch").frame(maxWidth: .infinity, minHeight: 36)
        }
        .disabled(!git.canCreateFeatureBranch || selected.isEmpty || git.busy)
      }
      .listRowBackground(Color.clear)
      .listRowInsets(EdgeInsets())
    }
    .listStyle(.insetGrouped)
    .navigationTitle("Commit changes")
    .navigationSubtitle(Text(verbatim: git.status?.refName ?? String(localized: "(detached HEAD)")))
    .navigationBarTitleDisplayMode(.inline)
  }

  private func run(featureBranch: Bool) {
    commit(
      GitActionInput(
        .commit, commitMessage: message, filePaths: excluded.isEmpty ? nil : selected.map(\.path), featureBranch: featureBranch))
  }
}
