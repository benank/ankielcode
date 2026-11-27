import Foundation
import Testing

@testable import AnkielKit

/// Scheduled tasks: the editor's draft and its save (RN `scheduledTaskDraft.ts`), the list's
/// schedule and next-run wording (`scheduledTaskPresentation.ts`), the server time zone label
/// (`scheduledTaskTimeZone.ts`) and a worktree's automatic base (`scheduledTaskWorktree.ts`).
@Suite("Scheduled tasks")
struct ScheduledTaskTests {
  static let model = ModelSelection(instanceId: "devReplay", model: "showcase", options: nil)

  static func task(schedule: String, workspace: String = #"{"type":"worktree","baseRef":"develop","startFromOrigin":true}"#, extra: String = "") throws -> ScheduledTask {
    try decode(
      ScheduledTask.self,
      json: """
        {"id":"task-1","title":"Morning tides","prompt":"Check the tide table","enabled":true,"schedule":\(schedule),
         "projectId":"proj-tide","threadId":null,"workspaceStrategy":\(workspace),
         "modelSelection":{"instanceId":"devReplay","model":"showcase"},"runtimeMode":"full-access","interactionMode":"default",
         "createdBy":"user","creationSource":"web","createdAt":"2026-11-01T00:00:00.000Z","updatedAt":"2026-11-01T00:00:00.000Z",
         "nextRunAt":"2026-11-02T17:00:00.000Z","lastRunAt":null,"lastRunStatus":"never","lastRunError":null,"runCount":0\(extra)}
        """)
  }

  @Test("a new draft starts on weekdays at nine, full access, in a worktree")
  func newDraft() throws {
    var draft = ScheduledTaskDraft(projectId: "proj-tide", modelSelection: Self.model)
    #expect(draft.schedule.mode == .fixedTime)
    #expect(draft.schedule.weekdays == [1, 2, 3, 4, 5])
    #expect(draft.runtimeMode == "full-access")
    #expect(draft.upsert(refs: []) == .failure(.init(problem: .incomplete)))
    draft.title = "  Morning tides "
    draft.prompt = "Check the tide table"
    let input = try draft.upsert(refs: [ScheduledTaskBranch(name: "trunk", isDefault: true)]).get()
    #expect(input.title == "Morning tides")
    #expect(input.schedule == ["type": "fixed_time", "timeOfDay": "09:00", "weekdays": [1, 2, 3, 4, 5]])
    #expect(input.workspaceStrategy == ["type": "worktree", "baseRef": "trunk", "startFromOrigin": true])
    #expect(input.id == nil && input.requireExisting == nil && input.creationSource == "mobile")
  }

  @Test("schedules round-trip through the draft and refuse what the server would")
  func schedules() throws {
    var schedule = ScheduleDraft()
    schedule.weekdays = Set(0...6)
    #expect(schedule.schedule() == ["type": "fixed_time", "timeOfDay": "09:00"])
    schedule.weekdays = []
    #expect(schedule.schedule() == nil)
    schedule.weekdays = [3]
    schedule.timeOfDay = "24:00"
    #expect(schedule.schedule() == nil)
    schedule.timeOfDay = "7:05"
    #expect(schedule.schedule() != nil)

    schedule.mode = .interval
    schedule.intervalMinutes = "1,5"
    #expect(schedule.schedule() == ["type": "interval", "everyMs": 90_000])
    schedule.intervalMinutes = "0.5"
    #expect(schedule.schedule() == nil)

    schedule.mode = .once
    #expect(schedule.schedule() == nil)
    schedule.runAt = WireTimestamp(rawValue: "2026-12-01T09:30:00.000Z").date
    #expect(schedule.schedule() == ["type": "once", "runAt": "2026-12-01T09:30:00.000Z"])

    let fixed = ScheduleDraft(.fixedTime(timeOfDay: "06:15", weekdays: nil))
    #expect(fixed.weekdays == Set(0...6))
    #expect(ScheduleDraft(.interval(everyMs: 3_600_000)).intervalMinutes == "60")
    #expect(ScheduleDraft(.interval(everyMs: 30_000)).intervalMinutes == "1")
  }

  @Test("a webhook task saves its schedule back without filters or a secret")
  func webhook() throws {
    let task = try Self.task(
      schedule: #"{"type":"webhook","signature":{"header":"x-hub-signature-256","encoding":"hex","prefix":"sha256="},"filters":[{"path":"body.action","op":"exists"}],"dedupe":{"replayKey":"{{headers.x-id}}"}}"#,
      extra: #","webhook":{"path":"/api/hooks/abc","url":null,"hasSecret":true}"#)
    #expect(task.isWebhook)
    #expect(task.webhookPath == "/api/hooks/abc")
    let draft = ScheduledTaskDraft(editing: task)
    #expect(draft.schedule.mode == .webhook)
    let schedule = try #require(draft.schedule.schedule())
    #expect(schedule["filters"] == nil)
    #expect(schedule["signature"]?["header"] == "x-hub-signature-256")
    #expect(schedule["dedupe"]?["replayKey"] == "{{headers.x-id}}")
  }

  @Test("editing keeps the task's id, workspace, thread and modes")
  func editing() throws {
    let task = try Self.task(schedule: #"{"type":"interval","everyMs":900000}"#)
    let draft = ScheduledTaskDraft(editing: task)
    #expect(draft.schedule.mode == .interval)
    #expect(draft.schedule.intervalMinutes == "15")
    #expect(draft.baseRef == "develop")
    #expect(draft.startFromOrigin)
    let input = try draft.upsert(refs: []).get()
    #expect(input.id == "task-1" && input.requireExisting == true)
    #expect(input.threadId == nil && input.threadMode == nil)
    #expect(input.creationSource == "web")
    #expect(input.workspaceStrategy == ["type": "worktree", "baseRef": "develop", "startFromOrigin": true])
    let root = ScheduledTaskDraft(editing: try Self.task(schedule: #"{"type":"once","runAt":"2026-12-01T09:30:00.000Z"}"#, workspace: #"{"type":"root"}"#))
    #expect(root.workspace == .root && root.startFromOrigin)
    var checkout = root
    checkout.workspace = .existingWorktree
    #expect(checkout.upsert(refs: []) == .failure(.init(problem: .incomplete)))
    checkout.checkoutPath = " /work/tide-wt "
    #expect(try checkout.upsert(refs: []).get().workspaceStrategy == ["type": "existing_worktree", "worktreePath": "/work/tide-wt"])
  }

  @Test("thread modes default from the thread on older servers")
  func threadModes() throws {
    #expect(try Self.task(schedule: #"{"type":"interval","everyMs":60000}"#).threadMode == .newThread)
    #expect(try Self.task(schedule: #"{"type":"interval","everyMs":60000}"#, extra: #","threadMode":"fresh_session""#).threadMode == .freshSession)
  }

  @Test("a worktree's empty base is the default branch, then main or master, then main")
  func worktreeBase() {
    #expect(ScheduledTasks.worktreeBaseRef(" feature/x ", refs: []) == "feature/x")
    #expect(ScheduledTasks.worktreeBaseRef("", refs: [.init(name: "main"), .init(name: "trunk", isDefault: true)]) == "trunk")
    #expect(ScheduledTasks.worktreeBaseRef("", refs: [.init(name: "origin/master")]) == "origin/master")
    #expect(ScheduledTasks.worktreeBaseRef("", refs: [.init(name: "dev")]) == "main")
  }

  @Test("the server zone reads as its short name, by the run's offset when known")
  func timeZones() throws {
    #expect(ScheduledTasks.timeZoneLabel(nil) == nil)
    #expect(ScheduledTasks.timeZoneLabel("Etc/UTC") == "UTC")
    #expect(ScheduledTasks.timeZoneLabel("America/Los_Angeles") == "PT")
    #expect(ScheduledTasks.timeZoneLabel("America/Los_Angeles", at: try #require(WireTimestamp(rawValue: "2026-01-15T17:00:00.000Z").date)) == "PST")
    #expect(ScheduledTasks.timeZoneLabel("America/Los_Angeles", at: try #require(WireTimestamp(rawValue: "2026-07-15T16:00:00.000Z").date)) == "PDT")
    #expect(ScheduledTasks.timeZoneLabel("Not/AZone") == nil)
  }

  @Test("intervals read as one unit or as amounts")
  func intervals() {
    #expect(ScheduledTasks.interval(3_600_000) == .every(.hour))
    #expect(ScheduledTasks.interval(604_800_000) == .every(.week))
    #expect(ScheduledTasks.interval(5_400_000) == .amounts([.init(unit: .hour, count: 1), .init(unit: .minute, count: 30)]))
    #expect(ScheduledTasks.interval(7_200_000) == .amounts([.init(unit: .hour, count: 2)]))
    #expect(ScheduledTasks.interval(1_500) == .amounts([.init(unit: .second, count: 1), .init(unit: .millisecond, count: 500)]))
  }

  @Test("the next run counts calendar days, across a DST change too")
  func nextRun() throws {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = try #require(TimeZone(identifier: "America/Los_Angeles"))
    let now = try #require(WireTimestamp(rawValue: "2026-11-01T15:00:00.000Z").date)  // 8 AM PDT... DST ends at 2 AM, so 7 AM PST
    func at(_ raw: String) -> ScheduledTasks.NextRun { ScheduledTasks.nextRun(WireTimestamp(rawValue: raw), now: now, calendar: calendar) }
    #expect(at("2026-11-01T14:00:00.000Z") == .due)
    #expect(at("2026-11-01T15:00:30.000Z") == .lessThanMinute)
    #expect(at("2026-11-01T15:20:00.000Z") == .minutes(20))
    #expect(at("2026-11-01T18:00:00.000Z") == .hours(3))
    // 11 PM PST is still today; 1 AM the next day is tomorrow.
    #expect(at("2026-11-02T07:00:00.000Z") == .hours(16))
    #expect(at("2026-11-02T09:00:00.000Z") == .tomorrow(try #require(WireTimestamp(rawValue: "2026-11-02T09:00:00.000Z").date)))
    if case .weekday = at("2026-11-05T17:00:00.000Z") {} else { Issue.record("within a week") }
    #expect(at("2026-12-01T17:00:00.000Z") == .date(try #require(WireTimestamp(rawValue: "2026-12-01T17:00:00.000Z").date), showYear: false))
    if case .date(_, true) = at("2027-01-20T17:00:00.000Z") {} else { Issue.record("shows the year") }
    #expect(ScheduledTasks.nextRun(WireTimestamp(rawValue: "soon"), now: now) == .unavailable)
  }

  @Test("a list decodes tolerantly, keeping the server zone")
  func list() throws {
    let task = try Self.task(schedule: #"{"type":"fixed_time","timeOfDay":"09:00","weekdays":[1,3]}"#)
    #expect(task.schedule == .fixedTime(timeOfDay: "09:00", weekdays: [1, 3]))
    let list = try decode(
      ScheduledTaskList.self,
      json: #"{"tasks":[{"id":"broken"},{"id":"t2","title":"Later","prompt":"p","enabled":false,"schedule":{"type":"someday"},"projectId":"p","threadId":"th","workspaceStrategy":{"type":"root"},"modelSelection":{"instanceId":"x","model":"y"},"runtimeMode":"auto","interactionMode":"plan","nextRunAt":null,"lastRunAt":"2026-11-01T00:00:00.000Z","lastRunStatus":"failed","lastRunError":"boom","runCount":3}],"timeZone":"Europe/Berlin"}"#
    )
    #expect(list.tasks.map(\.id) == ["t2"])
    #expect(list.timeZone == "Europe/Berlin")
    #expect(list.tasks[0].schedule == .unknown("someday"))
    #expect(list.tasks[0].lastRunStatus == .failed)
    #expect(list.tasks[0].threadMode == .continue)
  }

  @Test("requests encode as their checked-in fixtures")
  func fixtures() throws {
    var draft = ScheduledTaskDraft(projectId: "proj-tide", modelSelection: Self.model)
    draft.title = "Morning tides"
    draft.prompt = "Check the tide table"
    let created = try draft.upsert(refs: []).get()
    var edited = ScheduledTaskDraft(editing: try Self.task(schedule: #"{"type":"interval","everyMs":900000}"#))
    edited.schedule.intervalMinutes = "30"
    edited.enabled = false
    let samples: [(String, any Encodable & Sendable)] = [
      ("scheduled-task-create", created),
      ("scheduled-task-edit", try edited.upsert(refs: []).get()),
      ("scheduled-task-set-enabled", ScheduledTaskSetEnabled(id: "task-1", enabled: false)),
      ("scheduled-task-ref", ScheduledTaskRef(id: "task-1")),
    ]
    let directory = URL(filePath: #filePath).deletingLastPathComponent().appending(path: "Fixtures/commands")
    for (name, value) in samples {
      let encoded = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder.wire.encode(value))
      let url = directory.appending(path: "\(name).json")
      if ProcessInfo.processInfo.environment["ANKIEL_WRITE_COMMAND_FIXTURES"] == "1" {
        let pretty = JSONEncoder()
        pretty.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        let schema = name == "scheduled-task-set-enabled" ? "scheduledTaskSetEnabled" : name == "scheduled-task-ref" ? "scheduledTaskRef" : "scheduledTaskUpsert"
        try pretty.encode(["schema": .string(schema), "value": encoded] as JSONValue).write(to: url)
      }
      let fixture = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url))
      #expect(encoded == fixture["value"], "\(name)")
    }
  }
}
