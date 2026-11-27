import Foundation

/// How a picked file is written into a draft: a Markdown link labelled with its file name
/// (`serializeComposerFileLink` in `shared/composerTrigger.ts`).
public enum ComposerFileLink {
  public static func serialize(_ path: String) -> String {
    let label = escapeLabel(basename(path))
    let destination = encodeDestination(path)
    return "[\(label)](\(needsDotSlashPrefix(path) ? "./\(destination)" : destination))"
  }

  /// The file a composer link names. Drops only the `./` `serialize` adds, not one the author wrote.
  public static func path(encoded: String, decoded: String) -> String {
    guard encoded.hasPrefix("./") else { return decoded }
    let bare = String(decoded.dropFirst(2))
    return needsDotSlashPrefix(bare) && encodeDestination(bare) == String(encoded.dropFirst(2)) ? bare : decoded
  }

  static func basename(_ path: String) -> String {
    guard let index = path.lastIndex(where: { $0 == "/" || $0 == "\\" }) else { return path }
    return String(path[path.index(after: index)...])
  }

  /// Emphasis markers too: `__init__.py` would otherwise render as bold "init.py".
  static func escapeLabel(_ label: String) -> String {
    var result = ""
    for character in label {
      if "\\[]*_&".contains(character) { result.append("\\") }
      result.append(character)
    }
    return result
  }

  /// JS `encodeURI`, then the characters a Markdown destination or the link parser would misread.
  public static func encodeDestination(_ path: String) -> String {
    var result = ""
    for byte in path.utf8 {
      let scalar = Unicode.Scalar(byte)
      let isURIUnreserved = byte < 0x80
        && (CharacterSet.alphanumerics.contains(scalar) && scalar.isASCII || ";,/:@=+$-_.!~*'".unicodeScalars.contains(scalar))
      if isURIUnreserved {
        result.unicodeScalars.append(scalar)
      } else {
        result += String(format: "%%%02X", byte)
      }
    }
    return result
  }

  static func decode(_ value: String) -> String { value.removingPercentEncoding ?? value }

  // MARK: The parts of `parseMarkdownFileLink` a relative composer path can reach

  /// A relative destination the parser rejects (`C%23/Program.cs`) gets `./`.
  static func needsDotSlashPrefix(_ path: String) -> Bool {
    !path.isEmpty && !parsesAsFileLink(encodeDestination(path)) && path.range(of: #"^(?:[a-z][a-z\d+.-]*:|[\\/])"#, options: [.regularExpression, .caseInsensitive]) == nil
  }

  static func parsesAsFileLink(_ href: String) -> Bool {
    let normalized = href.trimmingCharacters(in: .whitespaces)
    if normalized.isEmpty || normalized.hasPrefix("#") || normalized.hasPrefix("//") { return false }
    var pathPart = normalized
    if let hash = pathPart.firstIndex(of: "#") { pathPart = String(pathPart[..<hash]) }
    if let query = pathPart.firstIndex(of: "?") { pathPart = String(pathPart[..<query]) }
    let path = decode(pathPart.trimmingCharacters(in: .whitespaces))
    if path.isEmpty || hasExternalScheme(path) { return false }
    if parsesAsFilePath(path) { return true }
    if path.hasPrefix("/") || path.hasPrefix("\\") || isWindowsAbsolute(path) { return false }
    return path.contains("\\") && parsesAsFilePath(path.replacingOccurrences(of: "\\", with: "/"))
  }

  static func parsesAsFilePath(_ path: String) -> Bool {
    let bare = path.replacingOccurrences(of: #":\d+(?::\d+|-\d+)?$"#, with: "", options: .regularExpression)
    if bare.range(of: #"(?:^|[\\/])(?:\.{3,}|…)(?:[\\/]|$)"#, options: .regularExpression) != nil { return false }
    if isWindowsAbsolute(bare) || bare.range(of: #"^(~/|\.{1,2}/)"#, options: .regularExpression) != nil { return true }
    if bare.hasPrefix("/") { return true }
    if extensionlessNames.contains(bare) { return true }
    return path.range(of: relativeFilePath, options: .regularExpression) != nil
      || bare.range(of: relativeFileName, options: .regularExpression) != nil
  }

  static func hasExternalScheme(_ path: String) -> Bool {
    if isWindowsAbsolute(path) { return false }
    guard let colon = path.firstIndex(of: ":"),
      path[..<colon].range(of: #"^[A-Za-z][A-Za-z0-9+.-]*$"#, options: .regularExpression) != nil
    else { return false }
    let rest = path[path.index(after: colon)...]
    if rest.hasPrefix("//") { return true }
    return rest.range(of: #"^\d+(?::\d+|-\d+)?$"#, options: .regularExpression) == nil
  }

  static func isWindowsAbsolute(_ path: String) -> Bool {
    path.hasPrefix("\\\\") || path.range(of: #"^[A-Za-z]:[\\/]"#, options: .regularExpression) != nil
  }

  private static let segment = #"[\p{L}\p{M}\p{N}._$+@()\[\]-]+(?: +[\p{L}\p{M}\p{N}._$+@()\[\]-]+)*"#
  private static let relativeFilePath = "^(?:\(segment)/)+(?:\(segment)(?::\\d+(?::\\d+|-\\d+)?)?)?$"
  private static let relativeFileName =
    #"^[\p{L}\p{M}\p{N}._$+()\[\]-]+(?: +[\p{L}\p{M}\p{N}._$+()\[\]-]+)*\.[\p{L}\p{M}\p{N}_-]+(?::\d+(?::\d+|-\d+)?)?$"#

  static let extensionlessNames: Set<String> = [
    "Makefile", "makefile", "GNUmakefile", "Dockerfile", "Containerfile", "Justfile", "justfile", "Rakefile",
    "Gemfile", "Procfile", "Brewfile", "Caddyfile", "Vagrantfile", "Jenkinsfile", "Podfile", "Fastfile", "BUILD",
    "WORKSPACE", "LICENSE", "LICENCE", "COPYING", "NOTICE", "AUTHORS", "CONTRIBUTORS", "CHANGELOG", "README",
    "CODEOWNERS",
  ]
}
