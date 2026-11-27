import AnkielKit
import Foundation

/// RN's scheduled-task wording (`scheduledTaskPresentation.ts`, `describeSchedule`).
enum ScheduledTaskCopy {
  static func schedule(_ task: ScheduledTask, timeZone: String?) -> String {
    switch task.schedule {
    case .webhook: return String(localized: "On webhook")
    case .once(let raw):
      guard let date = WireTimestamp(rawValue: raw).date else { return raw }
      return String(localized: "Once, \(date.formatted(.dateTime.month(.abbreviated).day().year())) at \(date.formatted(date: .omitted, time: .shortened))")
    case .interval(let everyMs): return interval(everyMs)
    case .fixedTime(let time, let weekdays):
      let days = weekdays.flatMap { $0.isEmpty ? nil : repeatLabel(Set($0)) } ?? String(localized: "Every day")
      let shown = timeOfDay(time)
      guard let zone = ScheduledTasks.timeZoneLabel(timeZone, at: task.nextRunAt?.date) else {
        return String(localized: "\(days) at \(shown)")
      }
      return String(localized: "\(days) at \(shown) \(zone)")
    case .unknown: return String(localized: "Unknown schedule")
    }
  }

  static func repeatLabel(_ days: Set<Int>) -> String {
    if days.count == 7 { return String(localized: "Every day") }
    if ScheduledTasks.isWeekdays(days) { return String(localized: "Weekdays") }
    let names = days.sorted().map(weekday).joined(separator: ", ")
    return names.isEmpty ? String(localized: "Choose days") : names
  }

  /// A weekday's short name, 0 being Sunday.
  static func weekday(_ index: Int) -> String {
    let symbols = Calendar.current.shortWeekdaySymbols
    return symbols.indices.contains(index) ? symbols[index] : "\(index)"
  }

  static func timeOfDay(_ value: String) -> String {
    guard let date = date(timeOfDay: value) else { return value }
    return date.formatted(date: .omitted, time: .shortened)
  }

  static func date(timeOfDay value: String) -> Date? {
    let parts = value.split(separator: ":").compactMap { Int($0) }
    guard parts.count == 2 else { return nil }
    return Calendar.current.date(bySettingHour: parts[0], minute: parts[1], second: 0, of: .now)
  }

  static func timeOfDay(_ date: Date) -> String {
    let parts = Calendar.current.dateComponents([.hour, .minute], from: date)
    return String(format: "%02d:%02d", parts.hour ?? 9, parts.minute ?? 0)
  }

  static func interval(_ everyMs: Int) -> String {
    switch ScheduledTasks.interval(everyMs) {
    case .every(let unit):
      switch unit {
      case .week: return String(localized: "Every week")
      case .day: return String(localized: "Every day")
      case .hour: return String(localized: "Every hour")
      case .minute: return String(localized: "Every minute")
      case .second: return String(localized: "Every second")
      case .millisecond: return String(localized: "Every millisecond")
      }
    case .amounts(let amounts):
      let duration = amounts.map { amount -> String in
        if amount.unit == .millisecond { return Duration.milliseconds(amount.count).formatted(.units(allowed: [.milliseconds], width: .wide)) }
        let seconds = amount.count * amount.unit.milliseconds / 1000
        let unit: Duration.UnitsFormatStyle.Unit =
          switch amount.unit {
          case .week: .weeks
          case .day: .days
          case .hour: .hours
          case .minute: .minutes
          default: .seconds
          }
        return Duration.seconds(seconds).formatted(.units(allowed: [unit], width: .wide))
      }.joined(separator: " ")
      return String(localized: "Every \(duration)")
    }
  }

  static func nextRun(_ next: WireTimestamp, now: Date = .now) -> String {
    switch ScheduledTasks.nextRun(next, now: now) {
    case .unavailable: return String(localized: "Next run unavailable")
    case .due: return String(localized: "Next run due")
    case .lessThanMinute: return String(localized: "Next run in less than a minute")
    case .minutes(let count):
      return String(localized: "Next run in \(Duration.seconds(count * 60).formatted(.units(allowed: [.minutes], width: .wide)))")
    case .hours(let count):
      return String(localized: "Next run in \(Duration.seconds(count * 3600).formatted(.units(allowed: [.hours], width: .wide)))")
    case .tomorrow(let date): return String(localized: "Next run tomorrow at \(date.formatted(date: .omitted, time: .shortened))")
    case .weekday(let date):
      return String(localized: "Next run \(date.formatted(.dateTime.weekday(.wide))) at \(date.formatted(date: .omitted, time: .shortened))")
    case .date(let date, let showYear):
      let day = showYear ? date.formatted(.dateTime.month(.abbreviated).day().year()) : date.formatted(.dateTime.month(.abbreviated).day())
      return String(localized: "Next run \(day) at \(date.formatted(date: .omitted, time: .shortened))")
    }
  }

  /// The line under a task's name: its schedule, then paused or when it runs next.
  static func summary(_ task: ScheduledTask, timeZone: String?) -> String {
    let schedule = schedule(task, timeZone: timeZone)
    if !task.enabled { return String(localized: "\(schedule) · Paused") }
    guard let next = task.nextRunAt else { return schedule }
    return String(localized: "\(schedule) · \(nextRun(next))")
  }
}
