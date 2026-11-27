import Foundation
import Network

/// Addresses for a device preview of a computer's localhost (RN `browserTabs.ts`,
/// `@ankielcode/shared/preview`).
public enum PreviewURLs {
  /// `isLoopbackHost` in shared: the names a link to the computer's own servers uses.
  public static func isLoopbackHost(_ host: String) -> Bool {
    ["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"].contains(host.lowercased())
  }

  /// A link the device opens through the tunnel: an http(s) URL on the computer's loopback, with
  /// the unspecified address (which would name this device's interfaces) read as `localhost`.
  public static func loopbackURLForDevice(_ value: String) -> URL? {
    guard var components = URLComponents(string: value.trimmingCharacters(in: .whitespaces)),
      let scheme = components.scheme?.lowercased(), scheme == "http" || scheme == "https",
      let host = components.host
    else { return nil }
    if host == "0.0.0.0" || host == "::" || host == "[::]" { components.host = "localhost" }
    guard isLoopbackHost(components.host ?? "") else { return nil }
    return withRootPath(components)
  }

  /// What a device preview loads for `value`: a loopback page, any other http(s) URL, or nil.
  public static func localPreviewURLForDevice(_ value: String) -> URL? {
    if let loopback = loopbackURLForDevice(value) { return loopback }
    guard let components = URLComponents(string: value), let scheme = components.scheme?.lowercased(),
      scheme == "http" || scheme == "https", components.host?.isEmpty == false
    else { return nil }
    return withRootPath(components)
  }

  public enum NormalizationError: Error, Equatable {
    case empty
    case parse
    case unsupportedProtocol(String)
  }

  private static let nonWebSchemes: Set<String> = [
    "about", "blob", "chrome", "data", "file", "ftp", "javascript", "mailto", "sms", "ssh", "tel",
    "view-source", "ws", "wss",
  ]

  /// `normalizePreviewUrl`: what the address bar opens. A bare loopback host gets `http`, any
  /// other bare host `https`; non-web schemes are refused.
  public static func normalize(_ raw: String) throws(NormalizationError) -> URL {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { throw .empty }
    let explicit = trimmed.firstMatch(of: /^([A-Za-z][A-Za-z\d+.\-]*):/)?.1.lowercased()
    if let explicit, nonWebSchemes.contains(explicit) { throw .unsupportedProtocol(explicit) }
    let hasScheme = trimmed.contains(/^[A-Za-z][A-Za-z\d+.\-]*:\/\//)
    let loopbackPrefix = trimmed.contains(/^(?i:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::|\/|$)/)
    let candidate: String
    if hasScheme {
      candidate = trimmed
    } else {
      let bareHost = String(trimmed.prefix { !"/:?#".contains($0) })
      candidate = (loopbackPrefix || isAnyLoopback(bareHost) ? "http://" : "https://") + trimmed
    }
    guard let components = URLComponents(string: candidate), let scheme = components.scheme?.lowercased(),
      let host = components.host, !host.isEmpty
    else { throw .parse }
    guard scheme == "http" || scheme == "https" else { throw .unsupportedProtocol(scheme) }
    guard let url = withRootPath(components) else { throw .parse }
    return url
  }

  /// WHATWG URLs always have a path; Foundation's do not, and a bare origin must compare equal.
  private static func withRootPath(_ components: URLComponents) -> URL? {
    var components = components
    components.scheme = components.scheme?.lowercased()
    if components.percentEncodedPath.isEmpty { components.percentEncodedPath = "/" }
    return components.url
  }

  /// Every loopback form a page can name: `localhost`, `*.localhost`, `127/8`, `::1`.
  public static func isAnyLoopback(_ host: String) -> Bool {
    let host = host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
    if host == "localhost" || host.hasSuffix(".localhost") { return true }
    if let address = IPv4Address(host) { return address.rawValue.first == 127 }
    if let address = IPv6Address(host) { return address.isLoopback }
    return false
  }

  /// The port a URL reaches, for error copy.
  public static func port(of url: URL) -> Int {
    url.port ?? (url.scheme?.lowercased() == "https" ? 443 : 80)
  }

  /// `host[:port]`, for error copy.
  public static func hostAndPort(of url: URL) -> String {
    guard let host = url.host(percentEncoded: false) else { return url.absoluteString }
    return url.port.map { "\(host):\($0)" } ?? host
  }
}

/// Real iPhones never send loopback addresses to a web view's proxy (the simulator does), so the
/// page loads under a stand-in host the proxy carries and shows `localhost` instead (RN
/// `AnkielLoopback`). It is as long as `localhost`, so the proxy can swap the two in plain HTTP
/// without changing a message's length.
public enum PreviewLoopback {
  public static let standInHost = "ankl.test"

  public static func standIn(_ url: URL) -> URL {
    guard let host = url.host(percentEncoded: false), PreviewURLs.isAnyLoopback(host) else { return url }
    return replacingHost(url, with: standInHost)
  }

  public static func shown(_ url: URL) -> URL {
    guard url.host(percentEncoded: false)?.lowercased() == standInHost else { return url }
    return replacingHost(url, with: "localhost")
  }

  /// Whether the page is one of the computer's (it went through the tunnel).
  public static func isTunnelled(_ url: URL) -> Bool {
    url.host(percentEncoded: false)?.lowercased() == standInHost
  }

  private static func replacingHost(_ url: URL, with host: String) -> URL {
    guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url }
    components.host = host
    return components.url ?? url
  }
}
