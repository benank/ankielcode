import Foundation

/// Path rules for workspace files, ported from RN `features/files/filePath.ts` and
/// `shared/fileLinks.ts`. Server paths use `/`; Windows hosts are handled where RN handles them.
public enum WorkspacePath {
  public static func isAbsolute(_ path: String) -> Bool {
    path.hasPrefix("/") || isWindowsAbsolute(path)
  }

  static func isWindowsAbsolute(_ path: String) -> Bool {
    path.hasPrefix("\\\\") || path.wholeMatch(of: /^[A-Za-z]:[\\\/].*/) != nil
  }

  public static func basename(_ path: String) -> String {
    path.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? path
  }

  /// The parent folder of a relative path, "" at the root.
  public static func parent(_ path: String) -> String {
    guard let slash = path.lastIndex(of: "/") else { return "" }
    return String(path[..<slash])
  }

  /// `cwd` + `relative`, or `relative` when it is already absolute.
  public static func resolve(_ relative: String, in cwd: String) -> String {
    if isAbsolute(relative) { return relative }
    let windows = isWindowsAbsolute(cwd)
    let separator = windows ? "\\" : "/"
    var base = cwd
    while base.hasSuffix("/") || base.hasSuffix("\\") { base.removeLast() }
    var next = relative
    while next.hasPrefix("./") { next.removeFirst(2) }
    while next.hasPrefix("/") { next.removeFirst() }
    return base + separator + (windows ? next.replacingOccurrences(of: "/", with: "\\") : next)
  }

  /// Collapses `.` and `..`; nil when `..` climbs above the start.
  static func normalizeRelative(_ path: String) -> String? {
    var segments: [Substring] = []
    for segment in path.replacingOccurrences(of: "\\", with: "/").split(separator: "/", omittingEmptySubsequences: true) {
      if segment == "." { continue }
      if segment == ".." {
        guard !segments.isEmpty else { return nil }
        segments.removeLast()
        continue
      }
      segments.append(segment)
    }
    return segments.isEmpty ? nil : segments.joined(separator: "/")
  }

  /// A link target as a workspace-relative path when it lies inside `root`; else the absolute
  /// path; nil when it cannot name a file there (RN `resolveWorkspaceRelativeFilePath`, but
  /// keeping absolute paths outside the root, which `media-file` can still read).
  public static func workspaceRelative(_ target: String, root: String?) -> String? {
    var target = target
    if target.hasPrefix("~/") {
      guard let root, let home = inferHome(root) else { return nil }
      target = home + "/" + target.dropFirst(2)
    }
    guard isAbsolute(target) else { return normalizeRelative(target) }
    guard let root else { return target }
    let normalizedTarget = target.replacingOccurrences(of: "\\", with: "/")
    var normalizedRoot = root.replacingOccurrences(of: "\\", with: "/")
    while normalizedRoot.hasSuffix("/") { normalizedRoot.removeLast() }
    let caseInsensitive = isWindowsAbsolute(target) || isWindowsAbsolute(root)
    let comparableTarget = caseInsensitive ? normalizedTarget.lowercased() : normalizedTarget
    let comparableRoot = caseInsensitive ? normalizedRoot.lowercased() : normalizedRoot
    guard comparableTarget.hasPrefix(comparableRoot + "/") else { return target }
    let relative = String(normalizedTarget.dropFirst(normalizedRoot.count + 1))
    guard !relative.split(separator: "/").contains("..") else { return target }
    return normalizeRelative(relative) ?? target
  }

  static func inferHome(_ cwd: String) -> String? {
    if let match = cwd.firstMatch(of: /^\/(Users|home)\/([^\/]+)/) { return String(match.output.0) }
    return nil
  }
}

/// A file path with an optional `:line[:column]` / `#L12` position (RN `splitFilePathPosition`).
public struct FilePosition: Sendable, Hashable {
  public var path: String
  public var line: Int?

  public init(path: String, line: Int? = nil) {
    self.path = path
    self.line = line
  }

  public init(splitting raw: String, hash: String = "") {
    if let match = raw.firstMatch(of: /:(\d+)(?::(\d+)|-(\d+))?$/) {
      path = String(raw[..<match.range.lowerBound])
      line = Int(match.output.1).flatMap { $0 > 0 ? $0 : nil }
    } else if let match = hash.wholeMatch(of: /#L(\d+)(?:C\d+|-L?\d+)?/.ignoresCase()) {
      path = raw
      line = Int(match.output.1).flatMap { $0 > 0 ? $0 : nil }
    } else {
      path = raw
      line = nil
    }
  }
}

/// A link tapped in a message or work row, read as a file on the thread's computer. Web links
/// and app links are not files; bare relative paths and `file:` URLs are.
public enum FileLink {
  public static func position(_ url: URL) -> FilePosition? {
    let raw = url.absoluteString
    if let scheme = url.scheme?.lowercased() {
      guard scheme == "file" else { return nil }
      let path = url.path(percentEncoded: false)
      guard !path.isEmpty else { return nil }
      return FilePosition(splitting: path, hash: url.fragment.map { "#" + $0 } ?? "")
    }
    // Relative references: `src/a.ts:12`, `./x`, `~/y`, `#L5` anchors.
    guard !raw.isEmpty, !raw.hasPrefix("#"), !raw.hasPrefix("?") else { return nil }
    let decoded = raw.removingPercentEncoding ?? raw
    let (pathPart, hash) =
      if let hashIndex = decoded.firstIndex(of: "#") {
        (String(decoded[..<hashIndex]), String(decoded[hashIndex...]))
      } else {
        (decoded, "")
      }
    // `www.example.com` style hosts are web links the parser left without a scheme.
    if pathPart.hasPrefix("www.") { return nil }
    return FilePosition(splitting: pathPart, hash: hash)
  }
}
