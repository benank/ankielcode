import Foundation

/// One image the thread shows, in feed order, for swiping between them in the viewer.
public struct ThreadImage: Sendable, Hashable, Identifiable {
  public enum Source: Sendable, Hashable {
    case attachment(ChatAttachment)
    /// A markdown image's `src`: a web URL, a workspace path or a `file:` URL.
    case markdown(String)
    /// The `index`th image a tool returned (`tool-output-image`).
    case toolOutput(itemId: String, index: Int)
  }

  public var source: Source
  /// The item (message or plan) it appears in, so the same picture in two messages is two pages.
  public var itemId: String
  public var title: String

  public var id: String { Self.id(itemId: itemId, source: source) }

  /// The id a thumbnail uses for the zoom transition, computed the same way in the feed.
  public static func id(itemId: String, source: Source) -> String {
    switch source {
    case .attachment(let attachment): "\(itemId)|a:\(attachment.id)"
    case .markdown(let src): "\(itemId)|m:\(src)"
    case .toolOutput(_, let index): "\(itemId)|t:\(index)"
    }
  }

  public init(source: Source, itemId: String, title: String) {
    self.source = source
    self.itemId = itemId
    self.title = title
  }
}

extension ThreadImage {
  /// Every image the feed draws: user attachments and markdown images (inside lists and
  /// quotes too), in reading order. Rows hidden in a closed fold still count.
  public static func collect(_ rows: [TimelineRow]) -> [ThreadImage] {
    var images: [ThreadImage] = []
    var seen: Set<String> = []
    func add(_ image: ThreadImage) {
      if seen.insert(image.id).inserted { images.append(image) }
    }
    func visit(_ blocks: [MarkdownBlock], itemId: String) {
      for block in blocks {
        switch block.kind {
        case .image(let alt, let source):
          add(ThreadImage(source: .markdown(source), itemId: itemId, title: alt.isEmpty ? WorkspacePath.basename(source) : alt))
        case .list(let list): for item in list.items { visit(item.blocks, itemId: itemId) }
        case .quote(let nested): visit(nested, itemId: itemId)
        default: break
        }
      }
    }
    for row in rows {
      switch row.content {
      case .user(let message):
        for attachment in message.attachments where attachment.isImage {
          add(ThreadImage(source: .attachment(attachment), itemId: message.itemId, title: attachment.name))
        }
      case .assistant(let message):
        visit(message.document.blocks, itemId: message.itemId)
      default:
        break
      }
    }
    return images
  }
}

/// Images in a tool's output, in the order the server indexes `tool-output-image` assets
/// (`toolOutputImages` in `shared/toolOutput.ts`): image blocks of the output (an array, or an
/// object's `content`), base64 or inline data, with a type providers accept, at most 8.
public enum ToolOutputImages {
  static let maxImages = 8
  static let mimeTypes: Set<String> = ["image/png", "image/jpeg", "image/gif", "image/webp"]

  public static func count(_ output: JSONValue?) -> Int {
    guard let output else { return 0 }
    let blocks: [JSONValue] =
      switch output {
      case .array(let items): items
      case .object(let object):
        if case .array(let items)? = object["content"] { items } else { [output] }
      default: [output]
      }
    var count = 0
    for block in blocks where isImage(block) {
      count += 1
      if count == maxImages { break }
    }
    return count
  }

  static func isImage(_ block: JSONValue) -> Bool {
    guard block["type"]?.stringValue == "image" else { return false }
    let source = block["source"]
    if let source, source["type"]?.stringValue != "base64" { return false }
    let mime = (source == nil ? block["mimeType"] : source?["media_type"])?.stringValue?.lowercased()
    return mime.map(mimeTypes.contains) ?? false
  }
}
