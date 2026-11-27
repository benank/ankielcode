import Foundation

/// A thread's pull request chip (RN `thread-pr-presentation.ts` over source-control-core
/// `threadPullRequests.ts`): the current pull request of its links, or a count for a stack or
/// several, with the overall state and the checks of the one shown.
public struct ThreadPullRequestBadge: Sendable, Hashable {
  public enum Kind: Sendable, Hashable {
    case single
    /// Linked pull requests that stack on one another (`layers` of them).
    case stack(layers: Int)
    /// Unrelated linked pull requests (`count` in all).
    case several(count: Int)
  }

  public var kind: Kind
  public var number: Int
  public var url: String
  public var repository: String
  public var host: String
  /// nil while the link has no snapshot yet ("status pending").
  public var state: PullRequestDisplayState?
  public var checks: PullRequestChecksState?
  public var title: String?

  public init(
    kind: Kind, number: Int, url: String, repository: String, host: String, state: PullRequestDisplayState?,
    checks: PullRequestChecksState?, title: String?
  ) {
    self.kind = kind
    self.number = number
    self.url = url
    self.repository = repository
    self.host = host
    self.state = state
    self.checks = checks
    self.title = title
  }

  /// "#12", a stack's layer count, or "+3".
  public var label: String {
    switch kind {
    case .single: "#\(number)"
    case .stack(let layers): "\(layers)"
    case .several(let count): "+\(count)"
    }
  }
}

public enum ThreadPullRequests {
  typealias Link = ThreadShell.PullRequestLink

  /// Stack-dismissed tombstones stay hidden.
  static func visible(_ links: [Link]) -> [Link] { links.filter { $0.source != .stackDismissed } }

  static func isOpen(_ link: Link) -> Bool { link.snapshot == nil || link.snapshot?.state == .open }

  static func updatedAt(_ link: Link) -> Date { (link.snapshot?.updatedAt ?? link.linkedAt).date ?? .distantPast }

  static func key(_ link: Link) -> String {
    if let parsed = ChangeRequestLink.parse(link.url), parsed.number == link.number {
      return "\(parsed.refHost)/\(parsed.repository)#\(link.number)"
    }
    return "\(link.host.lowercased())/\(link.repository.lowercased())#\(link.number)"
  }

  struct Chain {
    var native: Bool
    var layers: [Link]
    var depths: [Int]

    /// Top of the stack first.
    var fromTop: [Link] {
      zip(layers.indices, layers).sorted { left, right in
        depths[left.0] != depths[right.0] ? depths[left.0] > depths[right.0] : left.0 > right.0
      }.map(\.1)
    }
  }

  /// Native stacks by stack id, then chains derived from head and base branches.
  static func chains(_ links: [Link]) -> [Chain] {
    let visible = visible(links)
    var chains: [Chain] = []
    var placed = Set<String>()
    var stacks: [String: [Link]] = [:]
    var stackOrder: [String] = []
    for link in visible {
      guard let stack = link.stack else { continue }
      let parsed = key(link).split(separator: "#").first.map(String.init) ?? ""
      let stackKey = "\(parsed)#stack:\(stack.id)"
      if stacks[stackKey] == nil { stackOrder.append(stackKey) }
      stacks[stackKey, default: []].append(link)
    }
    for stackKey in stackOrder {
      var members = stacks[stackKey] ?? []
      let numbers = Set(members.map(\.number))
      var layers = members[0].stack?.layers ?? []
      var coverage = layers.filter { numbers.contains($0.number) }.count
      for member in members.dropFirst() {
        let candidate = member.stack?.layers ?? []
        let candidateCoverage = candidate.filter { numbers.contains($0.number) }.count
        if candidateCoverage > coverage || (candidateCoverage == coverage && candidate.count > layers.count) {
          layers = candidate
          coverage = candidateCoverage
        }
      }
      let order = Dictionary(layers.enumerated().map { ($1.number, $0) }, uniquingKeysWith: { first, _ in first })
      members.sort { (order[$0.number] ?? layers.count) < (order[$1.number] ?? layers.count) }
      for member in members { placed.insert(key(member)) }
      chains.append(Chain(native: true, layers: members, depths: Array(members.indices)))
    }

    let remaining = visible.filter { !placed.contains(key($0)) }
    func repoKey(_ link: Link) -> String { String(key(link).split(separator: "#").first ?? "") }
    var byHead: [String: Link?] = [:]
    for link in remaining {
      guard let snapshot = link.snapshot else { continue }
      let headKey = "\(repoKey(link)):\(snapshot.headBranch)"
      byHead[headKey] = byHead[headKey] == nil ? link : .some(nil)
    }
    func parent(_ link: Link) -> Link? {
      guard let snapshot = link.snapshot, let found = byHead["\(repoKey(link)):\(snapshot.baseBranch)"], let parent = found,
        key(parent) != key(link)
      else { return nil }
      return parent
    }
    var children: [String: [Link]] = [:]
    for link in remaining {
      if let parent = parent(link) { children[key(parent), default: []].append(link) }
    }
    for base in remaining where parent(base) == nil {
      var layers: [Link] = []
      var depths: [Int] = []
      var pending: [(Link, Int)] = [(base, 0)]
      while let (link, depth) = pending.popLast() {
        guard placed.insert(key(link)).inserted else { continue }
        layers.append(link)
        depths.append(depth)
        for child in (children[key(link)] ?? []).reversed() { pending.append((child, depth + 1)) }
      }
      if !layers.isEmpty { chains.append(Chain(native: false, layers: layers, depths: depths)) }
    }
    for link in remaining where !placed.contains(key(link)) {
      chains.append(Chain(native: false, layers: [link], depths: [0]))
    }
    return chains
  }

  /// The link a thread's chip opens (`resolveThreadCurrentPullRequestLink`).
  public static func current(_ links: [ThreadShell.PullRequestLink]) -> ThreadShell.PullRequestLink? {
    let visible = visible(links)
    guard !visible.isEmpty else { return nil }
    let open = visible.filter(isOpen)
    if open.count == 1 { return open[0] }
    let chains = chains(visible)
    if open.count > 1 {
      let openChains = chains.map { $0.fromTop.filter(isOpen) }.filter { !$0.isEmpty }
      if openChains.count == 1 { return openChains[0].first }
      return openChains.max { left, right in
        (left.compactMap { $0.linkedAt.date }.max() ?? .distantPast) < (right.compactMap { $0.linkedAt.date }.max() ?? .distantPast)
      }?.first
    }
    if chains.count == 1 { return chains[0].fromTop.first }
    return visible.max { updatedAt($0) < updatedAt($1) }
  }

  /// The chip for a thread's linked pull requests, or nil without any.
  public static func badge(_ links: [ThreadShell.PullRequestLink]?) -> ThreadPullRequestBadge? {
    let visible = visible(links ?? [])
    guard let link = current(visible) else { return nil }
    let states = visible.map { $0.snapshot?.state.known ?? .open }
    let overall: PullRequestDisplayState =
      visible.allSatisfy({ $0.snapshot?.state == .open && $0.snapshot?.isDraft == true }) ? .draft
      : states.contains(.open) ? .open
      : states.allSatisfy({ $0 == .merged }) ? .merged : .closed
    let chains = chains(visible)
    let kind: ThreadPullRequestBadge.Kind =
      visible.count > 1 && chains.count == 1 ? .stack(layers: visible.count)
      : visible.count > 1 ? .several(count: visible.count) : .single
    let snapshot = link.snapshot
    let state: PullRequestDisplayState? =
      if case .single = kind {
        snapshot.map { PullRequestDisplayState(state: WireEnum(rawValue: $0.state.rawValue), isDraft: $0.isDraft) }
      } else { overall }
    return ThreadPullRequestBadge(
      kind: kind, number: link.number, url: link.url, repository: link.repository, host: link.host, state: state,
      checks: snapshot?.checksState?.known.flatMap { PullRequestChecksState(rawValue: $0.rawValue) }, title: snapshot?.title)
  }

  /// The chip from a branch's pull request summary (`pullRequests.summary`), used when the thread
  /// has no links but its branch has an open pull request.
  public static func badge(summary: PullRequestSummary, host: String?) -> ThreadPullRequestBadge {
    ThreadPullRequestBadge(
      kind: .single, number: summary.number, url: summary.url, repository: summary.repository,
      host: host ?? ChangeRequestLink.parse(summary.url)?.refHost ?? "", state: PullRequestDisplayState(state: summary.state, isDraft: summary.isDraft ?? false),
      checks: summary.checksState?.known, title: summary.title)
  }

  /// The project that reads a link, to open it: the thread's own project.
  public static func ref(_ badge: ThreadPullRequestBadge, projectId: String) -> PullRequestRef {
    let parsed = ChangeRequestLink.parse(badge.url)
    return PullRequestRef(
      projectId: projectId, host: parsed?.refHost ?? badge.host,
      repository: parsed?.repository ?? badge.repository.lowercased(), number: badge.number)
  }
}
