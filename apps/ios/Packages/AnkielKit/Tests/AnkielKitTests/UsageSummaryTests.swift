import Foundation
import Testing

@testable import AnkielKit

@Suite("Usage summary")
struct UsageSummaryTests {
  static let now = Date(timeIntervalSince1970: 1_795_780_800)  // 2026-11-27T09:20:00Z
  static let utc = TimeZone(identifier: "UTC")!

  nonisolated static let samples: [(name: String, value: UsageSummaryRequest)] = [
    ("usage-summary-30d", .window(days: 30, now: now, timeZone: utc)),
    ("usage-summary-24h-fresh", .window(days: 1, now: now, timeZone: utc, fresh: true)),
  ]

  @Test("windows encode exactly as their checked-in fixtures", arguments: samples.map(\.name))
  func matchesFixture(_ name: String) throws {
    let sample = try #require(Self.samples.first { $0.name == name })
    let encoded = try JSONEncoder.wire.encode(sample.value)
    let url = CommandEncodingTests.directory.appending(path: "\(name).json")
    if ProcessInfo.processInfo.environment["ANKIEL_WRITE_COMMAND_FIXTURES"] == "1" {
      let pretty = JSONEncoder()
      pretty.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
      let value = try JSONDecoder().decode(JSONValue.self, from: encoded)
      try pretty.encode(["schema": "usageSummary", "value": value] as JSONValue).write(to: url)
    }
    let fixture = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url))
    #expect(try JSONDecoder().decode(JSONValue.self, from: encoded) == fixture["value"])
  }

  @Test("a 30-day window ends today and starts 29 days back; 24 hours is hourly")
  func windows() {
    let month = UsageSummaryRequest.window(days: 30, now: Self.now, timeZone: Self.utc)
    #expect(month.sinceDay == "2026-10-29" && month.untilDay == "2026-11-27" && month.resolution == nil)
    let day = UsageSummaryRequest.window(days: 1, now: Self.now, timeZone: Self.utc)
    #expect(day.resolution == "hour" && day.sinceDay == "2026-11-26" && day.sinceTime != nil)
  }

  @Test("buckets fold into totals, a series by provider and rankings; bad rows are skipped")
  func report() throws {
    let json = """
      {"contractVersion":6,"readAt":"2026-11-27T09:20:00.000Z","timeZone":"UTC","sinceDay":"2026-11-26","untilDay":"2026-11-27",
       "buckets":[
        {"day":"2026-11-26","provider":"claude","model":"claude-opus-5-5","totals":{"uncachedInputTokens":100,"cachedInputTokens":900,"cacheCreationTokens":50,"outputTokens":200,"reasoningTokens":40},"costUsd":2.5,"cacheSavingsUsd":4,"costSource":"modelPriced","records":10,"unpricedRecords":0,"sessions":2},
        {"day":"2026-11-27","provider":"claude","model":"claude-opus-5-5","totals":{"uncachedInputTokens":10,"cachedInputTokens":0,"cacheCreationTokens":0,"outputTokens":20,"reasoningTokens":0},"costUsd":0.5,"cacheSavingsUsd":0,"costSource":"modelPriced","records":2,"unpricedRecords":0,"sessions":1},
        {"day":"2026-11-27","provider":"codex","model":"gpt-x","totals":{"uncachedInputTokens":5,"cachedInputTokens":0,"cacheCreationTokens":0,"outputTokens":5,"reasoningTokens":0},"costUsd":0,"cacheSavingsUsd":0,"costSource":"unpriced","records":4,"unpricedRecords":4,"sessions":1},
        {"day":3}
       ],
       "sources":[{"fingerprint":{"hostId":"h","provider":"claude","resolvedHomePath":"~","volumeId":"1"},"status":"ok","scannedFiles":3,"skippedFiles":0,"malformedRecords":0,"distinctSessions":3,"message":null,"refreshing":true}],
       "pricing":{"status":"fresh","source":"x","fetchedAt":null,"knownModels":9},"scanDurationMs":12}
      """
    let report = UsageReport(try decode(UsageSummary.self, json: json))
    #expect(report.costUsd == 3)
    #expect(report.totals.processed == 1250 + 30 + 10)
    #expect(report.series.map(\.id) == ["2026-11-26|claude", "2026-11-27|claude", "2026-11-27|codex"])
    #expect(report.providers.map(\.id) == ["claude", "codex"])
    #expect(report.models.first?.id == "claude/claude-opus-5-5")
    #expect(report.unpricedShare == 4.0 / 16.0)
    #expect(report.activePeriods == 2)
    #expect(report.sessions == 3 && report.refreshing)
  }
}
