import AnkielKit
import SwiftUI
import UIKit

/// One issue, read-only: title and state, the description as markdown, comments oldest first
/// with older pages on request, and "Start a thread" from it.
struct IssueDetailScreen: View {
  let startThread: (IssueEntry) -> Void
  @State private var detail: IssueDetailModel
  @Environment(\.openURL) private var openURL

  init(entry: IssueEntry, environmentId: String, source: any IssueSource, startThread: @escaping (IssueEntry) -> Void) {
    self.startThread = startThread
    _detail = State(initialValue: IssueDetailModel(entry: entry, environmentId: environmentId, source: source))
  }

  private var entry: IssueEntry { detail.detail?.entry ?? detail.entry }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: Spacing.lg) {
        header
        if let body = detail.body {
          if body.blocks.isEmpty {
            Text("No description provided.")
              .font(Typography.callout)
              .foregroundStyle(Palette.textTertiary)
          } else {
            MarkdownView(document: body)
          }
        } else if detail.error == nil {
          ProgressView().frame(maxWidth: .infinity)
        }
        if let error = detail.error {
          Label { Text(verbatim: error) } icon: { Image(systemName: "exclamationmark.triangle") }
            .font(Typography.footnote)
            .foregroundStyle(Palette.danger)
        }
        comments
      }
      .padding(Spacing.lg)
      .frame(maxWidth: Layout.readingWidth, alignment: .leading)
      .frame(maxWidth: .infinity)
    }
    .background(Palette.canvas)
    .navigationTitle(Text(verbatim: entry.displayKey))
    .navigationSubtitle(entry.scope)
    .navigationBarTitleDisplayMode(.inline)
    .refreshable { await detail.load() }
    .safeAreaInset(edge: .bottom) {
      Button {
        startThread(entry)
      } label: {
        Label("Start a thread", systemImage: "bubble.left.and.text.bubble.right")
          .font(Typography.headline)
          .foregroundStyle(Palette.onPrimaryButton)
          .frame(maxWidth: .infinity, minHeight: 44)
      }
      .buttonStyle(.glassProminent)
      .tint(Palette.primaryButton)
      .padding(.horizontal, Spacing.lg)
      .padding(.bottom, Spacing.sm)
      .accessibilityIdentifier("issue.startThread")
    }
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Menu {
          if let url = URL(string: entry.url) {
            Button("Open on the tracker", systemImage: "safari") { openURL(url) }
            Button("Copy link", systemImage: "link") {
              UIPasteboard.general.string = entry.url
              Haptics.success()
            }
            ShareLink(item: url) { Label("Share…", systemImage: "square.and.arrow.up") }
          }
        } label: {
          Label("Issue actions", systemImage: "ellipsis")
        }
        .accessibilityIdentifier("issue.menu")
      }
    }
    .task { if detail.detail == nil { await detail.load() } }
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: Spacing.sm) {
      Text(verbatim: entry.title)
        .typeStyle(.title)
        .foregroundStyle(Palette.textPrimary)
        .textSelection(.enabled)
      HStack(spacing: Spacing.sm) {
        HStack(spacing: Spacing.xs) {
          IssueStateIcon(state: entry.state)
          Text(verbatim: entry.state.name)
        }
        .font(Typography.subheadline.weight(.medium))
        .padding(.horizontal, Spacing.sm)
        .padding(.vertical, Spacing.xs)
        .background(Palette.fill, in: .capsule)
        Text(verbatim: [entry.author?.displayName, entry.projectTitle, IssueCopy.relative(entry.createdAt)].compactMap(\.self).joined(separator: " · "))
          .font(Typography.footnote)
          .foregroundStyle(Palette.textSecondary)
          .lineLimit(2)
      }
      if !entry.labels.isEmpty { IssueLabels(labels: entry.labels) }
    }
  }

  @ViewBuilder private var comments: some View {
    if detail.detail != nil {
      VStack(alignment: .leading, spacing: Spacing.md) {
        Text("Comments")
          .font(Typography.headline)
          .foregroundStyle(Palette.textPrimary)
        if detail.cursor != nil {
          Button {
            Task { await detail.loadOlder() }
          } label: {
            if detail.loadingOlder { ProgressView() } else { Text("Load older comments") }
          }
          .buttonStyle(.glass)
          .accessibilityIdentifier("issue.olderComments")
        }
        if detail.comments.isEmpty {
          Text("No comments yet.")
            .font(Typography.callout)
            .foregroundStyle(Palette.textTertiary)
        }
        ForEach(detail.comments) { comment in
          IssueCommentCard(comment: comment)
        }
      }
    }
  }
}

private struct IssueCommentCard: View {
  let comment: IssueComment
  @State private var document: MarkdownDocument?

  var body: some View {
    VStack(alignment: .leading, spacing: Spacing.sm) {
      Text(verbatim: [comment.author?.displayName ?? String(localized: "Unknown"), IssueCopy.relative(comment.createdAt)].compactMap(\.self).joined(separator: " · "))
        .font(Typography.footnote.weight(.medium))
        .foregroundStyle(Palette.textSecondary)
      if let document {
        MarkdownView(document: document)
      } else {
        Text(verbatim: comment.body).font(Typography.body).foregroundStyle(Palette.textPrimary)
      }
    }
    .padding(Spacing.md)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Palette.surface, in: .rect(cornerRadius: Radius.medium, style: .continuous))
    .task(id: comment.body) { document = await IssueDetailModel.parse(comment.body, style: .thread) }
  }
}
