import AnkielKit
import Foundation

/// `--usage-summary [days]`: read-only. The computer's usage for the past days (default 30), first
/// the provisional answer from its last scan, then a fresh scan, folded like the app's Cost and
/// Tokens views.
func probeUsageSummary(_ session: EnvironmentSession) async throws {
  let days = argument("--usage-summary").flatMap(Int.init) ?? 30
  for fresh in [false, true] {
    let started = Date.now
    let query = UsageSummaryRequest.window(days: days, fresh: fresh)
    let summary = try await session.rpc.call(UsageSummaryRequest.rpcTag, payload: query, as: UsageSummary.self)
    let report = UsageReport(summary)
    print("\(fresh ? "fresh" : "provisional"): \(summary.sinceDay)…\(summary.untilDay) in \(Int(Date.now.timeIntervalSince(started) * 1000)) ms, pricing \(summary.pricingStatus), refreshing \(report.refreshing)")
    print("  buckets \(summary.buckets.count) sources \(summary.sources.map { "\($0.provider):\($0.status)" }) sessions \(report.sessions)")
    print("  cost $\(String(format: "%.2f", report.costUsd)) savings $\(String(format: "%.2f", report.cacheSavingsUsd)) processed \(report.totals.processed) unpriced \(Int(report.unpricedShare * 100))% periods \(report.activePeriods)")
    for share in report.providers { print("  provider \(share.id): $\(String(format: "%.2f", share.costUsd)) \(share.tokens) tokens") }
    for share in report.models.prefix(5) { print("  model \(share.id): $\(String(format: "%.2f", share.costUsd)) \(share.tokens) tokens") }
  }
}
