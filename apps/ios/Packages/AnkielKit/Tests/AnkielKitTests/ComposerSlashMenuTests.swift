import Foundation
import Testing

@testable import AnkielKit

/// Ported from `use-composer-command-menu.test.ts` and `composerSlashSkillSearch.ts`.
struct ComposerSlashMenuTests {
  func provider(_ driver: String, commands: [ProviderSlashCommand] = [], skills: [ProviderSkill] = []) -> ServerProvider {
    var provider = ServerProvider(instanceId: driver, driver: driver)
    provider.slashCommands = commands
    provider.skills = skills
    return provider
  }

  @Test func aProvidersPlanCommandInsertsAsText() {
    let antigravity = provider("antigravity", commands: [ProviderSlashCommand(name: "plan", description: "Plan with Antigravity")])
    let items = ComposerSlashMenu.slashItems(
      query: "pl", atMessageStart: true, context: .init(hasThread: true), provider: antigravity, cwd: nil)
    #expect(items.map(\.id) == ["pcmd:plan"])
    let picked = ComposerMenu.apply(items[0], to: "/pl", trigger: ComposerTrigger(kind: .slashCommand, query: "pl", rangeStart: 0, rangeEnd: 3))
    #expect(picked.text == "/plan ")
    #expect(picked.cursor == 6)
  }

  @Test func ankielsClearReplacesTheProvidersOnlyAtTheStart() {
    let claude = provider("claudeAgent", commands: [ProviderSlashCommand(name: "clear", description: "Clear conversation history")])
    func build(_ fresh: Bool, _ start: Bool = true) -> [String] {
      ComposerSlashMenu.slashItems(
        query: "cle", atMessageStart: start, context: .init(hasThread: true, offersFreshSession: fresh), provider: claude, cwd: nil
      ).map(\.id)
    }
    #expect(build(true) == ["cmd:clear"])
    #expect(build(false) == ["pcmd:clear"])
    #expect(build(true, false) == [])
  }

  @Test func modelIsOfferedAnywhereAndTheRestOnlyAtTheStart() {
    let codex = provider("codex", commands: [ProviderSlashCommand(name: "review")])
    #expect(ComposerSlashMenu.slashItems(query: "", atMessageStart: false, context: .init(hasThread: true), provider: codex, cwd: nil).map(\.id) == ["cmd:model"])
    let all = ComposerSlashMenu.slashItems(
      query: "", atMessageStart: true, context: .init(hasThread: true, offersFreshSession: true, offersSideChat: true), provider: codex, cwd: nil)
    #expect(all.map(\.id) == ["cmd:model", "cmd:side", "cmd:btw", "cmd:clear", "pcmd:review"])
  }

  @Test func providerCommandsFollowTheirRules() {
    let codex = provider("codex", commands: [
      ProviderSlashCommand(name: "compact"), ProviderSlashCommand(name: "feedback"), ProviderSlashCommand(name: "usage-limits"),
    ])
    let newThread = ComposerSlashMenu.slashItems(
      query: "", atMessageStart: true, context: .init(hasThread: false, offersUsageLimits: true), provider: codex, cwd: nil)
    #expect(newThread.map(\.id) == ["cmd:model"], "no compact without a conversation, no feedback or usage limits before a thread")
    let thread = ComposerSlashMenu.slashItems(
      query: "", atMessageStart: true, context: .init(hasThread: true, hasCompactableConversation: true, offersUsageLimits: true),
      provider: codex, cwd: nil)
    #expect(thread.map(\.id) == ["cmd:model", "pcmd:compact", "pcmd:feedback", "pcmd:usage-limits"])
  }

  @Test func skillsJoinTheSlashListAndHideSameNamedCommands() {
    let claude = provider(
      "claudeAgent", commands: [ProviderSlashCommand(name: "review"), ProviderSlashCommand(name: "deploy")],
      skills: [
        ProviderSkill(name: "review", shortDescription: "Review a diff"), ProviderSkill(name: "hidden", userInvocable: false),
        ProviderSkill(name: "off", enabled: false),
      ])
    let items = ComposerSlashMenu.slashItems(query: "", atMessageStart: true, context: .init(hasThread: true), provider: claude, cwd: nil)
    #expect(items.map(\.id) == ["cmd:model", "pcmd:deploy", "skill:review"])
    #expect(ComposerSlashMenu.slashItems(query: "skill:rev", atMessageStart: true, context: .init(hasThread: true), provider: claude, cwd: nil).map(\.id) == ["skill:review"])
  }

  @Test func aFoldersSnapshotReplacesTheProvidersCatalog() throws {
    let json = #"{"instanceId":"codex","driver":"codex","slashCommands":[{"name":"global"}],"skills":[],"workspaceSnapshots":[{"cwd":"/w","checkedAt":"2026-11-27T00:00:00.000Z","slashCommands":[{"name":"local","description":null}],"skills":[{"name":"s","path":"/w/s","enabled":true}]}]}"#
    let codex = try JSONDecoder().decode(ServerProvider.self, from: Data(json.utf8))
    #expect(codex.slashCommands(forCwd: "/w").map(\.name) == ["local"])
    #expect(codex.slashCommands(forCwd: "/other").map(\.name) == ["global"])
    #expect(codex.skills(forCwd: "/w").map(\.name) == ["s"])
  }

  @Test func dollarSkillsRankBestFirst() {
    let claude = provider("claudeAgent", skills: [
      ProviderSkill(name: "frontend-review", shortDescription: "Review UI"), ProviderSkill(name: "review"),
      ProviderSkill(name: "deploy", description: "Ship after review"), ProviderSkill(name: "rvw-tool"),
    ])
    #expect(ComposerSlashMenu.skillItems(query: "review", provider: claude, cwd: nil).map(\.label) == ["review", "frontend-review", "deploy"])
    #expect(ComposerSlashMenu.skillItems(query: "rvw", provider: claude, cwd: nil).first?.label == "rvw-tool")
    #expect(ComposerSlashMenu.skillItems(query: "", provider: claude, cwd: nil).count == 4)
    let pick = ComposerMenu.apply(
      ComposerSlashMenu.skillItems(query: "rev", provider: claude, cwd: nil)[0], to: "Use $rev",
      trigger: ComposerTrigger(kind: .skill, query: "rev", rangeStart: 4, rangeEnd: 8))
    #expect(pick.text == "Use $review ")
  }

  @Test func rankingMatchesSearchRankingTs() {
    #expect(SearchRanking.score("abc", "abc", exact: 0) == 0)
    #expect(SearchRanking.score("abcdef", "abc", exact: 0, prefix: 2) == 5)
    #expect(SearchRanking.score("x-abc", "abc", exact: 0, prefix: 2, boundary: 4) == 4 + 2 * 2 + 2)
    #expect(SearchRanking.score("xxabc", "abc", exact: 0, includes: 6) == 6 + 4 + 2)
    #expect(SearchRanking.score("a_b_c", "abc", exact: 0, fuzzy: 100) == 100 + 0 + 2 * 3 + 2 + 2)
    #expect(SearchRanking.score("zzz", "abc", exact: 0, fuzzy: 100) == nil)
  }
}
