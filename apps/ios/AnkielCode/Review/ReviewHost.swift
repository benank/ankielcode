import AnkielKit
import SwiftUI

extension View {
  /// Gives a thread screen its review and git state: the Changes screen, the Git sheet, the
  /// action progress toast, and the entries other views reach through `\.reviewPresenter`.
  func threadReview(_ ref: ThreadRef, detail: ThreadDetailModel) -> some View {
    modifier(ThreadReviewHost(ref: ref, detail: detail))
  }
}

/// One thread's review and git models and what is presented. Shared by the thread menu, the feed's
/// file rows, the review screen and the Git sheet.
@MainActor @Observable
final class ReviewPresenter {
  let ref: ThreadRef
  let review: ReviewModel
  let git: GitModel
  var showsReview = false
  var showsGit = false
  /// A file to open once the review's files load (from a feed row).
  var pendingPath: String?
  /// Whether this connection can read the checkout (`filesystem:read`), for git sections.
  var canReadFiles = true
  var connected = true
  var environmentLabel: String?
  /// The thread's file viewer (the files host's presenter), for opening a whole file.
  var files: FilePresenter?

  init(ref: ThreadRef, review: ReviewModel, git: GitModel) {
    self.ref = ref
    self.review = review
    self.git = git
  }

  /// Opens review on a section (a turn from the feed), optionally on one file.
  func openReview(section: ReviewSectionID? = nil, path: String? = nil) {
    if let section { review.picked = section }
    pendingPath = path
    review.load()
    showsReview = true
  }

  /// The turn a run belongs to, for opening review from a feed row of that run.
  func section(forRun runId: String?) -> ReviewSectionID? {
    guard let runId, let turn = review.turns.first(where: { $0.runId == runId }) else { return nil }
    return .turn(turn.turnCount)
  }

  func openGit() {
    showsGit = true
    Task { await git.refresh() }
  }
}

extension EnvironmentValues {
  @Entry var reviewPresenter: ReviewPresenter?
}

private struct ThreadReviewHost: ViewModifier {
  let ref: ThreadRef
  let detail: ThreadDetailModel
  @Environment(AppModel.self) private var model
  @Environment(\.filePresenter) private var files
  @State private var presenter: ReviewPresenter?
  @State private var confirming: GitStackedAction?

  private var environment: EnvironmentModel? { model.registry.environment(ref.environmentId) }

  private var context: FileContext? { threadFileContext(ref, projectId: detail.state.projectId, registry: model.registry) }

  private struct Inputs: Equatable {
    var turns: [TurnChange]
    var cwd: String?
    var worktree: String?
    var canReadFiles: Bool
    var canWrite: Bool
    var canOperate: Bool
    var connected: Bool
  }

  private var inputs: Inputs {
    #if DEBUG
      if let fixture = ReviewDebug.fixture(ref) {
        return Inputs(
          turns: fixture.turns, cwd: fixture.cwd, worktree: nil, canReadFiles: true, canWrite: !ReviewDebug.readOnly,
          canOperate: !ReviewDebug.readOnly, connected: true)
      }
    #endif
    let canRead = environment?.holds("filesystem:read") ?? false
    let cwd = context?.cwd
    return Inputs(
      turns: detail.state.turnChanges, cwd: cwd, worktree: model.home.thread(ref)?.worktreePath,
      canReadFiles: canRead, canWrite: environment?.holds("source-control:write") ?? false,
      canOperate: environment?.holds(AuthScope.orchestrationOperate) ?? false, connected: environment?.status.isConnected ?? false)
  }

  func body(content: Content) -> some View {
    let presenter = presenter ?? makePresenter()
    content
      .environment(\.reviewPresenter, presenter)
      .onChange(of: inputs, initial: true) { _, inputs in apply(inputs, to: presenter) }
      .gitProgressToast(presenter.git)
      .fullScreenCover(isPresented: Bindable(presenter).showsReview) {
        ReviewScreen(presenter: presenter)
          .environment(\.reviewPresenter, presenter)
      }
      .sheet(isPresented: Bindable(presenter).showsGit) {
        GitSheet(presenter: presenter)
          .environment(\.reviewPresenter, presenter)
      }
      .gitConfirmation($confirming, git: presenter.git)
      .environment(\.runGitQuickAction, GitQuickActionRunner { action in run(action, presenter: presenter) })
      .onAppear {
        if self.presenter == nil { self.presenter = presenter }
        #if DEBUG
          ReviewDebug.apply(to: presenter)
        #endif
      }
  }

  private func makePresenter() -> ReviewPresenter {
    #if DEBUG
      if let fixture = ReviewDebug.fixture(ref) {
        return ReviewPresenter(
          ref: ref, review: ReviewModel(ref: ref, source: fixture.review), git: GitModel(ref: ref, source: fixture.git))
      }
    #endif
    return ReviewPresenter(
      ref: ref, review: ReviewModel(ref: ref, source: LiveReviewSource(registry: model.registry, environmentId: ref.environmentId)),
      git: GitModel(ref: ref, source: LiveGitSource(registry: model.registry, environmentId: ref.environmentId)))
  }

  private func apply(_ inputs: Inputs, to presenter: ReviewPresenter) {
    // Git comparisons read files: without the grant, review shows turns only (RN).
    presenter.review.update(turns: inputs.turns, cwd: inputs.canReadFiles ? inputs.cwd : nil)
    presenter.git.update(cwd: inputs.cwd, worktreePath: inputs.worktree)
    presenter.git.canWrite = inputs.canWrite
    presenter.git.canOperateThread = inputs.canOperate
    presenter.canReadFiles = inputs.canReadFiles
    presenter.connected = inputs.connected
    presenter.environmentLabel = environment?.label
    presenter.files = files
    if inputs.connected, presenter.git.status == nil { Task { await presenter.git.refresh() } }
  }

  private func run(_ action: GitActionRules.QuickAction, presenter: ReviewPresenter) {
    switch action {
    case .run(let stacked):
      if GitActionRules.needsDefaultBranchConfirmation(stacked, status: presenter.git.status) {
        confirming = stacked
      } else {
        Task { await presenter.git.run(GitActionInput(stacked)) }
      }
    case .pull: Task { await presenter.git.pull() }
    case .openPR, .hint: break
    }
  }
}

/// Runs the thread menu's quick action (with the default-branch confirmation) from below the host.
struct GitQuickActionRunner {
  let run: @MainActor (GitActionRules.QuickAction) -> Void
}

extension EnvironmentValues {
  @Entry var runGitQuickAction: GitQuickActionRunner?
}

/// "Review changes" in the thread menu's tools group (RN puts it in the git section; here it sits
/// with Files and Terminal, the screens a thread opens most).
struct ReviewMenuButton: View {
  @Environment(\.reviewPresenter) private var presenter

  var body: some View {
    if let presenter {
      Button {
        presenter.openReview()
      } label: {
        Label {
          Text("Review changes")
          if presenter.git.status?.isRepo ?? true { Text("Turn diffs and worktree changes") } else { Text("Turn diffs") }
        } icon: {
          Image(systemName: "text.bubble")
        }
      }
      .accessibilityIdentifier("thread.review")
    }
  }
}

/// The thread menu's git section (RN `useThreadGitMenuDefinition`): the branch and its status,
/// the one-tap action, and Git actions (the Git sheet).
struct ReviewMenuSection: View {
  @Environment(\.reviewPresenter) private var presenter
  @Environment(\.runGitQuickAction) private var runQuick
  @Environment(\.openURL) private var openURL

  var body: some View {
    if let presenter {
      let git = presenter.git
      let status = git.status
      let term = GitActionRules.term(status)
      let isRepo = status?.isRepo ?? true
      Section {
        if isRepo {
          Button {} label: {
            Label {
              Text(verbatim: status?.refName ?? String(localized: "Detached HEAD"))
              Text(ReviewCopy.menuStatus(status))
            } icon: {
              Image(systemName: "point.topleft.down.curvedto.point.bottomright.up")
            }
          }
          .disabled(true)
          quickAction(git, term: term)
        }
        Button {
          presenter.openGit()
        } label: {
          Label {
            Text("Git actions")
            Text("Commit, files, branches")
          } icon: {
            Image(systemName: "arrow.triangle.branch")
          }
        }
        .accessibilityIdentifier("thread.git")
      }
    }
  }

  @ViewBuilder
  private func quickAction(_ git: GitModel, term: GitActionRules.ChangeRequestTerm) -> some View {
    let action = git.quickAction
    let blocked = !git.canWrite && !(action == .openPR)
    Button {
      if case .openPR = action, let url = git.status?.openChangeRequest.flatMap({ URL(string: $0.url) }) {
        openURL(url)
      } else {
        runQuick?.run(action)
      }
    } label: {
      Label {
        Text(verbatim: ReviewCopy.quickLabel(action, term: term))
        if blocked {
          Text("This connection cannot change source control.")
        } else if case .hint(let hint, _) = action {
          Text(verbatim: ReviewCopy.hint(hint, term: term))
        }
      } icon: {
        Image(systemName: ReviewCopy.quickSymbol(action))
      }
    }
    .disabled(blocked || { if case .hint = action { true } else { false } }())
    .accessibilityIdentifier("thread.git.quick")
  }
}

extension ReviewCopy {
  /// The menu's compact status (RN `compactMenuStatus`).
  static func menuStatus(_ status: VcsStatus?) -> String {
    guard let status else { return String(localized: "Checking status") }
    guard status.isRepo else { return String(localized: "Not a repo") }
    var parts: [String] = []
    if status.hasWorkingTreeChanges {
      parts.append(String(localized: "\(status.workingTree.files.count) changed"))
    } else if status.aheadCount == 0, status.behindCount == 0 {
      parts.append(String(localized: "Clean", comment: "git working tree has no changes"))
    }
    if status.aheadCount > 0 { parts.append(String(localized: "\(status.aheadCount) ahead")) }
    if status.behindCount > 0 { parts.append(String(localized: "\(status.behindCount) behind")) }
    if let pr = status.openChangeRequest { parts.append("\(term(GitActionRules.term(status))) #\(pr.number)") }
    return parts.joined(separator: " · ")
  }

  static func quickSymbol(_ action: GitActionRules.QuickAction) -> String {
    switch action {
    case .pull: "arrow.down.circle"
    case .openPR: "arrow.up.right.circle"
    case .run(.commit): "checkmark.circle"
    case .run(.push), .run(.commitPush): "arrow.up.circle"
    default: "arrow.up.right.circle"
    }
  }
}

// MARK: Progress and confirmation

extension View {
  /// The floating progress and result of the thread's git action (RN `GitActionProgressOverlay`).
  func gitProgressToast(_ git: GitModel) -> some View {
    modifier(GitProgressToastModifier(git: git))
  }

  /// The default-branch confirmation for a publishing action (RN `GitConfirmSheet`).
  func gitConfirmation(_ action: Binding<GitStackedAction?>, git: GitModel) -> some View {
    modifier(GitConfirmation(action: action, git: git))
  }
}

private struct GitProgressToastModifier: ViewModifier {
  let git: GitModel

  func body(content: Content) -> some View {
    content
      .overlay(alignment: .top) {
        if git.progress != .idle {
          GitProgressToast(git: git)
            .padding(.horizontal, Spacing.md)
            .padding(.top, Spacing.xs)
            .motionTransition(.move(edge: .top).combined(with: .opacity))
        }
      }
      .motion(Motion.snappy, value: git.progress == .idle)
      .sensoryFeedback(.success, trigger: git.finishedCount)
      .sensoryFeedback(.error, trigger: git.failedCount)
  }
}

struct GitProgressToast: View {
  let git: GitModel
  @Environment(\.openURL) private var openURL
  @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

  var body: some View {
    HStack(spacing: Spacing.md) {
      icon
      VStack(alignment: .leading, spacing: 2) {
        Text(verbatim: title)
          .font(Typography.subheadline.weight(.semibold))
          .foregroundStyle(Palette.textPrimary)
          .lineLimit(2)
        if let detail {
          Text(verbatim: detail)
            .font(Typography.footnote)
            .foregroundStyle(Palette.textSecondary)
            .lineLimit(2)
        } else if case .running(_, nil, let since) = git.progress {
          // Stepped once a second, not animated.
          TimelineView(.periodic(from: since, by: 1)) { context in
            let seconds = Int(context.date.timeIntervalSince(since))
            if seconds >= 2 {
              Text("Running for \(seconds)s")
                .font(Typography.footnote.monospacedDigit())
                .foregroundStyle(Palette.textSecondary)
            }
          }
        }
      }
      Spacer(minLength: 0)
      if case .succeeded(.action(_, _, let url?)) = git.progress {
        Button { openURL(url) } label: { Text("View", comment: "verb, opens the pull request") }
          .buttonStyle(.glassProminent)
          .controlSize(.small)
      }
    }
    .padding(.horizontal, Spacing.lg)
    .padding(.vertical, Spacing.md)
    .frame(maxWidth: Layout.readingWidth)
    // Mostly opaque: it floats over conversation text, which glass alone left legible through it.
    .background(Palette.surfaceRaised.opacity(reduceTransparency ? 1 : 0.88), in: .rect(cornerRadius: Radius.large))
    .glassEffect(.regular, in: .rect(cornerRadius: Radius.large))
    .contentShape(.rect)
    .onTapGesture { git.dismissProgress() }
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(.updatesFrequently)
    .accessibilityIdentifier("git.progress")
  }

  @ViewBuilder
  private var icon: some View {
    switch git.progress {
    case .running: ProgressView().controlSize(.small)
    case .succeeded: Image(systemName: "checkmark.circle.fill").foregroundStyle(Palette.success)
    case .failed: Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Palette.danger)
    case .idle: EmptyView()
    }
  }

  private var title: String {
    switch git.progress {
    case .running(let label, _, _): ReviewCopy.progressLabel(label)
    case .succeeded(let result): ReviewCopy.result(result).title
    case .failed: String(localized: "Git action failed")
    case .idle: ""
    }
  }

  private var detail: String? {
    switch git.progress {
    case .running(_, let detail, _): detail
    case .succeeded(let result): ReviewCopy.result(result).description
    case .failed(let message): message.isEmpty ? String(localized: "Git action failed.") : message
    case .idle: nil
    }
  }
}

private struct GitConfirmation: ViewModifier {
  @Binding var action: GitStackedAction?
  let git: GitModel

  func body(content: Content) -> some View {
    let term = GitActionRules.term(git.status)
    let branch = git.status?.refName ?? ""
    let copy = action.map { ReviewCopy.defaultBranchCopy($0, branch: branch, term: term) }
    content.alert(
      Text(verbatim: copy?.title ?? String(localized: "Run action on default branch?")),
      isPresented: Binding(get: { action != nil }, set: { if !$0 { action = nil } }), presenting: action
    ) { pending in
      Button {
        Task { await git.run(GitActionInput(pending)) }
      } label: {
        Text(verbatim: copy?.continueLabel ?? String(localized: "Continue"))
      }
      .disabled(!git.canWrite)
      Button("Feature branch & continue") {
        Task { await git.runOnFeatureBranch(pending) }
      }
      .disabled(!git.canCreateFeatureBranch)
      Button("Cancel", role: .cancel) {}
    } message: { _ in
      Text(verbatim: copy?.description ?? String(localized: "Choose how to continue."))
    }
  }
}

/// "Review changes" under an expanded file-change row: opens review on that row's turn (and on
/// the file when the row changed one).
struct ReviewChangesLink: View {
  let review: ReviewPresenter
  let runId: String?
  let files: [String]

  var body: some View {
    Button {
      review.openReview(section: review.section(forRun: runId), path: files.count == 1 ? files.first : nil)
    } label: {
      Label("Review changes", systemImage: "text.bubble")
        .font(Typography.footnote.weight(.medium))
        .frame(minHeight: 44)
        .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .foregroundStyle(Palette.working)
    .accessibilityIdentifier("work.review")
  }
}
