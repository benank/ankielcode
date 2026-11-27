import Foundation

/// The active conversation's context window (port of `client-runtime/state/contextWindow.ts`):
/// the newest report among the active provider thread's turns, its own snapshot, or a completed
/// compaction that came after them.
public struct ContextWindowSnapshot: Sendable, Hashable {
  public var usedTokens: Int
  public var totalProcessedTokens: Int?
  public var maxTokens: Int?
  public var remainingTokens: Int?
  /// 0…100, nil without a known window size.
  public var usedPercentage: Double?
  public var inputTokens: Int?
  public var cachedInputTokens: Int?
  public var outputTokens: Int?
  public var reasoningOutputTokens: Int?
  public var compactsAutomatically: Bool?
  public var autoCompactThreshold: Int?
  public var updatedAt: Date
  /// The numbers are what a compaction left (`afterTokenCount`), not a provider report.
  public var fromCompaction = false
  /// A compaction is running right now.
  public var compacting = false

  public init(usedTokens: Int, maxTokens: Int?, updatedAt: Date) {
    self.usedTokens = usedTokens
    self.maxTokens = maxTokens
    self.updatedAt = updatedAt
    let max = maxTokens.flatMap { $0 > 0 ? $0 : nil }
    remainingTokens = max.map { Swift.max(0, $0 - usedTokens) }
    usedPercentage = max.map { Swift.min(100, Double(usedTokens) / Double($0) * 100) }
  }

  public enum Level: Sendable, Hashable {
    case normal
    /// 90% or more (RN's danger threshold).
    case high
    /// More tokens than the window holds (a report before the provider compacts).
    case over
  }

  public var level: Level {
    guard let maxTokens, maxTokens > 0 else { return .normal }
    if usedTokens > maxTokens { return .over }
    return (usedPercentage ?? 0) >= 90 ? .high : .normal
  }

  /// Rounded, clamped percent for meters; nil without a window size.
  public var shownPercent: Int? {
    usedPercentage.map { Int(Swift.max(0, Swift.min(100, $0)).rounded()) }
  }
}

public enum ContextWindow {
  /// `deriveThreadContextWindow` for a held projection.
  public static func derive(_ projection: ThreadProjection) -> ContextWindowSnapshot? {
    let providerThread = projection.providerThreads.first { $0.id == projection.thread.activeProviderThreadId }
    var snapshot = latest(
      projection.visibleTurnItems.map(\.item),
      liveUsage: latestTurnUsage(projection.providerTurns, providerThread: providerThread),
      providerThread: providerThread)
    let compacting = projection.visibleTurnItems.last { row in
      if case .compaction = row.item.body { return !isRetired(row.item, providerThread) }
      return false
    }.map { $0.item.status == .running || $0.item.status == .pending } ?? false
    snapshot?.compacting = compacting
    return snapshot
  }

  /// Newest report by timestamp among the active provider thread's turns; without an active
  /// provider thread every turn is a candidate. Ties go to the later entry (live upserts append).
  public static func latestTurnUsage(_ turns: [ProviderTurn], providerThread: ProviderThread?) -> ProviderTurn.TokenUsage? {
    var latest: ProviderTurn.TokenUsage?
    for turn in turns {
      guard let usage = turn.tokenUsage else { continue }
      if let providerThread, turn.providerThreadId != providerThread.id { continue }
      if let current = latest, (usage.updatedAt?.date ?? .distantPast) < (current.updatedAt?.date ?? .distantPast) { continue }
      latest = usage
    }
    return latest
  }

  static func isRetired(_ item: TurnItem, _ providerThread: ProviderThread?) -> Bool {
    guard let providerThread, let id = item.providerThreadId else { return false }
    return id != providerThread.id
  }

  static func compactionSnapshot(_ item: TurnItem, maxTokens: Int?, updatedAt: Date) -> ContextWindowSnapshot? {
    guard case .compaction(let compaction) = item.body, let used = compaction.afterTokenCount, used >= 0 else { return nil }
    var snapshot = ContextWindowSnapshot(usedTokens: used, maxTokens: maxTokens, updatedAt: updatedAt)
    snapshot.totalProcessedTokens = compaction.beforeTokenCount
    snapshot.compactsAutomatically = true
    snapshot.fromCompaction = true
    return snapshot
  }

  /// `deriveLatestContextWindowSnapshot`.
  static func latest(_ items: [TurnItem], liveUsage: ProviderTurn.TokenUsage?, providerThread: ProviderThread?) -> ContextWindowSnapshot? {
    let completedCompaction = items.last { item in
      if case .compaction = item.body { return item.status == .completed && !isRetired(item, providerThread) }
      return false
    }
    let usageUpdatedAt = liveUsage?.updatedAt?.date ?? (providerThread?.contextUsage != nil ? providerThread?.updatedAt?.date : nil)
    if let completedCompaction, let compactedAt = (completedCompaction.completedAt ?? completedCompaction.updatedAt).date {
      // Usage reported before the compaction describes the context it just discarded; usage at
      // the same instant is the provider's own post-compaction report.
      if usageUpdatedAt.map({ compactedAt > $0 }) ?? true,
        let snapshot = compactionSnapshot(
          completedCompaction, maxTokens: liveUsage?.maxTokens ?? providerThread?.contextUsage?.maxTokens, updatedAt: compactedAt)
      {
        return snapshot
      }
    }
    if let liveUsage {
      var snapshot = ContextWindowSnapshot(
        usedTokens: max(0, liveUsage.usedTokens), maxTokens: liveUsage.maxTokens,
        updatedAt: liveUsage.updatedAt?.date ?? .distantPast)
      snapshot.inputTokens = liveUsage.inputTokens
      snapshot.cachedInputTokens = liveUsage.cachedInputTokens
      snapshot.outputTokens = liveUsage.outputTokens
      snapshot.reasoningOutputTokens = liveUsage.reasoningOutputTokens
      snapshot.compactsAutomatically = true
      snapshot.autoCompactThreshold = liveUsage.autoCompactThreshold
      return snapshot
    }
    if let usage = providerThread?.contextUsage, let updatedAt = providerThread?.updatedAt?.date {
      var snapshot = ContextWindowSnapshot(usedTokens: usage.usedTokens, maxTokens: usage.maxTokens, updatedAt: updatedAt)
      snapshot.totalProcessedTokens = usage.totalProcessedTokens
      snapshot.inputTokens = usage.inputTokens
      snapshot.cachedInputTokens = usage.cachedInputTokens
      snapshot.outputTokens = usage.outputTokens
      snapshot.reasoningOutputTokens = usage.reasoningOutputTokens
      snapshot.compactsAutomatically = usage.compactsAutomatically
      snapshot.autoCompactThreshold = usage.autoCompactThreshold
      return snapshot
    }
    for item in items.reversed() {
      guard case .compaction = item.body, !isRetired(item, providerThread) else { continue }
      if let at = (item.startedAt ?? item.updatedAt).date, let snapshot = compactionSnapshot(item, maxTokens: nil, updatedAt: at) {
        return snapshot
      }
    }
    return nil
  }

  /// RN `formatContextWindowTokens`: 950, 1.2k, 45k, 1.2m.
  public static func formatTokens(_ value: Int?) -> String {
    guard let value else { return "0" }
    let number = Double(value)
    // JS `toFixed(1)` rounds halves up; `%.1f` would round them to even.
    func trimmed(_ value: Double) -> String {
      let tenths = Int((value * 10).rounded(.toNearestOrAwayFromZero))
      return tenths % 10 == 0 ? "\(tenths / 10)" : "\(tenths / 10).\(tenths % 10)"
    }
    if number < 1_000 { return "\(value)" }
    if number < 10_000 { return "\(trimmed(number / 1_000))k" }
    if number < 999_500 { return "\(Int((number / 1_000).rounded()))k" }
    return "\(trimmed(number / 1_000_000))m"
  }
}
