import Foundation

/// What `assets.createUrl` can sign (spec §8.4); the kinds the thread screen shows.
public enum AssetResource: Sendable, Hashable, Encodable {
  case attachment(id: String, fileName: String?, mimeType: String?)
  case workspaceFile(threadId: String, path: String)

  enum CodingKeys: String, CodingKey { case _tag, attachmentId, fileName, mimeType, disposition, threadId, path }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    switch self {
    case .attachment(let id, let fileName, let mimeType):
      try container.encode("attachment", forKey: ._tag)
      try container.encode(id, forKey: .attachmentId)
      try container.encodeIfPresent(fileName, forKey: .fileName)
      try container.encodeIfPresent(mimeType, forKey: .mimeType)
      try container.encode("inline", forKey: .disposition)
    case .workspaceFile(let threadId, let path):
      try container.encode("workspace-file", forKey: ._tag)
      try container.encode(threadId, forKey: .threadId)
      try container.encode(path, forKey: .path)
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
}
