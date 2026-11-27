import AnkielKit
import Observation
import SwiftUI

/// What a viewer opens: a file in the workspace or a message attachment.
enum FileTarget: Hashable, Identifiable {
  case workspace(path: String, line: Int?)
  case attachment(ChatAttachment)

  var id: String {
    switch self {
    case .workspace(let path, let line): "w:\(path):\(line ?? 0)"
    case .attachment(let attachment): "a:\(attachment.id)"
    }
  }

  var name: String {
    switch self {
    case .workspace(let path, _): WorkspacePath.basename(path)
    case .attachment(let attachment): attachment.name
    }
  }

  var isAttachment: Bool { if case .attachment = self { true } else { false } }

  var kind: FileKind {
    switch self {
    case .workspace(let path, _): FileKind(path: path)
    case .attachment(let attachment):
      attachment.isImage ? .image : attachment.mimeType == "application/pdf" ? .pdf
        : attachment.mimeType.hasPrefix("video/") ? .video : FileKind(path: attachment.name)
    }
  }
}

/// The sheet over a thread: the file browser, or one file opened from the feed.
enum FileSheet: Hashable, Identifiable {
  case browser
  case file(FileTarget)

  var id: String {
    switch self {
    case .browser: "browser"
    case .file(let target): target.id
    }
  }
}

/// The thread's image gallery: every image in the feed, opened at one.
struct Gallery: Identifiable, Hashable {
  let id = UUID()
  var images: [ThreadImage]
  var index: Int
}

/// Opens viewers for one thread (or a project). Feed rows reach it through the environment and
/// call it from taps, so rows keep their `Equatable` short-circuit (no closures in their inputs).
@Observable
final class FilePresenter {
  /// The workspace files resolve against; nil when the thread's root is not known yet.
  var context: FileContext?
  var sheet: FileSheet?
  var gallery: Gallery?
  /// The gallery's page, for closing back into the right thumbnail.
  var galleryImageId: String?
  @ObservationIgnored let registry: EnvironmentRegistry?
  @ObservationIgnored let environmentId: String
  @ObservationIgnored var rows: () -> [TimelineRow] = { [] }
  /// The zoom transition's namespace (set by the host view).
  @ObservationIgnored var namespace: Namespace.ID?

  init(environmentId: String, registry: EnvironmentRegistry?, context: FileContext?) {
    self.environmentId = environmentId
    self.registry = registry
    self.context = context
  }

  /// A known root, and a session that may read files (`filesystem:read`; unknown scopes allow it,
  /// the server still decides).
  var canBrowse: Bool {
    context != nil && registry?.environment(environmentId)?.allows(Self.readScope) != false
  }

  static let readScope = "filesystem:read"

  /// Whether requests can reach the computer now (observed: views retry when it connects).
  var isConnected: Bool { registry?.environment(environmentId)?.activeRoute != nil }

  func openBrowser() {
    guard canBrowse else { return }
    sheet = .browser
  }

  /// A path from a work row or a link: relative to the workspace, or absolute.
  func open(path: String, line: Int? = nil) {
    guard canBrowse, let context, let relative = WorkspacePath.workspaceRelative(path, root: context.cwd) else { return }
    sheet = .file(.workspace(path: relative, line: line))
  }

  /// A link tapped in a message. Returns false for links that are not files (the system opens those).
  func open(link url: URL) -> Bool {
    guard canBrowse, let position = FileLink.position(url) else { return false }
    open(path: position.path, line: position.line)
    return true
  }

  func open(attachment: ChatAttachment) {
    sheet = .file(.attachment(attachment))
  }

  /// Opens the gallery at the thumbnail with this id.
  func openImage(id: String) {
    let images = ThreadImage.collect(rows())
    guard let index = images.firstIndex(where: { $0.id == id }) else { return }
    galleryImageId = id
    gallery = Gallery(images: images, index: index)
  }

  /// Opens a gallery of given images (a tool's output), not the feed's.
  func openImages(_ images: [ThreadImage], at index: Int) {
    guard images.indices.contains(index) else { return }
    galleryImageId = images[index].id
    gallery = Gallery(images: images, index: index)
  }

  // MARK: Loading

  /// A signed URL and a cache key for the bytes behind an image source.
  func signed(_ source: ThreadImage.Source) async -> (url: URL, key: String)? {
    switch source {
    case .attachment(let attachment):
      guard let asset = try? await registry?.signedAsset(
        .attachment(id: attachment.id, fileName: attachment.name, mimeType: attachment.mimeType), in: environmentId)
      else { return nil }
      return (asset.url, "\(environmentId)|attachment|\(attachment.id)")
    case .markdown(let text):
      if let url = URL(string: text), let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http" {
        return (url, text)
      }
      guard !text.hasPrefix("data:"), let context else { return nil }
      let path = text.hasPrefix("file://") ? (URL(string: text)?.path(percentEncoded: false) ?? text) : text
      return await signed(context.asset(path))
    case .toolOutput(let itemId, let index):
      guard let threadId = context?.threadId else { return nil }
      return await signed(.toolOutputImage(threadId: threadId, itemId: itemId, index: index))
    }
  }

  /// A workspace or attachment resource, keyed by its revision when the server sends one.
  func signed(_ resource: AssetResource) async -> (url: URL, key: String)? {
    guard let registry, let asset = try? await registry.signedAsset(resource, in: environmentId) else { return nil }
    // Attachments and tool images never change; files are keyed by their revision when the server
    // sends one (`media-file`), else by the signed URL (`workspace-file` has no revision).
    let version: String =
      switch resource {
      case .attachment, .toolOutputImage: "immutable"
      default: asset.fileRevision ?? asset.url.absoluteString
      }
    return (asset.url, "\(environmentId)|\(resource)|\(version)")
  }

  /// Downloads a target's bytes into the media cache (Quick Look, PDF, Share, text attachments).
  func download(_ target: FileTarget) async -> URL? {
    let resource: AssetResource
    switch target {
    case .workspace(let path, _):
      guard let context else { return nil }
      resource = context.asset(path, download: true)
    case .attachment(let attachment):
      resource = .attachment(id: attachment.id, fileName: attachment.name, mimeType: attachment.mimeType, download: true)
    }
    guard let signed = await signed(resource) else { return nil }
    return try? await MediaStore.shared.file(key: signed.key, url: signed.url, name: target.name)
  }

  /// An inline URL for a previewable target (image, video, PDF), for streaming.
  func inlineURL(_ target: FileTarget) async -> URL? {
    switch target {
    case .workspace(let path, _):
      guard let context else { return nil }
      return await signed(context.asset(path))?.url
    case .attachment(let attachment):
      return await signed(.attachment(id: attachment.id, fileName: attachment.name, mimeType: attachment.mimeType))?.url
    }
  }
}

extension EnvironmentValues {
  @Entry var filePresenter: FilePresenter?
  /// The message or plan item a markdown view draws, for its images' transition ids.
  @Entry var mediaOwner: String = ""
}
