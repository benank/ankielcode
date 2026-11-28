import Foundation
import Testing

@testable import AnkielKit

private func at(_ text: String) -> Date { WireTimestamp(rawValue: text).date! }

private let now = at("2026-09-03T12:00:00.000Z")
private let checkedAt = at("2026-09-03T11:00:00.000Z")
private let session = UsageWindow(
  id: "five_hour", kind: .session, label: "Session", usedPercent: 40, resetsAt: at("2026-09-03T14:00:00.000Z"),
  windowDurationMins: 300)
private let weekly = UsageWindow(
  id: "seven_day", kind: .weekly, label: "Weekly", usedPercent: 40, resetsAt: at("2026-09-06T12:00:00.000Z"),
  windowDurationMins: 7 * 24 * 60)

private func provider(
  _ instanceId: String = "codex", driver: String = "codex", email: String? = nil, plan: String? = nil,
  workspace: String? = nil, displayName: String? = nil, limits: ProviderUsageLimits?
) -> ServerProvider {
  var provider = ServerProvider(instanceId: instanceId, driver: driver, displayName: displayName)
  provider.authStatus = "authenticated"
  provider.authEmail = email
  provider.authLabel = plan
  provider.authWorkspaceId = workspace
  provider.usageLimits = limits
  return provider
}

private func limits(_ windows: [UsageWindow], at checked: Date = checkedAt, credits: Int? = nil) -> ProviderUsageLimits {
  ProviderUsageLimits(checkedAt: checked, windows: windows, resetCredits: credits.map { ResetCredits(availableCount: $0) })
}

private func source(_ id: String, _ label: String, _ providers: [ServerProvider]) -> LimitSource {
  LimitSource(environmentId: id, label: label, providers: providers)
}

private func source(_ id: String, _ providers: [ServerProvider]) -> LimitSource {
  LimitSource(environmentId: id, label: "Laptop", providers: providers)
}

private func account(_ key: String, driver: String = "claudeAgent", _ windows: [UsageWindow], at checked: Date = checkedAt) -> LimitAccount {
  LimitAccount(
    key: key, driver: driver, displayName: key, redeem: .init(environmentId: "env", instanceId: "claude"),
    limits: limits(windows, at: checked))
}

private func with(_ window: UsageWindow, id: String? = nil, used: Double? = nil, resetsAt: Date?? = nil) -> UsageWindow {
  var copy = window
  if let id { copy.id = id }
  if let used { copy.usedPercent = used }
  if let resetsAt { copy.resetsAt = resetsAt }
  return copy
}

@Suite("Usage limits")
struct UsageLimitsTests {
  @Test("pace: three fifths through a five-hour window with two hours left")
  func pace() {
    #expect(abs((UsageLimits.elapsedShare(session, now: now) ?? 0) - 0.6) < 0.0001)
    #expect(UsageLimits.paceRemainingPercent(session, now: now) == 40)
    #expect(UsageLimits.pace(session, now: now) == .under)
    #expect(UsageLimits.pace(with(session, used: 62), now: now) == .on)
    #expect(UsageLimits.pace(with(session, used: 80), now: now) == .ahead)
  }

  @Test("reset countdowns: now, momentarily, after")
  func countdown() {
    #expect(UsageLimits.resetCountdown(with(session, resetsAt: now), now: now) == .now)
    #expect(UsageLimits.resetCountdown(with(session, resetsAt: now.addingTimeInterval(30)), now: now) == .momentarily)
    #expect(UsageLimits.resetCountdown(session, now: now) == .after(7200))
    #expect(UsageLimits.resetCountdown(with(session, resetsAt: .some(nil)), now: now) == nil)
  }

  @Test("merges one account reported on two computers into one entry")
  func mergesComputers() {
    let native = provider("claude", driver: "claudeAgent", email: "Same@example.com", limits: limits([session]))
    var fresher = native
    fresher.usageLimits = limits([with(session, used: 55)], at: at("2026-09-03T11:30:00.000Z"))
    let accounts = UsageLimits.accounts([source("env-a", [native]), source("env-b", "Desktop", [fresher])])
    #expect(accounts.count == 1)
    #expect(accounts[0].key == "env-a:claude")
    #expect(accounts[0].redeem == .init(environmentId: "env-b", instanceId: "claude"))
    #expect(accounts[0].environments.map(\.label) == ["Laptop", "Desktop"])
    #expect(accounts[0].limits.windows[0].usedPercent == 55)
  }

  @Test("uses the freshest reported plan even when the newest quota has no plan")
  func freshestPlan() {
    func read(_ plan: String?, _ time: String, _ used: Double) -> ServerProvider {
      provider(driver: "claudeAgent", email: "same@example.com", plan: plan, limits: limits([with(session, used: used)], at: at(time)))
    }
    let stale = read("Claude Team Subscription", "2026-09-03T11:00:00.000Z", 40)
    let fresh = read("Claude Max Subscription", "2026-09-03T11:30:00.000Z", 7)
    let newest = read(nil, "2026-09-03T12:00:00.000Z", 5)
    for (reports, plan, used) in [
      ([stale, fresh], "Claude Max Subscription", 7.0), ([fresh, stale], "Claude Max Subscription", 7),
      ([stale, newest], "Claude Team Subscription", 5), ([newest, stale], "Claude Team Subscription", 5),
      ([stale, fresh, newest], "Claude Max Subscription", 5), ([newest, fresh, stale], "Claude Max Subscription", 5),
    ] {
      let accounts = UsageLimits.accounts(reports.enumerated().map { source("env-\($0.offset)", [$0.element]) })
      #expect(accounts.count == 1)
      #expect(accounts.first?.plan == plan)
      #expect(accounts.first?.limits.windows.first?.usedPercent == used)
    }
  }

  @Test("shows Antigravity's tier as its plan, not its sign-in method")
  func antigravityPlan() {
    func plan(_ label: String) -> String? {
      UsageLimits.accounts([source("env", [provider(driver: "antigravity", plan: label, limits: limits([session]))])]).first?.plan
    }
    #expect(plan("Google AI Pro") == "Google AI Pro")
    #expect(plan("Google account") == nil)
  }

  @Test("merges by API key fingerprint and email, apart by different keys")
  func fingerprints() {
    var go = provider("opencode", driver: "opencode", limits: limits([with(session, id: "go_rolling", used: 3)]))
    go.usageLimits?.credentialFingerprint = "shared-go-key"
    var other = go
    other.usageLimits?.checkedAt = at("2026-09-03T11:30:00.000Z")
    other.usageLimits?.windows[0].usedPercent = 4
    let merged = UsageLimits.accounts([source("env-a", [go]), source("env-b", "Desktop", [other])])
    #expect(merged.count == 1)
    #expect(merged[0].limits.windows[0].usedPercent == 4)
    #expect(UsageLimits.pools(merged, now: now)[0].windows[0].members.count == 1)
    other.usageLimits?.credentialFingerprint = "other-go-key"
    #expect(UsageLimits.accounts([source("env-a", [go]), source("env-b", [other])]).count == 2)
  }

  @Test("takes windows from a fresher read but credits and redeem from the read that has them")
  func creditsSource() {
    let native = provider("claude", driver: "claudeAgent", email: "same@example.com", limits: limits([session], credits: 2))
    var fresher = native
    fresher.usageLimits = limits([with(session, used: 55)], at: at("2026-09-03T11:30:00.000Z"))
    let account = UsageLimits.accounts([source("env-a", [native]), source("env-b", [fresher])])[0]
    #expect(account.limits.windows[0].usedPercent == 55)
    #expect(account.limits.resetCredits?.availableCount == 2)
    #expect(account.redeem == .init(environmentId: "env-a", instanceId: "claude"))
  }

  @Test("old credits do not borrow the time of a newer window-only read")
  func creditTimes() {
    let reads = [
      limits([session], credits: 2), limits([session], at: at("2026-09-03T12:00:00.000Z")),
      limits([session], at: at("2026-09-03T11:30:00.000Z"), credits: 1),
    ]
    let sources = reads.enumerated().map { source("env-\($0.offset)", [provider(email: "same@example.com", limits: $0.element)]) }
    let account = UsageLimits.accounts(sources)[0]
    #expect(account.limits.checkedAt == at("2026-09-03T12:00:00.000Z"))
    #expect(account.limits.resetCredits?.availableCount == 1)
    #expect(account.redeem.environmentId == "env-2")
  }

  @Test("one email in two workspaces stays apart; a report without a workspace joins the only one")
  func workspaces() {
    let a = provider("a", email: "x@example.com", workspace: "w1", limits: limits([session]))
    let b = provider("b", email: "x@example.com", workspace: "w2", limits: limits([session]))
    #expect(UsageLimits.accounts([source("env", [a, b])]).count == 2)
    let bare = provider("c", email: "x@example.com", limits: limits([session]))
    #expect(UsageLimits.accounts([source("env", [a]), source("env-2", [bare])]).count == 1)
  }

  @Test("pools Codex windows by kind, whichever slot reported them")
  func codexPools() {
    func codex(_ id: String, _ slots: [String]) -> ServerProvider {
      provider(id, limits: limits(slots.map { with(weekly, id: $0, used: 50) }))
    }
    for order in [[codex("business", ["primary"]), codex("plus", ["secondary"])], [codex("plus", ["secondary"]), codex("business", ["primary"])]] {
      let windows = UsageLimits.pools(UsageLimits.accounts([source("env", order)]), now: now)[0].windows
      #expect(windows.map(\.id) == ["weekly"])
      #expect(windows[0].members.count == 2)
    }
    let split = UsageLimits.pools(UsageLimits.accounts([source("env", [codex("a", ["secondary"]), codex("b", ["primary", "secondary"])])]), now: now)
    #expect(split[0].windows.map(\.id) == ["weekly", "weekly:secondary"])
  }

  @Test("weights pooled Codex quota and resets by plan capacity")
  func capacity() {
    let providers = [("pro", "ChatGPT Pro 200 Subscription", 100.0), ("plus", "ChatGPT Plus Subscription", 0)].map {
      provider($0.0, email: "\($0.0)@example.com", plan: $0.1, limits: limits([with(weekly, id: "secondary", used: $0.2)]))
    }
    let pooled = UsageLimits.pools(UsageLimits.accounts([source("env", providers)]), now: now)[0].windows[0]
    #expect(pooled.remainingPercent == 5)
    #expect(pooled.resets.contains { $0.member.account.email == "pro@example.com" && $0.restoresPercent == 95 })
  }

  @Test("pools windows by id across accounts and orders resets by when they land")
  func poolsById() {
    let sources = [
      source(
        "env-a",
        [
          provider("a", driver: "claudeAgent", limits: limits([with(session, used: 80, resetsAt: at("2026-09-03T13:00:00.000Z")), with(weekly, used: 20)])),
          provider("b", driver: "claudeAgent", limits: limits([session])),
          provider("c", limits: limits([with(weekly, used: 50)])),
          provider(
            "unsupported", driver: "claudeAgent",
            limits: ProviderUsageLimits(checkedAt: checkedAt, windows: [], unavailable: .init(reason: "unsupported"))),
        ]),
    ]
    let pools = UsageLimits.pools(UsageLimits.accounts(sources), now: now)
    #expect(pools.map { "\($0.driver):\($0.accounts.count)" } == ["claudeAgent:2", "codex:1"])
    let sessionPool = pools[0].windows[0]
    #expect(sessionPool.id == "five_hour")
    #expect(sessionPool.remainingPercent == 40)
    #expect(sessionPool.usedPercent == 60)
    #expect(sessionPool.pace == .under)
    #expect(sessionPool.resets.map { "\($0.member.account.key):\($0.restoresPercent)" } == ["env-a:a:40", "env-a:b:20"])
    #expect(pools[0].windows[1].remainingPercent == 80)
    #expect(pools[0].accounts.map(\.key) == ["env-a:a", "env-a:b"])
  }

  @Test(
    "a session blocked by a spent weekly window refills when it becomes usable",
    arguments: [
      ("claudeAgent", "13:00", 40.0, "14:00", 100), ("codex", "14:00", 100, "14:00", 100),
      ("claudeAgent", "15:00", 100, "15:00", 100), ("codex", "15:00", 40, "14:00", 60),
    ])
  func blockedSessions(_ driver: String, _ sessionReset: String, _ used: Double, _ usableAt: String, _ restores: Int) {
    func time(_ clock: String) -> Date { at("2026-09-03T\(clock):00.000Z") }
    let blocked = account(
      "a", driver: driver,
      [
        with(session, id: driver == "codex" ? "primary" : session.id, used: used, resetsAt: time(sessionReset)),
        with(weekly, id: driver == "codex" ? "secondary" : weekly.id, used: 100, resetsAt: time("14:00")),
      ])
    let row = UsageLimits.pools([blocked], now: now)[0].windows[0]
    #expect(row.remainingPercent == 0)
    #expect(row.resets.first?.at == time(usableAt))
    #expect(row.resets.first?.restoresPercent == restores)
  }

  @Test("keeps session columns across rows with opposite reset and usage orders")
  func columns() {
    let accounts = [
      account("a", [with(weekly, used: 80, resetsAt: at("2026-09-05T12:00:00.000Z")), with(session, used: 10, resetsAt: at("2026-09-03T15:00:00.000Z"))]),
      account("b", [with(weekly, used: 20, resetsAt: at("2026-09-06T12:00:00.000Z")), with(session, used: 90, resetsAt: at("2026-09-03T13:00:00.000Z"))]),
    ]
    let pool = UsageLimits.pools(accounts, now: now)[0]
    func keys(_ pool: LimitPool) -> [[String?]] { pool.windows.map { $0.columns.map { $0.member?.account.key } } }
    #expect(pool.accounts.map(\.key) == ["b", "a"])
    #expect(keys(pool) == [["b", "a"], ["b", "a"]])
    #expect(pool.windows[1].resets.map(\.member.account.key) == ["a", "b"])
    #expect(pool.windows[1].remainingPercent == 50)
    #expect(keys(UsageLimits.pools(accounts.reversed(), now: now)[0]) == keys(pool))
  }

  @Test("preserves gaps without counting missing windows toward pooled quota")
  func gaps() {
    let pool = UsageLimits.pools(
      [account("a", [session]), account("b", [with(session, resetsAt: at("2026-09-03T15:00:00.000Z")), with(weekly, used: 80)]), account("c", [weekly])],
      now: now)[0]
    #expect(pool.windows.map { $0.columns.map { $0.member?.account.key } } == [["a", "b", nil], [nil, "b", "c"]])
    #expect(pool.windows[1].remainingPercent == 40)
    #expect(pool.windows[1].resets.map(\.restoresPercent) == [40, 20])
  }

  @Test("Cursor hides an overall window that only repeats its pools")
  func cursor() {
    let cursor = account("0", driver: "cursor", [with(weekly, id: "totalPercentUsed", used: 14), with(weekly, id: "autoPercentUsed", used: 14)])
    let pool = UsageLimits.pools([cursor], now: now)[0]
    #expect(UsageLimits.displayWindows(pool).map(\.id) == ["autoPercentUsed"])
    #expect(UsageLimits.cursorWindowIsUnlabeled("autoPercentUsed", in: pool))
  }

  @Test("notices skip a bare unsupported and name the computer when there are several")
  func notices() {
    let failed = provider(
      "claude", driver: "claudeAgent",
      limits: ProviderUsageLimits(checkedAt: checkedAt, windows: [], unavailable: .init(reason: "probeFailed")))
    let bare = provider(limits: ProviderUsageLimits(checkedAt: checkedAt, windows: [], unavailable: .init(reason: "unsupported")))
    let one = UsageLimits.notices([source("env", [failed, bare])])
    #expect(one.map(\.subject) == ["Claude"])
    #expect(one.first?.notice == .probeFailed(message: nil))
    let two = UsageLimits.notices([source("env", [failed]), source("env-2", "Desktop", [failed])])
    #expect(two.map(\.subject) == ["Laptop · Claude", "Desktop · Claude"])
  }

  @Test("external usage links dedupe by URL across accounts and computers")
  func externalLinks() {
    var limited = limits([session])
    limited.externalUsage = .init(label: "Claude usage and resets", url: "https://claude.ai/settings/usage")
    let a = provider("claude", driver: "claudeAgent", displayName: "Work", limits: limited)
    let links = UsageLimits.externalLinks([source("env", [a]), source("env-2", "Desktop", [a])])
    #expect(links.count == 1)
    #expect(links[0].accounts.map(\.environment) == ["Laptop", "Desktop"])
  }

  @Test("decodes a provider's limits from the wire and tolerates unknown kinds")
  func decoding() throws {
    let json = """
      {"instanceId":"codex","driver":"codex","enabled":true,"installed":true,
       "auth":{"status":"authenticated","email":"a@b.c","workspaceId":"ws"},
       "usageLimits":{"checkedAt":"2026-11-27T18:50:51.162Z","resetCredits":{"availableCount":3,"nextExpiresAt":"2026-12-01T22:09:47.000Z"},
        "externalUsage":{"label":"ChatGPT usage and resets","url":"https://chatgpt.com/codex/settings/usage"},
        "windows":[{"id":"primary","kind":"session","label":"Session","resetsAt":"2026-11-27T19:48:48.000Z","usedPercent":1,"windowDurationMins":300},
                   {"id":"future","kind":"quarterly","label":"Quarter","usedPercent":"NaN"},{"broken":true}]}}
      """
    let provider = try JSONDecoder().decode(ServerProvider.self, from: Data(json.utf8))
    let limits = try #require(provider.usageLimits)
    #expect(provider.authWorkspaceId == "ws")
    #expect(limits.windows.map(\.kind) == [.session, .other])
    #expect(limits.windows[1].usedPercent == 0)
    #expect(limits.resetCredits?.availableCount == 3)
    #expect(limits.windows[0].resetsAt == at("2026-11-27T19:48:48.000Z"))
  }

  @Test("highest spend and short plan labels for the header ring")
  func header() {
    #expect(UsageLimits.highestUsedPercent([account("a", [session, with(weekly, used: 91)])]) == 91)
    #expect(UsageLimits.highestUsedPercent([]) == nil)
    #expect(UsageLimits.shortPlanLabel("ChatGPT Pro 200 Subscription") == "Pro 200")
    #expect(UsageLimits.shortPlanLabel("Claude Max Subscription") == "Max")
  }
}

@Suite("Context window")
struct ContextWindowTests {
  private func projection(turns: [ProviderTurn], threads: [ProviderThread] = [], active: String? = "pt-current", items: [TurnItem] = []) -> ThreadProjection {
    var projection = Make.projection(items: items)
    projection.thread.activeProviderThreadId = active
    projection.providerTurns = turns
    projection.providerThreads = threads
    return projection
  }

  private func usage(_ used: Int, max: Int? = 1_000_000, at seconds: Int) -> ProviderTurn.TokenUsage {
    .init(usedTokens: used, maxTokens: max, updatedAt: Make.at(seconds))
  }

  private func compaction(_ id: String, status: TurnItemStatus, after: Int?, at seconds: Int, providerThread: String? = nil) -> TurnItem {
    var item = TurnItem(
      id: id, threadId: Make.threadId, runId: Make.runId, ordinal: 5, status: status, startedAt: Make.at(seconds),
      completedAt: status == .completed ? Make.at(seconds) : nil, updatedAt: Make.at(seconds),
      body: .compaction(.init(driver: "claudeAgent", beforeTokenCount: 400_000, afterTokenCount: after)))
    item.providerThreadId = providerThread
    return item
  }

  @Test("reads the active conversation's usage, not an earlier one's")
  func activeConversation() {
    let threads = [ProviderThread(id: "pt-earlier"), ProviderThread(id: "pt-current")]
    let current = ContextWindow.derive(projection(turns: [ProviderTurn(id: "t", providerThreadId: "pt-current", tokenUsage: usage(293_611, at: 1))], threads: threads))
    #expect(current?.usedTokens == 293_611)
    let earlier = ContextWindow.derive(projection(turns: [ProviderTurn(id: "t", providerThreadId: "pt-earlier", tokenUsage: usage(293_611, at: 1))], threads: threads))
    #expect(earlier == nil)
  }

  @Test("the newest report wins; ties go to the later entry")
  func newest() {
    let threads = [ProviderThread(id: "pt-current")]
    let turns = [
      ProviderTurn(id: "a", providerThreadId: "pt-current", tokenUsage: usage(300, at: 5)),
      ProviderTurn(id: "b", providerThreadId: "pt-current", tokenUsage: usage(100, at: 1)),
      ProviderTurn(id: "c", providerThreadId: "pt-current", tokenUsage: usage(400, at: 5)),
    ]
    #expect(ContextWindow.derive(projection(turns: turns, threads: threads))?.usedTokens == 400)
  }

  @Test("a compaction after the last report shows what it left; one before is ignored")
  func compactions() {
    let threads = [ProviderThread(id: "pt-current")]
    let turn = ProviderTurn(id: "t", providerThreadId: "pt-current", tokenUsage: usage(900_000, at: 5))
    let after = ContextWindow.derive(projection(turns: [turn], threads: threads, items: [compaction("c", status: .completed, after: 40_000, at: 9)]))
    #expect(after?.usedTokens == 40_000)
    #expect(after?.fromCompaction == true)
    #expect(after?.maxTokens == 1_000_000)
    let before = ContextWindow.derive(projection(turns: [turn], threads: threads, items: [compaction("c", status: .completed, after: 40_000, at: 2)]))
    #expect(before?.usedTokens == 900_000)
    let running = ContextWindow.derive(projection(turns: [turn], threads: threads, items: [compaction("c", status: .running, after: nil, at: 9)]))
    #expect(running?.compacting == true)
    let retired = ContextWindow.derive(
      projection(turns: [turn], threads: threads, items: [compaction("c", status: .completed, after: 40_000, at: 9, providerThread: "pt-old")]))
    #expect(retired?.usedTokens == 900_000)
  }

  @Test("falls back to the provider thread's own snapshot")
  func providerSnapshot() {
    var thread = ProviderThread(id: "pt-current", contextUsage: .init(usedTokens: 120_000, maxTokens: 200_000), updatedAt: Make.at(3))
    thread.contextUsage?.outputTokens = 9
    let window = ContextWindow.derive(projection(turns: [], threads: [thread]))
    #expect(window?.usedTokens == 120_000)
    #expect(window?.remainingTokens == 80_000)
    #expect(window?.shownPercent == 60)
    #expect(window?.outputTokens == 9)
  }

  @Test("levels: normal, high at 90%, over past the window")
  func levels() {
    #expect(ContextWindowSnapshot(usedTokens: 100, maxTokens: 1000, updatedAt: now).level == .normal)
    #expect(ContextWindowSnapshot(usedTokens: 900, maxTokens: 1000, updatedAt: now).level == .high)
    let over = ContextWindowSnapshot(usedTokens: 1200, maxTokens: 1000, updatedAt: now)
    #expect(over.level == .over)
    #expect(over.shownPercent == 100)
    #expect(over.remainingTokens == 0)
    #expect(ContextWindowSnapshot(usedTokens: 1200, maxTokens: nil, updatedAt: now).level == .normal)
  }

  @Test("provider-thread events set the active conversation unless it is a queued placeholder")
  func reducer() throws {
    var projection = Make.projection()
    let json = #"{"id":"pt-1","appThreadId":"\#(Make.threadId)","status":"idle","firstRunOrdinal":1,"providerSessionId":"s","nativeThreadRef":null,"contextUsage":{"usedTokens":5,"maxTokens":10},"updatedAt":"2026-06-20T00:00:00.000Z"}"#
    let thread = try JSONDecoder().decode(ProviderThread.self, from: Data(json.utf8))
    ThreadReducer.apply(Make.event(.providerThread(thread), type: "provider-thread.updated"), to: &projection)
    #expect(projection.thread.activeProviderThreadId == "pt-1")
    #expect(projection.providerThreads.first?.contextUsage?.usedTokens == 5)
    var placeholder = ProviderThread(id: "pt-2", appThreadId: Make.threadId)
    placeholder.status = "not_loaded"
    ThreadReducer.apply(Make.event(.providerThread(placeholder), type: "provider-thread.updated"), to: &projection)
    #expect(projection.thread.activeProviderThreadId == "pt-1")
    #expect(projection.providerThreads.count == 2)
  }

  @Test("formats token counts compactly")
  func format() {
    #expect(ContextWindow.formatTokens(158_000) == "158K")
    #expect(ContextWindow.formatTokens(1_000_000) == "1M")
    #expect(ContextWindow.formatTokens(1_250) == "1.3K")
    #expect(ContextWindow.formatTokens(2_000) == "2K")
    #expect(ContextWindow.formatTokens(400_000) == "400K")
    #expect(ContextWindow.formatTokens(999_499) == "999K")
    #expect(ContextWindow.formatTokens(999_500) == "1M")
    #expect(ContextWindow.formatTokens(950) == "950")
    #expect(ContextWindow.formatTokens(nil) == "0")
  }
}

@Suite("Usage widget snapshot")
struct UsageWidgetSnapshotTests {
  private let widgetChecked = at("2026-09-05T12:00:00.000Z")
  private var shortSession: UsageWindow {
    UsageWindow(id: "session", kind: .session, label: "5 hours", usedPercent: 40, resetsAt: at("2026-09-05T12:10:00.000Z"))
  }

  @Test("uses provider data and its read time without account emails")
  func basics() throws {
    let codex = provider(email: "private@example.com", displayName: "private@example.com", limits: limits([shortSession], at: widgetChecked))
    let snapshot = UsageWidgetSnapshot.build([source("env", "Remote", [codex])])
    #expect(snapshot.checkedAt == widgetChecked)
    #expect(snapshot.providers.map(\.name) == ["Codex"])
    #expect(snapshot.providers[0].windows.map(\.remaining) == [60])
    #expect(snapshot.providers[0].expiresAt == widgetChecked.addingTimeInterval(600))
    let encoded = String(decoding: try JSONEncoder().encode(snapshot), as: UTF8.self)
    #expect(!encoded.contains("private@example.com"))
  }

  @Test("lists configured Codex and Claude even without limits, most constrained windows first")
  func ordering() {
    var claude = ServerProvider(instanceId: "claude", driver: "claudeAgent")
    claude.authStatus = "authenticated"
    let windows = (0..<8).map { UsageWindow(id: "w\($0)", kind: .other, label: "W\($0)", usedPercent: Double($0 * 10)) }
    let snapshot = UsageWidgetSnapshot.build([source("env", [provider(limits: limits(windows + [shortSession], at: widgetChecked)), claude])])
    #expect(snapshot.providers.map(\.driver) == ["codex", "claudeAgent"])
    #expect(snapshot.providers[1].detail == .noLimits)
    let shown = snapshot.providers[0].windows
    #expect(shown.count == 6)
    #expect(shown.map(\.remaining) == shown.map(\.remaining).sorted())
    #expect(shown.contains { $0.kind == .session })
    #expect(snapshot.providers[0].totalWindows == 9)
  }

  @Test("the timeline greys a provider out at its expiry and never before")
  func expiry() {
    let snapshot = UsageWidgetSnapshot.build([source("env", [provider(limits: limits([shortSession], at: widgetChecked))])])
    let timeline = snapshot.timeline(from: widgetChecked)
    #expect(timeline.map(\.date) == [widgetChecked, widgetChecked.addingTimeInterval(600)])
    #expect(timeline[0].snapshot.providers[0].windows.count == 1)
    #expect(timeline[1].snapshot.providers[0].windows.isEmpty)
    #expect(timeline[1].snapshot.providers[0].detail == .refresh)
    let late = snapshot.timeline(from: widgetChecked.addingTimeInterval(3600))
    #expect(late.count == 1)
    #expect(late[0].snapshot.providers[0].detail == .refresh)
  }

  @Test("a reset at or before the read does not expire the snapshot early")
  func pastReset() {
    let past = with(shortSession, resetsAt: at("2026-09-05T11:00:00.000Z"))
    let snapshot = UsageWidgetSnapshot.build([source("env", [provider(limits: limits([past], at: widgetChecked))])])
    #expect(snapshot.providers[0].expiresAt == widgetChecked.addingTimeInterval(UsageWidgetSnapshot.maxAge))
    #expect(snapshot.providers[0].windows[0].resetUpcoming == false)
  }

  @Test("the snapshot is the same whenever it is built, so it only republishes on change")
  func deterministic() {
    let sources = [source("env", [provider(limits: limits([shortSession, weekly], at: widgetChecked))])]
    #expect(UsageWidgetSnapshot.build(sources) == UsageWidgetSnapshot.build(sources))
  }

  @Test("families pick session and weekly first, the Lock Screen the tightest, periods filter")
  func layout() {
    let windows = [
      UsageWidgetSnapshot.Window(kind: .weekly, label: "Weekly", remaining: 30),
      UsageWidgetSnapshot.Window(kind: .other, label: "Opus", remaining: 10),
      UsageWidgetSnapshot.Window(kind: .session, label: "Session", remaining: 80),
    ]
    let snapshot = UsageWidgetSnapshot(
      checkedAt: now, providers: [.init(driver: "codex", name: "Codex", detail: .subscriptionRemaining, windows: windows, totalWindows: 3)])
    #expect(UsageWidgetLayout.columns(snapshot, family: .small)[0].windows.map(\.label) == ["Session", "Weekly"])
    let lock = UsageWidgetLayout.columns(snapshot, family: .accessoryRectangular)[0]
    #expect(lock.windows.map(\.label) == ["Opus"])
    let weeklyOnly = UsageWidgetLayout.columns(snapshot, family: .medium, periods: ["codex": .weekly])[0]
    #expect(weeklyOnly.windows.map(\.label) == ["Weekly"])
    let large = UsageWidgetLayout.columns(snapshot, family: .large)[0]
    #expect(large.windows.map(\.label) == ["Session", "Weekly", "Opus"])
    #expect(UsageWidgetLayout.columns(snapshot, family: .medium)[0].hiddenCount == 1)
    var noSession = snapshot
    noSession.providers[0].windows = [windows[0]]
    #expect(UsageWidgetLayout.columns(noSession, family: .medium, periods: ["codex": .session])[0].detail == .noSessionLimit)
  }
}

@MainActor
@Suite("Usage refresher")
struct UsageRefresherTests {
  @Test("one refresh per computer at a time; automatic ones wait five minutes")
  func throttle() async {
    var clock = Date(timeIntervalSince1970: 0)
    var calls = 0
    let refresher = UsageRefresher(now: { clock }) { _ throws(EnvironmentRequestError) in
      calls += 1
      await Task.yield()
    }
    async let first: Bool = refresher.refresh(["env"])
    async let joined: Bool = refresher.refresh(["env"])
    let (ran, joinedRan) = await (first, joined)
    #expect(calls == 1)
    #expect(ran != joinedRan)
    #expect(await refresher.refresh(["env"], automatic: true) == false)
    clock = clock.addingTimeInterval(UsageRefresher.automaticInterval + 1)
    #expect(await refresher.refresh(["env"], automatic: true))
    #expect(calls == 2)
    #expect(await refresher.refresh(["env"]))
    #expect(calls == 3)
  }

  @Test("remembers which computers failed until they succeed")
  func failures() async {
    var fail = true
    let refresher = UsageRefresher { _ throws(EnvironmentRequestError) in
      if fail { throw .notConnected }
    }
    await refresher.refresh(["env"])
    #expect(refresher.failed == ["env"])
    fail = false
    await refresher.refresh(["env"])
    #expect(refresher.failed.isEmpty)
  }
}

@Suite("Usage wire fixtures")
struct UsageWireFixtureTests {
  static let samples: [(name: String, schema: String, value: any Encodable & Sendable)] = [
    ("refresh-providers", "refreshProviders", RefreshProvidersRequest()),
    ("consume-reset-credit", "consumeResetCredit", ConsumeResetCreditRequest(instanceId: "claudeAgent")),
  ]

  @Test("usage requests encode exactly as their fixtures", arguments: samples.map(\.name))
  func matchesFixture(_ name: String) throws {
    let sample = try #require(Self.samples.first { $0.name == name })
    let encoded = try JSONEncoder.wire.encode(sample.value)
    let url = CommandEncodingTests.directory.appending(path: "\(name).json")
    if ProcessInfo.processInfo.environment["ANKIEL_WRITE_COMMAND_FIXTURES"] == "1" {
      let pretty = JSONEncoder()
      pretty.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
      let value = try JSONDecoder().decode(JSONValue.self, from: encoded)
      let document: JSONValue = ["schema": .string(sample.schema), "value": value]
      try pretty.encode(document).write(to: url)
    }
    let fixture = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url))
    #expect(fixture["schema"] == .string(sample.schema))
    #expect(try JSONDecoder().decode(JSONValue.self, from: encoded) == fixture["value"])
  }

  /// `provider-catalog.json` is encoded through the server's `ServerProvider` schema.
  @Test("the schema-encoded provider catalog's limits decode")
  func catalogLimits() throws {
    struct Catalog: Decodable { var providers: [ServerProvider] }
    let catalog = try JSONDecoder().decode(Catalog.self, from: Fixture.data("provider-catalog"))
    let claude = try #require(catalog.providers.first { $0.driver == "claudeAgent" })
    let limits = try #require(claude.usageLimits)
    #expect(limits.windows.map(\.usedPercent) == [35, 52.5])
    #expect(limits.resetCredits?.availableCount == 2)
    #expect(claude.authWorkspaceId == "ws-tide")
    let account = try #require(UsageLimits.accounts([LimitSource(environmentId: "env", label: "Studio", providers: catalog.providers)]).first)
    #expect(account.plan == "Claude Max Subscription")
  }
}
