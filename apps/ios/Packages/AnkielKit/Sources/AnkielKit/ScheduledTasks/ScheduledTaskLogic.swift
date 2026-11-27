import Foundation

/// The schedule part of the editor (RN `ScheduleDraft`).
public struct ScheduleDraft: Sendable, Hashable {
  public enum Mode: String, Sendable, Hashable, CaseIterable { case fixedTime = "fixed_time", once, interval, webhook }

  public var mode: Mode = .fixedTime
  /// `HH:MM`, in the server's zone.
  public var timeOfDay = "09:00"
  public var runAt: Date?
  public var weekdays: Set<Int> = [1, 2, 3, 4, 5]
  public var intervalMinutes = "15"
  /// A webhook task's schedule, saved back as it came (webhook editing is not built here).
  public var webhook: JSONValue?

  public init() {}

  public init(_ schedule: ScheduledTaskSchedule) {
    switch schedule {
    case .fixedTime(let time, let days):
      timeOfDay = time
      weekdays = days.flatMap { $0.isEmpty ? nil : Set($0) } ?? Set(0...6)
    case .once(let runAt):
      mode = .once
      self.runAt = WireTimestamp(rawValue: runAt).date
    case .interval(let everyMs):
      mode = .interval
      let minutes = max(1, Double(everyMs) / 60_000)
      intervalMinutes = minutes.rounded() == minutes ? String(Int(minutes)) : String(minutes)
    case .webhook(let json):
      mode = .webhook
      webhook = json
    case .unknown:
      break
    }
  }

  /// `parseIntervalMinutes`: a comma reads as a decimal point.
  public static func minutes(_ text: String) -> Double? {
    Double(text.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: "."))
  }

  /// `scheduleFromDraft`: the schedule to save, nil when it is not valid.
  public func schedule() -> JSONValue? {
    switch mode {
    case .webhook:
      guard case .object(var fields)? = webhook else { return nil }
      // The server keeps the stored filters and secret when they are left out.
      fields["filters"] = nil
      if case .object(var signature)? = fields["signature"] {
        signature["secret"] = nil
        fields["signature"] = .object(signature)
      }
      return .object(fields)
    case .once:
      guard let runAt else { return nil }
      return ["type": "once", "runAt": .string(WireTimestamp(runAt).rawValue)]
    case .interval:
      guard let minutes = Self.minutes(intervalMinutes), minutes >= 1, minutes.isFinite else { return nil }
      return ["type": "interval", "everyMs": .number((minutes * 60_000).rounded())]
    case .fixedTime:
      let days = weekdays.sorted()
      guard timeOfDay.wholeMatch(of: /([01]?\d|2[0-3]):[0-5]\d/) != nil, !days.isEmpty, days.allSatisfy({ (0...6).contains($0) }) else {
        return nil
      }
      var fields: [String: JSONValue] = ["type": "fixed_time", "timeOfDay": .string(timeOfDay)]
      if days.count < 7 { fields["weekdays"] = .array(days.map { .number(Double($0)) }) }
      return .object(fields)
    }
  }
}

/// The editor's state (RN `ScheduledTaskDraft`), without thread binding: a bound task keeps its
/// thread because the save leaves `threadId` out.
public struct ScheduledTaskDraft: Sendable, Hashable {
  public enum Workspace: String, Sendable, Hashable, CaseIterable { case worktree, root, existingWorktree = "existing_worktree" }

  public var task: ScheduledTask?
  public var title = ""
  public var prompt = ""
  public var projectId: String?
  public var modelSelection: ModelSelection?
  public var schedule = ScheduleDraft()
  public var workspace = Workspace.worktree
  public var baseRef = ""
  public var checkoutPath = ""
  public var enabled = true
  public var startFromOrigin = true
  public var runtimeMode = RuntimeMode.fullAccess.rawValue

  /// `createDraft`.
  public init(projectId: String?, modelSelection: ModelSelection?) {
    self.projectId = projectId
    self.modelSelection = modelSelection
  }

  /// `editDraft`.
  public init(editing task: ScheduledTask) {
    self.task = task
    title = task.title
    prompt = task.prompt
    projectId = task.projectId
    modelSelection = task.modelSelection
    schedule = ScheduleDraft(task.schedule)
    let type = task.workspaceStrategy["type"]?.stringValue ?? "worktree"
    workspace = Workspace(rawValue: type) ?? .worktree
    baseRef = workspace == .worktree ? task.workspaceStrategy["baseRef"]?.stringValue ?? "" : ""
    checkoutPath = workspace == .existingWorktree ? task.workspaceStrategy["worktreePath"]?.stringValue ?? "" : ""
    enabled = task.enabled
    startFromOrigin = workspace == .worktree ? task.workspaceStrategy["startFromOrigin"]?.boolValue ?? false : true
    runtimeMode = task.runtimeMode
  }

  public enum Problem: Sendable, Hashable { case incomplete, schedule }

  /// The `scheduledTasks.upsert` input, or why it cannot be saved. `refs` are the project's
  /// branches, for an automatic worktree base.
  public func upsert(refs: [ScheduledTaskBranch]) -> Result<ScheduledTaskUpsert, ProblemError> {
    let title = title.trimmingCharacters(in: .whitespacesAndNewlines)
    let prompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let schedule = schedule.schedule() else { return .failure(ProblemError(problem: .schedule)) }
    guard !title.isEmpty, !prompt.isEmpty, let projectId, let modelSelection,
      workspace != .existingWorktree || !checkoutPath.trimmingCharacters(in: .whitespaces).isEmpty
    else { return .failure(ProblemError(problem: .incomplete)) }
    let strategy: JSONValue =
      switch workspace {
      case .root: ["type": "root"]
      case .existingWorktree: ["type": "existing_worktree", "worktreePath": .string(checkoutPath.trimmingCharacters(in: .whitespaces))]
      case .worktree:
        [
          "type": "worktree", "baseRef": .string(ScheduledTasks.worktreeBaseRef(baseRef, refs: refs)),
          "startFromOrigin": .bool(startFromOrigin),
        ]
      }
    return .success(
      ScheduledTaskUpsert(
        id: task?.id, requireExisting: task == nil ? nil : true, title: title, prompt: prompt, enabled: enabled, schedule: schedule,
        projectId: projectId, threadId: nil, unbindThread: nil, threadMode: nil, workspaceStrategy: strategy,
        modelSelection: modelSelection, runtimeMode: runtimeMode, interactionMode: task?.interactionMode ?? "default",
        creationSource: task?.creationSource ?? "mobile"))
  }

  public struct ProblemError: Error, Sendable, Hashable { public var problem: Problem }
}

/// What the list says about a schedule and its next run; the app words it.
public enum ScheduledTasks {
  /// `scheduledTaskWorktreeBaseRef`: an empty base is the project's default branch, else
  /// `main`/`master` (local or on origin), else `main`.
  public static func worktreeBaseRef(_ baseRef: String, refs: [ScheduledTaskBranch]) -> String {
    let picked = baseRef.trimmingCharacters(in: .whitespacesAndNewlines)
    if !picked.isEmpty { return picked }
    if let defaultRef = refs.first(where: { $0.isDefault == true }) { return defaultRef.name }
    for name in ["main", "master"] {
      if let match = refs.first(where: { $0.name == name || $0.name == "origin/\(name)" }) { return match.name }
    }
    return "main"
  }

  /// `scheduleTimeZoneLabel`: the server zone a fixed time runs in, with that instant's offset
  /// name (PST/PDT) when a run time is known, else the generic one (PT). nil without a zone.
  public static func timeZoneLabel(_ identifier: String?, at runAt: Date? = nil) -> String? {
    guard let identifier else { return nil }
    if ["Etc/UTC", "UTC", "GMT"].contains(identifier) { return "UTC" }
    guard let zone = TimeZone(identifier: identifier) else { return nil }
    let locale = Locale(identifier: "en_US")
    guard let runAt else { return zone.localizedName(for: .shortGeneric, locale: locale) }
    return zone.localizedName(for: zone.isDaylightSavingTime(for: runAt) ? .shortDaylightSaving : .shortStandard, locale: locale)
  }

  public enum IntervalUnit: Int, Sendable, Hashable, CaseIterable {
    case week, day, hour, minute, second, millisecond

    public var milliseconds: Int {
      switch self {
      case .week: 604_800_000
      case .day: 86_400_000
      case .hour: 3_600_000
      case .minute: 60_000
      case .second: 1_000
      case .millisecond: 1
      }
    }
  }

  public enum IntervalText: Sendable, Hashable {
    /// "Every hour".
    case every(IntervalUnit)
    /// "Every 1 hour 30 minutes".
    case amounts([Amount])

    public struct Amount: Sendable, Hashable {
      public var unit: IntervalUnit
      public var count: Int
    }
  }

  /// `formatScheduledTaskInterval`.
  public static func interval(_ everyMs: Int) -> IntervalText {
    var remaining = everyMs
    var parts: [IntervalText.Amount] = []
    for unit in IntervalUnit.allCases {
      let count = remaining / unit.milliseconds
      guard count > 0 else { continue }
      if count == 1, remaining == everyMs, remaining == unit.milliseconds { return .every(unit) }
      parts.append(.init(unit: unit, count: count))
      remaining %= unit.milliseconds
    }
    return .amounts(parts)
  }

  public enum NextRun: Sendable, Hashable {
    case unavailable, due, lessThanMinute
    case minutes(Int)
    case hours(Int)
    case tomorrow(Date)
    /// Within the week: "next Monday at 9:00 AM".
    case weekday(Date)
    case date(Date, showYear: Bool)
  }

  /// `formatNextScheduledTaskRun`: compares calendar days, not 24-hour spans (DST days differ).
  public static func nextRun(_ nextRunAt: WireTimestamp, now: Date, calendar: Calendar = .current) -> NextRun {
    guard let next = nextRunAt.date else { return .unavailable }
    let remaining = next.timeIntervalSince(now)
    if remaining <= 0 { return .due }
    let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: now), to: calendar.startOfDay(for: next)).day ?? 0
    if days == 0 {
      if remaining < 60 { return .lessThanMinute }
      let minutes = Int((remaining / 60).rounded())
      return minutes < 60 ? .minutes(minutes) : .hours(Int((remaining / 3600).rounded()))
    }
    if days == 1 { return .tomorrow(next) }
    if days <= 7 { return .weekday(next) }
    return .date(next, showYear: calendar.component(.year, from: next) != calendar.component(.year, from: now))
  }

  public static func isWeekdays(_ days: Set<Int>) -> Bool { days == [1, 2, 3, 4, 5] }
}
