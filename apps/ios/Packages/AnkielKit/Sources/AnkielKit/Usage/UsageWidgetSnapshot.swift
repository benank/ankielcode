import Foundation

/// What the app hands the subscription usage widget (port of RN `subscriptionUsageSnapshot.ts`):
/// Codex and Claude, pooled across accounts and computers. The widget never connects; it reads
/// this file and greys a provider out once its data passes `expiresAt`. No emails, ids or copy:
/// the widget localizes every word itself.
public struct UsageWidgetSnapshot: Sendable, Hashable, Codable {
  /// The oldest read among the providers shown; nil when nothing reported limits.
  public var checkedAt: Date?
  public var providers: [Provider]

  public struct Provider: Sendable, Hashable, Codable, Identifiable {
    /// `codex` or `claudeAgent`.
    public var driver: String
    public var name: String
    public var detail: Detail
    public var windows: [Window]
    /// When this provider's data goes stale (15 minutes after its oldest read, or its first
    /// upcoming reset, whichever is sooner); nil when it has none.
    public var expiresAt: Date?
    /// Every pooled window, including those not in `windows` (for "N more in the app").
    public var totalWindows: Int
    public var id: String { driver }

    public init(driver: String, name: String, detail: Detail, windows: [Window] = [], expiresAt: Date? = nil, totalWindows: Int = 0) {
      self.driver = driver
      self.name = name
      self.detail = detail
      self.windows = windows
      self.expiresAt = expiresAt
      self.totalWindows = totalWindows
    }
  }

  public enum Detail: Sendable, Hashable, Codable {
    case noLimits
    case refresh
    case subscriptionRemaining
    case pooled(accounts: Int)
  }

  public struct Window: Sendable, Hashable, Codable, Identifiable {
    public var kind: UsageWindow.Kind
    public var label: String
    public var remaining: Int
    /// The soonest refill in the pool, and whether it is still ahead of the read.
    public var resetAt: Date?
    public var resetUpcoming: Bool
    public var id: String { "\(kind.rawValue):\(label)" }

    public init(kind: UsageWindow.Kind, label: String, remaining: Int, resetAt: Date? = nil, resetUpcoming: Bool = false) {
      self.kind = kind
      self.label = label
      self.remaining = remaining
      self.resetAt = resetAt
      self.resetUpcoming = resetUpcoming
    }
  }

  public init(checkedAt: Date?, providers: [Provider]) {
    self.checkedAt = checkedAt
    self.providers = providers
  }

  /// Snapshots expire after 15 minutes: refreshing needs the app's authenticated connection.
  public static let maxAge: TimeInterval = 15 * 60
  /// How often the app re-reads limits for the widget while it runs.
  public static let refreshInterval: TimeInterval = 5 * 60
  public static let widgetDrivers = ["codex", "claudeAgent"]

  /// The snapshot for these computers. It never reads the clock (RN builds with `now = 0`), so it
  /// changes only when the limits do and the app reloads the widget only then.
  public static func build(_ sources: [LimitSource], maxWindowsPerProvider: Int = 6) -> UsageWidgetSnapshot {
    // Servers report default-enabled drivers even when their CLI is missing.
    let configured = Set(
      sources.flatMap(\.providers).filter {
        $0.enabled && $0.installed && $0.usageLimits?.unavailable?.reason != "unsupported"
      }.map(\.driver))
    let accounts = UsageLimits.accounts(sources)
    let pools = UsageLimits.pools(accounts, now: .distantPast)
    let checked = accounts.filter { widgetDrivers.contains($0.driver) }.map(\.limits.checkedAt)

    let providers = widgetDrivers.filter { driver in configured.contains(driver) || accounts.contains { $0.driver == driver } }
      .map { driver -> Provider in
        let name = driver == "codex" ? "Codex" : "Claude"
        guard let pool = pools.first(where: { $0.driver == driver }) else {
          return Provider(driver: driver, name: name, detail: .noLimits)
        }
        let checkedAt = pool.accounts.map(\.limits.checkedAt).min() ?? .distantPast
        let resets = pool.windows.flatMap { $0.resets.filter(isUpcoming).map(\.at) }
        let expiresAt = ([checkedAt.addingTimeInterval(maxAge)] + resets).min()!
        let sorted = UsageLimits.stableSorted(pool.windows) { $0.remainingPercent < $1.remainingPercent }
        var picked: [LimitPoolWindow] = []
        for window in [sorted.first { $0.kind == .session }, sorted.first { $0.kind == .weekly }].compactMap({ $0 }) + sorted
        where !picked.contains(where: { $0.id == window.id && $0.kind == window.kind }) {
          picked.append(window)
        }
        let shown = UsageLimits.stableSorted(Array(picked.prefix(maxWindowsPerProvider))) { $0.remainingPercent < $1.remainingPercent }
        return Provider(
          driver: driver, name: name,
          detail: pool.accounts.count > 1 ? .pooled(accounts: pool.accounts.count) : .subscriptionRemaining,
          windows: shown.map { window in
            Window(
              kind: window.kind, label: window.label, remaining: window.remainingPercent, resetAt: window.resets.first?.at,
              resetUpcoming: window.resets.first.map(isUpcoming) ?? false)
          },
          expiresAt: expiresAt, totalWindows: pool.windows.count)
      }
    return UsageWidgetSnapshot(checkedAt: checked.min(), providers: providers)
  }

  /// A reset at or before its account's read already happened, so it cannot expire the snapshot.
  static func isUpcoming(_ reset: LimitPoolWindow.Reset) -> Bool {
    reset.at > reset.member.account.limits.checkedAt
  }

  /// This snapshot as the widget should show it at `date`: providers past `expiresAt` lose their
  /// windows and ask to open the app.
  public func shown(at date: Date) -> UsageWidgetSnapshot {
    var copy = self
    copy.providers = providers.map { provider in
      guard !provider.windows.isEmpty, provider.expiresAt.map({ $0 <= date }) ?? true else { return provider }
      return Provider(driver: provider.driver, name: provider.name, detail: .refresh, expiresAt: provider.expiresAt)
    }
    return copy
  }

  /// Timeline dates: now, then each provider's expiry still ahead (RN `subscriptionUsageTimeline`).
  public func timeline(from now: Date) -> [(date: Date, snapshot: UsageWidgetSnapshot)] {
    let deadlines = Set(providers.compactMap(\.expiresAt)).filter { $0 > now }.sorted()
    return ([now] + deadlines).map { ($0, shown(at: $0)) }
  }
}

/// Which windows a widget family shows (RN `SubscriptionUsage.tsx`), kept here so tests cover it.
public enum UsageWidgetLayout {
  public enum Family: Sendable, Hashable { case small, medium, large, accessoryRectangular, accessoryCircular }
  /// The widget's per-provider setting: both windows, or only one kind.
  public enum Period: String, Sendable, Hashable, CaseIterable { case auto, session, weekly }

  public struct Column: Sendable, Hashable, Identifiable {
    public var provider: UsageWidgetSnapshot.Provider
    public var windows: [UsageWidgetSnapshot.Window]
    /// The tightest window shown (Lock Screen and the circular gauge).
    public var tightest: UsageWidgetSnapshot.Window?
    public var detail: Detail
    public var hiddenCount: Int
    public var id: String { provider.id }
  }

  public enum Detail: Sendable, Hashable {
    case provider(UsageWidgetSnapshot.Detail)
    case noSessionLimit
    case noWeeklyLimit
  }

  public static func limit(_ family: Family) -> Int { family == .large ? 4 : 2 }

  public static func columns(
    _ snapshot: UsageWidgetSnapshot, family: Family, periods: [String: Period] = [:], simplified: Bool = false
  ) -> [Column] {
    let limit = limit(family)
    let accessory = family == .accessoryRectangular || family == .accessoryCircular
    return snapshot.providers.map { provider in
      let period = periods[provider.driver] ?? .auto
      let windows = provider.windows.filter { period == .auto || $0.kind.rawValue == period.rawValue }
      let tightest = windows.min { $0.remaining < $1.remaining }
      let compact = [windows.first { $0.kind == .session }, windows.first { $0.kind == .weekly }].compactMap { $0 }
      let shown: [UsageWidgetSnapshot.Window]
      if accessory || simplified {
        shown = tightest.map { [$0] } ?? []
      } else if family == .small, !compact.isEmpty {
        shown = compact
      } else if period == .auto, !compact.isEmpty {
        shown = Array((compact + windows.filter { window in !compact.contains(window) }).prefix(limit))
      } else {
        shown = Array(windows.prefix(limit))
      }
      let detail: Detail =
        period != .auto && windows.isEmpty && !provider.windows.isEmpty
        ? (period == .session ? .noSessionLimit : .noWeeklyLimit) : .provider(provider.detail)
      let hidden = (period == .auto ? provider.totalWindows : windows.count) - shown.count
      return Column(provider: provider, windows: shown, tightest: tightest, detail: detail, hiddenCount: max(0, hidden))
    }
  }
}

/// The snapshot file in the App Group container the app and the widget share.
public struct UsageWidgetStore: Sendable {
  public static let appGroup = "group.com.ankiel.ankielcode.native"
  public static let widgetKind = "SubscriptionUsage"
  /// The app's link to its usage page (Settings → Usage).
  public static let deepLink = URL(string: "ankielcode-native://settings/usage")!

  public let url: URL?

  public init(url: URL?) { self.url = url }

  /// The shared container's file; nil when the app group is not provisioned (a build without it).
  public static var shared: UsageWidgetStore {
    UsageWidgetStore(
      url: FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)?
        .appending(path: "subscription-usage.json"))
  }

  static let encoder: JSONEncoder = {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    encoder.dateEncodingStrategy = .secondsSince1970
    return encoder
  }()

  public func read() -> UsageWidgetSnapshot? {
    guard let url, let data = try? Data(contentsOf: url) else { return nil }
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .secondsSince1970
    return try? decoder.decode(UsageWidgetSnapshot.self, from: data)
  }

  /// Writes the snapshot when it differs from the file; returns whether it did.
  @discardableResult
  public func write(_ snapshot: UsageWidgetSnapshot) -> Bool {
    guard let url, let data = try? Self.encoder.encode(snapshot) else { return false }
    if (try? Data(contentsOf: url)) == data { return false }
    do {
      try data.write(to: url, options: .atomic)
      return true
    } catch {
      return false
    }
  }
}

extension UsageWidgetSnapshot {
  /// Gallery and placeholder data (shown redacted by WidgetKit); invented numbers.
  public static func placeholder(now: Date) -> UsageWidgetSnapshot {
    UsageWidgetSnapshot(
      checkedAt: now,
      providers: [
        .init(
          driver: "codex", name: "Codex", detail: .subscriptionRemaining,
          windows: [
            .init(kind: .session, label: "Session", remaining: 82, resetAt: now.addingTimeInterval(3 * 3600), resetUpcoming: true),
            .init(kind: .weekly, label: "Weekly", remaining: 57, resetAt: now.addingTimeInterval(4 * 86_400), resetUpcoming: true),
          ], expiresAt: now.addingTimeInterval(maxAge), totalWindows: 2),
        .init(
          driver: "claudeAgent", name: "Claude", detail: .subscriptionRemaining,
          windows: [
            .init(kind: .session, label: "Session", remaining: 65, resetAt: now.addingTimeInterval(2 * 3600), resetUpcoming: true),
            .init(kind: .weekly, label: "Weekly", remaining: 48, resetAt: now.addingTimeInterval(3 * 86_400), resetUpcoming: true),
          ], expiresAt: now.addingTimeInterval(maxAge), totalWindows: 2),
      ])
  }
}
