import AnkielKit
import SwiftUI

/// The conversation: comments, reviews and commits in time order, then the review threads.
struct PullRequestActivityView: View {
  let detail: PullRequestDetailModel
  let permissions: PullRequestPermissions
  @Binding var sheet: PullRequestSheet?
  @Binding var alert: String?

  enum Event: Identifiable {
    case comment(PullRequestComment)
    case commits([PullRequestCommit])

    var id: String {
      switch self {
      case .comment(let comment): comment.id
      case .commits(let commits): "commits:\(commits.first?.oid ?? "")"
      }
    }

    var date: WireTimestamp {
      switch self {
      case .comment(let comment): comment.createdAt
      case .commits(let commits): commits.first?.committedDate ?? WireTimestamp(rawValue: "")
      }
    }
  }

  /// Comments and reviews with runs of consecutive commits grouped, oldest first.
  static func events(_ activity: PullRequestActivity) -> [Event] {
    let comments = activity.comments.filter { $0.kind != .reviewComment }
    let merged = (comments.map { (date: $0.createdAt, event: Event.comment($0)) }
      + activity.commits.map { (date: $0.committedDate, event: Event.commits([$0])) })
      .sorted { $0.date < $1.date }
    var events: [Event] = []
    for item in merged {
      if case .commits(let next) = item.event, case .commits(let held)? = events.last {
        events[events.count - 1] = .commits(held + next)
      } else {
        events.append(item.event)
      }
    }
    return events
  }

  var body: some View {
    switch detail.activity {
    case .failed(let error):
      ContentUnavailableView {
        Label("Couldn't load the conversation", systemImage: "exclamationmark.triangle")
      } description: {
        Text(PullRequestCopy.error(error))
      } actions: {
        Button("Try again") { Task { await detail.load() } }.buttonStyle(.glass)
      }
    case .loaded(let activity):
      content(activity)
    default:
      ProgressView().frame(maxWidth: .infinity).padding(.vertical, Spacing.xxl)
    }
  }

  @ViewBuilder
  private func content(_ activity: PullRequestActivity) -> some View {
    let events = Self.events(activity)
    let links = detail.value.flatMap { PullRequestMarkdown.LinkContext(pullRequestURL: $0.url) }
    if events.isEmpty, activity.conversationThreads.isEmpty {
      ContentUnavailableView("No activity yet", systemImage: "bubble.left.and.bubble.right")
    }
    VStack(alignment: .leading, spacing: Spacing.lg) {
      ForEach(events) { event in
        switch event {
        case .comment(let comment):
          commentView(comment, links: links)
        case .commits(let commits):
          commitsView(commits)
        }
      }
      if activity.commentsTruncated {
        Text("Older comments are on GitHub.").font(Typography.footnote).foregroundStyle(Palette.textTertiary)
      }
    }
    let threads = activity.conversationThreads
    if !threads.isEmpty {
      VStack(alignment: .leading, spacing: Spacing.sm) {
        Text("Review threads")
          .font(Typography.headline)
          .accessibilityAddTraits(.isHeader)
          .padding(.top, Spacing.md)
        ForEach(threads) { thread in
          Button { sheet = .thread(thread) } label: { PullRequestThreadSummary(thread: thread) }
            .buttonStyle(.plain)
            .accessibilityIdentifier("pr.thread.\(thread.id)")
        }
      }
    }
  }

  private func commentView(_ comment: PullRequestComment, links: PullRequestMarkdown.LinkContext?) -> some View {
    let review = comment.kind == .review ? PullRequestStatus.normalizedReviewState(comment.reviewState) : nil
    return VStack(alignment: .leading, spacing: Spacing.sm) {
      HStack(spacing: Spacing.sm) {
        PullRequestAvatar(actor: comment.author)
        Text(verbatim: comment.author?.login ?? String(localized: "Unknown author"))
          .font(Typography.subheadline.weight(.semibold))
          .foregroundStyle(Palette.textPrimary)
        if let review {
          let (label, symbol, tint) = PullRequestCopy.reviewState(review)
          Label(label, systemImage: symbol)
            .font(Typography.footnote)
            .foregroundStyle(tint)
            .labelStyle(.titleAndIcon)
        }
        Spacer(minLength: 0)
        if let date = comment.createdAt.date {
          Text(date, format: .relative(presentation: .named, unitsStyle: .abbreviated))
            .font(Typography.caption)
            .foregroundStyle(Palette.textTertiary)
        }
      }
      if !comment.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        PullRequestBody(text: comment.body, detail: detail, links: links)
          .padding(Spacing.md)
          .background(Palette.surface, in: .rect(cornerRadius: Radius.medium, style: .continuous))
      }
      let canReact = permissions.canWrite && detail.value.map { PullRequestReactions.canReact(provider: $0.provider, capabilities: $0.capabilities, kind: comment.kind) } == true
      if !comment.reactions.isEmpty || canReact {
        PullRequestReactionsRow(reactions: detail.reactions(comment.reactions, subjectId: comment.id), canReact: canReact) { content in
          Task {
            if let error = await detail.react(content, on: comment.id, current: comment.reactions) { alert = PullRequestCopy.error(error) }
          }
        }
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("pr.comment.\(comment.id)")
  }

  private func commitsView(_ commits: [PullRequestCommit]) -> some View {
    VStack(alignment: .leading, spacing: Spacing.xs) {
      ForEach(commits) { commit in
        HStack(alignment: .firstTextBaseline, spacing: Spacing.sm) {
          Image(systemName: "smallcircle.filled.circle").font(.system(size: 11)).foregroundStyle(Palette.textTertiary)
          Text(verbatim: commit.messageHeadline).font(Typography.footnote).foregroundStyle(Palette.textSecondary).lineLimit(2)
          Spacer(minLength: Spacing.sm)
          Text(verbatim: String(commit.oid.prefix(7))).font(Typography.caption.monospaced()).foregroundStyle(Palette.textTertiary)
        }
      }
    }
    .padding(.leading, Spacing.xs)
    .accessibilityElement(children: .combine)
  }
}

/// A review thread's first comment and its state.
struct PullRequestThreadSummary: View {
  let thread: PullRequestReviewThread

  var body: some View {
    VStack(alignment: .leading, spacing: Spacing.xs) {
      HStack(spacing: Spacing.xs) {
        Image(systemName: thread.path == nil ? "text.bubble" : "doc.text").foregroundStyle(Palette.textTertiary)
        Text(verbatim: thread.path.map { path in thread.line.map { "\(path):\($0)" } ?? path } ?? String(localized: "Discussion"))
          .font(Typography.caption.monospaced())
          .foregroundStyle(Palette.textSecondary)
          .lineLimit(1)
          .truncationMode(.head)
        Spacer(minLength: 0)
        if thread.isResolved {
          Label("Resolved", systemImage: "checkmark.circle").font(Typography.caption).foregroundStyle(Palette.success)
        } else if thread.isOutdated {
          Text("Outdated").font(Typography.caption).foregroundStyle(Palette.textTertiary)
        }
      }
      if let first = thread.comments.first {
        Text(verbatim: "\(first.author?.login ?? "") · \(first.body)")
          .font(Typography.footnote)
          .foregroundStyle(Palette.textPrimary)
          .lineLimit(3)
      }
      Text("^[\(thread.commentCount ?? thread.comments.count) comment](inflect: true)")
        .font(Typography.caption)
        .foregroundStyle(Palette.textTertiary)
    }
    .padding(Spacing.md)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Palette.surface, in: .rect(cornerRadius: Radius.medium, style: .continuous))
    .opacity(thread.isResolved ? 0.7 : 1)
    .contentShape(.rect)
  }
}

/// "Start work": a thread for the pull request (RN `pullRequestAgentTasks`). It only fills a
/// draft (the pull request's link and the task's prompt); nothing runs until it is sent.
struct PullRequestStartWorkMenu: View {
  let target: PullRequestTarget
  let detail: PullRequestDetail
  let threads: [PullRequestLinkedThreadsResult.Thread]
  @Environment(AppModel.self) private var model

  enum WorkTask: String, CaseIterable { case ask, explain, feedback, conflicts }

  var body: some View {
    Section {
      ForEach(WorkTask.allCases, id: \.self) { task in
        let (title, symbol) = Self.title(task)
        let disabled = (task == .feedback && detail.state != .open) || (task == .conflicts && (detail.state != .open || detail.mergeability != .conflicting))
        let open = threads.filter { $0.archivedAt == nil }
        if open.isEmpty {
          Button(title, systemImage: symbol) { start(task, in: nil) }
            .disabled(disabled)
            .accessibilityIdentifier("pr.work.\(task.rawValue)")
        } else {
          Menu {
            Button("Start a new thread", systemImage: "plus") { start(task, in: nil) }
            ForEach(open) { thread in
              Button(thread.title.isEmpty ? String(localized: "Continue thread") : thread.title, systemImage: "bubble.left.and.bubble.right") {
                start(task, in: thread)
              }
            }
          } label: {
            Label(title, systemImage: symbol)
          }
          .disabled(disabled)
        }
      }
    }
  }

  static func title(_ task: WorkTask) -> (String, String) {
    switch task {
    case .ask: (String(localized: "Ask a question"), "bubble.left.and.text.bubble.right")
    case .explain: (String(localized: "Explain this PR"), "book")
    case .feedback: (String(localized: "Address feedback"), "wrench.and.screwdriver")
    case .conflicts: (String(localized: "Resolve conflicts"), "arrow.triangle.branch")
    }
  }

  /// The prompts RN sends (agent-facing, so not translated).
  static func prompt(_ task: WorkTask) -> String {
    switch task {
    case .ask: ""
    case .explain:
      "Explain this pull request. Read the diff and walk through its purpose, the changes, the risks, and what I should read closely before approving. Do not change any code."
    case .feedback:
      "Address the actionable feedback and failing checks on this pull request. Fetch the latest review threads and check results, skip resolved feedback, and verify each finding before changing code. First confirm this thread is on the PR's branch; if it isn't, prepare the PR in its own worktree. Keep the fixes focused and run the relevant checks."
    case .conflicts:
      "Resolve this pull request's conflicts with its base branch. First confirm this thread is on the PR's branch; if it isn't, prepare the PR in its own worktree. Bring it up to date using this repository's convention, preserve the intent of both sides, and run the relevant checks before pushing."
    }
  }

  /// The draft's text: the pull request's reference, then the task.
  static func draft(_ detail: PullRequestDetail, task: WorkTask) -> String {
    let reference = "\(detail.url) (#\(detail.number) \(detail.title), \(detail.headBranch) → \(detail.baseBranch))"
    let prompt = prompt(task)
    return prompt.isEmpty ? reference + "\n\n" : reference + "\n\n" + prompt
  }

  private func start(_ task: WorkTask, in thread: PullRequestLinkedThreadsResult.Thread?) {
    let text = Self.draft(detail, task: task)
    let model = model
    let environmentId = target.environmentId
    model.pullRequests.close()
    // Home presents the thread or the new-thread sheet once the full-screen cover has gone.
    Task { @MainActor in
      try? await Task.sleep(for: .milliseconds(450))
      if let thread {
        let ref = ThreadRef(environmentId: environmentId, threadId: thread.id)
        model.composer.updateDraft(ref.key) { draft in
          if !draft.text.contains(detail.url) { draft.text = draft.text.isEmpty ? text : draft.text + "\n\n" + text }
        }
        model.navigator.open(ref)
      } else {
        model.open(.newThread(prompt: text, environmentId: environmentId, projectId: detail.projectId))
      }
    }
  }
}
