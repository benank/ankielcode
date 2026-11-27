import AnkielKit
import SwiftUI

/// What a sheet over the pull request is for.
enum PullRequestSheet: Identifiable {
  case comment
  case review
  case merge
  case edit
  case reviewers
  case thread(PullRequestReviewThread)
  case inline(PullRequestInlineTarget)

  var id: String {
    switch self {
    case .comment: "comment"
    case .review: "review"
    case .merge: "merge"
    case .edit: "edit"
    case .reviewers: "reviewers"
    case .thread(let thread): "thread:\(thread.id)"
    case .inline(let target): "inline:\(target.id)"
    }
  }
}

/// One pull request: its header, then Overview, Activity and Files, with its actions below.
struct PullRequestDetailScreen: View {
  let target: PullRequestTarget
  @Environment(AppModel.self) private var model
  @State private var tab: Tab = .overview
  @State private var sheet: PullRequestSheet?
  @State private var alert: String?
  @State private var confirming: PullRequestAction?
  @State private var successCount = 0

  enum Tab: Hashable { case overview, activity, files }

  private var feature: PullRequestFeature { model.pullRequests }
  private var detail: PullRequestDetailModel { feature.model(target) }

  private var permissions: PullRequestPermissions {
    PullRequestPermissions(
      detail: detail.value, connected: feature.isConnected(target.environmentId), sourceControlWrite: feature.canWrite(target.environmentId))
  }

  var body: some View {
    let detail = detail
    ScrollView {
      LazyVStack(alignment: .leading, spacing: Spacing.lg, pinnedViews: [.sectionHeaders]) {
        PullRequestHeader(detail: detail, environmentLabel: feature.targets.count > 1 ? feature.label(target.environmentId) : nil)
        Section {
          switch tab {
          case .overview:
            PullRequestOverview(detail: detail, permissions: permissions, sheet: $sheet)
          case .activity:
            PullRequestActivityView(detail: detail, permissions: permissions, sheet: $sheet, alert: $alert)
          case .files:
            PullRequestFilesList(detail: detail, target: target)
          }
        } header: {
          tabs
        }
      }
      .padding(.horizontal, Spacing.lg)
      .padding(.bottom, Spacing.xxl)
      .frame(maxWidth: Layout.readingWidth)
      .frame(maxWidth: .infinity)
    }
    .background(Palette.canvas)
    .navigationTitle(Text(verbatim: "#\(target.ref.number)"))
    .navigationSubtitle(Text(verbatim: target.ref.repository))
    .navigationBarTitleDisplayMode(.inline)
    .refreshable { await detail.refresh() }
    .toolbar { toolbar }
    .safeAreaInset(edge: .bottom, spacing: 0) { actionBar }
    .safeAreaInset(edge: .top, spacing: 0) { debugPill }
    .task {
      await detail.load()
      #if DEBUG
        applyPreset()
      #endif
    }
    .onChange(of: tab) { _, tab in
      if tab == .files, detail.diff == .idle { Task { await detail.loadDiff() } }
    }
    .sheet(item: $sheet) { sheet in
      PullRequestSheetView(sheet: sheet, detail: detail, permissions: permissions) { error in
        if let error { alert = PullRequestCopy.error(error) } else { successCount += 1 }
      }
    }
    .alert("Couldn't send", isPresented: Binding(get: { alert != nil }, set: { if !$0 { alert = nil } })) {
      Button("OK", role: .cancel) {}
    } message: {
      Text(verbatim: alert ?? "")
    }
    .confirmationDialog(
      confirming.map { PullRequestCopy.action($0).0 } ?? "", isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }),
      titleVisibility: .visible
    ) {
      if let action = confirming {
        Button(PullRequestCopy.action(action).0, role: action == .close || action == .deleteBranch ? .destructive : nil) {
          run(action)
        }
        .accessibilityIdentifier("pr.confirm.action")
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      if confirming == .deleteBranch, let value = detail.value {
        Text("Delete \(value.headBranch) from \(value.repository)? Local branches and worktrees are not changed.")
      }
    }
    .sensoryFeedback(.success, trigger: successCount)
  }

  @ViewBuilder
  private var debugPill: some View {
    #if DEBUG
      PullRequestDebugSentPill(sink: feature.sink)
    #endif
  }

  private var tabs: some View {
    Picker("Section", selection: $tab) {
      Text("Overview").tag(Tab.overview)
      Text("Activity").tag(Tab.activity)
      Text(filesTitle).tag(Tab.files)
    }
    .pickerStyle(.segmented)
    .padding(.vertical, Spacing.sm)
    .background(Palette.canvas)
    .accessibilityIdentifier("pr.tabs")
  }

  private var filesTitle: String {
    let count = detail.value?.changedFiles ?? detail.diff.value?.count
    return count.map { String(localized: "Files \($0)") } ?? String(localized: "Files")
  }

  // MARK: Actions

  private func run(_ action: PullRequestAction) {
    Task {
      if let error = await detail.run(action) { alert = PullRequestCopy.error(error) } else { successCount += 1 }
    }
  }

  @ViewBuilder
  private var actionBar: some View {
    if let value = detail.value, permissions.canWrite || !permissions.verdicts.isEmpty || permissions.canComment {
      HStack(spacing: Spacing.sm) {
        if permissions.canComment {
          Button { sheet = .comment } label: {
            Label("Comment", systemImage: "bubble.left").frame(maxWidth: .infinity, minHeight: 36)
          }
          .buttonStyle(.glass)
          .accessibilityIdentifier("pr.action.comment")
        }
        if !permissions.verdicts.isEmpty {
          Button { sheet = .review } label: {
            Label(detail.reviewDrafts.isEmpty ? String(localized: "Review") : String(localized: "Review \(detail.reviewDrafts.count)"), systemImage: "checkmark.bubble")
              .frame(maxWidth: .infinity, minHeight: 36)
          }
          .buttonStyle(.glass)
          .accessibilityIdentifier("pr.action.review")
        }
        if value.state == .open, PullRequestStatus.canPerform(.merge, on: value) {
          Button { sheet = .merge } label: {
            Label("Merge", systemImage: "arrow.triangle.merge").frame(maxWidth: .infinity, minHeight: 36)
          }
          .buttonStyle(.glassProminent)
          .accessibilityIdentifier("pr.action.merge")
        }
      }
      .labelStyle(.titleAndIcon)
      .lineLimit(1)
      .minimumScaleFactor(0.85)
      .font(Typography.subheadline.weight(.semibold))
      .disabled(detail.busy != nil)
      .padding(.horizontal, Spacing.lg)
      .padding(.vertical, Spacing.sm)
      .frame(maxWidth: Layout.readingWidth)
      .frame(maxWidth: .infinity)
      .background {
        // Long descriptions scroll under the floating buttons; fade them out behind the bar.
        LinearGradient(colors: [Palette.canvas.opacity(0), Palette.canvas], startPoint: .top, endPoint: .center)
          .ignoresSafeArea()
          .allowsHitTesting(false)
      }
    }
  }

  @ToolbarContentBuilder
  private var toolbar: some ToolbarContent {
    ToolbarItem(placement: .topBarTrailing) {
      Menu {
        if let value = detail.value {
          PullRequestStartWorkMenu(target: target, detail: value, threads: detail.linkedThreads)
          if permissions.canWrite {
            Section {
              ForEach(
                [PullRequestAction.ready, .draft, .updateBranch, .enableAutoMerge, .disableAutoMerge, .close, .reopen, .deleteBranch].filter {
                  PullRequestStatus.canPerform($0, on: value)
                }, id: \.self
              ) { action in
                let (title, symbol) = PullRequestCopy.action(action)
                Button(title, systemImage: symbol, role: action == .close || action == .deleteBranch ? .destructive : nil) {
                  confirming = action
                }
                .accessibilityIdentifier("pr.menu.\(action.rawValue)")
              }
              if permissions.canEditChangeRequest {
                Button("Edit title and description", systemImage: "pencil") { sheet = .edit }
                  .accessibilityIdentifier("pr.menu.edit")
              }
              if permissions.canRequestReviewers {
                Button("Request reviewers", systemImage: "person.badge.plus") { sheet = .reviewers }
                  .accessibilityIdentifier("pr.menu.reviewers")
              }
            }
          }
          Section {
            Button("Copy link", systemImage: "link") { UIPasteboard.general.string = value.url }
            Button("Copy number", systemImage: "number") { UIPasteboard.general.string = "#\(value.number)" }
            if let url = URL(string: value.url) {
              Link(destination: url) { Label("Open on GitHub", systemImage: "safari") }
              ShareLink(item: url) { Label("Share…", systemImage: "square.and.arrow.up") }
            }
          }
        }
      } label: {
        Label("Pull request actions", systemImage: "ellipsis")
      }
      .accessibilityIdentifier("pr.menu")
    }
  }

  #if DEBUG
    private func applyPreset() {
      guard let preset = feature.debugPreset else { return }
      feature.debugPreset = nil
      switch preset.kind {
      case "files":
        tab = .files
        Task { await detail.loadDiff() }
      case "file":
        tab = .files
        Task {
          await detail.loadDiff()
          if let path = preset.argument { feature.path.append(.file(target, path: path)) }
        }
      case "activity": tab = .activity
      case "review": sheet = .review
      case "merge": sheet = .merge
      case "comment": sheet = .comment
      case "edit": sheet = .edit
      case "reviewers": sheet = .reviewers
      case "thread":
        tab = .activity
        if let thread = detail.threads.first { sheet = .thread(thread) }
      case "confirm-close": confirming = .close
      default: break
      }
    }
  #endif
}

/// The pull request's title, state, people and branches.
struct PullRequestHeader: View {
  let detail: PullRequestDetailModel
  let environmentLabel: String?

  var body: some View {
    let value = detail.value
    let preview = detail.preview
    let state = PullRequestDisplayState(state: value?.state ?? preview?.state, isDraft: value?.isDraft ?? preview?.isDraft ?? false)
    VStack(alignment: .leading, spacing: Spacing.md) {
      HStack(spacing: Spacing.sm) {
        Label(PullRequestCopy.state(state), systemImage: PullRequestCopy.symbol(state))
          .font(Typography.footnote.weight(.semibold))
          .foregroundStyle(state == .draft ? Palette.textSecondary : Palette.onAccent)
          .padding(.horizontal, Spacing.md)
          .padding(.vertical, 5)
          .background(state == .draft ? Palette.fill : PullRequestCopy.tint(state), in: .capsule)
          .accessibilityIdentifier("pr.state")
        if let environmentLabel {
          Text(verbatim: environmentLabel).font(Typography.footnote).foregroundStyle(Palette.textTertiary)
        }
        Spacer(minLength: 0)
        if let value { PullRequestCounts(additions: value.additions, deletions: value.deletions) }
      }
      Text(verbatim: value?.title ?? preview?.title ?? "")
        .font(Typography.title)
        .foregroundStyle(Palette.textPrimary)
        .textSelection(.enabled)
        .accessibilityAddTraits(.isHeader)
        .redacted(reason: value == nil && preview == nil ? .placeholder : [])
      HStack(spacing: Spacing.sm) {
        PullRequestAvatar(actor: value?.author ?? preview?.author)
        Text(verbatim: value?.author?.login ?? preview?.author?.login ?? String(localized: "Unknown author"))
          .font(Typography.subheadline.weight(.medium))
          .foregroundStyle(Palette.textSecondary)
        if let date = (value?.createdAt ?? preview?.createdAt)?.date {
          Text(date, format: .relative(presentation: .named)).font(Typography.footnote).foregroundStyle(Palette.textTertiary)
        }
      }
      if let base = value?.baseBranch ?? preview?.baseBranch, let head = value?.headBranch ?? preview?.headBranch {
        HStack(spacing: Spacing.xs) {
          branch(base)
          Image(systemName: "arrow.left").font(.system(size: 10, weight: .bold)).foregroundStyle(Palette.textTertiary)
          branch(head)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Merging \(head) into \(base)"))
      }
    }
    .padding(.top, Spacing.sm)
  }

  private func branch(_ name: String) -> some View {
    Text(verbatim: name)
      .font(Typography.monoSmall)
      .foregroundStyle(Palette.textSecondary)
      .lineLimit(1)
      .truncationMode(.middle)
      .padding(.horizontal, Spacing.sm)
      .padding(.vertical, 3)
      .background(Palette.codeBackground, in: .rect(cornerRadius: Radius.small, style: .continuous))
      .contextMenu { Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = name } }
  }
}

/// Status, people, labels and the description.
struct PullRequestOverview: View {
  let detail: PullRequestDetailModel
  let permissions: PullRequestPermissions
  @Binding var sheet: PullRequestSheet?
  @State private var checksOpen = false

  var body: some View {
    switch detail.detail {
    case .failed(let error) where detail.value == nil:
      ContentUnavailableView {
        Label("Couldn't load this pull request", systemImage: "exclamationmark.triangle")
      } description: {
        Text(PullRequestCopy.error(error))
      } actions: {
        Button("Try again") { Task { await detail.load() } }.buttonStyle(.glass)
      }
    default:
      if let value = detail.value {
        content(value)
      } else {
        ProgressView().frame(maxWidth: .infinity).padding(.vertical, Spacing.xxl)
      }
    }
  }

  @ViewBuilder
  private func content(_ value: PullRequestDetail) -> some View {
    let checks = PullRequestStatus.checksSummary(detail.shownChecks)
    let review = PullRequestStatus.reviewSummary(reviewers: value.reviewers, activity: detail.activity.value)
    VStack(spacing: 0) {
      Button {
        withAnimation(Motion.micro) { checksOpen.toggle() }
      } label: {
        let (symbol, tint) = PullRequestCopy.checksSymbol(checks.state)
        statusRow(symbol: symbol, tint: tint, title: PullRequestCopy.checksTitle(checks), detail: PullRequestCopy.checksDetail(checks), chevron: checks.total > 0 ? (checksOpen ? "chevron.up" : "chevron.down") : nil)
      }
      .buttonStyle(.plain)
      .disabled(checks.total == 0)
      .accessibilityIdentifier("pr.checks")
      if checksOpen {
        ForEach(PullRequestStatus.orderedChecks(detail.shownChecks), id: \.name) { check in
          PullRequestCheckRow(check: check)
        }
      }
      Divider().overlay(Palette.separator)
      let copy = PullRequestCopy.reviewTitle(review.tone)
      Button {
        if permissions.canRequestReviewers { sheet = .reviewers }
      } label: {
        statusRow(symbol: copy.symbol, tint: copy.tint, title: copy.title, detail: copy.detail, chevron: permissions.canRequestReviewers ? "chevron.right" : nil)
      }
      .buttonStyle(.plain)
      Divider().overlay(Palette.separator)
      let branch = PullRequestStatus.branch(value)
      statusRow(
        symbol: branch == .conflicts ? "exclamationmark.triangle.fill" : "arrow.triangle.branch",
        tint: branch == .conflicts ? Palette.attention : Palette.textTertiary,
        title: PullRequestCopy.branch(branch, base: value.baseBranch),
        detail: PullRequestStatus.mergeBlock(value, canWrite: permissions.canWrite).map(PullRequestCopy.mergeBlock), chevron: nil)
    }
    .padding(.horizontal, Spacing.md)
    .background(Palette.surface, in: .rect(cornerRadius: Radius.large, style: .continuous))

    if !value.labels.isEmpty || !value.reviewers.isEmpty {
      VStack(alignment: .leading, spacing: Spacing.sm) {
        if !value.labels.isEmpty {
          FlowRow(spacing: Spacing.xs) {
            ForEach(value.labels, id: \.name) { PullRequestLabelDot(label: $0) }
          }
        }
        if !value.reviewers.isEmpty {
          HStack(spacing: Spacing.xs) {
            Text("Reviewers").font(Typography.footnote).foregroundStyle(Palette.textTertiary)
            ForEach(value.reviewers, id: \.login) { reviewer in
              HStack(spacing: Spacing.xxs) {
                PullRequestAvatar(actor: reviewer, size: 18)
                Text(verbatim: reviewer.login).font(Typography.footnote).foregroundStyle(Palette.textSecondary)
              }
            }
          }
        }
      }
    }

    PullRequestBody(
      text: value.body, detail: detail, links: PullRequestMarkdown.LinkContext(pullRequestURL: value.url),
      empty: String(localized: "No description provided."))
      .accessibilityIdentifier("pr.description")
    if let reactions = detail.activity.value?.reactions, !reactions.isEmpty || permissions.canReact {
      PullRequestReactionsRow(
        reactions: detail.reactions(reactions, subjectId: nil), canReact: permissions.canReact
      ) { content in
        Task { _ = await detail.react(content, on: nil, current: reactions) }
      }
    }
  }

  private func statusRow(symbol: String, tint: Color, title: String, detail: String?, chevron: String?) -> some View {
    HStack(spacing: Spacing.md) {
      Image(systemName: symbol).font(.system(size: 17)).foregroundStyle(tint).frame(width: 24)
      VStack(alignment: .leading, spacing: 1) {
        Text(verbatim: title).font(Typography.subheadline.weight(.semibold)).foregroundStyle(Palette.textPrimary)
        if let detail { Text(verbatim: detail).font(Typography.footnote).foregroundStyle(Palette.textSecondary) }
      }
      Spacer(minLength: 0)
      if let chevron { Image(systemName: chevron).font(.system(size: 12, weight: .semibold)).foregroundStyle(Palette.textTertiary) }
    }
    .padding(.vertical, Spacing.md)
    .frame(minHeight: 44)
    .contentShape(.rect)
  }
}

struct PullRequestCheckRow: View {
  let check: PullRequestCheck

  var body: some View {
    let status = PullRequestCopy.checkStatus(check.status)
    HStack(spacing: Spacing.md) {
      Image(systemName: status.symbol).foregroundStyle(status.tint).frame(width: 24)
      VStack(alignment: .leading, spacing: 1) {
        HStack(spacing: Spacing.xs) {
          Text(verbatim: check.name).font(Typography.footnote.weight(.medium)).foregroundStyle(Palette.textPrimary)
          if check.required == true {
            Text("Required").font(Typography.caption2).foregroundStyle(Palette.textTertiary)
          }
        }
        Text(verbatim: check.description ?? status.label).font(Typography.caption).foregroundStyle(Palette.textSecondary).lineLimit(2)
      }
      Spacer(minLength: 0)
      if let link = check.url.flatMap(URL.init(string:)) {
        Link(destination: link) {
          Image(systemName: "arrow.up.right.square").frame(width: 44, height: 44)
        }
        .foregroundStyle(Palette.textTertiary)
        .accessibilityLabel(Text("Open \(check.name)"))
      }
    }
    .padding(.leading, Spacing.xs)
    .frame(minHeight: 44)
    .accessibilityElement(children: .combine)
  }
}

/// A body or comment in the markdown renderer, with media segments as images.
struct PullRequestBody: View {
  let text: String
  let detail: PullRequestDetailModel
  let links: PullRequestMarkdown.LinkContext?
  var empty: String?
  @Environment(AppModel.self) private var model

  var body: some View {
    let segments = PullRequestMarkdown.segments(text)
    VStack(alignment: .leading, spacing: Spacing.md) {
      if segments.isEmpty, let empty {
        Text(verbatim: empty).font(Typography.body).italic().foregroundStyle(Palette.textTertiary)
      }
      ForEach(segments) { segment in
        switch segment {
        case .markdown(_, let text):
          MarkdownView(document: PullRequestMarkdownCache.document(PullRequestMarkdown.prepare(text, links: links)), images: images)
        case .attachment(_, let url, let media):
          if media == .image {
            MarkdownView(document: PullRequestMarkdownCache.document("![](\(url))"), images: images)
          } else if let link = URL(string: url) {
            Link(destination: link) {
              Label("Video", systemImage: "play.rectangle.fill")
                .font(Typography.subheadline.weight(.medium))
                .padding(.horizontal, Spacing.md)
                .frame(minHeight: 44)
                .background(Palette.fill, in: .capsule)
            }
          }
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  /// GitHub attachments and repository files load through the computer's credential; other web
  /// images load as they are.
  private var images: ThreadImages {
    let registry = model.registry
    let environmentId = detail.environmentId
    let cwd = detail.value?.workspaceRoot
    let repository = detail.ref.repository
    return ThreadImages(id: "pr:\(detail.ref.key)") { source in
      guard case .markdown(let text) = source, let url = URL(string: text), url.scheme == "https" || url.scheme == "http" else { return nil }
      if let fetch = SourceControlMedia.fetchURL(text), let cwd {
        return try? await registry.assetURL(.sourceControlMedia(cwd: cwd, url: fetch, repository: repository), in: environmentId)
      }
      return url
    }
  }
}

/// Parsed markdown by source, shared across the pull request screens.
@MainActor
enum PullRequestMarkdownCache {
  private static var parser = MarkdownParser(style: .thread, cacheLimit: 400)
  private static var documents: [String: MarkdownDocument] = [:]

  static func document(_ text: String) -> MarkdownDocument {
    if let held = documents[text] { return held }
    if documents.count > 300 { documents.removeAll(keepingCapacity: true) }
    let document = parser.parse(text)
    documents[text] = document
    return document
  }
}

/// Reactions under a body or comment; tapping one toggles it.
struct PullRequestReactionsRow: View {
  let reactions: [PullRequestReaction]
  let canReact: Bool
  let toggle: (PullRequestReactionContent) -> Void

  var body: some View {
    HStack(spacing: Spacing.xs) {
      ForEach(reactions, id: \.content) { reaction in
        if let content = reaction.content.known {
          let names = PullRequestReactions.names(reaction, you: String(localized: "You", comment: "the viewer, in a list of people who reacted"))
          Button {
            toggle(content)
          } label: {
            HStack(spacing: 3) {
              Text(verbatim: PullRequestReactions.emoji(content))
              Text(reaction.count, format: .number).monospacedDigit().contentTransition(.numericText())
            }
            .font(Typography.footnote)
            .padding(.horizontal, Spacing.sm)
            .frame(minHeight: 30)
            .background(reaction.viewerHasReacted ? Palette.working.opacity(0.14) : Palette.fill, in: .capsule)
            .overlay(Capsule().strokeBorder(reaction.viewerHasReacted ? Palette.working.opacity(0.5) : .clear))
          }
          .buttonStyle(.plain)
          .disabled(!canReact)
          .frame(minHeight: 44)
          .accessibilityLabel(Text(verbatim: "\(PullRequestReactions.emoji(content)) \(reaction.count)"))
          .accessibilityHint(Text(verbatim: (names.shown + (names.others > 0 ? ["+\(names.others)"] : [])).joined(separator: ", ")))
          .accessibilityAddTraits(reaction.viewerHasReacted ? .isSelected : [])
        }
      }
      if canReact {
        Menu {
          ForEach(PullRequestReactions.order, id: \.self) { content in
            Button(PullRequestReactions.emoji(content)) { toggle(content) }
          }
        } label: {
          Image(systemName: "face.smiling")
            .font(Typography.footnote)
            .foregroundStyle(Palette.textTertiary)
            .frame(width: 44, height: 44)
        }
        .accessibilityLabel(Text("Add reaction"))
        .accessibilityIdentifier("pr.react")
      }
    }
  }
}

/// Wraps its children onto lines.
struct FlowRow: SwiftUI.Layout {
  var spacing: CGFloat

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let width = proposal.width ?? .infinity
    var x: CGFloat = 0
    var y: CGFloat = 0
    var line: CGFloat = 0
    var widest: CGFloat = 0
    for subview in subviews {
      let size = subview.sizeThatFits(.unspecified)
      if x > 0, x + size.width > width {
        y += line + spacing
        x = 0
        line = 0
      }
      x += size.width + spacing
      widest = max(widest, x - spacing)
      line = max(line, size.height)
    }
    return CGSize(width: min(widest, width), height: y + line)
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    var x = bounds.minX
    var y = bounds.minY
    var line: CGFloat = 0
    for subview in subviews {
      let size = subview.sizeThatFits(.unspecified)
      if x > bounds.minX, x + size.width > bounds.maxX {
        y += line + spacing
        x = bounds.minX
        line = 0
      }
      subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
      x += size.width + spacing
      line = max(line, size.height)
    }
  }
}
