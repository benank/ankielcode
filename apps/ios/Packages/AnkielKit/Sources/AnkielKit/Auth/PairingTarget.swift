import Foundation

/// Where to pair and with what: the result of reading a pairing URL, app link or host + code.
public struct PairingTarget: Sendable, Hashable {
  public var credential: String
  public var endpoint: EnvironmentEndpoint

  public init(credential: String, endpoint: EnvironmentEndpoint) {
    self.credential = credential
    self.endpoint = endpoint
  }
}

public enum PairingInputError: Error, Sendable, Hashable {
  case backendURLMissing
  case pairingURLInvalid
  case backendURLInvalid
  case tokenMissing(host: String)
  case codeMissing(host: String)
}

public enum PairingInput {
  private static let supportedSchemes: Set<String> = ["http", "https", "ws", "wss"]

  /// Reads anything a user can paste or scan: an `ankielcode[-channel]://pair?pairingUrl=` app
  /// link, or a pairing URL (`https://host/pair#token=CODE`, `…/h/<hostId>/#token=CODE`).
  public static func resolve(_ value: String) throws(PairingInputError) -> PairingTarget {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return try resolve(pairingURL: appLinkPairingURL(trimmed) ?? trimmed)
  }

  public static func resolve(pairingURL raw: String) throws(PairingInputError) -> PairingTarget {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { throw .backendURLMissing }
    guard let components = URLComponents(string: trimmed), let scheme = components.scheme?.lowercased(),
      components.host?.isEmpty == false
    else { throw .pairingURLInvalid }
    guard supportedSchemes.contains(scheme) else { throw .pairingURLInvalid }
    guard let token = token(in: components) else {
      throw .tokenMissing(host: EnvironmentEndpoint.hostAndPort(components))
    }
    guard let endpoint = EnvironmentEndpoint(components) else { throw .pairingURLInvalid }
    return PairingTarget(credential: token, endpoint: endpoint)
  }

  /// A host typed by hand plus a separate code. A bare IP literal defaults to `http://`, any
  /// other host to `https://` (as the RN form does).
  public static func resolve(host raw: String, code: String) throws(PairingInputError) -> PairingTarget {
    var host = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    while host.hasPrefix("/") { host.removeFirst() }
    guard !host.isEmpty else { throw .backendURLMissing }
    if host.firstMatch(of: /^[a-zA-Z][a-zA-Z\d+\-]*:\/\//) == nil {
      host = (isIPLiteral(host) ? "http://" : "https://") + host
    }
    guard let components = URLComponents(string: host), let scheme = components.scheme?.lowercased(),
      supportedSchemes.contains(scheme), let endpoint = EnvironmentEndpoint(components)
    else { throw .backendURLInvalid }
    let credential = code.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !credential.isEmpty else { throw .codeMissing(host: EnvironmentEndpoint.hostAndPort(components)) }
    return PairingTarget(credential: credential, endpoint: endpoint)
  }

  /// The pairing URL inside an `ankielcode://pair?pairingUrl=…` link on any channel scheme.
  public static func appLinkPairingURL(_ value: String) -> String? {
    guard let components = URLComponents(string: value), let scheme = components.scheme?.lowercased(),
      scheme.wholeMatch(of: /ankielcode(?:-[a-z]+)?/) != nil, components.host?.lowercased() == "pair",
      components.path.isEmpty || components.path == "/"
    else { return nil }
    let link = components.queryItems?.first { $0.name == "pairingUrl" }?.value?
      .trimmingCharacters(in: .whitespacesAndNewlines)
    return link?.isEmpty == false ? link : nil
  }

  /// `#token=` first, then `?token=`, as `getPairingTokenFromUrl` reads them.
  static func token(in components: URLComponents) -> String? {
    if let fragment = components.percentEncodedFragment,
      let token = FormEncoding.decode(fragment).first(where: { $0.0 == "token" })?.1
        .trimmingCharacters(in: .whitespaces), !token.isEmpty
    {
      return token
    }
    if let query = components.percentEncodedQuery,
      let token = FormEncoding.decode(query).first(where: { $0.0 == "token" })?.1
        .trimmingCharacters(in: .whitespaces), !token.isEmpty
    {
      return token
    }
    return nil
  }

  private static func isIPLiteral(_ host: String) -> Bool {
    let name = host.split(separator: "/", maxSplits: 1).first.map(String.init) ?? host
    if name.hasPrefix("[") { return true }
    let withoutPort = name.split(separator: ":").first.map(String.init) ?? name
    return withoutPort.wholeMatch(of: /\d{1,3}(\.\d{1,3}){3}/) != nil
  }
}
