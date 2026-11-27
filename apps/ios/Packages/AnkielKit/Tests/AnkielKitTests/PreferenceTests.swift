import Foundation
import Testing

@testable import AnkielKit

/// Chat and thread preferences added after the first settings phase.
@Suite("Preferences")
struct PreferenceTests {
  nonisolated static let samples: [(name: String, value: UpdateSettingsRequest)] = [
    ("settings-streaming-turn", UpdateSettingsRequest(patch: .responseStreaming(.turn))),
    ("settings-auto-settle-match", UpdateSettingsRequest(patch: .autoSettle(matching: Self.reference))),
  ]

  nonisolated static var reference: ServerSettings {
    var settings = ServerSettings()
    settings.autoSettleAfterDays = 21
    settings.autoSettleOnMerge = false
    return settings
  }

  @Test("settings patches encode exactly as their checked-in fixtures", arguments: samples.map(\.name))
  func matchesFixture(_ name: String) throws {
    let sample = try #require(Self.samples.first { $0.name == name })
    let encoded = try JSONEncoder.wire.encode(sample.value)
    let url = CommandEncodingTests.directory.appending(path: "\(name).json")
    if ProcessInfo.processInfo.environment["ANKIEL_WRITE_COMMAND_FIXTURES"] == "1" {
      let pretty = JSONEncoder()
      pretty.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
      let value = try JSONDecoder().decode(JSONValue.self, from: encoded)
      try pretty.encode(["schema": "updateSettings", "value": value] as JSONValue).write(to: url)
    }
    let fixture = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url))
    #expect(try JSONDecoder().decode(JSONValue.self, from: encoded) == fixture["value"])
  }

  @Test("response streaming decodes with the server default and applies optimistically")
  func streaming() throws {
    #expect(try decode(ServerSettings.self, json: "{}").responseStreaming == .paragraph)
    #expect(try decode(ServerSettings.self, json: #"{"responseStreamingMode":"turn"}"#).responseStreaming == .turn)
    #expect(try decode(ServerSettings.self, json: #"{"responseStreamingMode":"word"}"#).responseStreaming == .paragraph)
    #expect(ServerSettings().applying(.responseStreaming(.turn)).responseStreaming == .turn)
    let matched = ServerSettings().applying(.autoSettle(matching: Self.reference))
    #expect(matched.autoSettleAfterDays == 21 && !matched.autoSettleOnMerge)
  }

  @Test("new device preferences default on and survive older saved values")
  func clientDefaults() throws {
    let old = try decode(ClientPreferenceValues.self, json: #"{"themeMode":"dark"}"#)
    #expect(old.useLastProjectForNewThreads && old.streamHapticsEnabled)
    let off = try decode(ClientPreferenceValues.self, json: #"{"useLastProjectForNewThreads":false,"streamHapticsEnabled":false}"#)
    #expect(!off.useLastProjectForNewThreads && !off.streamHapticsEnabled)
  }

  @Test("a new stream ticks at once; growth ticks at most every 320 ms; a finished reply never")
  func streamTicks() {
    let start = Date(timeIntervalSince1970: 1_000)
    let first = StreamHaptics.Mark(id: "m1", length: 10)
    #expect(StreamHaptics.shouldTick(previous: nil, latest: first, lastTick: .distantPast, now: start))
    let grown = StreamHaptics.Mark(id: "m1", length: 40)
    #expect(!StreamHaptics.shouldTick(previous: first, latest: grown, lastTick: start, now: start.addingTimeInterval(0.1)))
    #expect(StreamHaptics.shouldTick(previous: first, latest: grown, lastTick: start, now: start.addingTimeInterval(0.33)))
    #expect(!StreamHaptics.shouldTick(previous: grown, latest: grown, lastTick: start, now: start.addingTimeInterval(2)))
    #expect(!StreamHaptics.shouldTick(previous: grown, latest: nil, lastTick: start, now: start.addingTimeInterval(2)))
    #expect(StreamHaptics.shouldTick(previous: grown, latest: StreamHaptics.Mark(id: "m2", length: 1), lastTick: start, now: start))
  }
}
