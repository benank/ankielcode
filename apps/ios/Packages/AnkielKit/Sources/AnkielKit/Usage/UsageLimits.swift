import Foundation

/// One connected computer's providers, the input of every limits view (RN `LimitPresentations`).
public struct LimitSource: Sendable, Hashable {
  public var environmentId: String
  public var label: String
  public var providers: [ServerProvider]

  public init(environmentId: String, label: String, providers: [ServerProvider]) {
    self.environmentId = environmentId
    self.label = label
    self.providers = providers
  }
}

/// One provider login, merged across the computers that report it (RN `LimitAccount`).
public struct LimitAccount: Sendable, Hashable, Identifiable {
  public struct Environment: Sendable, Hashable {
    public var environmentId: String
    public var label: String
  }

  /// Where to redeem a reset credit: the computer whose report supplied the credits on show.
  public struct Redeem: Sendable, Hashable {
    public var environmentId: String
    public var instanceId: String
  }

  public var key: String
  public var driver: String
  public var displayName: String?
  public var email: String?
  public var plan: String?
  public var accentColor: String?
  public var environments: [Environment]
  public var redeem: Redeem
  public var limits: ProviderUsageLimits

  public var id: String { key }

  public init(
    key: String, driver: String, displayName: String? = nil, email: String? = nil, plan: String? = nil,
    accentColor: String? = nil, environments: [Environment] = [], redeem: Redeem, limits: ProviderUsageLimits
  ) {
    self.key = key
    self.driver = driver
    self.displayName = displayName
    self.email = email
    self.plan = plan
    self.accentColor = accentColor
    self.environments = environments
    self.redeem = redeem
    self.limits = limits
  }
}

/// Why an account shows a note instead of windows (RN `limitsNotice`).
public enum LimitsNotice: Sendable, Hashable {
  /// The account has no subscription limits; `message` is the server's own words.
  case unsupported(message: String?)
  case probeFailed(message: String?)
  case noneReported
}

/// RN `LimitPace`: spend against elapsed time.
public enum LimitPace: String, Sendable, Hashable { case ahead, on, under }

/// RN `ResetCountdown`.
public enum ResetCountdown: Sendable, Hashable {
  case now
  case momentarily
  case after(TimeInterval)
}

/// One account's share of a pooled window. `window` is what the pool counts, which differs from
/// the report when a spent weekly window blocks a session.
public struct LimitPoolMember: Sendable, Hashable {
  public var account: LimitAccount
  public var window: UsageWindow
  public var refillPercent: Double
}

public struct LimitPoolWindow: Sendable, Hashable, Identifiable {
  public struct Reset: Sendable, Hashable {
    public var member: LimitPoolMember
    public var at: Date
    public var restoresPercent: Int
  }

  /// A column per pooled account, in the pool's account order; nil where it has no such window.
  public struct Column: Sendable, Hashable {
    public var account: LimitAccount
    public var member: LimitPoolMember?
  }

  public var id: String
  public var kind: UsageWindow.Kind
  public var label: String
  public var members: [LimitPoolMember]
  public var columns: [Column]
  public var remainingPercent: Int
  public var usedPercent: Int
  public var pace: LimitPace?
  /// Upcoming refills, soonest first.
  public var resets: [Reset]
}

/// One driver's accounts and their pooled windows (RN `LimitPool`).
public struct LimitPool: Sendable, Hashable, Identifiable {
  public var driver: String
  public var accounts: [LimitAccount]
  public var windows: [LimitPoolWindow]
  public var id: String { driver }
}

/// Port of `packages/shared/src/usageLimits.ts`: which providers report limits, how one login is
/// recognized across computers, pooling, pace and reset countdowns. Pure; dates are passed in.
public enum UsageLimits {
  static let antigravityAuthLabels: Set<String> = [
    "Google account", "Gemini Enterprise", "Gemini API key", "Agent Platform (Vertex AI)",
  ]

  /// Enabled, installed, available providers that report limits (RN `providersWithLimits`).
  public static func providersWithLimits(_ providers: [ServerProvider]) -> [ServerProvider] {
    providers.filter { $0.enabled && $0.installed && $0.availability != "unavailable" && $0.usageLimits != nil }
  }

  public static func notice(_ limits: ProviderUsageLimits) -> LimitsNotice? {
    switch limits.unavailable?.reason {
    case "unsupported": return .unsupported(message: limits.unavailable?.message)
    case "probeFailed": return .probeFailed(message: limits.unavailable?.message)
    default: return limits.windows.isEmpty ? .noneReported : nil
    }
  }

  public static func remainingPercent(_ window: UsageWindow) -> Int {
    jsRound(100 - min(100, max(0, window.usedPercent)))
  }

  public static func elapsedShare(_ window: UsageWindow, now: Date) -> Double? {
    guard let resetsAt = window.resetsAt, let minutes = window.windowDurationMins else { return nil }
    let length = Double(minutes) * 60
    guard length > 0 else { return nil }
    return max(0, min(1, (length - resetsAt.timeIntervalSince(now)) / length))
  }

  /// Bars show quota remaining, so even pace tracks time remaining.
  public static func paceRemainingPercent(_ window: UsageWindow, now: Date) -> Int? {
    elapsedShare(window, now: now).map { jsRound((1 - $0) * 100) }
  }

  public static func pace(_ window: UsageWindow, now: Date) -> LimitPace? {
    elapsedShare(window, now: now).map { pace(used: window.usedPercent, elapsed: $0) }
  }

  static func pace(used: Double, elapsed: Double) -> LimitPace {
    let gap = used - elapsed * 100
    if gap > 5 { return .ahead }
    if gap < -5 { return .under }
    return .on
  }

  public static func resetCountdown(_ window: UsageWindow, now: Date) -> ResetCountdown? {
    guard let resetsAt = window.resetsAt else { return nil }
    let left = resetsAt.timeIntervalSince(now)
    if left <= 0 { return .now }
    if left < 60 { return .momentarily }
    return .after(left)
  }

  /// The highest spend across every account's windows (the header ring), nil with none.
  public static func highestUsedPercent(_ accounts: [LimitAccount]) -> Double? {
    var highest: Double?
    for account in accounts {
      for window in account.limits.windows { highest = max(highest ?? 0, window.usedPercent) }
    }
    return highest
  }

  /// Plan labels repeat the product the provider name already shows ("ChatGPT Pro 200 Subscription").
  public static func shortPlanLabel(_ plan: String) -> String {
    plan.replacing(/^(?i:ChatGPT|Claude|Google AI)\s+/, with: "").replacing(/\s+(?i:Subscription)$/, with: "")
  }

  // MARK: Accounts

  struct AccountReport {
    var driver: String
    var email: String?
    var workspaceId: String?
    var limits: ProviderUsageLimits?

    init(_ provider: ServerProvider) {
      driver = provider.driver
      email = provider.authEmail
      workspaceId = provider.authWorkspaceId
      limits = provider.usageLimits
    }
  }

  static func accountKey(_ driver: String, _ email: String?, _ limits: ProviderUsageLimits?) -> String? {
    if let email = email?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(), !email.isEmpty {
      return "\(driver):\(email)"
    }
    if let fingerprint = limits?.credentialFingerprint, !fingerprint.isEmpty { return "\(driver):credential:\(fingerprint)" }
    return nil
  }

  /// Includes every enabled login, even unreadable workspaces, so an email in two workspaces stays
  /// apart and a report without a workspace joins the only one signed in with its email.
  static func accountKeyResolver(_ reports: [AccountReport]) -> (AccountReport) -> String? {
    var workspaces: [String: [String]] = [:]
    for report in reports {
      if let key = accountKey(report.driver, report.email, report.limits), let workspace = nonEmpty(report.workspaceId) {
        if !(workspaces[key]?.contains(workspace) ?? false) { workspaces[key, default: []].append(workspace) }
      }
    }
    return { report in
      guard let key = accountKey(report.driver, report.email, report.limits) else { return nil }
      if let workspace = nonEmpty(report.workspaceId) { return "\(key):\(workspace)" }
      guard let known = workspaces[key] else { return key }
      return known.count == 1 ? "\(key):\(known[0])" : nil
    }
  }

  /// Until a session reports Antigravity's tier, older servers label the sign-in method.
  static func providerPlan(_ provider: ServerProvider) -> String? {
    guard let label = nonEmpty(provider.authLabel) else { return nil }
    return provider.driver == "antigravity" && antigravityAuthLabels.contains(label) ? nil : label
  }

  public static func accounts(_ sources: [LimitSource]) -> [LimitAccount] {
    let resolve = accountKeyResolver(sources.flatMap { $0.providers.filter(\.enabled).map(AccountReport.init) })
    var order: [String] = []
    var accounts: [String: LimitAccount] = [:]
    var creditSources: [String: LimitAccount] = [:]
    var planSources: [String: LimitAccount] = [:]

    func merge(_ key: String, _ next: LimitAccount) {
      if next.limits.resetCredits != nil, creditSources[key].map({ next.limits.checkedAt > $0.limits.checkedAt }) ?? true {
        creditSources[key] = next
      }
      if next.plan != nil, planSources[key].map({ next.limits.checkedAt > $0.limits.checkedAt }) ?? true {
        planSources[key] = next
      }
      guard let previous = accounts[key] else {
        order.append(key)
        accounts[key] = next
        return
      }
      let winner = next.limits.checkedAt > previous.limits.checkedAt ? next : previous
      var merged = previous
      merged.displayName = previous.displayName ?? next.displayName
      merged.plan = planSources[key]?.plan ?? previous.plan ?? next.plan
      merged.accentColor = previous.accentColor ?? next.accentColor
      merged.environments += next.environments.filter { candidate in
        !previous.environments.contains { $0.environmentId == candidate.environmentId }
      }
      let credit = creditSources[key]
      merged.redeem = (credit ?? winner).redeem
      merged.limits = winner.limits
      merged.limits.resetCredits = credit?.limits.resetCredits
      accounts[key] = merged
    }

    for source in sources {
      for provider in providersWithLimits(source.providers) {
        guard let limits = provider.usageLimits, notice(limits) == nil else { continue }
        let key = resolve(AccountReport(provider)) ?? "\(source.environmentId):\(provider.instanceId)"
        merge(
          key,
          LimitAccount(
            key: "\(source.environmentId):\(provider.instanceId)", driver: provider.driver,
            displayName: nonEmpty(provider.displayName?.trimmingCharacters(in: .whitespacesAndNewlines)),
            email: provider.authEmail, plan: providerPlan(provider), accentColor: provider.accentColor,
            environments: [.init(environmentId: source.environmentId, label: source.label)],
            redeem: .init(environmentId: source.environmentId, instanceId: provider.instanceId), limits: limits))
      }
    }
    return order.compactMap { accounts[$0] }
  }

  /// Accounts that report a note instead of windows, as "Computer · Provider" (with more than one
  /// computer) and the notice. A bare `unsupported` (no limits on this plan) is not a notice, nor
  /// one that comes with an external usage link (RN `collectLimitNotices`).
  public static func notices(_ sources: [LimitSource]) -> [(subject: String, notice: LimitsNotice)] {
    var seen: Set<String> = []
    var notices: [(subject: String, notice: LimitsNotice)] = []
    for source in sources {
      for provider in providersWithLimits(source.providers) {
        guard let limits = provider.usageLimits, let notice = notice(limits) else { continue }
        if case .unsupported(let message) = notice, message == nil || limits.externalUsage != nil { continue }
        let name = provider.label
        let subject = sources.count > 1 ? "\(source.label) · \(name)" : name
        let id = "\(subject)|\(notice)"
        guard seen.insert(id).inserted else { continue }
        notices.append((subject, notice))
      }
    }
    return notices
  }

  public struct ExternalLink: Sendable, Hashable, Identifiable {
    public var label: String
    public var url: String
    public var message: String?
    /// "Provider on Computer" pairs, as (provider, computer).
    public var accounts: [Account]
    public var id: String { url }

    public struct Account: Sendable, Hashable {
      public var provider: String
      public var environment: String
    }
  }

  /// Signed-in accounts that send users to the provider's own usage page, one row per URL.
  public static func externalLinks(_ sources: [LimitSource]) -> [ExternalLink] {
    var order: [String] = []
    var links: [String: ExternalLink] = [:]
    for source in sources {
      for provider in providersWithLimits(source.providers) {
        guard let external = provider.usageLimits?.externalUsage, provider.authStatus == "authenticated" else { continue }
        let account = ExternalLink.Account(provider: provider.label, environment: source.label)
        var link = links[external.url] ?? {
          order.append(external.url)
          return ExternalLink(label: external.label, url: external.url, accounts: [])
        }()
        link.label = external.label
        link.message = provider.usageLimits?.unavailable?.message
        if !link.accounts.contains(account) { link.accounts.append(account) }
        links[external.url] = link
      }
    }
    return order.compactMap { links[$0] }
  }

  // MARK: Pools

  static let codexPlanCapacity: [String: Double] = [
    "ChatGPT Plus Subscription": 1, "ChatGPT Pro 100 Subscription": 5, "ChatGPT Pro 200 Subscription": 20,
  ]
  /// Claude's published plan multipliers describe the session allowance only.
  static let claudeSessionCapacity: [String: Double] = ["Pro": 1, "Max": 5, "Ultra": 20]

  static func planCapacity(_ account: LimitAccount, _ kind: UsageWindow.Kind) -> Double? {
    guard let plan = account.plan else { return nil }
    if account.driver == "codex", kind == .session || kind == .weekly { return codexPlanCapacity[plan] }
    if account.driver == "claudeAgent", kind == .session { return claudeSessionCapacity[plan] }
    return nil
  }

  /// Codex ids name slots, so it pools by kind; other drivers' ids identify distinct allowances.
  static func poolKey(_ driver: String, _ window: UsageWindow) -> String {
    driver == "codex" ? window.kind.rawValue : "\(window.kind.rawValue):\(window.id)"
  }

  /// A session is unusable while the account's weekly allowance is spent: the pool counts it as
  /// spent and refilling when the weekly window (or the session, if later) resets.
  static func poolMember(_ account: LimitAccount, _ reported: UsageWindow, now: Date) -> LimitPoolMember {
    let spentWeekly =
      reported.kind == .session
      ? account.limits.windows.first { window in
        window.usedPercent >= 100
          && (account.driver == "claudeAgent" ? window.id == "seven_day" : account.driver == "codex" && window.kind == .weekly)
      } : nil
    guard let spentWeekly else { return LimitPoolMember(account: account, window: reported, refillPercent: reported.usedPercent) }

    let cutoff = max(now, account.limits.checkedAt)
    var resetsAt: Date?
    var refill = 0.0
    // A stale or missing clock cannot tell when blocked quota becomes usable.
    if let weeklyReset = spentWeekly.resetsAt, let sessionReset = reported.resetsAt, weeklyReset > cutoff, sessionReset > cutoff {
      if sessionReset <= weeklyReset {
        resetsAt = spentWeekly.resetsAt
        refill = 100
      } else if reported.usedPercent >= 100 {
        resetsAt = reported.resetsAt
        refill = 100
      } else {
        resetsAt = spentWeekly.resetsAt
        refill = 100 - max(0, min(100, reported.usedPercent))
      }
    }
    var window = reported
    window.usedPercent = 100
    window.resetsAt = resetsAt
    // Suppression is not session spending, so it has no session pace clock.
    window.windowDurationMins = nil
    return LimitPoolMember(account: account, window: window, refillPercent: refill)
  }

  public static func pools(_ accounts: [LimitAccount], now: Date) -> [LimitPool] {
    var drivers: [String] = []
    var byDriver: [String: [LimitAccount]] = [:]
    for account in accounts {
      if byDriver[account.driver] == nil { drivers.append(account.driver) }
      byDriver[account.driver, default: []].append(account)
    }
    return drivers.map { driver in
      let members = byDriver[driver] ?? []
      let orderWindow = stableSorted(members.flatMap(\.limits.windows)) { $0.kind.order < $1.kind.order }.first
      func orderReset(_ account: LimitAccount) -> Double {
        guard let orderWindow,
          let window = account.limits.windows.first(where: { poolKey(driver, $0) == poolKey(driver, orderWindow) }),
          let at = poolMember(account, window, now: now).window.resetsAt
        else { return .infinity }
        return at.timeIntervalSince1970
      }
      let sorted = stableSorted(members) { left, right in
        let (l, r) = (orderReset(left), orderReset(right))
        if l != r { return l < r }
        let (ln, rn) = (sortName(left), sortName(right))
        if ln != rn { return ln < rn }
        return left.key < right.key
      }
      return LimitPool(driver: driver, accounts: sorted, windows: poolWindows(sorted, now: now))
    }
  }

  static func sortName(_ account: LimitAccount) -> String {
    (account.displayName ?? account.email ?? account.key).lowercased()
  }

  static func poolWindows(_ accounts: [LimitAccount], now: Date) -> [LimitPoolWindow] {
    var keys: [String] = []
    var byKey: [String: [LimitPoolMember]] = [:]
    for account in accounts {
      for reported in account.limits.windows {
        let member = poolMember(account, reported, now: now)
        let pooled = poolKey(account.driver, member.window)
        let key =
          byKey[pooled]?.contains { $0.account.key == account.key } == true
          ? "\(member.window.kind.rawValue):\(member.window.id)" : pooled
        if byKey[key] == nil { keys.append(key) }
        byKey[key, default: []].append(member)
      }
    }
    let windows = keys.map { key -> LimitPoolWindow in
      let members = byKey[key] ?? []
      let first = members[0].window
      let id = members[0].account.driver == "codex" ? key : first.id
      // One unknown plan makes the pool incomparable by plan, so every member then counts once.
      let capacities = members.map { planCapacity($0.account, first.kind) }
      let weights = capacities.allSatisfy { $0 != nil } ? capacities.map { $0 ?? 1 } : members.map { _ in 1.0 }
      let totalWeight = weights.reduce(0, +)
      let used = zip(members, weights).reduce(0) { $0 + $1.0.window.usedPercent * $1.1 } / totalWeight
      // Judge pace only for windows with reset clocks; others add spend without elapsed time.
      let timed = zip(members, weights).compactMap { member, weight in
        elapsedShare(member.window, now: now).map { (used: member.window.usedPercent, elapsed: $0, weight: weight) }
      }
      let timedWeight = timed.reduce(0) { $0 + $1.weight }
      let timedUsed = timed.reduce(0) { $0 + $1.used * $1.weight } / timedWeight
      let meanElapsed = timed.isEmpty ? nil : timed.reduce(0) { $0 + $1.elapsed * $1.weight } / timedWeight
      let resets = stableSorted(
        zip(members, weights).compactMap { member, weight in
          member.window.resetsAt.map {
            LimitPoolWindow.Reset(member: member, at: $0, restoresPercent: jsRound(member.refillPercent * weight / totalWeight))
          }
        }
      ) { $0.at < $1.at }
      let byAccount = Dictionary(members.map { ($0.account.key, $0) }, uniquingKeysWith: { first, _ in first })
      return LimitPoolWindow(
        id: id, kind: first.kind, label: first.label, members: members,
        columns: accounts.map { .init(account: $0, member: byAccount[$0.key]) },
        remainingPercent: jsRound(100 - used), usedPercent: jsRound(used),
        pace: meanElapsed.map { pace(used: timedUsed, elapsed: $0) }, resets: resets)
    }
    return stableSorted(windows) { $0.kind.order < $1.kind.order }
  }

  /// Cursor reports an overall window beside its two pools, and Antigravity one per model family:
  /// the rows the limits screen shows (RN `displayLimitWindows`).
  public static func displayWindows(_ pool: LimitPool) -> [LimitPoolWindow] {
    if pool.driver == "antigravity" {
      func family(_ id: String) -> String { id.replacing(/-(5h|weekly|quota)$/, with: "") }
      return stableSorted(pool.windows) { left, right in
        let (lg, rg) = (!left.id.hasPrefix("gemini-"), !right.id.hasPrefix("gemini-"))
        if lg != rg { return !lg }
        let (lf, rf) = (family(left.id), family(right.id))
        if lf != rf { return lf < rf }
        return left.kind.order < right.kind.order
      }
    }
    guard pool.driver == "cursor" else { return pool.windows }
    let hasAuto = pool.windows.contains { $0.id == "autoPercentUsed" }
    let hasApi = pool.windows.contains { $0.id == "apiPercentUsed" }
    let hideTotal = (hasAuto && hasApi) || hasDuplicateCursorTotal(pool)
    let rank = ["totalPercentUsed", "autoPercentUsed", "apiPercentUsed"]
    return stableSorted(pool.windows.filter { !hideTotal || $0.id != "totalPercentUsed" }) {
      (rank.firstIndex(of: $0.id) ?? rank.count) < (rank.firstIndex(of: $1.id) ?? rank.count)
    }
  }

  static func hasDuplicateCursorTotal(_ pool: LimitPool) -> Bool {
    guard pool.windows.count == 2, let total = pool.windows.first(where: { $0.id == "totalPercentUsed" }),
      let auto = pool.windows.first(where: { $0.id == "autoPercentUsed" }), total.members.count == auto.members.count
    else { return false }
    return total.members.allSatisfy { member in
      member.account.limits.windows.contains {
        $0.id == auto.id && $0.kind == auto.kind && $0.usedPercent == member.window.usedPercent
          && $0.resetsAt == member.window.resetsAt
      }
    }
  }

  /// Whether a Cursor window keeps its own label (RN `cursorUsageWindowDetails`): one overall
  /// window, or an overall that only repeats Cursor Models, reads as the plan itself.
  public static func cursorWindowIsUnlabeled(_ id: String, in pool: LimitPool) -> Bool {
    guard ["totalPercentUsed", "autoPercentUsed", "apiPercentUsed"].contains(id) else { return false }
    return (pool.windows.count == 1 && id == "totalPercentUsed") || hasDuplicateCursorTotal(pool)
  }

  // MARK: Helpers

  static func jsRound(_ value: Double) -> Int {
    guard value.isFinite else { return 0 }
    return Int((value + 0.5).rounded(.down))
  }

  static func nonEmpty(_ value: String?) -> String? {
    guard let value, !value.isEmpty else { return nil }
    return value
  }

  static func stableSorted<T>(_ items: [T], by less: (T, T) -> Bool) -> [T] {
    items.enumerated().sorted { a, b in
      if less(a.element, b.element) { return true }
      if less(b.element, a.element) { return false }
      return a.offset < b.offset
    }.map(\.element)
  }
}

extension EnvironmentRegistry {
  /// Connected computers' providers: what the usage sheet and Settings show (RN
  /// `connectedLimitPresentations`).
  public var connectedLimitSources: [LimitSource] {
    environments.filter { $0.isEnabled && $0.status.isConnected && $0.hasConfig }
      .map { LimitSource(environmentId: $0.id, label: $0.label, providers: $0.providers) }
  }

  /// Every computer with a config this launch, connected or not: the widget keeps showing the
  /// last limits while the app is offline, until they expire.
  public var widgetLimitSources: [LimitSource] {
    environments.filter { $0.isEnabled && $0.hasConfig }
      .map { LimitSource(environmentId: $0.id, label: $0.label, providers: $0.providers) }
  }
}
