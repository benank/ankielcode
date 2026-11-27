import AnkielKit
import Foundation

/// Usage limits copy (RN `usageLimitsCopy.ts`, `resetLabels`), localized and locale-formatted.
enum UsageCopy {
  /// "2d 3h", "4h 5m", "12m" in the reader's locale (RN `formatDuration`).
  static func duration(_ seconds: TimeInterval) -> String {
    let seconds = max(0, seconds)
    let units: Set<Duration.UnitsFormatStyle.Unit> = seconds >= 86_400 ? [.days, .hours] : seconds >= 3600 ? [.hours, .minutes] : [.minutes]
    return Duration.seconds(Int(seconds)).formatted(.units(allowed: units, width: .narrow, maximumUnitCount: 2, zeroValueUnits: .show(length: 1)))
  }

  /// "resets in 2h 5m" (`full`) or just "2h 5m" (`compact`).
  static func reset(_ window: UsageWindow, now: Date, compact: Bool = false) -> String? {
    switch UsageLimits.resetCountdown(window, now: now) {
    case nil: nil
    case .now: String(localized: "resets now", comment: "usage limit")
    case .momentarily: String(localized: "Resets momentarily")
    case .after(let seconds): compact ? duration(seconds) : String(localized: "resets in \(duration(seconds))")
    }
  }

  /// "↻ +40% in 2h 5m": a pooled window's next refill.
  static func refill(_ reset: LimitPoolWindow.Reset, now: Date) -> String {
    let left = reset.at.timeIntervalSince(now)
    if left <= 0 { return String(localized: "↻ +\(reset.restoresPercent)% now", comment: "usage limit refill") }
    if left < 60 { return String(localized: "↻ +\(reset.restoresPercent)% Resets momentarily") }
    return String(localized: "↻ +\(reset.restoresPercent)% in \(duration(left))", comment: "usage limit refill")
  }

  static func pace(_ pace: LimitPace) -> String {
    switch pace {
    case .ahead: String(localized: "ahead of pace")
    case .on: String(localized: "on pace")
    case .under: String(localized: "under pace")
    }
  }

  static func notice(_ notice: LimitsNotice) -> String {
    switch notice {
    case .unsupported(let message): message ?? String(localized: "This account has no subscription limits.")
    case .probeFailed(let message): message ?? String(localized: "Could not read limits.")
    case .noneReported: String(localized: "No limits reported.")
    }
  }

  static func credits(_ credits: ResetCredits, now: Date) -> String {
    let count = credits.availableCount
    guard count > 0 else { return String(localized: "No reset credits banked") }
    if let expires = credits.nextExpiresAt {
      return String(localized: "\(count) reset credits banked · next expires in \(duration(expires.timeIntervalSince(now)))")
    }
    return String(localized: "\(count) reset credits banked")
  }

  static func outcome(_ result: ConsumeResetCreditResult) -> String {
    if let warning = result.warning { return warning }
    switch result.outcome.known {
    case .reset: return String(localized: "Reset applied. Your windows have cleared.")
    case .nothingToReset: return String(localized: "Nothing to reset right now.")
    case .noCredit: return String(localized: "No reset credit left.")
    case .alreadyRedeemed: return String(localized: "That credit was already redeemed.")
    case nil: return String(localized: "Reset applied. Your windows have cleared.")
    }
  }

  static func providerName(_ driver: String, displayName: String? = nil) -> String {
    if let displayName, !displayName.isEmpty, !displayName.contains("@") { return displayName }
    return ServerProvider(instanceId: driver, driver: driver).label
  }

  /// Account emails stay hidden until tapped (RN `RedactedEmail`).
  static let redactedEmail = "••••••@••••••"

  /// "Updated 3 min ago".
  static func checked(_ date: Date, now: Date) -> String {
    let relative = date.formatted(.relative(presentation: .named, unitsStyle: .abbreviated))
    return now.timeIntervalSince(date) < 60 ? String(localized: "Updated just now") : String(localized: "Updated \(relative)")
  }
}
