import Foundation

/// What `assets.createUrl` can sign (spec §8.4); the kinds the app shows.
public enum AssetResource: Sendable, Hashable, Encodable {
  /// `download` asks for `disposition: "attachment"` (any type, for Quick Look and Share).
  case attachment(id: String, fileName: String?, mimeType: String?, download: Bool = false)
  /// A workspace file of a previewable type (images, video, PDF, …), relative to the thread's root.
  case workspaceFile(threadId: String, path: String)
  /// A host file by absolute path; `download` serves any type, not only previewable ones.
  case mediaFile(threadId: String, path: String, download: Bool)
  /// A file in a project with no thread (the project's file browser).
  case draftWorkspaceFile(cwd: String, path: String, download: Bool)
  /// The `index`th image a tool returned (`toolOutputImages` order).
  case toolOutputImage(threadId: String, itemId: String, index: Int)
  /// A host's media (a GitHub attachment or repository file) fetched with the computer's source
  /// control credential, read through the checkout at `cwd`.
  case sourceControlMedia(cwd: String, url: String, repository: String?)

  enum CodingKeys: String, CodingKey { case _tag, attachmentId, fileName, mimeType, disposition, threadId, path, cwd, itemId, index, url, repository }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    switch self {
    case .attachment(let id, let fileName, let mimeType, let download):
      try container.encode("attachment", forKey: ._tag)
      try container.encode(id, forKey: .attachmentId)
      try container.encodeIfPresent(fileName, forKey: .fileName)
      try container.encodeIfPresent(mimeType, forKey: .mimeType)
      try container.encode(download ? "attachment" : "inline", forKey: .disposition)
    case .workspaceFile(let threadId, let path):
      try container.encode("workspace-file", forKey: ._tag)
      try container.encode(threadId, forKey: .threadId)
      try container.encode(path, forKey: .path)
    case .mediaFile(let threadId, let path, let download):
      try container.encode("media-file", forKey: ._tag)
      try container.encode(threadId, forKey: .threadId)
      try container.encode(path, forKey: .path)
      if download { try container.encode("attachment", forKey: .disposition) }
    case .draftWorkspaceFile(let cwd, let path, let download):
      try container.encode("draft-workspace-file", forKey: ._tag)
      try container.encode(cwd, forKey: .cwd)
      try container.encode(path, forKey: .path)
      if download { try container.encode("attachment", forKey: .disposition) }
    case .toolOutputImage(let threadId, let itemId, let index):
      try container.encode("tool-output-image", forKey: ._tag)
      try container.encode(threadId, forKey: .threadId)
      try container.encode(itemId, forKey: .itemId)
      try container.encode(index, forKey: .index)
    case .sourceControlMedia(let cwd, let url, let repository):
      try container.encode("github-media", forKey: ._tag)
      try container.encode(cwd, forKey: .cwd)
      try container.encode(url, forKey: .url)
      try container.encodeIfPresent(repository, forKey: .repository)
    }
  }
}

struct AssetURLRequest: Encodable, Sendable {
  static let rpcTag = "assets.createUrl"
  var resource: AssetResource
}

struct AssetURLResult: Decodable, Sendable {
  var relativeUrl: String
  /// Epoch milliseconds.
  var expiresAt: WireNumber
  /// Changes only when the file does; the URL is re-signed on every mint.
  @Tolerant var fileRevision: String?
  @Tolerant var imageDimensions: AssetImageDimensions?
}

/// Pixel size the server read from an image's header.
public struct AssetImageDimensions: Codable, Sendable, Hashable {
  public var width: Int
  public var height: Int
}

/// A signed URL and what identifies the bytes behind it, so caches survive re-signing.
public struct SignedAsset: Sendable, Hashable {
  public var url: URL
  public var fileRevision: String?
  public var imageDimensions: AssetImageDimensions?
}
