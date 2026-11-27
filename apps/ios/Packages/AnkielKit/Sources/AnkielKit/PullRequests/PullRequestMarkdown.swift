import Foundation

/// A pull request body or comment prepared for the app's markdown renderer (RN
/// `pullRequestMarkdown.ts` and `pullRequestAutolinks.ts`): standalone media lines become their
/// own segments, GitHub's `:alias:` emoji become emoji, and `@login`, `#123` and `owner/repo#123`
/// in prose become links. Code (fenced, indented, inline) and existing links are left alone.
public enum PullRequestMarkdown {
  public enum Media: String, Sendable, Hashable { case image, video }

  public enum Segment: Sendable, Hashable, Identifiable {
    case markdown(id: String, text: String)
    case attachment(id: String, url: String, media: Media)

    public var id: String {
      switch self {
      case .markdown(let id, _), .attachment(let id, _, _): id
      }
    }

    public var kindName: String {
      switch self {
      case .markdown: "markdown"
      case .attachment(_, _, let media): media.rawValue
      }
    }
  }

  /// How references link: the host's web origin and the pull request's repository.
  public struct LinkContext: Sendable, Hashable {
    public var webOrigin: String
    public var repository: String
    public init(webOrigin: String, repository: String) {
      self.webOrigin = webOrigin.hasSuffix("/") ? String(webOrigin.dropLast()) : webOrigin
      self.repository = repository
    }

    /// `https://github.com` and `owner/repo` from a pull request URL (`…/owner/repo/pull/12`).
    public init?(pullRequestURL: String) {
      guard let link = ChangeRequestLink.parse(pullRequestURL) else { return nil }
      self.init(webOrigin: link.origin, repository: link.repository)
    }
  }

  // MARK: Segments

  /// Splits the body at lines that are only a media link (an image or video URL, a markdown link
  /// to one, GitHub's bare `user-attachments` video links, a lone `<video src>` tag).
  public static func segments(_ body: String) -> [Segment] {
    var segments: [Segment] = []
    var markdown: [Substring] = []
    var openFence: Substring?

    func flush() {
      let text = markdown.joined(separator: "\n")
      markdown.removeAll(keepingCapacity: true)
      let trimmed = text.drop { $0 == "\n" || $0 == "\r" }
      guard !trimmed.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
      segments.append(.markdown(id: "markdown:\(segments.count)", text: String(trimmed).trimmingTrailingWhitespace()))
    }

    let lines = body.split(separator: "\n", omittingEmptySubsequences: false).map { $0.last == "\r" ? $0.dropLast() : $0 }
    var index = 0
    while index < lines.count {
      let line = lines[index]
      if let fence = fenceMarker(line) {
        if let open = openFence {
          if fence.marker.first == open.first, fence.marker.count >= open.count, fence.rest.allSatisfy(\.isWhitespace) { openFence = nil }
        } else if !(fence.marker.first == "`" && fence.rest.contains(String(fence.marker))) {
          openFence = fence.marker
        }
        markdown.append(line)
        index += 1
        continue
      }
      if openFence != nil || isIndentedCode(line) {
        markdown.append(line)
        index += 1
        continue
      }
      if let attachment = attachment(line) {
        flush()
        segments.append(.attachment(id: "attachment:\(segments.count)", url: attachment.url, media: attachment.media))
        index += 1
        continue
      }
      if line.trimmingCharacters(in: .whitespaces).lowercased().hasPrefix("<video") {
        let last = min(index + 8, lines.count) - 1
        var cursor = index
        while cursor < last, !lines[cursor].lowercased().contains("</video>") { cursor += 1 }
        let tag = lines[index...cursor].joined(separator: "\n")
        if tag.lowercased().trimmingCharacters(in: .whitespaces).hasSuffix("</video>"), let source = videoSource(tag), isWebURL(source) {
          flush()
          segments.append(.attachment(id: "attachment:\(segments.count)", url: source, media: .video))
          index = cursor + 1
          continue
        }
      }
      markdown.append(line)
      index += 1
    }
    flush()
    return segments
  }

  static func fenceMarker(_ line: Substring) -> (marker: Substring, rest: Substring)? {
    var rest = line[...]
    var spaces = 0
    while rest.first == " ", spaces < 3 {
      rest = rest.dropFirst()
      spaces += 1
    }
    guard let first = rest.first, first == "`" || first == "~" else { return nil }
    let marker = rest.prefix { $0 == first }
    guard marker.count >= 3 else { return nil }
    return (marker, rest.dropFirst(marker.count))
  }

  static func isIndentedCode(_ line: Substring) -> Bool {
    line.hasPrefix("    ") || line.prefix(4).drop(while: { $0 == " " }).first == "\t"
  }

  static func isWebURL(_ text: String) -> Bool {
    guard let url = URL(string: text), let scheme = url.scheme?.lowercased(), url.host() != nil else { return false }
    return scheme == "https" || scheme == "http"
  }

  static func attachment(_ line: Substring) -> (url: String, media: Media)? {
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    var candidate: String?
    if let match = trimmed.wholeMatch(of: /<?(https?:\/\/\S+?)>?/) {
      candidate = String(match.1)
    } else if let match = trimmed.wholeMatch(of: /\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/) {
      candidate = String(match.1)
    }
    guard let url = candidate, isWebURL(url) else { return nil }
    let lower = url.lowercased()
    if lower.firstMatch(of: /\.(?:mp4|webm|mov|m4v|ogv)(?:$|[?#])/) != nil || SourceControlMedia.isAttachmentVideo(url) {
      return (url, .video)
    }
    if lower.firstMatch(of: /\.(?:png|jpe?g|gif|webp|avif|heic|heif|svg)(?:$|[?#])/) != nil { return (url, .image) }
    return nil
  }

  static func videoSource(_ tag: String) -> String? {
    guard let match = tag.firstMatch(of: /(?i)<(?:video|source)\b[^<>]*\bsrc\s*=\s*["']([^"']+)["']/) else { return nil }
    return String(match.1)
  }

  // MARK: Emoji and references

  private static let emoji: [String: String] = {
    var table: [String: String] = [:]
    for line in GitHubEmojiAliases.table.split(separator: "\n") {
      guard let space = line.firstIndex(of: " ") else { continue }
      table[String(line[..<space])] = String(line[line.index(after: space)...])
    }
    return table
  }()

  /// `:alias:` emoji; a colon closes one alias only, so `:tada:tada:` has one.
  public static func expandEmoji(_ text: String) -> String {
    guard text.contains(":") else { return text }
    var result = ""
    var rest = text[...]
    while let start = rest.firstIndex(of: ":") {
      let after = rest[rest.index(after: start)...]
      let name = after.prefix { ($0.isASCII && ($0.isLowercase || $0.isNumber)) || $0 == "_" || $0 == "+" || $0 == "-" }
      if !name.isEmpty, after.dropFirst(name.count).first == ":", let value = emoji[String(name)] {
        result += rest[..<start]
        // Keycap emoji start with `*`, which the renderer would read as emphasis.
        result += value.replacingOccurrences(of: "*", with: "\\*")
        rest = after.dropFirst(name.count + 1)
      } else {
        result += rest[...start]
        rest = after
      }
    }
    return result + rest
  }

  /// The markdown with emoji and references rewritten (prose only).
  public static func prepare(_ markdown: String, links: LinkContext?) -> String {
    var output: [String] = []
    var openFence: Substring?
    for line in markdown.split(separator: "\n", omittingEmptySubsequences: false) {
      if let fence = fenceMarker(line) {
        if let open = openFence {
          if fence.marker.first == open.first, fence.marker.count >= open.count { openFence = nil }
        } else {
          openFence = fence.marker
        }
        output.append(String(line))
        continue
      }
      if openFence != nil || isIndentedCode(line) {
        output.append(String(line))
        continue
      }
      output.append(prose(String(line), links: links))
    }
    return output.joined(separator: "\n")
  }

  /// Rewrites one prose line, skipping inline code spans, links, images and HTML tags.
  static func prose(_ line: String, links: LinkContext?) -> String {
    var result = ""
    var plain = ""
    func flushPlain() {
      result += autolink(expandEmoji(plain), links: links)
      plain = ""
    }
    var index = line.startIndex
    while index < line.endIndex {
      let character = line[index]
      if character == "`" {
        let ticks = line[index...].prefix { $0 == "`" }
        let after = line.index(index, offsetBy: ticks.count)
        if let close = line[after...].range(of: String(ticks)) {
          flushPlain()
          result += line[index..<close.upperBound]
          index = close.upperBound
          continue
        }
      }
      if character == "[" || (character == "!" && line[index...].dropFirst().first == "["),
        let match = line[index...].prefixMatch(of: /!?\[[^\]]*\]\([^)]*\)/)
      {
        flushPlain()
        result += match.0
        index = match.range.upperBound
        continue
      }
      if character == "<", let match = line[index...].prefixMatch(of: /<[^>\n]*>/) {
        flushPlain()
        result += match.0
        index = match.range.upperBound
        continue
      }
      if character == "h", let match = line[index...].prefixMatch(of: /https?:\/\/[^\s<>()]+/) {
        flushPlain()
        result += match.0
        index = match.range.upperBound
        continue
      }
      plain.append(character)
      index = line.index(after: index)
    }
    flushPlain()
    return result
  }

  /// `@login`, `#123` and `owner/repo#123` as links on the host.
  static func autolink(_ text: String, links: LinkContext?) -> String {
    guard let links, text.contains("@") || text.contains("#") else { return text }
    let pattern = /(^|[^\w\/@#&.\-])(?:@([A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\/[A-Za-z0-9_.-]+)?)|([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#(\d{1,9}))(?![\w#])/
    var result = ""
    var cursor = text.startIndex
    for match in text.matches(of: pattern) {
      result += text[cursor..<match.range.lowerBound]
      result += match.1
      let start = text.index(match.range.lowerBound, offsetBy: match.1.count)
      let label = String(text[start..<match.range.upperBound]).replacingOccurrences(of: "_", with: "\\_")
      if let login = match.2 {
        result += "[\(label)](\(links.webOrigin)/\(login))"
      } else if let number = match.4 {
        let repository = match.3.map(String.init) ?? links.repository
        // GitHub writes every bare reference through `/issues/`; it redirects pull requests.
        result += "[\(label)](\(links.webOrigin)/\(repository)/issues/\(number))"
      } else {
        result += text[start..<match.range.upperBound]
      }
      cursor = match.range.upperBound
    }
    return result + text[cursor...]
  }
}

extension String {
  func trimmingTrailingWhitespace() -> String {
    var end = endIndex
    while end > startIndex, self[index(before: end)].isWhitespace { end = index(before: end) }
    return String(self[..<end])
  }
}

/// Media links whose bytes need the computer's source control credential (RN `gitHubMedia.ts`):
/// GitHub attachments and repository files. Signed `githubusercontent` links load on their own.
public enum SourceControlMedia {
  /// The URL the computer fetches with its credential, or nil for a link that loads by itself.
  public static func fetchURL(_ text: String) -> String? {
    guard let url = URL(string: text), url.scheme?.lowercased() == "https", let host = url.host()?.lowercased() else { return nil }
    let path = url.path(percentEncoded: true)
    let query = url.query(percentEncoded: true).map { "?\($0)" } ?? ""
    if host == "raw.githubusercontent.com" || host == "media.githubusercontent.com" { return "https://\(host)\(path)\(query)" }
    guard host == "github.com" || host == "www.github.com" else { return nil }
    if path.wholeMatch(of: /\/user-attachments\/assets\/[\w-]+/) != nil || path.wholeMatch(of: /\/[^\/]+\/[^\/]+\/assets\/\d+\/[\w-]+/) != nil {
      return "https://github.com\(path)"
    }
    if let match = path.wholeMatch(of: /\/([^\/]+)\/([^\/]+)\/(?:raw|blob)\/(.*[^\/])/) {
      return "https://github.com/\(match.1)/\(match.2)/raw/\(match.3)\(query)"
    }
    return nil
  }

  /// GitHub links an uploaded video bare, with no extension.
  static func isAttachmentVideo(_ text: String) -> Bool {
    guard let url = URL(string: text), let host = url.host()?.lowercased(), host == "github.com" || host == "www.github.com" else { return false }
    return url.path(percentEncoded: true).wholeMatch(of: /\/user-attachments\/assets\/[\w-]+/) != nil
  }
}
