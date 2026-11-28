import Foundation

/// `SnoozePresetSetting`: a duration, or a time on a day.
public enum SnoozePresetSetting: Sendable, Hashable {
  public enum Day: String, Sendable, Hashable {
    case today, tomorrow, sunday, monday, tuesday, wednesday, thursday, friday, saturday

    /// `Calendar` weekday (1 = Sunday), nil for today and tomorrow.
    var weekday: Int? {
      switch self {
      case .today, .tomorrow: nil
      case .sunday: 1
      case .monday: 2
      case .tuesday: 3
      case .wednesday: 4
      case .thursday: 5
      case .friday: 6
      case .saturday: 7
      }
    }
  }

  case after(minutes: Int)
  case at(day: Day, hour: Int, minute: Int)

  /// `DEFAULT_SNOOZE_PRESETS`.
  public static let defaults: [SnoozePresetSetting] = [
    .after(minutes: 60), .after(minutes: 180), .at(day: .today, hour: 18, minute: 0),
    .at(day: .tomorrow, hour: 9, minute: 0), .at(day: .monday, hour: 9, minute: 0),
  ]

  public var id: String {
    switch self {
    case .after(let minutes): "after:\(minutes)"
    case .at(let day, let hour, let minute): String(format: "at:%@:%02d:%02d", day.rawValue, hour, minute)
    }
  }
}

/// One choice in a snooze menu (`resolveSnoozePresets`, `state/threadSettled.ts`). The app turns
/// `label` into words and formats `wake`.
public struct SnoozePreset: Sendable, Hashable, Identifiable {
  public enum Label: Sendable, Hashable {
    case inMinutes(Int), inHours(Int), inDays(Int)
    case thisMorning, thisAfternoon, thisEvening, tomorrow, nextWeek
    /// `weekday` is a `Calendar` weekday; `next` when it is a week away.
    case weekday(Int, next: Bool)
  }

  public var id: String
  public var label: Label
  public var wake: Date
  /// Whether the label already names the day (so the menu shows only the time).
  public var labelNamesDay: Bool

  /// Soonest first, one per wake minute; a "today" time that has passed is left out.
  public static func resolve(
    _ settings: [SnoozePresetSetting] = SnoozePresetSetting.defaults, now: Date, calendar: Calendar = .current
  ) -> [SnoozePreset] {
    let presets = settings.compactMap { resolve($0, now: now, calendar: calendar) }
    let minute = { (preset: SnoozePreset) in Int((preset.wake.timeIntervalSince1970 / 60).rounded(.down)) }
    var seen = Set<Int>()
    return
      presets.enumerated().sorted { l, r in
        minute(l.element) != minute(r.element) ? minute(l.element) < minute(r.element) : l.offset < r.offset
      }
      .map(\.element).filter { seen.insert(minute($0)).inserted }
  }

  static func resolve(_ setting: SnoozePresetSetting, now: Date, calendar: Calendar) -> SnoozePreset? {
    switch setting {
    case .after(let minutes):
      let label: Label =
        minutes % (24 * 60) == 0 ? .inDays(minutes / (24 * 60)) : minutes % 60 == 0 ? .inHours(minutes / 60) : .inMinutes(minutes)
      return SnoozePreset(
        id: setting.id, label: label, wake: now.addingTimeInterval(TimeInterval(minutes * 60)), labelNamesDay: false)
    case .at(let day, let hour, let minute):
      let daysAhead: Int
      switch day {
      case .today: daysAhead = 0
      case .tomorrow: daysAhead = 1
      default:
        let today = calendar.component(.weekday, from: now)
        let gap = ((day.weekday ?? today) - today + 7) % 7
        daysAhead = gap == 0 ? 7 : gap
      }
      guard let base = calendar.date(byAdding: .day, value: daysAhead, to: now),
        let wake = calendar.date(bySettingHour: hour, minute: minute, second: 0, of: base), wake > now
      else { return nil }
      let label: Label
      if daysAhead == 0 {
        label = hour < 12 ? .thisMorning : hour < 17 ? .thisAfternoon : .thisEvening
      } else if daysAhead == 1 {
        label = .tomorrow
      } else if day == .monday {
        label = .nextWeek
      } else {
        label = .weekday(day.weekday ?? 1, next: daysAhead == 7)
      }
      return SnoozePreset(id: setting.id, label: label, wake: wake, labelNamesDay: !(daysAhead > 1 && day == .monday))
    }
  }
}

/// A snooze the user sets by hand (RN `resolveCustomSnooze`): a local date and time, or an amount
/// of minutes, hours or days from now. Nil when it would not end in the future.
public enum CustomSnooze: Sendable, Hashable {
  public enum Unit: String, Sendable, Hashable, CaseIterable { case minutes, hours, days }

  case date(Date)
  case duration(Int, Unit)

  public func wake(now: Date, calendar: Calendar = .current) -> Date? {
    let wake: Date
    switch self {
    case .duration(let amount, let unit):
      guard amount > 0 else { return nil }
      let seconds: TimeInterval = switch unit {
      case .minutes: 60
      case .hours: 3600
      case .days: 86_400
      }
      wake = now.addingTimeInterval(Double(amount) * seconds)
    case .date(let date):
      // The picker's minute, in local time: seconds dropped like RN's `HH:MM` round trip.
      var parts = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: date)
      parts.second = 0
      guard let minute = calendar.date(from: parts) else { return nil }
      wake = minute
    }
    return wake > now ? wake : nil
  }
}
