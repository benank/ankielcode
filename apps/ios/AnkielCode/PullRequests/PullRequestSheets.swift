import AnkielKit
import SwiftUI

/// Every sheet over a pull request. `done` gets the write's error, or nil when it landed.
struct PullRequestSheetView: View {
  let sheet: PullRequestSheet
  let detail: PullRequestDetailModel
  let permissions: PullRequestPermissions
  let done: (PullRequestError?) -> Void

  var body: some View {
    switch sheet {
    case .comment:
      PullRequestTextSheet(
        title: String(localized: "Add comment"), placeholder: String(localized: "Leave a comment"), action: String(localized: "Comment"),
        identifier: "pr.sheet.comment"
      ) { body in await detail.comment(body) } done: { done($0) }
    case .review: PullRequestReviewSheet(detail: detail, verdicts: permissions.verdicts, done: done)
    case .merge: PullRequestMergeSheet(detail: detail, done: done)
    case .edit: PullRequestEditSheet(detail: detail, done: done)
    case .reviewers: PullRequestReviewersSheet(detail: detail, done: done)
    case .thread(let thread): PullRequestThreadSheet(detail: detail, thread: thread, permissions: permissions, done: done)
    case .inline(let target): PullRequestInlineSheet(detail: detail, target: target)
    }
  }
}

/// A title, one text field and a send button.
struct PullRequestTextSheet: View {
  let title: String
  let placeholder: String
  let action: String
  let identifier: String
  var initial = ""
  let send: (String) async -> PullRequestError?
  let done: (PullRequestError?) -> Void
  @Environment(\.dismiss) private var dismiss
  @State private var text = ""
  @State private var sending = false
  @State private var error: String?
  @FocusState private var focused: Bool

  var body: some View {
    NavigationStack {
      VStack(alignment: .leading, spacing: Spacing.sm) {
        TextField(placeholder, text: $text, axis: .vertical)
          .lineLimit(6...16)
          .focused($focused)
          .padding(Spacing.md)
          .background(Palette.surface, in: .rect(cornerRadius: Radius.field, style: .continuous))
          .accessibilityIdentifier("\(identifier).field")
        if let error { Text(verbatim: error).font(Typography.footnote).foregroundStyle(Palette.danger) }
        Text("Markdown works here.").font(Typography.caption).foregroundStyle(Palette.textTertiary)
        Spacer()
      }
      .padding(Spacing.lg)
      .background(Palette.canvas)
      .navigationTitle(title)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          if sending {
            ProgressView()
          } else {
            Button(action) { submit() }
              .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
              .accessibilityIdentifier("\(identifier).send")
          }
        }
      }
      .onAppear {
        if text.isEmpty { text = initial }
        focused = true
      }
      .interactiveDismissDisabled(sending || text != initial)
    }
    .presentationDetents([.medium, .large])
  }

  private func submit() {
    sending = true
    error = nil
    Task {
      let failure = await send(text)
      sending = false
      if let failure {
        error = PullRequestCopy.error(failure)
      } else {
        done(nil)
        dismiss()
      }
    }
  }
}

/// Submitting a review: a verdict, a summary and the pending inline comments.
struct PullRequestReviewSheet: View {
  let detail: PullRequestDetailModel
  let verdicts: [PullRequestReviewVerdict]
  let done: (PullRequestError?) -> Void
  @Environment(\.dismiss) private var dismiss
  @State private var verdict: PullRequestReviewVerdict = .comment
  @State private var text = ""
  @State private var sending = false
  @State private var error: String?

  var body: some View {
    NavigationStack {
      Form {
        Section {
          Picker("Verdict", selection: $verdict) {
            ForEach(verdicts, id: \.self) { verdict in
              let (title, symbol) = PullRequestCopy.verdict(verdict)
              Label(title, systemImage: symbol).tag(verdict)
            }
          }
          .pickerStyle(.inline)
          .labelsHidden()
          .accessibilityIdentifier("pr.review.verdict")
        }
        Section {
          TextField(verdict == .approve ? String(localized: "Add a note (optional)") : String(localized: "Leave a comment"), text: $text, axis: .vertical)
            .lineLimit(4...12)
            .accessibilityIdentifier("pr.review.body")
        }
        if !detail.reviewDrafts.isEmpty {
          Section {
            ForEach(detail.reviewDrafts) { draft in
              VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: "\((draft.path as NSString).lastPathComponent) · \(PullRequestFileScreen.label(draft.position))")
                  .font(Typography.caption.monospaced())
                  .foregroundStyle(Palette.textSecondary)
                Text(verbatim: draft.body).font(Typography.footnote).lineLimit(3)
              }
              .swipeActions { Button("Remove", role: .destructive) { detail.removeDraft(draft) } }
            }
          } header: {
            Text("^[\(detail.reviewDrafts.count) pending comment](inflect: true)")
          }
        }
        if let error {
          Section { Text(verbatim: error).foregroundStyle(Palette.danger) }
        }
      }
      .navigationTitle("Submit review")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          if sending {
            ProgressView()
          } else {
            Button("Submit") { submit() }
              .disabled(!canSubmit)
              .accessibilityIdentifier("pr.review.submit")
          }
        }
      }
      .onAppear { if let first = verdicts.first, !verdicts.contains(verdict) { verdict = first } }
    }
    .presentationDetents([.medium, .large])
  }

  /// A comment or change request needs words (or inline comments); an approval does not.
  private var canSubmit: Bool {
    verdict == .approve || !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !detail.reviewDrafts.isEmpty
  }

  private func submit() {
    sending = true
    Task {
      let failure = await detail.submitReview(verdict, body: text)
      sending = false
      if let failure {
        error = PullRequestCopy.error(failure)
      } else {
        done(nil)
        dismiss()
      }
    }
  }
}

/// Merging: the method, what it does, and a confirmation.
struct PullRequestMergeSheet: View {
  let detail: PullRequestDetailModel
  let done: (PullRequestError?) -> Void
  @Environment(\.dismiss) private var dismiss
  @AppStorage("ankiel.pullRequestMergeMethod") private var lastUsed = ""
  @State private var method: PullRequestMergeMethod?
  @State private var confirming = false
  @State private var sending = false
  @State private var error: String?

  var body: some View {
    NavigationStack {
      if let value = detail.value {
        let methods = PullRequestStatus.allowedMergeMethods(value)
        let chosen = method ?? PullRequestStatus.resolveMergeMethod(value, selected: nil, projectDefault: nil, lastUsed: PullRequestMergeMethod(rawValue: lastUsed))
        Form {
          Section {
            ForEach(methods, id: \.self) { candidate in
              let copy = PullRequestCopy.merge(candidate)
              Button {
                method = candidate
              } label: {
                HStack {
                  VStack(alignment: .leading, spacing: 2) {
                    Text(copy.title).foregroundStyle(Palette.textPrimary)
                    Text(copy.detail).font(Typography.footnote).foregroundStyle(Palette.textSecondary)
                  }
                  Spacer()
                  if candidate == chosen { Image(systemName: "checkmark").foregroundStyle(Palette.accent) }
                }
                .contentShape(.rect)
              }
              .buttonStyle(.plain)
              .accessibilityAddTraits(candidate == chosen ? .isSelected : [])
              .accessibilityIdentifier("pr.merge.method.\(candidate.rawValue)")
            }
          } footer: {
            Text("Merging \(value.headBranch) into \(value.baseBranch)")
          }
          if let block = PullRequestStatus.mergeBlock(value, canWrite: true) {
            Section { Text(PullRequestCopy.mergeBlock(block)).foregroundStyle(Palette.attention) }
          }
          if let error { Section { Text(verbatim: error).foregroundStyle(Palette.danger) } }
          Section {
            Button {
              confirming = true
            } label: {
              HStack {
                Spacer()
                if sending { ProgressView() } else { Text(chosen.map { PullRequestCopy.merge($0).title } ?? String(localized: "Merge")).fontWeight(.semibold) }
                Spacer()
              }
              .frame(minHeight: 36)
            }
            .disabled(chosen == nil || sending || PullRequestStatus.mergeBlock(value, canWrite: true) != nil)
            .accessibilityIdentifier("pr.merge.confirm")
          }
        }
        .navigationTitle("Merge pull request")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        .confirmationDialog(
          Text("Merge #\(value.number) into \(value.baseBranch)?"), isPresented: $confirming, titleVisibility: .visible
        ) {
          Button(chosen.map { PullRequestCopy.merge($0).title } ?? String(localized: "Merge")) { merge(chosen) }
            .accessibilityIdentifier("pr.merge.final")
          Button("Cancel", role: .cancel) {}
        } message: {
          Text("This merges on GitHub for everyone. It can't be undone from here.")
        }
      }
    }
    .presentationDetents([.medium, .large])
  }

  private func merge(_ method: PullRequestMergeMethod?) {
    guard let method else { return }
    sending = true
    Task {
      let failure = await detail.run(.merge, mergeMethod: method)
      sending = false
      if let failure {
        error = PullRequestCopy.error(failure)
      } else {
        lastUsed = method.rawValue
        done(nil)
        dismiss()
      }
    }
  }
}

/// Editing the title and description.
struct PullRequestEditSheet: View {
  let detail: PullRequestDetailModel
  let done: (PullRequestError?) -> Void
  @Environment(\.dismiss) private var dismiss
  @State private var title = ""
  @State private var text = ""
  @State private var loaded = false
  @State private var sending = false
  @State private var error: String?

  var body: some View {
    NavigationStack {
      Form {
        Section("Title") {
          TextField("Title", text: $title, axis: .vertical).accessibilityIdentifier("pr.edit.title")
        }
        Section("Description") {
          TextField("Description", text: $text, axis: .vertical)
            .lineLimit(8...24)
            .font(Typography.mono)
            .accessibilityIdentifier("pr.edit.body")
        }
        if let error { Section { Text(verbatim: error).foregroundStyle(Palette.danger) } }
      }
      .navigationTitle("Edit pull request")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          if sending {
            ProgressView()
          } else {
            Button("Save") { save() }
              .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty || !changed)
              .accessibilityIdentifier("pr.edit.save")
          }
        }
      }
      .onAppear {
        guard !loaded, let value = detail.value else { return }
        loaded = true
        title = value.title
        text = value.body
      }
    }
  }

  private var changed: Bool { title != detail.value?.title || text != detail.value?.body }

  private func save() {
    sending = true
    let newTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
    Task {
      let failure = await detail.update(
        title: newTitle == detail.value?.title ? nil : newTitle, body: text == detail.value?.body ? nil : text)
      sending = false
      if let failure {
        error = PullRequestCopy.error(failure)
      } else {
        done(nil)
        dismiss()
      }
    }
  }
}

/// Requesting reviewers: picks are kept on the device and sent when Done is pressed.
struct PullRequestReviewersSheet: View {
  let detail: PullRequestDetailModel
  let done: (PullRequestError?) -> Void
  @Environment(\.dismiss) private var dismiss
  @State private var candidates: PullRequestLoad<PullRequestReviewerCandidateList> = .idle
  @State private var picks = PullRequestSelection<PullRequestReviewerChoice>()
  @State private var query = ""
  @State private var sending = false
  @State private var error: String?

  var body: some View {
    NavigationStack {
      List {
        switch candidates {
        case .loaded(let list):
          let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
          ForEach(list.candidates.filter { needle.isEmpty || $0.login.lowercased().contains(needle) || ($0.name ?? "").lowercased().contains(needle) }) { candidate in
            let choice = PullRequestReviewerChoice(id: candidate.id, kind: candidate.kind.known ?? .user)
            let key = "\(candidate.kind.rawValue):\(candidate.id)"
            let selected = picks.isSelected(key, host: candidate.isRequested)
            Button {
              picks.toggle(key, item: choice, host: candidate.isRequested)
            } label: {
              HStack(spacing: Spacing.md) {
                PullRequestAvatar(actor: PullRequestActor(login: candidate.login, name: candidate.name), size: 28)
                VStack(alignment: .leading, spacing: 1) {
                  Text(verbatim: candidate.login).foregroundStyle(Palette.textPrimary)
                  if let name = candidate.name { Text(verbatim: name).font(Typography.footnote).foregroundStyle(Palette.textSecondary) }
                }
                Spacer()
                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                  .foregroundStyle(selected ? Palette.accent : Palette.textTertiary)
                  .contentTransition(.symbolEffect(.replace))
              }
              .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(selected ? .isSelected : [])
            .accessibilityIdentifier("pr.reviewer.\(candidate.login)")
          }
          if list.truncated { Text("Type to find more people.").font(Typography.footnote).foregroundStyle(Palette.textTertiary) }
        case .failed(let failure):
          Text(PullRequestCopy.error(failure)).foregroundStyle(Palette.danger)
        default:
          ProgressView().frame(maxWidth: .infinity)
        }
        if let error { Text(verbatim: error).foregroundStyle(Palette.danger) }
      }
      .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: Text("Search people"))
      .navigationTitle("Reviewers")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          if sending { ProgressView() } else {
            Button("Done") { send() }.accessibilityIdentifier("pr.reviewers.done")
          }
        }
      }
      .task {
        do throws(PullRequestError) {
          candidates = .loaded(try await detail.reviewerCandidates(query: nil))
        } catch {
          candidates = .failed(error)
        }
      }
    }
  }

  private func send() {
    guard case .loaded(let list) = candidates else { return dismiss() }
    let requested = Set(list.candidates.filter(\.isRequested).map { "\($0.kind.rawValue):\($0.id)" })
    let changes = picks.changes { key, _ in requested.contains(key) }
    guard !changes.add.isEmpty || !changes.remove.isEmpty else { return dismiss() }
    sending = true
    Task {
      let failure = await detail.requestReviewers(add: changes.add, remove: changes.remove)
      sending = false
      if let failure {
        error = PullRequestCopy.error(failure)
      } else {
        done(nil)
        dismiss()
      }
    }
  }
}

/// A review thread: its comments, a reply and resolve.
struct PullRequestThreadSheet: View {
  let detail: PullRequestDetailModel
  let thread: PullRequestReviewThread
  let permissions: PullRequestPermissions
  let done: (PullRequestError?) -> Void
  @Environment(\.dismiss) private var dismiss
  @State private var reply = ""
  @State private var sending = false
  @State private var error: String?

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: Spacing.lg) {
          ForEach(thread.comments) { comment in
            VStack(alignment: .leading, spacing: Spacing.xs) {
              HStack(spacing: Spacing.sm) {
                PullRequestAvatar(actor: comment.author)
                Text(verbatim: comment.author?.login ?? "").font(Typography.subheadline.weight(.semibold))
                Spacer()
                if let date = comment.createdAt.date {
                  Text(date, format: .relative(presentation: .named)).font(Typography.caption).foregroundStyle(Palette.textTertiary)
                }
              }
              PullRequestBody(text: comment.body, detail: detail, links: detail.value.flatMap { PullRequestMarkdown.LinkContext(pullRequestURL: $0.url) })
            }
          }
          if permissions.canReply {
            TextField("Reply", text: $reply, axis: .vertical)
              .lineLimit(2...8)
              .padding(Spacing.md)
              .background(Palette.surface, in: .rect(cornerRadius: Radius.field, style: .continuous))
              .accessibilityIdentifier("pr.thread.reply")
          }
          if let error { Text(verbatim: error).font(Typography.footnote).foregroundStyle(Palette.danger) }
        }
        .padding(Spacing.lg)
      }
      .background(Palette.canvas)
      .navigationTitle(Text(verbatim: thread.path.map { ($0 as NSString).lastPathComponent } ?? String(localized: "Discussion")))
      .navigationSubtitle(thread.line.map { Text("Line \($0)") } ?? Text(""))
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
        ToolbarItemGroup(placement: .confirmationAction) {
          if sending {
            ProgressView()
          } else {
            if permissions.canResolve, thread.canResolve != false {
              Button(thread.isResolved ? String(localized: "Unresolve") : String(localized: "Resolve")) {
                run { await detail.resolve(thread, resolved: !thread.isResolved) }
              }
              .accessibilityIdentifier("pr.thread.resolve")
            }
            if permissions.canReply {
              Button("Reply") { run { await detail.reply(to: thread, body: reply) } }
                .disabled(reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityIdentifier("pr.thread.send")
            }
          }
        }
      }
    }
    .presentationDetents([.medium, .large])
  }

  private func run(_ write: @escaping () async -> PullRequestError?) {
    sending = true
    Task {
      let failure = await write()
      sending = false
      if let failure {
        error = PullRequestCopy.error(failure)
      } else {
        done(nil)
        dismiss()
      }
    }
  }
}

/// An inline comment: added to the pending review (nothing is sent until the review is).
struct PullRequestInlineSheet: View {
  let detail: PullRequestDetailModel
  let target: PullRequestInlineTarget
  @Environment(\.dismiss) private var dismiss
  @State private var text = ""
  @FocusState private var focused: Bool

  private var existing: PullRequestReviewCommentDraft? {
    detail.reviewDrafts.first { $0.path == target.path && $0.position == target.position && $0.startPosition == target.start }
  }

  var body: some View {
    NavigationStack {
      VStack(alignment: .leading, spacing: Spacing.md) {
        Text(verbatim: target.excerpt)
          .font(Typography.monoSmall)
          .foregroundStyle(Palette.textSecondary)
          .lineLimit(3)
          .padding(Spacing.sm)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(Palette.codeBackground, in: .rect(cornerRadius: Radius.small, style: .continuous))
        TextField("Add review comment", text: $text, axis: .vertical)
          .lineLimit(4...12)
          .padding(Spacing.md)
          .background(Palette.surface, in: .rect(cornerRadius: Radius.field, style: .continuous))
          .focused($focused)
          .accessibilityIdentifier("pr.inline.field")
        Text("Comments are sent together when you submit the review.").font(Typography.caption).foregroundStyle(Palette.textTertiary)
        Spacer()
      }
      .padding(Spacing.lg)
      .background(Palette.canvas)
      .navigationTitle(Text(verbatim: target.label))
      .navigationSubtitle(Text(verbatim: (target.path as NSString).lastPathComponent))
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        if let existing {
          ToolbarItem(placement: .destructiveAction) {
            Button("Remove", role: .destructive) {
              detail.removeDraft(existing)
              dismiss()
            }
          }
        }
        ToolbarItem(placement: .confirmationAction) {
          Button(existing == nil ? String(localized: "Add to review") : String(localized: "Save")) {
            if let existing { detail.removeDraft(existing) }
            detail.addDraft(
              PullRequestReviewCommentDraft(
                path: target.path, oldPath: target.oldPath == target.path ? nil : target.oldPath, position: target.position,
                startPosition: target.start, body: text))
            Haptics.success()
            dismiss()
          }
          .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          .accessibilityIdentifier("pr.inline.add")
        }
      }
      .onAppear {
        if text.isEmpty, let existing { text = existing.body }
        focused = true
      }
    }
    .presentationDetents([.medium, .large])
  }
}
