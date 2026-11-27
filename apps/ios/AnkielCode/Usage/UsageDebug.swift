#if DEBUG
  import AnkielKit
  import Foundation

  /// `ANKIEL_DEBUG_USAGE` (limits) and `ANKIEL_DEBUG_CONTEXT` (the thread's context window):
  /// canned, synthetic data so every state can be seen without a paid subscription. Nothing is
  /// sent to a computer; refreshes only wait.
  enum UsageDebug {
    static var environment: [String: String] { ProcessInfo.processInfo.environment }

    /// `fresh`, `near`, `stale`, `unavailable`, `pooled`, `empty`.
    static func sources(now: Date = .now) -> [LimitSource]? {
      guard let mode = environment["ANKIEL_DEBUG_USAGE"] else { return nil }
      func window(_ id: String, _ kind: UsageWindow.Kind, _ label: String, _ used: Double, in minutes: Double, length: Int?) -> UsageWindow {
        UsageWindow(id: id, kind: kind, label: label, usedPercent: used, resetsAt: now.addingTimeInterval(minutes * 60), windowDurationMins: length)
      }
      func provider(
        _ id: String, _ driver: String, plan: String?, email: String?, checked: Date, windows: [UsageWindow], credits: Int? = nil,
        external: ProviderUsageLimits.ExternalUsage? = nil, unavailable: ProviderUsageLimits.Unavailable? = nil
      ) -> ServerProvider {
        var provider = ServerProvider(instanceId: id, driver: driver)
        provider.authStatus = "authenticated"
        provider.authLabel = plan
        provider.authEmail = email
        provider.usageLimits = ProviderUsageLimits(
          checkedAt: checked, windows: windows,
          resetCredits: credits.map { ResetCredits(availableCount: $0, nextExpiresAt: now.addingTimeInterval(3 * 86_400)) },
          externalUsage: external, unavailable: unavailable)
        return provider
      }
      let claudeLink = ProviderUsageLimits.ExternalUsage(label: "Claude usage and resets", url: "https://claude.ai/settings/usage")
      let fresh = now.addingTimeInterval(-90)
      switch mode {
      case "fresh":
        return [
          LimitSource(
            environmentId: "debug-usage-studio", label: "Studio",
            providers: [
              provider(
                "codex", "codex", plan: "ChatGPT Plus Subscription", email: "tide@example.com", checked: fresh,
                windows: [
                  window("primary", .session, "Session", 18, in: 190, length: 300),
                  window("secondary", .weekly, "Weekly", 43, in: 5 * 1440, length: 10080),
                ], credits: 3),
              provider(
                "claudeAgent", "claudeAgent", plan: "Claude Max Subscription", email: "tide@example.com", checked: fresh,
                windows: [
                  window("five_hour", .session, "Session", 35, in: 120, length: 300),
                  window("seven_day", .weekly, "Weekly", 52, in: 3 * 1440, length: 10080),
                  window("seven_day_opus", .weekly, "Weekly · Opus", 12, in: 3 * 1440, length: 10080),
                ], external: claudeLink),
            ])
        ]
      case "near":
        return [
          LimitSource(
            environmentId: "debug-usage-studio", label: "Studio",
            providers: [
              provider(
                "codex", "codex", plan: "ChatGPT Pro 200 Subscription", email: "tide@example.com", checked: fresh,
                windows: [
                  window("primary", .session, "Session", 96, in: 14, length: 300),
                  window("secondary", .weekly, "Weekly", 88, in: 1440 + 300, length: 10080),
                ]),
              provider(
                "claudeAgent", "claudeAgent", plan: "Claude Pro Subscription", email: "tide@example.com", checked: fresh,
                windows: [
                  window("five_hour", .session, "Session", 100, in: 0.5, length: 300),
                  window("seven_day", .weekly, "Weekly", 100, in: 600, length: 10080),
                ]),
            ])
        ]
      case "stale":
        let old = now.addingTimeInterval(-3 * 3600)
        return [
          LimitSource(
            environmentId: "debug-usage-studio", label: "Studio",
            providers: [
              provider(
                "codex", "codex", plan: "ChatGPT Plus Subscription", email: "tide@example.com", checked: old,
                windows: [
                  window("primary", .session, "Session", 64, in: -40, length: 300),
                  window("secondary", .weekly, "Weekly", 43, in: 4 * 1440, length: 10080),
                ])
            ])
        ]
      case "unavailable":
        return [
          LimitSource(
            environmentId: "debug-usage-studio", label: "Studio",
            providers: [
              provider("claudeAgent", "claudeAgent", plan: nil, email: nil, checked: fresh, windows: [], unavailable: .init(reason: "probeFailed")),
              provider(
                "cursor", "cursor", plan: nil, email: nil, checked: fresh, windows: [],
                unavailable: .init(reason: "unsupported", message: "Cursor's free plan has no usage limits.")),
              provider(
                "codex", "codex", plan: nil, email: nil, checked: fresh, windows: [],
                external: .init(label: "ChatGPT usage and resets", url: "https://chatgpt.com/codex/settings/usage"),
                unavailable: .init(reason: "unsupported")),
            ]),
          LimitSource(environmentId: "debug-usage-laptop", label: "Laptop", providers: []),
        ]
      case "pooled":
        return [
          LimitSource(
            environmentId: "debug-usage-studio", label: "Studio",
            providers: [
              provider(
                "claudeAgent", "claudeAgent", plan: "Claude Max Subscription", email: "tide@example.com", checked: fresh,
                windows: [window("five_hour", .session, "Session", 70, in: 60, length: 300), window("seven_day", .weekly, "Weekly", 30, in: 2 * 1440, length: 10080)])
            ]),
          LimitSource(
            environmentId: "debug-usage-laptop", label: "Laptop",
            providers: [
              provider(
                "claude-work", "claudeAgent", plan: "Claude Pro Subscription", email: "harbor@example.com", checked: fresh,
                windows: [window("five_hour", .session, "Session", 20, in: 200, length: 300), window("seven_day", .weekly, "Weekly", 64, in: 4 * 1440, length: 10080)])
            ]),
        ]
      default:
        return []
      }
    }

    /// `low`, `high`, `over`, `compacting`, `compacted`, `unknown`: replaces any thread's context window.
    static func context(now: Date = .now) -> ContextWindowSnapshot?? {
      guard let mode = environment["ANKIEL_DEBUG_CONTEXT"] else { return nil }
      func window(_ used: Int, _ max: Int?) -> ContextWindowSnapshot {
        var window = ContextWindowSnapshot(usedTokens: used, maxTokens: max, updatedAt: now)
        window.inputTokens = used - used / 10
        window.cachedInputTokens = used / 2
        window.outputTokens = used / 10
        return window
      }
      switch mode {
      case "low": return .some(window(42_300, 400_000))
      case "high": return .some(window(372_000, 400_000))
      case "over": return .some(window(431_000, 400_000))
      case "compacting":
        var compacting = window(388_000, 400_000)
        compacting.compacting = true
        return .some(compacting)
      case "compacted":
        var compacted = ContextWindowSnapshot(usedTokens: 38_000, maxTokens: 400_000, updatedAt: now)
        compacted.fromCompaction = true
        compacted.totalProcessedTokens = 391_000
        return .some(compacted)
      case "unknown": return .some(window(58_000, nil))
      default: return .some(nil)
      }
    }
  }
#endif
