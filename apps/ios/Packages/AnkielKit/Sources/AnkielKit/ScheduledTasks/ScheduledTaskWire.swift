import Foundation

/// `ScheduledTaskSchedule` (`packages/contracts/src/scheduledTask.ts`). A webhook schedule keeps
/// its JSON, since the phone shows it and saves it back without editing it.
public enum ScheduledTaskSchedule: Sendable, Hashable, Decodable {
  case interval(everyMs: Int)
  /// `timeOfDay` is `HH:MM` in the server's zone; `weekdays` nil is every day (0 is Sunday).
  case fixedTime(timeOfDay: String, weekdays: [Int]?)
  case once(runAt: String)
  case webhook(JSONValue)
  case unknown(String)

  enum CodingKeys: String, CodingKey { case type, everyMs, timeOfDay, weekdays, runAt }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    let type = try c.decode(String.self, forKey: .type)
    switch type {
    case "interval": self = .interval(everyMs: c.loose(Double.self, .everyMs).map { Int($0) } ?? 0)
    case "fixed_time": self = .fixedTime(timeOfDay: c.loose(String.self, .timeOfDay) ?? "09:00", weekdays: c.loose([Int].self, .weekdays))
    case "once": self = .once(runAt: c.loose(String.self, .runAt) ?? "")
    case "webhook": self = .webhook((try? JSONValue(from: decoder)) ?? ["type": "webhook"])
    default: self = .unknown(type)
    }
  }
}

/// `ScheduledTask`.
public struct ScheduledTask: Sendable, Hashable, Decodable, Identifiable {
  public enum RunStatus: String, Sendable, Hashable { case never, running, succeeded, failed }
  public enum ThreadMode: String, Sendable, Hashable, CaseIterable { case newThread = "new_thread", `continue`, freshSession = "fresh_session" }

  public var id: String
  public var title: String
  public var prompt: String
  public var enabled: Bool
  public var schedule: ScheduledTaskSchedule
  public var projectId: String
  public var threadId: String?
  /// Absent from servers before thread modes; their bound tasks continue the conversation.
  public var threadModeRaw: String?
  public var workspaceStrategy: JSONValue
  public var modelSelection: ModelSelection
  public var runtimeMode: String
  public var interactionMode: String
  public var creationSource: String?
  public var nextRunAt: WireTimestamp?
  public var lastRunAt: WireTimestamp?
  public var lastRunStatus: WireEnum<RunStatus>
  public var lastRunError: String?
  public var runCount: Int
  /// The webhook's path, its URL when the server knows its address, and whether it signs.
  public var webhookPath: String?
  public var webhookURL: String?

  enum CodingKeys: String, CodingKey {
    case id, title, prompt, enabled, schedule, projectId, threadId, threadMode, workspaceStrategy, modelSelection, runtimeMode
    case interactionMode, creationSource, nextRunAt, lastRunAt, lastRunStatus, lastRunError, runCount, webhook
  }

  struct Webhook: Decodable {
    var path: String?
    var url: String?
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    title = try c.decode(String.self, forKey: .title)
    prompt = c.loose(String.self, .prompt) ?? ""
    enabled = c.loose(Bool.self, .enabled) ?? false
    schedule = (try? c.decode(ScheduledTaskSchedule.self, forKey: .schedule)) ?? .unknown("")
    projectId = try c.decode(String.self, forKey: .projectId)
    threadId = c.loose(String.self, .threadId)
    threadModeRaw = c.loose(String.self, .threadMode)
    workspaceStrategy = (try? c.decode(JSONValue.self, forKey: .workspaceStrategy)) ?? ["type": "worktree", "baseRef": "main"]
    modelSelection = try c.decode(ModelSelection.self, forKey: .modelSelection)
    runtimeMode = c.loose(String.self, .runtimeMode) ?? RuntimeMode.fullAccess.rawValue
    interactionMode = c.loose(String.self, .interactionMode) ?? "default"
    creationSource = c.loose(String.self, .creationSource)
    nextRunAt = c.loose(WireTimestamp.self, .nextRunAt)
    lastRunAt = c.loose(WireTimestamp.self, .lastRunAt)
    lastRunStatus = c.loose(WireEnum<RunStatus>.self, .lastRunStatus) ?? .known(.never)
    lastRunError = c.loose(String.self, .lastRunError)
    runCount = c.loose(Double.self, .runCount).map { Int($0) } ?? 0
    let webhook = c.loose(Webhook.self, .webhook)
    webhookPath = webhook?.path
    webhookURL = webhook?.url
  }

  /// `scheduledTaskThreadMode`.
  public var threadMode: ThreadMode {
    threadModeRaw.flatMap(ThreadMode.init(rawValue:)) ?? (threadId == nil ? .newThread : .continue)
  }

  public var isWebhook: Bool { if case .webhook = schedule { true } else { false } }
}

/// `ScheduledTaskListResult`, each item of `scheduledTasks.subscribe {}`.
public struct ScheduledTaskList: Sendable, Hashable, Decodable {
  public static let rpcTag = "scheduledTasks.subscribe"
  public var tasks: [ScheduledTask]
  /// The server's IANA zone for fixed-time schedules (absent from older servers).
  public var timeZone: String?

  public init(tasks: [ScheduledTask], timeZone: String?) {
    self.tasks = tasks
    self.timeZone = timeZone
  }

  enum CodingKeys: String, CodingKey { case tasks, timeZone }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    tasks = c.loose(LossyArray<ScheduledTask>.self, .tasks)?.elements ?? []
    timeZone = c.loose(String.self, .timeZone)
  }
}

/// `scheduledTasks.upsert`.
public struct ScheduledTaskUpsert: Sendable, Hashable, Encodable {
  public static let rpcTag = "scheduledTasks.upsert"
  public var id: String?
  public var requireExisting: Bool?
  public var title: String
  public var prompt: String
  public var enabled: Bool
  public var schedule: JSONValue
  public var projectId: String
  public var threadId: String?
  public var unbindThread: Bool?
  public var threadMode: String?
  public var workspaceStrategy: JSONValue
  public var modelSelection: ModelSelection
  public var runtimeMode: String
  public var interactionMode: String
  public var creationSource: String?
}

/// `scheduledTasks.setEnabled {id, enabled}`.
public struct ScheduledTaskSetEnabled: Sendable, Hashable, Encodable {
  public static let rpcTag = "scheduledTasks.setEnabled"
  public var id: String
  public var enabled: Bool
  public init(id: String, enabled: Bool) {
    self.id = id
    self.enabled = enabled
  }
}

/// `scheduledTasks.runNow {id}`, `scheduledTasks.delete {id}`.
public struct ScheduledTaskRef: Sendable, Hashable, Encodable {
  public static let runNowTag = "scheduledTasks.runNow"
  public static let deleteTag = "scheduledTasks.delete"
  public var id: String
  public init(id: String) { self.id = id }
}

/// `{task}`, the answer to upsert, setEnabled and runNow.
public struct ScheduledTaskMutation: Sendable, Hashable, Decodable {
  public var task: ScheduledTask
}

/// One branch from `vcs.listRefs`, for a worktree's automatic base.
public struct ScheduledTaskBranch: Sendable, Hashable, Decodable {
  public var name: String
  public var isDefault: Bool?
  public init(name: String, isDefault: Bool? = nil) {
    self.name = name
    self.isDefault = isDefault
  }
}

public struct ScheduledTaskRefList: Sendable, Decodable {
  public var refs: [ScheduledTaskBranch]
}

/// Changing scheduled tasks needs `orchestration:operate` (RN `upsertScheduledTask.permissionAtom`).
public enum ScheduledTaskScope {
  public static let operate = "orchestration:operate"
}
