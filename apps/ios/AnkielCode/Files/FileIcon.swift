import AnkielKit
import SwiftUI

/// SF Symbols by file type, quiet and monochrome like the rest of the list.
enum FileIcon {
  static func symbol(for name: String, isDirectory: Bool) -> String {
    if isDirectory { return "folder" }
    let lower = name.lowercased()
    let ext = (lower as NSString).pathExtension
    switch FileKind(path: lower) {
    case .image: return "photo"
    case .video: return "film"
    case .audio: return "waveform"
    case .pdf: return "doc.richtext"
    case .archive: return "doc.zipper"
    case .sqlite: return "cylinder.split.1x2"
    case .font: return "textformat"
    case .document: return "doc.text.image"
    case .markdown: return "text.document"
    case .html: return "chevron.left.forwardslash.chevron.right"
    case .other: return "doc"
    case .text: break
    }
    switch ext {
    case "swift": return "swift"
    case "json", "jsonc", "yaml", "yml", "toml", "plist", "xcstrings": return "curlybraces"
    case "lock": return "lock.doc"
    case "sh", "zsh", "bash", "fish": return "terminal"
    case "":
      return lower.hasPrefix(".") ? "gearshape" : "doc.plaintext"
    default:
      return SourceLanguage.named(path: lower) != nil ? "chevron.left.forwardslash.chevron.right" : "doc.plaintext"
    }
  }
}
