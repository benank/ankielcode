import AnkielKit
import Foundation
import Observation

/// Where scheduled tasks are changed: a computer, or (Debug) a recording fake.
@MainActor
protocol ScheduledTaskSink: AnyObject {
  func upsert(_ input: ScheduledTaskUpsert, environmentId: String) async throws(EnvironmentRequestError) -> ScheduledTask
  func setEnabled(_ id: String, _ enabled: Bool, environmentId: String) async throws(EnvironmentRequestError)
  func runNow(_ id: String, environmentId: String) async throws(EnvironmentRequestError)
  func delete(_ id: String, environmentId: String) async throws(EnvironmentRequestError)
  func branches(cwd: String, environmentId: String) async -> [ScheduledTaskBranch]
}

extension EnvironmentRegistry: ScheduledTaskSink {
  func upsert(_ input: ScheduledTaskUpsert, environmentId: String) async throws(EnvironmentRequestError) -> ScheduledTask {
    try await scheduledCall(ScheduledTaskUpsert.rpcTag, input, as: ScheduledTaskMutation.self, in: environmentId).task
  }

  func setEnabled(_ id: String, _ enabled: Bool, environmentId: String) async throws(EnvironmentRequestError) {
    _ = try await scheduledCall(ScheduledTaskSetEnabled.rpcTag, ScheduledTaskSetEnabled(id: id, enabled: enabled), as: JSONValue.self, in: environmentId)
  }

  func runNow(_ id: String, environmentId: String) async throws(EnvironmentRequestError) {
    _ = try await scheduledCall(ScheduledTaskRef.runNowTag, ScheduledTaskRef(id: id), as: JSONValue.self, in: environmentId)
  }

  func delete(_ id: String, environmentId: String) async throws(EnvironmentRequestError) {
    _ = try await scheduledCall(ScheduledTaskRef.deleteTag, ScheduledTaskRef(id: id), as: JSONValue.self, in: environmentId)
  }

  func branches(cwd: String, environmentId: String) async -> [ScheduledTaskBranch] {
    (try? await scheduledCall(ListRefsRequest.rpcTag, ListRefsRequest(cwd: cwd), as: ScheduledTaskRefList.self, in: environmentId).refs) ?? []
  }

  private func scheduledCall<Response: Decodable & Sendable>(
    _ tag: String, _ payload: some Encodable & Sendable, as type: Response.Type, in environmentId: String
  ) async throws(EnvironmentRequestError) -> Response {
    guard environment(environmentId)?.status.isConnected == true,
      let channel = await EnvironmentTerminalHost(registry: self, environmentId: environmentId).channel(after: nil)?.channel
    else { throw .notConnected }
    do {
      return try await channel.call(tag, payload: payload, as: type)
    } catch {
      throw EnvironmentRequestError(error)
    }
  }
}

/// Every computer's scheduled tasks (`scheduledTasks.subscribe`, RN
/// `SettingsScheduledTasksRouteScreen`), followed across reconnects while the page shows.
@MainActor @Observable
final class ScheduledTasksModel {
  struct Computer: Identifiable {
    let id: String
    var label: String
    var list: ScheduledTaskList?
    var error: String?
  }

  let sink: any ScheduledTaskSink
  private(set) var computers: [Computer] = []
  /// A task an action is on its way for.
  private(set) var busy: Set<String> = []
  var readonlyFixture = false
  @ObservationIgnored let registry: EnvironmentRegistry?
  @ObservationIgnored private var runs: [String: Task<Void, Never>] = [:]

  init(registry: EnvironmentRegistry?, sink: any ScheduledTaskSink, fixture: [Computer] = []) {
    self.registry = registry
    self.sink = sink
    computers = fixture
  }

  func canOperate(_ environmentId: String) -> Bool {
    guard let registry else { return !readonlyFixture }
    let environment = registry.environment(environmentId)
    return environment?.status.isConnected == true && environment?.allows(ScheduledTaskScope.operate) == true
  }

  func task(_ id: String, environmentId: String) -> ScheduledTask? {
    computers.first { $0.id == environmentId }?.list?.tasks.first { $0.id == id }
  }

  func start() {
    guard let registry else { return }
    let environments = registry.environments.filter(\.isEnabled)
    computers = environments.map { environment in
      computers.first { $0.id == environment.id } ?? Computer(id: environment.id, label: environment.label)
    }
    for environment in environments where runs[environment.id] == nil {
      let id = environment.id
      let host = EnvironmentTerminalHost(registry: registry, environmentId: id)
      runs[id] = Task { [weak self] in await self?.follow(id, host: host) }
    }
  }

  func stop() {
    for task in runs.values { task.cancel() }
    runs = [:]
  }

  private func follow(_ environmentId: String, host: EnvironmentTerminalHost) async {
    var previous: ObjectIdentifier?
    while !Task.isCancelled {
      guard let next = await host.channel(after: previous) else { return }
      previous = next.id
      do {
        for try await list in try await next.channel.stream(ScheduledTaskList.rpcTag, payload: EmptyObject(), of: ScheduledTaskList.self) {
          update(environmentId) {
            $0.list = list
            $0.error = nil
          }
        }
      } catch is CancellationError {
        return
      } catch {
        if case RpcError.failed = error {
          update(environmentId) { $0.error = WorkflowCopy.describe(EnvironmentRequestError(error)) }
        }
      }
    }
  }

  private func update(_ environmentId: String, _ change: (inout Computer) -> Void) {
    guard let index = computers.firstIndex(where: { $0.id == environmentId }) else { return }
    change(&computers[index])
  }

  enum Action { case toggle, run, delete }

  /// Runs an action and returns why it failed, nil on success. The list follows by itself.
  func perform(_ action: Action, on task: ScheduledTask, environmentId: String) async -> String? {
    guard !busy.contains(task.id) else { return nil }
    busy.insert(task.id)
    defer { busy.remove(task.id) }
    do {
      switch action {
      case .toggle: try await sink.setEnabled(task.id, !task.enabled, environmentId: environmentId)
      case .run: try await sink.runNow(task.id, environmentId: environmentId)
      case .delete: try await sink.delete(task.id, environmentId: environmentId)
      }
      // Fixtures have no stream to follow; apply the change here.
      if registry == nil { applyLocally(action, task: task, environmentId: environmentId) }
      return nil
    } catch {
      return WorkflowCopy.describe(error)
    }
  }

  func saved(_ task: ScheduledTask, environmentId: String) {
    guard registry == nil else { return }
    update(environmentId) { computer in
      var tasks = computer.list?.tasks ?? []
      if let index = tasks.firstIndex(where: { $0.id == task.id }) { tasks[index] = task } else { tasks.append(task) }
      computer.list = ScheduledTaskList(tasks: tasks, timeZone: computer.list?.timeZone)
    }
  }

  private func applyLocally(_ action: Action, task: ScheduledTask, environmentId: String) {
    update(environmentId) { computer in
      var tasks = computer.list?.tasks ?? []
      switch action {
      case .toggle: if let index = tasks.firstIndex(where: { $0.id == task.id }) { tasks[index].enabled.toggle() }
      case .delete: tasks.removeAll { $0.id == task.id }
      case .run: break
      }
      computer.list = ScheduledTaskList(tasks: tasks, timeZone: computer.list?.timeZone)
    }
  }
}
