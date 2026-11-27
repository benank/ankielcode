import Foundation

/// Semantic versions as `packages/shared/src/semver.ts` compares them.
public enum SemanticVersion {
  struct Parsed: Equatable {
    var major: Int, minor: Int, patch: Int
    var prerelease: [String]
  }

  static func normalize(_ version: String) -> String {
    let withoutBuild = version.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: "+", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? ""
    let parts = withoutBuild.split(separator: "-", omittingEmptySubsequences: false).map(String.init)
    let main = parts.first ?? ""
    let prerelease = parts.dropFirst().joined(separator: "-")
    var segments = main.split(separator: ".", omittingEmptySubsequences: false)
      .map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    while !segments.isEmpty, segments.count < 3 { segments.append("0") }
    let joined = segments.joined(separator: ".")
    return prerelease.isEmpty ? joined : "\(joined)-\(prerelease)"
  }

  static func parse(_ value: String) -> Parsed? {
    var normalized = normalize(value)
    if normalized.hasPrefix("v") { normalized.removeFirst() }
    let parts = normalized.split(separator: "-", omittingEmptySubsequences: false).map(String.init)
    let segments = (parts.first ?? "").split(separator: ".", omittingEmptySubsequences: false).map(String.init)
    guard segments.count == 3, segments.allSatisfy(isNumeric),
      let major = Int(segments[0]), let minor = Int(segments[1]), let patch = Int(segments[2])
    else { return nil }
    let prerelease = parts.dropFirst().joined(separator: "-")
      .split(separator: ".", omittingEmptySubsequences: false)
      .map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    return Parsed(major: major, minor: minor, patch: patch, prerelease: prerelease)
  }

  static func isNumeric(_ value: String) -> Bool {
    !value.isEmpty && value.allSatisfy { $0.isASCII && $0.isNumber }
  }

  /// Negative, zero or positive, like `compareSemverVersions`.
  public static func compare(_ left: String, _ right: String) -> Int {
    guard let l = parse(left), let r = parse(right) else {
      return left == right ? 0 : (left.localizedCompare(right) == .orderedAscending ? -1 : 1)
    }
    if l.major != r.major { return l.major < r.major ? -1 : 1 }
    if l.minor != r.minor { return l.minor < r.minor ? -1 : 1 }
    if l.patch != r.patch { return l.patch < r.patch ? -1 : 1 }
    if l.prerelease.isEmpty, r.prerelease.isEmpty { return 0 }
    if l.prerelease.isEmpty { return 1 }
    if r.prerelease.isEmpty { return -1 }
    for index in 0..<max(l.prerelease.count, r.prerelease.count) {
      guard index < l.prerelease.count else { return -1 }
      guard index < r.prerelease.count else { return 1 }
      let result = compareIdentifier(l.prerelease[index], r.prerelease[index])
      if result != 0 { return result }
    }
    return 0
  }

  static func compareIdentifier(_ left: String, _ right: String) -> Int {
    switch (isNumeric(left), isNumeric(right)) {
    case (true, true):
      // Arbitrary length: compare digit strings without leading zeros.
      let l = left.drop { $0 == "0" }, r = right.drop { $0 == "0" }
      if l.count != r.count { return l.count < r.count ? -1 : 1 }
      return l == r ? 0 : (l < r ? -1 : 1)
    case (true, false): return -1
    case (false, true): return 1
    case (false, false): return left == right ? 0 : (left < right ? -1 : 1)
    }
  }
}

/// Ankiel Code release tracks (`packages/shared/src/cliRelease.ts`).
public enum ReleaseChannel: String, Sendable {
  case stable, nightly, preview

  /// `cliReleaseChannelOf`.
  public init(version: String) {
    let match = version.wholeMatch(of: /[^-+]+-(nightly|preview)\.\d{8}\.\d+/)
    self = match.flatMap { ReleaseChannel(rawValue: String($0.1)) } ?? .stable
  }

  /// `newestCliReleaseVersion`: the first non-draft `v<semver>` tag on this channel.
  public func newest(in releases: [(tag: String, draft: Bool)]) -> String? {
    for release in releases where !release.draft {
      guard let match = release.tag.wholeMatch(of: /v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/) else { continue }
      let version = String(match.1)
      if ReleaseChannel(version: version) == self { return version }
    }
    return nil
  }
}

/// Finds whether a newer Ankiel Code exists for a server version, from the public GitHub release
/// pages as RN does (`environment-maintenance.ts` `findEnvironmentUpdate`). The fetch is
/// injectable so tests and debug builds never reach the network.
public struct ReleaseLookup: Sendable {
  public typealias Fetch = @Sendable (URLRequest) async throws -> (Data, HTTPURLResponse)

  public enum Failure: Error, Sendable, Hashable {
    case http(Int)
    case unreadable
    case noRelease(ReleaseChannel)
    case unreachable(String)
  }

  static let releasesPage = URL(string: "https://github.com/benank/ankielcode/releases")!
  let fetch: Fetch

  public init(fetch: @escaping Fetch) {
    self.fetch = fetch
  }

  public static var live: ReleaseLookup {
    ReleaseLookup { request in
      let (data, response) = try await URLSession.shared.data(for: request)
      guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
      return (data, http)
    }
  }

  /// The newer version to offer, or nil when `current` is the newest on its channel.
  public func newerVersion(than current: String) async throws(Failure) -> String? {
    let channel = ReleaseChannel(version: current)
    var version: String?
    if channel == .stable {
      let data = try await get(Self.releasesPage.appending(path: "latest"), accept: "application/json")
      struct Release: Decodable {
        var tag_name: String
        var draft: Bool?
      }
      guard let release = try? JSONDecoder().decode(Release.self, from: data) else { throw .unreadable }
      version = channel.newest(in: [(release.tag_name, release.draft ?? false)])
    } else {
      let data = try await get(URL(string: Self.releasesPage.absoluteString + ".atom")!, accept: "application/atom+xml")
      let text = String(decoding: data, as: UTF8.self)
      let tags = text.matches(of: /<id>tag:github\.com,2008:Repository\/\d+\/([^<]+)<\/id>/).map { (tag: String($0.1), draft: false) }
      version = channel.newest(in: tags)
    }
    // The feed holds only ten releases; RN pages the API as a last resort, which this skips.
    guard let version else { throw .noRelease(channel) }
    return SemanticVersion.compare(version, current) > 0 ? version : nil
  }

  private func get(_ url: URL, accept: String) async throws(Failure) -> Data {
    var request = URLRequest(url: url)
    request.setValue(accept, forHTTPHeaderField: "Accept")
    request.timeoutInterval = 20
    do {
      let (data, response) = try await fetch(request)
      guard (200..<300).contains(response.statusCode) else { throw Failure.http(response.statusCode) }
      return data
    } catch let failure as Failure {
      throw failure
    } catch {
      throw .unreachable(error.localizedDescription)
    }
  }
}

/// `server.updateServer` payload (`ServerSelfUpdateInput`).
public struct ServerUpdateRequest: Sendable, Encodable {
  public var targetVersion: String

  public init(targetVersion: String) {
    self.targetVersion = targetVersion
  }

  public static let rpcTag = "server.updateServer"
}

/// `ServerSelfUpdateResult`, the fields this client reads.
public struct ServerUpdateResult: Sendable, Decodable {
  public var targetVersion: String
  public var method: String?
}
