import AnkielKit
import Foundation

/// `--scheduled-tasks`: read-only. The first `scheduledTasks.subscribe` list, each task's schedule
/// and next run as the app reads them.
func probeScheduledTasks(_ session: EnvironmentSession) async throws {
  for try await list in try await session.rpc.stream(ScheduledTaskList.rpcTag, payload: EmptyObject(), of: ScheduledTaskList.self) {
    print("time zone:         \(list.timeZone ?? "-") (\(ScheduledTasks.timeZoneLabel(list.timeZone) ?? "-"))")
    print("tasks:             \(list.tasks.count)")
    for task in list.tasks {
      let next = task.nextRunAt.map { "\(ScheduledTasks.nextRun($0, now: .now))" } ?? "-"
      print("  \(task.title) · \(task.schedule) · enabled \(task.enabled) · next \(next) · last \(task.lastRunStatus) · \(task.threadMode)")
    }
    break
  }
}
