import AnkielKit
import Foundation
import Observation
import SwiftUI

/// The list's words for kit values (the kit returns meaning; the catalog holds the words).
enum ThreadCopy {
  static func status(_ label: ThreadStatusLabel) -> String {
    switch label {
    case .approval: String(localized: "Approval", comment: "thread status, waiting for approval")
    case .input: String(localized: "Input", comment: "thread status, waiting for user input")
    case .failed: String(localized: "Failed", comment: "thread status")
    case .limited: String(localized: "Limited", comment: "thread status, usage limit reached")
    case .done: String(localized: "Done", comment: "thread status, turn finished")
    case .woke: String(localized: "Woke", comment: "thread came back from snooze")
    case .working: String(localized: "Working", comment: "thread status")
    case .waiting: String(localized: "Waiting", comment: "thread status")
    case .goal: String(localized: "Goal", comment: "thread status, working toward a goal")
    }
  }

  /// `relativeTime`: "<1m", "5m", "3h", "2d".
  static func elapsed(since date: Date, now: Date) -> String {
    let seconds = max(0, Int(now.timeIntervalSince(date)))
    if seconds < 60 { return String(localized: "<1m", comment: "compact elapsed time, under one minute") }
    let minutes = seconds / 60
    if minutes < 60 { return String(localized: "\(minutes)m", comment: "compact elapsed minutes") }
    let hours = minutes / 60
    if hours < 24 { return String(localized: "\(hours)h", comment: "compact elapsed hours") }
    return String(localized: "\(hours / 24)d", comment: "compact elapsed days")
  }

  /// `snoozeWakeLabel`: "now", "45m", "3h", "2d".
  static func wakesIn(_ wake: Date, now: Date) -> String {
    guard wake > now else { return String(localized: "now", comment: "a snoozed thread wakes now") }
    let minutes = max(1, Int(wake.timeIntervalSince1970 / 60) - Int(now.timeIntervalSince1970 / 60))
    if minutes < 60 { return String(localized: "\(minutes)m", comment: "compact elapsed minutes") }
    if minutes < 24 * 60 {
      return String(localized: "\(Int((Double(minutes) / 60).rounded(.up)))h", comment: "compact elapsed hours")
    }
    return String(localized: "\(Int((Double(minutes) / 1440).rounded(.up)))d", comment: "compact elapsed days")
  }

  static func wakes(at wake: Date) -> String {
    String(localized: "Wakes \(wake.formatted(date: .abbreviated, time: .shortened))")
  }

  static func snoozeLabel(_ preset: SnoozePreset) -> String {
    switch preset.label {
    case .inMinutes(let count): String(localized: "In \(count) minutes")
    case .inHours(let count): count == 1 ? String(localized: "In 1 hour") : String(localized: "In \(count) hours")
    case .inDays(let count): count == 1 ? String(localized: "In 1 day") : String(localized: "In \(count) days")
    case .thisMorning: String(localized: "This morning")
    case .thisAfternoon: String(localized: "This afternoon")
    case .thisEvening: String(localized: "This evening")
    case .tomorrow: String(localized: "Tomorrow")
    case .nextWeek: String(localized: "Next week")
    case .weekday(let weekday, let next):
      next
        ? String(localized: "Next \(Calendar.current.weekdaySymbols[weekday - 1])")
        : Calendar.current.weekdaySymbols[weekday - 1]
    }
  }

  /// When a preset wakes: the time, with the weekday when the label does not name the day.
  static func snoozeWhen(_ preset: SnoozePreset, now: Date) -> String {
    let time = preset.wake.formatted(date: .omitted, time: .shortened)
    if preset.labelNamesDay || Calendar.current.isDate(preset.wake, inSameDayAs: now) { return time }
    return "\(preset.wake.formatted(.dateTime.weekday(.abbreviated))) \(time)"
  }
}

/// One clock for every relative time on screen, ticking on the wall-clock minute. Only the
/// leaf text views read it, so a tick re-renders those labels and nothing else.
@Observable
final class MinuteClock {
  private(set) var now = Date.now

  func run() async {
    while !Task.isCancelled {
      now = .now
      let next = (now.timeIntervalSince1970 / 60).rounded(.down) * 60 + 60
      try? await Task.sleep(for: .seconds(next - Date.now.timeIntervalSince1970 + 0.05))
    }
  }
}

struct RelativeTimeText: View {
  let date: Date
  @Environment(MinuteClock.self) private var clock

  var body: some View {
    Text(ThreadCopy.elapsed(since: date, now: clock.now))
      .contentTransition(.numericText())
  }
}

struct SnoozeCountdownText: View {
  let wake: Date
  @Environment(MinuteClock.self) private var clock

  var body: some View {
    Label {
      Text(ThreadCopy.wakesIn(wake, now: clock.now))
    } icon: {
      Image(systemName: "moon.zzz")
    }
    .labelStyle(.titleAndIcon)
    .imageScale(.small)
  }
}
