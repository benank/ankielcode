import Foundation

/// A change request URL read into its parts (the source control definitions'
/// `parseChangeRequestUrl`). GitHub (any host: `/owner/repo/pull/12`) and GitLab
/// (`/group/repo/-/merge_requests/12`) are read; other hosts' links open in the browser.
public struct ChangeRequestLink: Sendable, Hashable {
  public enum Kind: String, Sendable { case github, gitlab }

  public var kind: Kind
  /// The hostname, lowercased (no port).
  public var host: String
  /// `host:port` when the URL names a port.
  public var authority: String?
  /// `owner/repo`, lowercased.
  public var repository: String
  public var number: Int
  /// `https://host[:port]` as written (scheme and host lowercased).
  public var origin: String
  /// The repository's web URL with its own casing.
  public var repositoryURL: String

  /// The host the server's references use (`authority ?? host`).
  public var refHost: String { authority ?? host }

  public static func parse(_ text: String) -> ChangeRequestLink? {
    guard let url = URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
      let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http",
      let host = url.host()?.lowercased(), !host.isEmpty
    else { return nil }
    let authority = url.port.map { "\(host):\($0)" }
    let origin = "\(scheme)://\(authority ?? host)"
    let parts = url.path(percentEncoded: false).split(separator: "/").map(String.init)
    if let dash = parts.firstIndex(of: "-"), dash >= 2, parts.count > dash + 2, parts[dash + 1] == "merge_requests",
      let number = Int(parts[dash + 2]), number > 0
    {
      let path = parts[..<dash].joined(separator: "/")
      return ChangeRequestLink(
        kind: .gitlab, host: host, authority: authority, repository: path.lowercased(), number: number, origin: origin,
        repositoryURL: "\(origin)/\(path)")
    }
    if parts.count >= 4, parts[2] == "pull" || parts[2] == "pulls", let number = Int(parts[3]), number > 0 {
      let path = "\(parts[0])/\(parts[1])"
      return ChangeRequestLink(
        kind: .github, host: host, authority: authority, repository: path.lowercased(), number: number, origin: origin,
        repositoryURL: "\(origin)/\(path)")
    }
    return nil
  }

  /// The project's repository key (`host/owner/repo`) matches the link's.
  public func isInRepository(_ identity: RepositoryIdentity?) -> Bool {
    guard let key = identity?.canonicalKey.lowercased() else { return false }
    return key == "\(host)/\(repository)" || key == "\(refHost)/\(repository)"
  }

  /// The project is on the link's host, so it can read a sibling repository's change requests.
  public func isOnHost(_ identity: RepositoryIdentity?) -> Bool {
    guard let key = identity?.canonicalKey.lowercased(), let first = key.split(separator: "/").first else { return false }
    return first == host || first == refHost
  }
}

/// What someone pasted to open a pull request (RN `pullRequestLinkInput.ts`).
public enum PullRequestLinkInput {
  public enum Parsed: Sendable, Hashable {
    case url(ChangeRequestLink, String)
    case number(Int)
  }

  /// A full URL, `#12`, `12`, or a checkout command (`gh pr checkout 12`, `glab mr checkout 12`).
  public static func parse(_ input: String) -> Parsed? {
    var text = input.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return nil }
    if let match = text.wholeMatch(of: /(?i)(?:gh\s+pr|glab\s+mr)\s+checkout\s+(.+)/) {
      text = String(match.1).trimmingCharacters(in: .whitespaces)
    }
    if let link = ChangeRequestLink.parse(text) { return .url(link, text) }
    if let match = text.wholeMatch(of: /#?(\d+)/), let number = Int(match.1), number > 0 { return .number(number) }
    return nil
  }

  public enum Resolution: Sendable, Hashable {
    case open(environmentId: String, ref: PullRequestRef)
    /// No project on any connected computer can read it.
    case noProject(host: String, repository: String)
    /// A bare number with no repository to read it against.
    case needsURL
  }

  public struct Project: Sendable, Hashable {
    public var environmentId: String
    public var projectId: String
    public var identity: RepositoryIdentity?
    public init(environmentId: String, projectId: String, identity: RepositoryIdentity?) {
      self.environmentId = environmentId
      self.projectId = projectId
      self.identity = identity
    }
  }

  /// Where a pasted reference opens: the project checked out from its repository, else any
  /// project on its host (`resolveChangeRequestLinkTarget` with `lendHostProject`). A bare number
  /// resolves against `scope` (the list's chosen project).
  public static func resolve(_ input: String, projects: [Project], scope: Project? = nil) -> Resolution? {
    switch parse(input) {
    case nil: return nil
    case .url(let link, _):
      let project = projects.first { link.isInRepository($0.identity) } ?? projects.first { link.isOnHost($0.identity) }
      guard let project else { return .noProject(host: link.host, repository: link.repository) }
      return .open(
        environmentId: project.environmentId,
        ref: PullRequestRef(projectId: project.projectId, host: link.refHost, repository: link.repository, number: link.number))
    case .number(let number):
      guard let scope, let identity = scope.identity, let repository = Self.repository(identity) else { return .needsURL }
      let host = identity.canonicalKey.split(separator: "/").first.map(String.init)
      return .open(environmentId: scope.environmentId, ref: PullRequestRef(projectId: scope.projectId, host: host, repository: repository, number: number))
    }
  }

  /// `owner/repo` from a project's identity.
  public static func repository(_ identity: RepositoryIdentity) -> String? {
    if let display = identity.displayName, display.contains("/") { return display }
    if let owner = identity.owner, let name = identity.name { return "\(owner)/\(name)" }
    let parts = identity.canonicalKey.split(separator: "/")
    return parts.count >= 3 ? parts.dropFirst().joined(separator: "/") : nil
  }
}
