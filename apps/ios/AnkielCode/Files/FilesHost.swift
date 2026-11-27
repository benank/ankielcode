import AnkielKit
import SwiftUI

extension View {
  /// Gives a thread screen its viewers: the file browser and file sheets, the image gallery with
  /// the zoom transition from its thumbnails, and file links in messages.
  func threadFiles(_ ref: ThreadRef, detail: ThreadDetailModel) -> some View {
    modifier(ThreadFilesHost(ref: ref, detail: detail))
  }
}

/// The thread's workspace: its worktree when it has one, else its project's root (RN
/// `useThreadFilesWorkspace`).
@MainActor
func threadFileContext(_ ref: ThreadRef, projectId: String?, registry: EnvironmentRegistry) -> FileContext? {
  guard let environment = registry.environment(ref.environmentId) else { return nil }
  let thread = environment.shell.threads.first { $0.id == ref.threadId }
  let projectId = projectId ?? thread?.projectId
  let project = environment.shell.snapshot?.projects.first { $0.id == projectId }
  guard let cwd = thread?.worktreePath ?? project?.workspaceRoot else { return nil }
  return FileContext(environmentId: ref.environmentId, cwd: cwd, threadId: ref.threadId, title: project?.title ?? WorkspacePath.basename(cwd))
}

private struct ThreadFilesHost: ViewModifier {
  let ref: ThreadRef
  let detail: ThreadDetailModel
  @Environment(AppModel.self) private var model
  @State private var presenter: FilePresenter?
  @Namespace private var zoom

  private var context: FileContext? {
    threadFileContext(ref, projectId: detail.state.projectId, registry: model.registry)
  }

  func body(content: Content) -> some View {
    let presenter = presenter ?? makePresenter()
    content
      .environment(\.filePresenter, presenter)
      .environment(\.openURL, OpenURLAction { url in presenter.open(link: url) ? .handled : .systemAction })
      .onChange(of: context, initial: true) { _, context in presenter.context = context }
      .filesPresentation(presenter, zoom: zoom)
      .onAppear {
        if self.presenter == nil { self.presenter = presenter }
        FilesDebug.apply(to: presenter)
      }
  }

  private func makePresenter() -> FilePresenter {
    let presenter = FilePresenter(
      environmentId: ref.environmentId, registry: ThreadDebug.isFixture(ref) ? nil : model.registry, context: context)
    presenter.rows = { [detail] in detail.state.timeline.rows }
    presenter.namespace = zoom
    return presenter
  }
}

extension View {
  /// The sheets and the gallery a presenter opens (threads and projects share it).
  func filesPresentation(_ presenter: FilePresenter, zoom: Namespace.ID) -> some View {
    modifier(FilesPresentation(presenter: presenter, zoom: zoom))
  }
}

private struct FilesPresentation: ViewModifier {
  @Bindable var presenter: FilePresenter
  let zoom: Namespace.ID

  func body(content: Content) -> some View {
    content
      .sheet(item: $presenter.sheet) { sheet in
        FilesSheet(sheet: sheet, presenter: presenter)
      }
      .fullScreenCover(item: $presenter.gallery) { gallery in
        ImageViewer(gallery: gallery, presenter: presenter)
          .navigationTransition(.zoom(sourceID: presenter.galleryImageId ?? "", in: zoom))
      }
      .onAppear { presenter.namespace = zoom }
  }
}

/// A sheet with its own stack: the browser (files open on top of it) or one file.
private struct FilesSheet: View {
  let sheet: FileSheet
  let presenter: FilePresenter
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      Group {
        switch sheet {
        case .browser: FileBrowserView(presenter: presenter)
        case .file(let target): FilePreviewView(target: target, presenter: presenter)
        }
      }
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Done") { dismiss() }
            .accessibilityIdentifier("files.done")
        }
      }
    }
    .presentationDragIndicator(.visible)
    .presentationSizing(.page)
  }
}

/// A thumbnail that opens the gallery and zooms out of (and back into) itself.
struct GalleryThumbnail: ViewModifier {
  let id: String?
  @Environment(\.filePresenter) private var presenter

  func body(content: Content) -> some View {
    if let id, let presenter, let namespace = presenter.namespace {
      content
        .matchedTransitionSource(id: id, in: namespace)
        .contentShape(.rect)
        .onTapGesture { presenter.openImage(id: id) }
        .accessibilityAddTraits(.isButton)
        .accessibilityHint(Text("Opens the image"))
        .accessibilityIdentifier("media.thumbnail")
    } else {
      content
    }
  }
}

extension View {
  func galleryThumbnail(_ id: String?) -> some View { modifier(GalleryThumbnail(id: id)) }
}

/// "Files" in a thread's menu; reads the presenter its screen provides.
struct FilesMenuButton: View {
  @Environment(\.filePresenter) private var presenter

  var body: some View {
    if let presenter, presenter.canBrowse {
      Section {
        Button("Files", systemImage: "folder") { presenter.openBrowser() }
          .accessibilityIdentifier("thread.files")
      }
    }
  }
}
