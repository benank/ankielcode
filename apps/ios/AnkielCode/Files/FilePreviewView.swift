import AnkielKit
import SwiftUI
import UIKit

/// One file, shown the way its kind reads best: source with line numbers (and rendered markdown),
/// a zoomable image, a player, a PDF, or Quick Look. Large and binary files degrade to a card with
/// their size and "Open in Quick Look".
struct FilePreviewView: View {
  let target: FileTarget
  let presenter: FilePresenter
  @Environment(AppModel.self) private var model
  @State private var state: LoadState = .loading
  @State private var mode: Mode = .preview
  @State private var findQuery = ""
  @State private var findIndex = 0
  @State private var copied = 0
  @State private var reloads = 0

  enum Mode { case preview, source }

  enum LoadState {
    case loading
    case text(SourceDocument, raw: String, byteLength: Int, truncated: Bool, markdown: MarkdownDocument?)
    case image(LoadedImage)
    case player(URL)
    case pdf(URL)
    /// Downloaded for Quick Look (documents, archives, binary files).
    case quickLook(URL)
    /// Binary or too unusual to show inline; offers Quick Look on demand.
    case binary(byteLength: Int?)
    case folder
    case failed(String)
  }

  private var kind: FileKind { target.kind }
  private var path: String? { if case .workspace(let path, _) = target { path } else { nil } }
  private var line: Int? { if case .workspace(_, let line) = target { line } else { nil } }

  var body: some View {
    content
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(Palette.canvas)
      .navigationTitle(target.name)
      .navigationSubtitle(subtitle)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { toolbar }
      .task(id: [reloads, presenter.isConnected ? 1 : 0]) { await load() }
      .sensoryFeedback(.success, trigger: copied)
  }

  private var subtitle: String {
    guard let path else { return "" }
    let parent = WorkspacePath.parent(path)
    if WorkspacePath.isAbsolute(path) { return parent }
    return [presenter.context?.title, parent.isEmpty ? nil : parent].compactMap { $0 }.joined(separator: " · ")
  }

  // MARK: Content

  @ViewBuilder
  private var content: some View {
    switch state {
    case .loading:
      ProgressView().accessibilityLabel(Text("Loading file"))
    case .text(let document, _, let byteLength, let truncated, let markdown):
      VStack(spacing: 0) {
        if truncated {
          PartialFileNotice(byteLength: byteLength) { openQuickLook() }
        }
        if let markdown, mode == .preview {
          ScrollView {
            MarkdownView(document: markdown)
              .padding(Spacing.lg)
              .frame(maxWidth: Layout.readingWidth, alignment: .leading)
              .frame(maxWidth: .infinity)
          }
          .accessibilityIdentifier("file.markdown")
        } else {
          SourceTextView(document: document, targetLine: line, matches: matches(document), currentMatch: currentMatch(document))
            .searchable(text: $findQuery, placement: .toolbar, prompt: Text("Find in file"))
            .onSubmit(of: .search) { advanceFind(document) }
            .safeAreaInset(edge: .bottom) { findBar(document) }
        }
      }
    case .image(let loaded):
      ZoomableImageView(image: loaded.image, title: target.name)
        .background(Color.black)
        .ignoresSafeArea(edges: .bottom)
    case .player(let url):
      MediaPlayerView(url: url, title: target.name).ignoresSafeArea(edges: .bottom)
    case .pdf(let url):
      PDFDocumentView(url: url).ignoresSafeArea(edges: .bottom)
    case .quickLook(let url):
      QuickLookView(url: url).ignoresSafeArea(edges: .bottom)
    case .binary(let byteLength):
      ContentUnavailableView {
        Label(target.name, systemImage: FileIcon.symbol(for: target.name, isDirectory: false))
      } description: {
        VStack(spacing: Spacing.xs) {
          Text("This file can't be shown as text.")
          if let byteLength { Text(Int64(byteLength).formatted(.byteCount(style: .file))).monospacedDigit() }
        }
      } actions: {
        Button("Open in Quick Look") { openQuickLook() }
          .buttonStyle(.glassProminent)
          .accessibilityIdentifier("file.quicklook")
      }
    case .folder:
      ContentUnavailableView("This is a folder", systemImage: "folder", description: Text("Open it from Files to see what is inside."))
    case .failed(let message):
      ContentUnavailableView {
        Label("File unavailable", systemImage: "exclamationmark.triangle")
      } description: {
        Text(message)
      } actions: {
        Button("Try again") { reloads += 1 }.buttonStyle(.glass)
      }
    }
  }

  @ViewBuilder
  private func findBar(_ document: SourceDocument) -> some View {
    let found = matches(document)
    if !findQuery.trimmingCharacters(in: .whitespaces).isEmpty {
      HStack(spacing: Spacing.sm) {
        Text(found.isEmpty ? String(localized: "No matches") : String(localized: "\(min(findIndex, found.count - 1) + 1) of \(found.count)"))
          .font(Typography.footnote.monospacedDigit())
          .foregroundStyle(Palette.textSecondary)
          .contentTransition(.numericText())
        Spacer(minLength: 0)
        Button("Previous match", systemImage: "chevron.up") { step(-1, count: found.count) }
          .labelStyle(.iconOnly)
          .frame(width: 44, height: 44)
          .disabled(found.isEmpty)
        Button("Next match", systemImage: "chevron.down") { step(1, count: found.count) }
          .labelStyle(.iconOnly)
          .frame(width: 44, height: 44)
          .disabled(found.isEmpty)
      }
      .padding(.horizontal, Spacing.lg)
      .padding(.vertical, Spacing.xs)
      .chromeGlass()
      .padding(.horizontal, Spacing.lg)
      .padding(.bottom, Spacing.sm)
    }
  }

  private func matches(_ document: SourceDocument) -> [Int] { document.matches(findQuery) }

  private func currentMatch(_ document: SourceDocument) -> Int? {
    let found = matches(document)
    return found.isEmpty ? nil : found[min(findIndex, found.count - 1)]
  }

  private func step(_ delta: Int, count: Int) {
    guard count > 0 else { return }
    findIndex = (min(findIndex, count - 1) + delta + count) % count
  }

  private func advanceFind(_ document: SourceDocument) { step(1, count: matches(document).count) }

  // MARK: Toolbar

  @ToolbarContentBuilder
  private var toolbar: some ToolbarContent {
    ToolbarItem(placement: .topBarTrailing) {
      Menu {
        if case .text(_, _, _, _, _?) = state {
          Picker("View", selection: $mode) {
            Label { Text("Preview", comment: "file view mode") } icon: { Image(systemName: "eye") }.tag(Mode.preview)
            Label { Text("Source", comment: "file view mode, raw source text") } icon: { Image(systemName: "doc.text") }.tag(Mode.source)
          }
          .pickerStyle(.inline)
        }
        if case .text(_, let raw, _, let truncated, let markdown) = state {
          if mode == .source || markdown == nil {
            Button(model.preferences.values.codeWordBreak ? "Disable word wrap" : "Enable word wrap", systemImage: "text.alignleft") {
              model.preferences.values.codeWordBreak.toggle()
            }
          }
          Button(truncated ? "Copy preview" : "Copy contents", systemImage: "doc.on.doc") {
            UIPasteboard.general.string = raw
            copied += 1
          }
          ShareLink(item: raw, preview: SharePreview(target.name)) { Label("Share", systemImage: "square.and.arrow.up") }
        }
        if let path, let context = presenter.context {
          Button("Copy path", systemImage: "link") {
            UIPasteboard.general.string = WorkspacePath.resolve(path, in: context.cwd)
            copied += 1
          }
        }
        if case .image(let loaded) = state, let file = loaded.file {
          ShareLink(item: file) { Label("Share", systemImage: "square.and.arrow.up") }
          Button("Save to Photos", systemImage: "square.and.arrow.down") {
            Task { try? await MediaActions.saveToPhotos(file: file, image: loaded.image) }
          }
          Button("Copy", systemImage: "photo.on.rectangle") {
            MediaActions.copy(file: file, image: loaded.image)
            copied += 1
          }
        } else if case .quickLook(let file) = state {
          ShareLink(item: file) { Label("Share", systemImage: "square.and.arrow.up") }
        } else if case .pdf(let file) = state {
          ShareLink(item: file) { Label("Share", systemImage: "square.and.arrow.up") }
        }
        if case .text = state {
          Button("Open in Quick Look", systemImage: "eye") { openQuickLook() }
        }
        Button("Refresh", systemImage: "arrow.clockwise") { reloads += 1 }
      } label: {
        Label("File actions", systemImage: "ellipsis")
      }
      .accessibilityIdentifier("file.menu")
    }
  }

  // MARK: Loading

  private func load() async {
    state = .loading
    guard presenter.registry != nil else {
      state = .failed(String(localized: "This environment is not connected."))
      return
    }
    switch target {
    case .workspace(let path, _):
      await loadWorkspace(path)
    case .attachment:
      await loadDownloaded()
    }
  }

  private func loadWorkspace(_ path: String) async {
    guard let context = presenter.context, let registry = presenter.registry else {
      state = .failed(String(localized: "This environment is not connected."))
      return
    }
    // Opened while the computer reconnects: wait; the task runs again when it connects.
    guard presenter.isConnected else { return }
    if kind.isText {
      do {
        switch try await registry.readFile(path, in: context) {
        case .text(let raw, let byteLength, let truncated):
          let parsed = await Self.parse(raw, language: SourceLanguage.named(path: path), markdown: kind == .markdown ? MarkdownStyle.thread : nil)
          state = .text(parsed.source, raw: raw, byteLength: byteLength, truncated: truncated, markdown: parsed.markdown)
          if kind == .markdown, line != nil { mode = .source }
        case .binary: state = .binary(byteLength: nil)
        case .notFile: state = .folder
        }
      } catch {
        state = .failed(Self.message(error))
      }
      return
    }
    await loadDownloaded()
  }

  /// Images, video, PDFs and everything else: signed URL, then the right viewer.
  private func loadDownloaded() async {
    guard presenter.isConnected else { return }
    switch kind {
    case .video, .audio:
      if let url = await presenter.inlineURL(target) { state = .player(url) } else { state = .failed(Self.unavailable) }
    case .image:
      guard let file = await presenter.download(target) else { state = .failed(Self.unavailable); return }
      if let image = await ImageDecoding.decode(file) {
        state = .image(LoadedImage(image: image, file: file))
      } else {
        state = QuickLookView.canPreview(file) ? .quickLook(file) : .binary(byteLength: Self.size(file))
      }
    case .pdf:
      guard let file = await presenter.download(target) else { state = .failed(Self.unavailable); return }
      state = .pdf(file)
    default:
      guard let file = await presenter.download(target) else { state = .failed(Self.unavailable); return }
      // A text attachment reads like a workspace file.
      if case .attachment = target, kind.isText, let size = Self.size(file), size <= FileRead.readLimit,
        let raw = try? String(contentsOf: file, encoding: .utf8)
      {
        let parsed = await Self.parse(raw, language: SourceLanguage.named(path: target.name), markdown: kind == .markdown ? MarkdownStyle.thread : nil)
        state = .text(parsed.source, raw: raw, byteLength: size, truncated: false, markdown: parsed.markdown)
      } else {
        state = QuickLookView.canPreview(file) ? .quickLook(file) : .binary(byteLength: Self.size(file))
      }
    }
  }

  private func openQuickLook() {
    Task {
      state = .loading
      if let file = await presenter.download(target) {
        state = QuickLookView.canPreview(file) ? .quickLook(file) : .binary(byteLength: Self.size(file))
      } else {
        state = .failed(Self.unavailable)
      }
    }
  }

  /// Lines, tokens and (for markdown) the rendered document, built off the main actor.
  @concurrent
  private static func parse(_ text: String, language: String?, markdown: MarkdownStyle?) async -> (source: SourceDocument, markdown: MarkdownDocument?) {
    (SourceDocument(text: text, language: language), markdown.map { MarkdownParser(style: $0).parse(text) })
  }

  private static var unavailable: String { String(localized: "The file could not be loaded. Reconnect and try again.") }

  private static func size(_ file: URL) -> Int? {
    (try? file.resourceValues(forKeys: [.fileSizeKey]))?.fileSize
  }

  private static func message(_ error: EnvironmentRequestError) -> String {
    switch error {
    case .notConnected: String(localized: "This environment is not connected.")
    case .rejected(let message, _): message ?? String(localized: "The computer could not read this file.")
    case .failed(let message): message
    }
  }
}

/// "Partial file": the server sends the first 1 MiB of a larger file.
private struct PartialFileNotice: View {
  let byteLength: Int
  let openWhole: () -> Void

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: Spacing.sm) {
      Image(systemName: "scissors").foregroundStyle(Palette.attention)
      VStack(alignment: .leading, spacing: Spacing.xxs) {
        Text("Partial file").font(Typography.footnote.weight(.semibold))
        Text("Showing the first 1 MB of \(Int64(byteLength).formatted(.byteCount(style: .file))).")
          .font(Typography.caption)
          .foregroundStyle(Palette.textSecondary)
      }
      Spacer(minLength: 0)
      Button("Open in Quick Look", action: openWhole)
        .font(Typography.footnote.weight(.medium))
        .buttonStyle(.bordered)
    }
    .padding(.horizontal, Spacing.lg)
    .padding(.vertical, Spacing.sm)
    .background(Palette.surface)
    .overlay(alignment: .bottom) { Rectangle().fill(Palette.separator).frame(height: 0.5) }
    .accessibilityElement(children: .combine)
  }
}
