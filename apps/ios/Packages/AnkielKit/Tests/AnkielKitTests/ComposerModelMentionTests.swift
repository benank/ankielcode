import Foundation
import Testing

@testable import AnkielKit

/// Ported from `client-runtime/composerModelMentions.test.ts`.
struct ComposerModelMentionTests {
  struct Model {
    var id: String
    var searchable: ComposerModelMentions.Searchable
  }

  static let models = [
    Model(id: "traex:gpt", searchable: .init(name: "GPT-6.1", driverKind: "codex", providerDisplayName: "Traex")),
    Model(id: "opencode:traex-gpt", searchable: .init(name: "GPT-6.1", subProvider: "Traex", driverKind: "opencode", providerDisplayName: "OpenCode")),
    Model(id: "opencode:opus", searchable: .init(name: "Claude Opus 5.5", subProvider: "Anthropic", driverKind: "opencode", providerDisplayName: "OpenCode")),
    Model(id: "claude:opus", searchable: .init(name: "Claude Opus 5.5", driverKind: "claudeAgent", providerDisplayName: "Claude")),
  ]

  func rank(_ query: String) -> [String] { ComposerModelMentions.rank(Self.models, query: query, \.searchable).map(\.id) }

  @Test(arguments: ["", "-", "---", ":/-/:", "src", "g", "agent", "pus"])
  func noModels(query: String) {
    #expect(rank(query).isEmpty)
  }

  @Test func ranking() {
    #expect(rank("gpt").sorted() == ["opencode:traex-gpt", "traex:gpt"])
    #expect(rank("opencode:traex") == ["opencode:traex-gpt"])
    #expect(rank("opencode/gpt") == ["opencode:traex-gpt"])
    #expect(rank("opencode-gpt") == ["opencode:traex-gpt"])
    #expect(rank("gpt-6.1").sorted() == ["opencode:traex-gpt", "traex:gpt"])
  }

  @Test func readsBackWhatItWrites() {
    let text = "use \(ComposerMenu.modelMention(instanceId: "opencode", model: "anthropic/opus")), then model:codex/gpt-5.4."
    #expect(ComposerModelMentions.collect(text).map { [$0.source, "\($0.start)", "\($0.end)"] } == [
      ["model:opencode/anthropic/opus", "4", "33"], ["model:codex/gpt-5.4", "40", "59"],
    ])
  }

  @Test(arguments: [
    ("(model:codex/gpt-6.1).", ["codex/gpt-6.1"]),
    ("\"model:codex/gpt-6.1\"", ["codex/gpt-6.1"]),
    ("model:codex/gpt-6.1,model:claudeAgent/sonnet", ["codex/gpt-6.1", "claudeAgent/sonnet"]),
    ("model:codex/gpt-6.1's output", ["codex/gpt-6.1"]),
    ("model:opencode/foo(bar)", ["opencode/foo(bar)"]),
    ("(model:codex/GPT-6.1-Sol[1m]).", ["codex/GPT-6.1-Sol[1m]"]),
    ("model:codex/gpt-6.1" + String(repeating: ")", count: 128), ["codex/gpt-6.1"]),
  ])
  func boundsTheReference(text: String, expected: [String]) {
    #expect(ComposerModelMentions.collect(text).map { "\($0.instanceId)/\($0.model)" } == expected)
  }

  @Test(arguments: ["remodel:codex/gpt", "model:codex", "model:/gpt", "model:codex/.", "model:1x/gpt"])
  func ignores(text: String) {
    #expect(ComposerModelMentions.collect(text).isEmpty)
  }
}
