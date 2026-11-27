import AnkielKit
import SwiftUI

/// The pull request screens over home: the list, with pull requests pushed on it (iPhone), or
/// the list beside the open pull request (iPad).
struct PullRequestsRoot: View {
  @Environment(AppModel.self) private var model
  @Environment(\.horizontalSizeClass) private var sizeClass

  var body: some View {
    let feature = model.pullRequests
    @Bindable var bindable = feature
    Group {
      if sizeClass == .regular {
        NavigationSplitView {
          PullRequestsScreen(split: true)
            .navigationSplitViewColumnWidth(min: 340, ideal: 400, max: 480)
        } detail: {
          NavigationStack {
            if let target = feature.selected {
              PullRequestDetailScreen(target: target)
                .id(target.id)
                .navigationDestination(for: PullRequestRoute.self) { PullRequestRouteView(route: $0) }
            } else {
              ContentUnavailableView {
                Label("No pull request selected", systemImage: "arrow.triangle.pull")
              } description: {
                Text("Choose a pull request from the list.")
              }
              .background(Palette.canvas)
            }
          }
        }
      } else {
        NavigationStack(path: $bindable.path) {
          PullRequestsScreen(split: false)
            .navigationDestination(for: PullRequestRoute.self) { PullRequestRouteView(route: $0) }
        }
      }
    }
    .tint(Palette.accent)
  }
}

/// A pushed pull request or file.
struct PullRequestRouteView: View {
  let route: PullRequestRoute
  @Environment(AppModel.self) private var model

  var body: some View {
    switch route {
    case .pullRequest(let target): PullRequestDetailScreen(target: target)
    case .file(let target, let path): PullRequestFileScreen(detail: model.pullRequests.model(target), path: path)
    }
  }
}

enum PullRequestListSheet: String, Identifiable {
  case link, routing
  var id: String { rawValue }
}

struct PullRequestsScreen: View {
  let split: Bool
  @Environment(AppModel.self) private var model
  @State private var sheet: PullRequestListSheet?
  @State private var expandedError: String?

  private var feature: PullRequestFeature { model.pullRequests }
  private var list: PullRequestListModel { feature.list }

  var body: some View {
    @Bindable var list = list
    List {
      Section {
        PullRequestFilterBar(list: list, feature: feature)
          .listRowInsets(EdgeInsets())
          .listRowBackground(Color.clear)
          .listRowSeparator(.hidden)
        ForEach(failureRows, id: \.id) { failure in
          failureRow(failure)
        }
        ForEach(list.projectErrors) { error in
          projectError(error)
        }
      }
      Section {
        ForEach(list.items) { item in
          row(item)
            .onAppear {
              if item.id == list.items.last?.id, list.hasMore { Task { await list.loadMore() } }
            }
        }
        footer
      }
    }
    .listStyle(.plain)
    .scrollContentBackground(.hidden)
    .background(Palette.canvas)
    .overlay { emptyState }
    .navigationTitle("Pull requests")
    .navigationBarTitleDisplayMode(.large)
    .searchable(text: $list.query, prompt: Text("Search or filter, e.g. label:bug"))
    .refreshable { await list.refresh() }
    .toolbar { toolbar }
    .sheet(item: $sheet) { sheet in
      switch sheet {
      case .link: PullRequestLinkSheet()
      case .routing: PullRequestRoutingSheet()
      }
    }
    .safeAreaInset(edge: .top, spacing: 0) { debugPill }
    .task {
      if list.phase == .idle { list.reload() }
      #if DEBUG
        if let preset = feature.debugSheet {
          feature.debugSheet = nil
          sheet = preset
        }
        if feature.debugLink != nil { sheet = .link }
      #endif
    }
    .onChange(of: feature.targets.map(\.connected)) { _, _ in list.reload() }
  }

  @ViewBuilder
  private var debugPill: some View {
    #if DEBUG
      PullRequestDebugSentPill(sink: feature.sink)
    #endif
  }

  private func row(_ item: PullRequestListItem) -> some View {
    let target = PullRequestTarget(environmentId: item.environmentId, ref: item.ref, preview: item.entry)
    let selected = split && feature.selected == target
    return Button {
      feature.path = [.pullRequest(target)]
    } label: {
      PullRequestRowView(
        entry: item.entry, computer: feature.targets.count > 1 ? feature.label(item.environmentId) : nil, selected: selected)
    }
    .buttonStyle(.plain)
    .listRowInsets(EdgeInsets(top: 0, leading: Spacing.lg, bottom: 0, trailing: Spacing.lg))
    .listRowBackground(
      RoundedRectangle(cornerRadius: Radius.medium, style: .continuous)
        .fill(selected ? Palette.fill : Color.clear)
        .padding(.horizontal, Spacing.sm)
    )
    .listRowSeparatorTint(Palette.separator)
    .accessibilityIdentifier("pr.row.\(item.entry.number)")
    .contextMenu {
      Button("Copy link", systemImage: "link") { UIPasteboard.general.string = item.entry.url }
      if let url = URL(string: item.entry.url) {
        Link(destination: url) { Label("Open on GitHub", systemImage: "safari") }
      }
    }
  }

  // MARK: States

  private struct Failure: Identifiable {
    let id: String
    let label: String
    let error: PullRequestError
  }

  private var failureRows: [Failure] {
    list.failures.sorted { $0.key < $1.key }.compactMap { id, error in
      if case .notConnected = error { return nil }
      // A single computer's failure is the empty state when nothing else listed.
      if list.items.isEmpty, list.failures.count == list.activeTargets.count { return nil }
      return Failure(id: id, label: feature.label(id), error: error)
    }
  }

  private func failureRow(_ failure: Failure) -> some View {
    Label {
      VStack(alignment: .leading, spacing: Spacing.xxs) {
        Text(verbatim: failure.label).font(Typography.subheadline.weight(.semibold))
        Text(PullRequestCopy.error(failure.error)).font(Typography.footnote).foregroundStyle(Palette.textSecondary)
      }
    } icon: {
      Image(systemName: PullRequestCopy.signedOut(failure.error) ? "person.crop.circle.badge.exclamationmark" : "exclamationmark.triangle")
        .foregroundStyle(Palette.attention)
    }
    .listRowBackground(Color.clear)
  }

  private func projectError(_ error: PullRequestListModel.ComputerError) -> some View {
    let expanded = expandedError == error.id
    return Button {
      expandedError = expanded ? nil : error.id
    } label: {
      HStack(spacing: Spacing.md) {
        Image(systemName: "exclamationmark.triangle").foregroundStyle(Palette.textTertiary)
        Text(verbatim: "\(error.projectTitle ?? feature.label(error.environmentId)): \(error.message)")
          .font(Typography.footnote)
          .foregroundStyle(Palette.textSecondary)
          .lineLimit(expanded ? nil : 1)
          .frame(maxWidth: .infinity, alignment: .leading)
        Image(systemName: "chevron.down")
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(Palette.textTertiary)
          .rotationEffect(.degrees(expanded ? 180 : 0))
      }
      .frame(minHeight: 44)
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .listRowBackground(Color.clear)
    .accessibilityValue(expanded ? Text("Expanded") : Text("Collapsed"))
  }

  @ViewBuilder
  private var footer: some View {
    if list.loadingMore {
      ProgressView()
        .frame(maxWidth: .infinity)
        .padding(.vertical, Spacing.lg)
        .accessibilityLabel(Text("Loading more pull requests"))
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
    } else if let error = list.loadMoreError {
      VStack(spacing: Spacing.sm) {
        Text(verbatim: error).font(Typography.footnote).foregroundStyle(Palette.textSecondary)
        Button("Try again") { Task { await list.loadMore() } }
          .buttonStyle(.glass)
          .accessibilityLabel(Text("Retry loading more pull requests"))
      }
      .frame(maxWidth: .infinity)
      .padding(.vertical, Spacing.md)
      .listRowBackground(Color.clear)
      .listRowSeparator(.hidden)
    } else if list.hasMore {
      // A filtered page can be too short to scroll, which leaves nothing to reach the end of.
      Button("Load more") { Task { await list.loadMore() } }
        .buttonStyle(.glass)
        .frame(maxWidth: .infinity)
        .padding(.vertical, Spacing.md)
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
        .accessibilityLabel(Text("Load more pull requests"))
    }
  }

  @ViewBuilder
  private var emptyState: some View {
    if list.items.isEmpty {
      if list.phase != .loaded, list.activeTargets.contains(where: \.connected) {
        ProgressView().controlSize(.large)
      } else if feature.targets.isEmpty {
        ContentUnavailableView {
          Label("Connect an environment", systemImage: "desktopcomputer")
        } description: {
          Text("Add an environment in Settings to browse its pull requests.")
        }
      } else if list.offline {
        ContentUnavailableView {
          Label("Environment offline", systemImage: "wifi.slash")
        } description: {
          Text("Reconnect to load pull requests that aren't saved on this device.")
        }
      } else if let error = list.failures.values.first, list.failures.count >= list.activeTargets.filter(\.connected).count {
        ContentUnavailableView {
          Label(
            PullRequestCopy.signedOut(error) ? String(localized: "Sign in to GitHub") : String(localized: "Couldn't load pull requests"),
            systemImage: PullRequestCopy.signedOut(error) ? "person.crop.circle.badge.exclamationmark" : "exclamationmark.triangle")
        } description: {
          Text(PullRequestCopy.error(error))
        } actions: {
          Button("Try again") { list.reload() }.buttonStyle(.glass)
        }
      } else {
        ContentUnavailableView {
          Label(list.query.isEmpty ? String(localized: "No matching pull requests") : String(localized: "No results"), systemImage: "arrow.triangle.pull")
        } description: {
          Text("Pull requests from the selected environments' projects appear here.")
        } actions: {
          if !list.controls.isDefault { Button("Reset filters") { list.resetFilters() }.buttonStyle(.glass) }
        }
      }
    }
  }

  @ToolbarContentBuilder
  private var toolbar: some ToolbarContent {
    ToolbarItem(placement: .topBarLeading) {
      Button("Close", systemImage: "xmark") { feature.close() }
        .accessibilityIdentifier("pr.close")
    }
    ToolbarItem(placement: .topBarTrailing) {
      Menu {
        Button("Open a pull request link", systemImage: "link") { sheet = .link }
          .accessibilityIdentifier("pr.openLink")
        Button("Pull request routing", systemImage: "arrow.triangle.branch") { sheet = .routing }
      } label: {
        Label("More", systemImage: "ellipsis")
      }
      .accessibilityIdentifier("pr.listMenu")
    }
  }
}

/// One pull request in the list.
struct PullRequestRowView: View, Equatable {
  let entry: PullRequestListEntry
  let computer: String?
  let selected: Bool
  @Environment(\.dynamicTypeSize) private var typeSize

  nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
    lhs.entry == rhs.entry && lhs.computer == rhs.computer && lhs.selected == rhs.selected
  }

  var body: some View {
    let state = PullRequestDisplayState(state: entry.state, isDraft: entry.isDraft)
    HStack(alignment: .firstTextBaseline, spacing: Spacing.md) {
      Image(systemName: PullRequestCopy.symbol(state))
        .font(.system(size: 14, weight: .semibold))
        .foregroundStyle(PullRequestCopy.tint(state))
        .frame(width: 18)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: Spacing.xs) {
        Text(verbatim: entry.title)
          .font(Typography.body.weight(.medium))
          .foregroundStyle(state == .draft ? Palette.textSecondary : Palette.textPrimary)
          .lineLimit(typeSize.isAccessibilitySize ? 4 : 2)
        HStack(spacing: Spacing.xs) {
          Text(verbatim: "\(entry.repository) #\(entry.number)")
          if let author = entry.author?.login { Text(verbatim: "· \(author)") }
          if let computer { Text(verbatim: "· \(computer)") }
        }
        .font(Typography.footnote)
        .foregroundStyle(Palette.textTertiary)
        .lineLimit(1)
        meta
        if !entry.labels.isEmpty {
          HStack(spacing: Spacing.xs) {
            ForEach(entry.labels.prefix(3), id: \.name) { PullRequestLabelDot(label: $0) }
            if entry.labels.count > 3 {
              Text(verbatim: "+\(entry.labels.count - 3)").font(Typography.caption).foregroundStyle(Palette.textTertiary)
            }
          }
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .padding(.vertical, Spacing.md)
    .contentShape(.rect)
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
  }

  private var meta: some View {
    HStack(spacing: Spacing.md) {
      if let checks = entry.checksState?.known {
        let (symbol, tint, label) = PullRequestCopy.checksState(checks)
        Image(systemName: symbol).foregroundStyle(tint).accessibilityLabel(Text(label))
      }
      if let badge = PullRequestList.reviewBadge(decision: entry.reviewDecision, viewerReviewRequested: entry.viewerReviewRequested) {
        let copy = PullRequestCopy.reviewBadge(badge)
        Label(copy.label, systemImage: copy.symbol)
          .foregroundStyle(copy.tint)
          .accessibilityLabel(Text(copy.accessible))
      }
      if PullRequestStatus.hasConflict(state: entry.state, isDraft: entry.isDraft, mergeability: entry.mergeability) {
        Label("Conflicts", systemImage: "exclamationmark.triangle").foregroundStyle(Palette.attention)
      }
      if entry.additions + entry.deletions > 0 { PullRequestCounts(additions: entry.additions, deletions: entry.deletions) }
      Spacer(minLength: 0)
      if let date = entry.updatedAt.date {
        Text(date, format: .relative(presentation: .named, unitsStyle: .abbreviated))
          .foregroundStyle(Palette.textTertiary)
      }
    }
    .font(Typography.caption)
    .labelStyle(.titleAndIcon)
    .lineLimit(1)
  }
}

/// The filter chips above the list (RN `PullRequestListFilters`).
struct PullRequestFilterBar: View {
  @Bindable var list: PullRequestListModel
  let feature: PullRequestFeature

  var body: some View {
    ScrollView(.horizontal) {
      HStack(spacing: Spacing.sm) {
        if feature.targets.count > 1 {
          chip(feature.targets.first { $0.environmentId == list.environmentId }?.label ?? String(localized: "All environments"), active: list.environmentId != nil) {
            Picker("Environment", selection: $list.environmentId) {
              Text("All environments").tag(String?.none)
              ForEach(feature.targets, id: \.environmentId) { Text(verbatim: $0.label).tag(Optional($0.environmentId)) }
            }
          }
        }
        chip(stateLabel(list.controls.state), active: list.controls.state != .open) {
          Picker("State", selection: $list.controls.state) {
            ForEach([PullRequestListState.open, .closed, .merged, .all], id: \.self) { Text(stateLabel($0)).tag($0) }
          }
        }
        .accessibilityIdentifier("pr.filter.state")
        chip(involvementLabel(list.controls.involvement), active: list.controls.involvement != .all) {
          Picker("Involvement", selection: $list.controls.involvement) {
            ForEach(PullRequestInvolvement.allCases, id: \.self) { Text(involvementLabel($0)).tag($0) }
          }
        }
        .accessibilityIdentifier("pr.filter.involvement")
        chip(draftLabel(typedFilters.draft), active: typedFilters.draft != nil) {
          Picker("Drafts", selection: draftBinding) {
            Text("All drafts").tag(PullRequestListFilters.Draft?.none)
            Text("Drafts only").tag(Optional(PullRequestListFilters.Draft.only))
            Text("Hide drafts").tag(Optional(PullRequestListFilters.Draft.hide))
          }
        }
        chip(reviewLabel(list.controls.filters.review), active: list.controls.filters.review != nil) {
          Picker("Reviews", selection: $list.controls.filters.review) {
            Text("All reviews").tag(PullRequestListFilters.Review?.none)
            Text("Approved", comment: "review status filter").tag(Optional(PullRequestListFilters.Review.approved))
            Text("Changes requested").tag(Optional(PullRequestListFilters.Review.changesRequested))
            Text("Review required").tag(Optional(PullRequestListFilters.Review.reviewRequired))
            Text("No reviews").tag(Optional(PullRequestListFilters.Review.none))
          }
        }
        chip(checksLabel(list.controls.filters.checks), active: list.controls.filters.checks != nil) {
          Picker("Checks", selection: $list.controls.filters.checks) {
            Text("All checks").tag(PullRequestListFilters.Checks?.none)
            Text("Passing", comment: "CI checks filter").tag(Optional(PullRequestListFilters.Checks.passing))
            Text("Failing", comment: "CI checks filter").tag(Optional(PullRequestListFilters.Checks.failing))
          }
        }
        if !list.knownLabels.isEmpty {
          chip(labelsTitle, active: !(list.controls.filters.labels ?? []).isEmpty) {
            Button("All labels") { list.controls.filters.labels = nil }
            ForEach(list.knownLabels, id: \.self) { name in
              Toggle(name, isOn: labelBinding(name))
            }
          }
        }
        if !list.knownAuthors.isEmpty {
          chip(authorTitle, active: list.controls.filters.author != nil) {
            Picker("Author", selection: $list.controls.filters.author) {
              Text("All authors").tag(String?.none)
              Text("Me", comment: "author filter, the current user").tag(Optional("me"))
              ForEach(list.knownAuthors, id: \.self) { Text(verbatim: $0).tag(Optional($0)) }
            }
          }
        }
        chip(sortLabel(list.controls.sort), active: list.controls.sort != .updated) {
          Picker("Sort", selection: $list.controls.sort) {
            ForEach(PullRequestListControls.Sort.allCases, id: \.self) { Text(sortLabel($0)).tag($0) }
          }
        }
        if !list.controls.isDefault {
          Button("Reset filters", systemImage: "xmark.circle.fill") { list.resetFilters() }
            .labelStyle(.iconOnly)
            .font(Typography.subheadline)
            .foregroundStyle(Palette.textTertiary)
            .frame(minWidth: 44, minHeight: 44)
        }
      }
      .padding(.horizontal, Spacing.lg)
      .padding(.vertical, Spacing.xs)
    }
    .scrollIndicators(.hidden)
  }

  private var typedFilters: PullRequestListFilters {
    list.controls.filters.overlaid(by: PullRequestQuery.parse(list.query).filters)
  }

  private var draftBinding: Binding<PullRequestListFilters.Draft?> {
    Binding(
      get: { typedFilters.draft },
      set: { value in
        var next = list.controls.filters
        next.draft = value
        let update = PullRequestQuery.applyDraftChange(query: list.query, menu: list.controls.filters, next: next)
        list.controls.filters = update.filters
        if update.query != list.query { list.query = update.query }
      })
  }

  private func labelBinding(_ name: String) -> Binding<Bool> {
    Binding(
      get: { list.controls.filters.labels?.contains { $0.contains(name) } == true },
      set: { on in
        var groups = (list.controls.filters.labels ?? []).filter { !$0.contains(name) }
        if on { groups.append([name]) }
        list.controls.filters.labels = groups.isEmpty ? nil : groups
      })
  }

  private var labelsTitle: String {
    let count = list.controls.filters.labels?.count ?? 0
    return count > 0 ? String(localized: "Labels \(count)") : String(localized: "Labels", comment: "filter menu")
  }

  private var authorTitle: String {
    switch list.controls.filters.author {
    case "me"?: String(localized: "By you")
    case let author?: author
    case nil: String(localized: "Author", comment: "filter menu")
    }
  }

  private func chip(_ title: String, active: Bool, @ViewBuilder content: () -> some View) -> some View {
    Menu {
      content()
    } label: {
      HStack(spacing: Spacing.xs) {
        Text(verbatim: title).lineLimit(1)
        Image(systemName: "chevron.down").font(.system(size: 9, weight: .bold))
      }
      .font(Typography.subheadline.weight(active ? .semibold : .regular))
      .foregroundStyle(active ? Palette.textPrimary : Palette.textSecondary)
      .padding(.horizontal, Spacing.md)
      .frame(minHeight: 34)
      .background(active ? Palette.fill : Palette.surface, in: .capsule)
      .overlay(Capsule().strokeBorder(Palette.separator, lineWidth: active ? 0 : 1))
      .contentShape(.capsule)
    }
    .menuActionDismissBehavior(.automatic)
    .frame(minHeight: 44)
  }

  private func stateLabel(_ state: PullRequestListState) -> String {
    switch state {
    case .open: String(localized: "Open", comment: "pull request state filter")
    case .closed: String(localized: "Closed", comment: "pull request state filter")
    case .merged: String(localized: "Merged", comment: "pull request state filter")
    case .all: String(localized: "All states")
    }
  }

  private func involvementLabel(_ involvement: PullRequestInvolvement) -> String {
    switch involvement {
    case .all: String(localized: "All PRs")
    case .reviewing: String(localized: "Your review")
    case .authored: String(localized: "By you")
    }
  }

  private func draftLabel(_ draft: PullRequestListFilters.Draft?) -> String {
    switch draft {
    case .only?: String(localized: "Drafts only")
    case .hide?: String(localized: "Hide drafts")
    case nil: String(localized: "Drafts", comment: "filter menu")
    }
  }

  private func reviewLabel(_ review: PullRequestListFilters.Review?) -> String {
    switch review {
    case .approved?: String(localized: "Approved", comment: "review status filter")
    case .changesRequested?: String(localized: "Changes requested")
    case .reviewRequired?: String(localized: "Review required")
    case .none?: String(localized: "No reviews")
    case nil: String(localized: "Reviews", comment: "filter menu")
    }
  }

  private func checksLabel(_ checks: PullRequestListFilters.Checks?) -> String {
    switch checks {
    case .passing?: String(localized: "Passing checks")
    case .failing?: String(localized: "Failing checks")
    case nil: String(localized: "Checks", comment: "filter menu")
    }
  }

  private func sortLabel(_ sort: PullRequestListControls.Sort) -> String {
    switch sort {
    case .updated: String(localized: "Recently updated")
    case .created: String(localized: "Newest created")
    case .oldest: String(localized: "Oldest updated")
    }
  }
}

/// Opening a pull request by pasting its link (RN `pullRequestLinkInput`).
struct PullRequestLinkSheet: View {
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  @State private var text = ""
  @State private var problem: String?
  @FocusState private var focused: Bool

  var body: some View {
    NavigationStack {
      Form {
        Section {
          TextField("https://github.com/owner/repo/pull/123", text: $text)
            .keyboardType(.URL)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .focused($focused)
            .submitLabel(.go)
            .onSubmit(open)
            .accessibilityIdentifier("pr.link.field")
        } footer: {
          if let problem {
            Text(verbatim: problem).foregroundStyle(Palette.danger)
          } else {
            Text("Paste a pull request link, or #123 for the chosen project.")
          }
        }
      }
      .navigationTitle("Open a pull request")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button("Open", action: open).disabled(text.trimmingCharacters(in: .whitespaces).isEmpty)
            .accessibilityIdentifier("pr.link.open")
        }
      }
      .onAppear {
        focused = true
        #if DEBUG
          if let link = model.pullRequests.debugLink {
            model.pullRequests.debugLink = nil
            text = link
            open()
          }
        #endif
      }
    }
    .presentationDetents([.medium])
  }

  private var projects: [PullRequestLinkInput.Project] {
    let feature = model.pullRequests
    if feature.isFixture {
      let identity = try? JSONDecoder().decode(
        RepositoryIdentity.self, from: Data(#"{"canonicalKey":"github.com/tidewater/tide-chart","provider":"github","owner":"tidewater","name":"tide-chart"}"#.utf8))
      return [.init(environmentId: PullRequestFixtures.environmentId, projectId: PullRequestFixtures.projectId, identity: identity)]
    }
    let serving = Set(feature.targets.filter(\.connected).map(\.environmentId))
    return model.registry.environments.filter { serving.contains($0.id) }.flatMap { environment in
      (environment.shell.snapshot?.projects ?? []).map {
        PullRequestLinkInput.Project(environmentId: environment.id, projectId: $0.id, identity: $0.repositoryIdentity)
      }
    }
  }

  private func open() {
    let feature = model.pullRequests
    let scope = feature.list.controls.projectId.flatMap { id in projects.first { $0.projectId == id } }
    switch PullRequestLinkInput.resolve(text, projects: projects, scope: scope) {
    case .open(let environmentId, let ref)?:
      dismiss()
      feature.path = [.pullRequest(PullRequestTarget(environmentId: environmentId, ref: ref))]
    case .noProject(let host, let repository)?:
      problem = String(localized: "No project in this environment can read \(host)/\(repository).")
    case .needsURL?:
      problem = String(localized: "Paste the full pull request URL; no project is chosen to resolve the number against.")
    case nil:
      problem = String(localized: "That is not a pull request link.")
    }
  }
}

/// Which computers may answer for each other (RN `PullRequestRoutingSettings`).
struct PullRequestRoutingSheet: View {
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    let trust = model.pullRequests.trust
    NavigationStack {
      Form {
        Section {
          ForEach(model.registry.environments) { environment in
            Picker(selection: binding(environment, trust)) {
              ForEach(PullRequestRoutingPermission.allCases, id: \.self) { permission in
                VStack(alignment: .leading) {
                  Text(title(permission))
                  Text(detail(permission)).font(Typography.caption).foregroundStyle(Palette.textSecondary)
                }
                .tag(permission)
              }
            } label: {
              VStack(alignment: .leading, spacing: Spacing.xxs) {
                Text(verbatim: environment.label)
                Text(verbatim: environment.displayRoute?.endpoint.httpBaseURL.host() ?? "")
                  .font(Typography.caption)
                  .foregroundStyle(Palette.textTertiary)
              }
            }
            .pickerStyle(.navigationLink)
            .disabled(PullRequestRoutingRules.connectionKey(environment.record) == nil)
          }
        } footer: {
          Text(
            "Choose environments you trust to share PR data and use each other's source control access. Enable both environments. This applies only to this client."
          )
        }
      }
      .navigationTitle("Pull request routing")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
    }
  }

  private func binding(_ environment: EnvironmentModel, _ trust: PullRequestRoutingStore) -> Binding<PullRequestRoutingPermission> {
    Binding(get: { trust.permission(environment.record) }, set: { trust.set($0, for: environment.record) })
  }

  private func title(_ permission: PullRequestRoutingPermission) -> String {
    switch permission {
    case .off: String(localized: "Off", comment: "pull request routing permission")
    case .read: String(localized: "Read PRs")
    case .readWrite: String(localized: "Read and act")
    }
  }

  private func detail(_ permission: PullRequestRoutingPermission) -> String {
    switch permission {
    case .off: String(localized: "Keep source control requests on this environment.")
    case .read: String(localized: "Share PR data with other enabled environments.")
    case .readWrite: String(localized: "Actions may use broader source control permissions than the original environment.")
    }
  }
}
