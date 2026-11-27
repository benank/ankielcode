import Foundation

/// How the app shows a file, from its name (RN `filePreviewKind` and the shared extension sets).
/// Only `image`, `video`, `audio`, `pdf` and `html` get an inline asset URL from the server; the
/// rest read as text through `projects.readFile` or download for Quick Look.
public enum FileKind: String, Sendable, Hashable {
  case image, video, audio, pdf, html, markdown, text, archive, sqlite, document, font, other

  public init(path: String) {
    let name = WorkspacePath.basename(path).lowercased()
    let ext = name.contains(".") ? String(name[name.index(after: name.lastIndex(of: ".")!)...]) : ""
    self =
      switch ext {
      case "avif", "bmp", "gif", "ico", "heic", "heif", "jpeg", "jpg", "png", "svg", "tif", "tiff", "webp": .image
      case "avi", "m4v", "mkv", "mov", "mp4", "ogv", "webm": .video
      case "mp3", "wav", "ogg", "oga", "flac", "aac", "m4a", "opus", "aiff", "weba": .audio
      case "pdf": .pdf
      case "html", "htm": .html
      case "md", "mdx", "markdown", "mdown", "mkd": .markdown
      case "zip", "jar", "tar", "gz", "tgz", "7z", "rar", "xz", "bz2": .archive
      case "sqlite", "sqlite3", "db": .sqlite
      case "docx", "xlsx", "pptx", "doc", "xls", "ppt", "key", "pages", "numbers", "odt", "ods", "odp", "rtf", "epub": .document
      case "ttf", "otf", "woff", "woff2": .font
      case "exe", "dll", "so", "dylib", "a", "o", "class", "wasm", "bin", "dmg", "iso", "pyc", "car", "icns", "psd", "sketch", "fig":
        .other
      default: .text
      }
  }

  /// Read with `projects.readFile` and shown as source.
  public var isText: Bool { self == .text || self == .markdown || self == .html }

  /// The server signs an inline URL for it (`hostPreviewMimeTypeFromExtension`).
  public var isPreviewable: Bool { self == .image || self == .video || self == .audio || self == .pdf || self == .html }

  /// Quick Look and Share need the bytes (`disposition: "attachment"`).
  public var opensInQuickLook: Bool {
    switch self {
    case .audio, .archive, .document, .font, .sqlite, .other: true
    default: false
    }
  }
}

/// The highlighter grammar for a file name, nil for plain text.
public enum SourceLanguage {
  public static func named(path: String) -> String? {
    let name = WorkspacePath.basename(path).lowercased()
    if name == "dockerfile" || name == "makefile" || name.hasSuffix(".sh") || name.hasSuffix(".zsh") || name.hasSuffix(".bash")
      || name == ".zshrc" || name == ".bashrc" || name.hasPrefix(".env")
    {
      return "sh"
    }
    guard let dot = name.lastIndex(of: ".") else { return nil }
    let ext = String(name[name.index(after: dot)...])
    switch ext {
    case "swift": return "swift"
    case "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts": return "ts"
    case "json", "jsonc", "json5", "jsonl", "ndjson": return "json"
    case "py", "pyi": return "py"
    case "rs": return "rust"
    case "go": return "go"
    case "html", "htm", "xml", "svg", "plist", "vue", "xcstrings": return ext == "xcstrings" ? "json" : "html"
    case "css", "scss", "less": return "css"
    case "diff", "patch": return "diff"
    case "fish": return "sh"
    default: return nil
    }
  }
}
