import AnkielKit
import Foundation

/// Debug launch hooks for scheduled tasks (README, "Scheduled tasks"). `ANKIEL_DEBUG_SCHEDULED=fixture`
/// shows synthetic tasks on a "Fixture Mac" with a recording sink instead of a computer
/// (`readonly` withholds `orchestration:operate`). `ANKIEL_DEBUG_SCHEDULED_OPEN=new` or
/// `edit:<taskId>` opens the editor once the page shows (with `ANKIEL_DEBUG_ROUTE=settings-scheduled`).
@MainActor
enum ScheduledTasksDebug {
  static let environmentId = "debug-scheduled"

  #if DEBUG
    private static var mode: String? { ProcessInfo.processInfo.environment["ANKIEL_DEBUG_SCHEDULED"] }
    private static var opened = false
  #endif

  static func model() -> ScheduledTasksModel? {
    #if DEBUG
      guard let mode else { return nil }
      let model = ScheduledTasksModel(
        registry: nil, sink: FixtureScheduledTaskSink(),
        fixture: [.init(id: environmentId, label: "Fixture Mac", list: FixtureScheduledTaskSink.list)])
      model.readonlyFixture = mode == "readonly"
      return model
    #else
      nil
    #endif
  }

  static var projects: [ProjectShell]? {
    #if DEBUG
      guard mode != nil else { return nil }
      let json = #"[{"id":"proj-tide","title":"tide-chart","workspaceRoot":"/work/tide-chart","createdAt":"2026-11-01T00:00:00.000Z","updatedAt":"2026-11-01T00:00:00.000Z"},{"id":"proj-buoy","title":"buoy-feed","workspaceRoot":"/work/buoy-feed","createdAt":"2026-11-01T00:00:00.000Z","updatedAt":"2026-11-01T00:00:00.000Z"}]"#
      return (try? JSONDecoder().decode([ProjectShell].self, from: Data(json.utf8))) ?? []
    #else
      nil
    #endif
  }

  static var modelSelection: ModelSelection? {
    #if DEBUG
      mode == nil ? nil : ModelSelection(instanceId: "devReplay", model: "showcase")
    #else
      nil
    #endif
  }

  /// `ANKIEL_DEBUG_SCHEDULED_PRESET=project=<title>;model=<instanceId>/<model>;workspace=root`:
  /// a new task's defaults, so a live test never picks a paid model or a real project.
  static func preset(_ draft: inout ScheduledTaskDraft, environment: EnvironmentModel?) {
    #if DEBUG
      guard let value = ProcessInfo.processInfo.environment["ANKIEL_DEBUG_SCHEDULED_PRESET"] else { return }
      for pair in value.split(separator: ";") {
        let parts = pair.split(separator: "=", maxSplits: 1).map(String.init)
        guard parts.count == 2 else { continue }
        switch parts[0] {
        case "project": draft.projectId = environment?.shell.snapshot?.projects.first { $0.title == parts[1] }?.id
        case "model":
          let model = parts[1].split(separator: "/", maxSplits: 1).map(String.init)
          if model.count == 2 { draft.modelSelection = ModelSelection(instanceId: model[0], model: model[1]) }
        case "workspace": draft.workspace = ScheduledTaskDraft.Workspace(rawValue: parts[1]) ?? draft.workspace
        default: break
        }
      }
    #endif
  }

  static func opening(_ model: ScheduledTasksModel) -> ScheduledTaskEditing? {
    #if DEBUG
      guard !opened, let value = ProcessInfo.processInfo.environment["ANKIEL_DEBUG_SCHEDULED_OPEN"] else { return nil }
      opened = true
      let environmentId = model.computers.first?.id ?? environmentId
      if value.hasPrefix("edit:") {
        let id = String(value.dropFirst(5))
        return model.task(id, environmentId: environmentId).map { ScheduledTaskEditing(environmentId: environmentId, task: $0) }
      }
      return ScheduledTaskEditing(environmentId: environmentId)
    #else
      nil
    #endif
  }
}

#if DEBUG
  /// Synthetic tasks about a made-up tide-chart app; writes are recorded, never sent.
  @MainActor
  final class FixtureScheduledTaskSink: ScheduledTaskSink {
    private(set) var writes: [String] = []

    static var list: ScheduledTaskList {
      func task(_ json: String) -> ScheduledTask? { try? JSONDecoder().decode(ScheduledTask.self, from: Data(json.utf8)) }
      let soon = WireTimestamp(Date.now.addingTimeInterval(25 * 60)).rawValue
      let tomorrow = WireTimestamp(Date.now.addingTimeInterval(20 * 3600)).rawValue
      let base = #""projectId":"proj-tide","workspaceStrategy":{"type":"worktree","baseRef":"main","startFromOrigin":true},"modelSelection":{"instanceId":"devReplay","model":"showcase"},"runtimeMode":"full-access","interactionMode":"default","creationSource":"web","runCount":4"#
      return ScheduledTaskList(
        tasks: [
          task(#"{"id":"task-morning","title":"Morning tide check","prompt":"Check today's tide table for gaps.","enabled":true,"schedule":{"type":"fixed_time","timeOfDay":"07:30","weekdays":[1,2,3,4,5]},"threadId":null,"nextRunAt":"\#(tomorrow)","lastRunStatus":"succeeded","lastRunError":null,\#(base)}"#),
          task(#"{"id":"task-feed","title":"Buoy feed health","prompt":"Ping the buoy feed and report stale stations.","enabled":true,"schedule":{"type":"interval","everyMs":5400000},"threadId":"thread-feed","threadMode":"continue","nextRunAt":"\#(soon)","lastRunStatus":"failed","lastRunError":"The buoy feed answered 502.",\#(base)}"#),
          task(#"{"id":"task-release","title":"Release notes on tag","prompt":"Draft release notes for {{body.ref}}.","enabled":false,"schedule":{"type":"webhook","signature":null},"threadId":null,"nextRunAt":null,"lastRunStatus":"never","lastRunError":null,"webhook":{"path":"/api/scheduled-tasks/webhook/abc123","url":null,"hasSecret":false},\#(base)}"#),
        ].compactMap(\.self), timeZone: "America/Los_Angeles")
    }

    func upsert(_ input: ScheduledTaskUpsert, environmentId: String) async throws(EnvironmentRequestError) -> ScheduledTask {
      writes.append("upsert \(input.title)")
      let json: JSONValue = [
        "id": .string(input.id ?? "task-\(UUID().uuidString.prefix(6).lowercased())"), "title": .string(input.title),
        "prompt": .string(input.prompt), "enabled": .bool(input.enabled), "schedule": input.schedule, "projectId": .string(input.projectId),
        "threadId": .null, "workspaceStrategy": input.workspaceStrategy,
        "modelSelection": ["instanceId": .string(input.modelSelection.instanceId), "model": .string(input.modelSelection.model)],
        "runtimeMode": .string(input.runtimeMode), "interactionMode": .string(input.interactionMode),
        "nextRunAt": .string(WireTimestamp(Date.now.addingTimeInterval(3600)).rawValue), "lastRunStatus": "never", "runCount": 0,
      ]
      do {
        return try JSONDecoder().decode(ScheduledTask.self, from: JSONEncoder().encode(json))
      } catch {
        throw .failed("fixture")
      }
    }

    func setEnabled(_ id: String, _ enabled: Bool, environmentId: String) async throws(EnvironmentRequestError) {
      writes.append("enabled \(id) \(enabled)")
    }

    func runNow(_ id: String, environmentId: String) async throws(EnvironmentRequestError) { writes.append("run \(id)") }

    func delete(_ id: String, environmentId: String) async throws(EnvironmentRequestError) { writes.append("delete \(id)") }

    func branches(cwd: String, environmentId: String) async -> [ScheduledTaskBranch] { [ScheduledTaskBranch(name: "main", isDefault: true)] }
  }
#endif
