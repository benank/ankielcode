import AnkielKit
import Foundation

/// `--usage`: read-only. Each provider's raw `usageLimits` from the config, a forced
/// `server.refreshProviders {}` (the answer, and whether `providerStatuses` follows on the config
/// stream), the accounts, pools and widget snapshot the app would show, and every listed thread's
/// context window.
func probeUsage(_ session: EnvironmentSession, label: String) async throws {
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.sortedKeys]
  encoder.dateEncodingStrategy = .iso8601
  func show(_ providers: [ServerProvider], _ title: String) {
    print(title)
    for provider in providers {
      let limits = provider.usageLimits.flatMap { try? encoder.encode($0) }.map { String(decoding: $0, as: UTF8.self) } ?? "nil"
      print("  \(provider.instanceId) [\(provider.driver)] enabled=\(provider.enabled) installed=\(provider.installed) auth=\(provider.authStatus ?? "nil") plan=\(provider.authLabel ?? "nil")")
      print("    usageLimits: \(limits)")
    }
  }
  var providers = session.initialConfig.providers
  show(providers, "config providers: \(providers.count)")

  let started = ContinuousClock.now
  let raw = try await session.rpc.call(RefreshProvidersRequest.rpcTag, payload: RefreshProvidersRequest(), as: JSONValue.self)
  let refreshed: [JSONValue] = if case .array(let list)? = raw["providers"] { list } else { [] }
  print("\nrefreshProviders: \(refreshed.count) providers in \((ContinuousClock.now - started).formatted(.units(allowed: [.milliseconds])))")
  for provider in refreshed {
    let limits = provider["usageLimits"]?.compactDescription ?? "absent"
    print("  \(provider["instanceId"]?.stringValue ?? "?"): usageLimits \(limits)")
  }

  // Does the config stream push the refreshed list too?
  let (events, continuation) = AsyncStream<[ServerProvider]?>.makeStream()
  let watcher = Task {
    while let event = try? await session.nextConfigEvent() {
      if case .providers(let list) = event {
        continuation.yield(list)
        return
      }
    }
    continuation.yield(nil)
  }
  let timer = Task {
    try? await Task.sleep(for: .seconds(8))
    continuation.yield(nil)
  }
  var iterator = events.makeAsyncIterator()
  let followed = await iterator.next() ?? nil
  watcher.cancel()
  timer.cancel()
  if let followed {
    print("providerStatuses followed the refresh: \(followed.count) providers")
    providers = followed
  } else {
    print("no providerStatuses within 8 s of the refresh")
  }

  let sources = [LimitSource(environmentId: session.environmentId, label: label, providers: providers)]
  let accounts = UsageLimits.accounts(sources)
  print("\naccounts: \(accounts.count), notices: \(UsageLimits.notices(sources).map { "\($0.subject): \($0.notice)" })")
  print("external links: \(UsageLimits.externalLinks(sources).map(\.url))")
  for pool in UsageLimits.pools(accounts, now: .now) {
    print("  pool \(pool.driver): \(pool.accounts.count) accounts")
    for window in UsageLimits.displayWindows(pool) {
      print("    \(window.label) [\(window.kind.rawValue)] \(window.remainingPercent)% left, pace \(window.pace?.rawValue ?? "-"), next reset \(window.resets.first.map { $0.at.formatted(.iso8601) } ?? "-")")
    }
  }
  let snapshot = UsageWidgetSnapshot.build(sources)
  print("widget snapshot: \(String(decoding: try encoder.encode(snapshot), as: UTF8.self))")

  let shellStream = try await session.subscribeShell(session.initialConfig.shellSubscription)
  var shell = ShellState(awaitingCompletion: true)
  for try await item in shellStream {
    shell.apply(item)
    if shell.status == .live { break }
  }
  print("\ncontext windows (\(shell.threads.count) threads):")
  for thread in shell.threads.prefix(20) {
    let projection = try await usageSnapshot(session, threadId: thread.id)
    let window = ContextWindow.derive(projection)
    let text = window.map {
      "\(ContextWindow.formatTokens($0.usedTokens)) / \(ContextWindow.formatTokens($0.maxTokens)) (\($0.shownPercent.map { "\($0)%" } ?? "no max"), \($0.level))\($0.fromCompaction ? " compacted" : "")"
    } ?? "none"
    print("  \(thread.title.prefix(40)) — turns \(projection.providerTurns.count) providerThreads \(projection.providerThreads.count): \(text)")
  }
}

private func usageSnapshot(_ session: EnvironmentSession, threadId: String) async throws -> ThreadProjection {
  let stream = try await session.rpc.stream(ThreadSubscription.rpcTag, payload: ThreadSubscription(threadId: threadId), of: ThreadStreamItem.self)
  for try await item in stream {
    if case .snapshot(let snapshot) = item { return snapshot.projection }
  }
  throw ProbeFailure(description: "No snapshot for \(threadId)")
}
