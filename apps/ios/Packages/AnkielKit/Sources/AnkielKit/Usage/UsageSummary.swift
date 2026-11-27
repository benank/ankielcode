import Foundation

// Usage cost and tokens (`packages/contracts/src/usage.ts`, `server.getUsageSummary`, needs
// `diagnostics:read`): the computer scans provider transcripts and answers buckets per day (or
// hour), provider and model. The views fold them into totals, a series and rankings.

/// `UsageTokenTotals`. Input is uncached + cache reads + cache writes; reasoning is inside output.
public struct UsageTokenTotals: Sendable, Hashable, Decodable {
  public var uncachedInputTokens = 0
  public var cachedInputTokens = 0
  public var cacheCreationTokens = 0
  public var outputTokens = 0
  public var reasoningTokens = 0

  public init() {}

  enum CodingKeys: String, CodingKey { case uncachedInputTokens, cachedInputTokens, cacheCreationTokens, outputTokens, reasoningTokens }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    uncachedInputTokens = c.loose(Int.self, .uncachedInputTokens) ?? 0
    cachedInputTokens = c.loose(Int.self, .cachedInputTokens) ?? 0
    cacheCreationTokens = c.loose(Int.self, .cacheCreationTokens) ?? 0
    outputTokens = c.loose(Int.self, .outputTokens) ?? 0
    reasoningTokens = c.loose(Int.self, .reasoningTokens) ?? 0
  }

  /// RN "Processed tokens".
  public var processed: Int { uncachedInputTokens + cachedInputTokens + cacheCreationTokens + outputTokens }

  static func + (a: Self, b: Self) -> Self {
    var sum = a
    sum.uncachedInputTokens += b.uncachedInputTokens
    sum.cachedInputTokens += b.cachedInputTokens
    sum.cacheCreationTokens += b.cacheCreationTokens
    sum.outputTokens += b.outputTokens
    sum.reasoningTokens += b.reasoningTokens
    return sum
  }
}

/// `UsageBucket`.
public struct UsageBucket: Sendable, Hashable, Decodable {
  public var day: String
  public var hourStart: String?
  public var provider: String
  public var model: String
  public var totals: UsageTokenTotals
  public var costUsd: Double
  public var cacheSavingsUsd: Double
  public var records: Int
  public var unpricedRecords: Int
  public var sessions: Int

  enum CodingKeys: String, CodingKey {
    case day, hourStart, provider, model, totals, costUsd, cacheSavingsUsd, records, unpricedRecords, sessions
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    day = try c.decode(String.self, forKey: .day)
    hourStart = c.loose(String.self, .hourStart)
    provider = try c.decode(String.self, forKey: .provider)
    model = try c.decode(String.self, forKey: .model)
    totals = c.loose(UsageTokenTotals.self, .totals) ?? UsageTokenTotals()
    costUsd = c.loose(Double.self, .costUsd) ?? 0
    cacheSavingsUsd = c.loose(Double.self, .cacheSavingsUsd) ?? 0
    records = c.loose(Int.self, .records) ?? 0
    unpricedRecords = c.loose(Int.self, .unpricedRecords) ?? 0
    sessions = c.loose(Int.self, .sessions) ?? 0
  }
}

/// `UsageSource`: one transcript folder the computer scanned.
public struct UsageSource: Sendable, Hashable, Decodable {
  public var provider: String
  public var status: String
  public var distinctSessions: Int
  public var message: String?
  public var refreshing: Bool

  enum CodingKeys: String, CodingKey { case fingerprint, status, distinctSessions, message, refreshing }
  enum FingerprintKeys: String, CodingKey { case provider }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    provider = (try? c.nestedContainer(keyedBy: FingerprintKeys.self, forKey: .fingerprint).decode(String.self, forKey: .provider)) ?? ""
    status = c.loose(String.self, .status) ?? "ok"
    distinctSessions = c.loose(Int.self, .distinctSessions) ?? 0
    message = c.loose(String.self, .message)
    refreshing = c.loose(Bool.self, .refreshing) ?? false
  }
}

/// `UsageSummary`.
public struct UsageSummary: Sendable, Hashable, Decodable {
  public var readAt: String
  public var sinceDay: String
  public var untilDay: String
  public var buckets: [UsageBucket]
  public var sources: [UsageSource]
  public var pricingStatus: String

  enum CodingKeys: String, CodingKey { case readAt, sinceDay, untilDay, buckets, sources, pricing }
  enum PricingKeys: String, CodingKey { case status }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    readAt = c.loose(String.self, .readAt) ?? ""
    sinceDay = try c.decode(String.self, forKey: .sinceDay)
    untilDay = try c.decode(String.self, forKey: .untilDay)
    buckets = c.loose(LossyArray<UsageBucket>.self, .buckets)?.elements ?? []
    sources = c.loose(LossyArray<UsageSource>.self, .sources)?.elements ?? []
    pricingStatus = (try? c.nestedContainer(keyedBy: PricingKeys.self, forKey: .pricing).decode(String.self, forKey: .status)) ?? "unavailable"
  }
}

/// `UsageSummaryInput`.
public struct UsageSummaryRequest: Sendable, Hashable, Encodable {
  public static let rpcTag = "server.getUsageSummary"
  public var sinceDay: String
  public var untilDay: String
  public var timeZone: String
  public var resolution: String?
  public var sinceTime: String?
  public var untilTime: String?
  /// An immediate answer from the last scan; its sources say `refreshing` while a new scan runs.
  public var provisional: Bool?
  public var awaitRefresh: Bool?

  /// The window RN offers: the past `days` days through today in `timeZone`, or for one day the
  /// past 24 hours by the hour.
  public static func window(days: Int, now: Date = .now, timeZone: TimeZone = .current, fresh: Bool = false) -> Self {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = timeZone
    func day(_ date: Date) -> String {
      let parts = calendar.dateComponents([.year, .month, .day], from: date)
      return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }
    if days <= 1 {
      let since = now.addingTimeInterval(-24 * 3600)
      return Self(
        sinceDay: day(since), untilDay: day(now), timeZone: timeZone.identifier, resolution: "hour",
        sinceTime: since.formatted(.iso8601), untilTime: now.formatted(.iso8601), provisional: fresh ? nil : true,
        awaitRefresh: fresh ? true : nil)
    }
    let since = calendar.date(byAdding: .day, value: -(days - 1), to: now) ?? now
    return Self(
      sinceDay: day(since), untilDay: day(now), timeZone: timeZone.identifier, provisional: fresh ? nil : true,
      awaitRefresh: fresh ? true : nil)
  }
}

/// A summary folded for the Cost and Tokens views (RN `mergeUsage`, one computer).
public struct UsageReport: Sendable, Hashable {
  public struct Point: Sendable, Hashable, Identifiable {
    /// A day (`2026-11-27`) or an hour start (ISO).
    public var key: String
    public var provider: String
    public var costUsd: Double
    public var tokens: Int
    public var id: String { "\(key)|\(provider)" }
  }

  public struct Share: Sendable, Hashable, Identifiable {
    public var id: String
    public var provider: String
    public var costUsd: Double
    public var tokens: Int
    /// Records with no known price (their cost is not in `costUsd`).
    public var unpricedRecords: Int
    public var records: Int
  }

  public var costUsd = 0.0
  public var cacheSavingsUsd = 0.0
  public var totals = UsageTokenTotals()
  public var records = 0
  public var unpricedRecords = 0
  public var sessions = 0
  /// One point per bucket key and provider, in time order.
  public var series: [Point] = []
  public var providers: [Share] = []
  public var models: [Share] = []
  /// Distinct day or hour keys that saw any tokens.
  public var activePeriods = 0
  public var refreshing = false
  public var sourceProblems: [String] = []

  public init() {}

  public init(_ summary: UsageSummary) {
    var points: [String: Point] = [:]
    var providers: [String: Share] = [:]
    var models: [String: Share] = [:]
    for bucket in summary.buckets {
      costUsd += bucket.costUsd
      cacheSavingsUsd += bucket.cacheSavingsUsd
      totals = totals + bucket.totals
      records += bucket.records
      unpricedRecords += bucket.unpricedRecords
      let key = bucket.hourStart ?? bucket.day
      let pointId = "\(key)|\(bucket.provider)"
      var point = points[pointId] ?? Point(key: key, provider: bucket.provider, costUsd: 0, tokens: 0)
      point.costUsd += bucket.costUsd
      point.tokens += bucket.totals.processed
      points[pointId] = point
      func add(_ id: String, into shares: inout [String: Share]) {
        var share = shares[id] ?? Share(id: id, provider: bucket.provider, costUsd: 0, tokens: 0, unpricedRecords: 0, records: 0)
        share.costUsd += bucket.costUsd
        share.tokens += bucket.totals.processed
        share.unpricedRecords += bucket.unpricedRecords
        share.records += bucket.records
        shares[id] = share
      }
      add(bucket.provider, into: &providers)
      add("\(bucket.provider)/\(bucket.model)", into: &models)
    }
    series = points.values.sorted { ($0.key, $0.provider) < ($1.key, $1.provider) }
    activePeriods = Set(series.filter { $0.tokens > 0 }.map(\.key)).count
    func ranked(_ shares: [String: Share]) -> [Share] {
      shares.values.sorted { ($0.costUsd, $0.tokens) > ($1.costUsd, $1.tokens) }
    }
    self.providers = ranked(providers)
    self.models = ranked(models)
    sessions = summary.sources.reduce(0) { $0 + $1.distinctSessions }
    refreshing = summary.sources.contains(where: \.refreshing)
    sourceProblems = summary.sources.filter { $0.status == "failed" || $0.status == "partial" }.compactMap(\.message)
  }

  public var isEmpty: Bool { records == 0 }
  /// Share of usage records with no known rate.
  public var unpricedShare: Double { records == 0 ? 0 : Double(unpricedRecords) / Double(records) }
  /// Cache reads among all input.
  public var cachedShare: Double {
    let input = totals.uncachedInputTokens + totals.cachedInputTokens + totals.cacheCreationTokens
    return input == 0 ? 0 : Double(totals.cachedInputTokens) / Double(input)
  }

  /// RN `providerLabel`.
  public static func providerLabel(_ provider: String) -> String {
    [
      "claude": "Claude", "codex": "Codex", "grok": "Grok", "cursor": "Cursor", "opencode": "OpenCode",
      "antigravity": "Antigravity", "pi": "Pi", "muse": "Muse",
    ][provider] ?? provider
  }
}

extension EnvironmentRegistry {
  /// `server.getUsageSummary` on one computer.
  public func usageSummary(_ query: UsageSummaryRequest, in environmentId: String) async throws(EnvironmentRequestError) -> UsageSummary {
    try await request(environmentId) { session in
      try await session.call(UsageSummaryRequest.rpcTag, payload: query, as: UsageSummary.self)
    }
  }
}
