import AnkielKit
import Foundation
import Observation

/// Where workflow runs come from and where actions go: the computers, or (Debug) a fixture.
@MainActor
protocol WorkflowSource: AnyObject {
  func detail(_ runId: String, environmentId: String) async throws(EnvironmentRequestError) -> WorkflowRunDetail
  func answer(_ request: WorkflowAnswerRequest, environmentId: String) async throws(EnvironmentRequestError)
  func resume(_ runId: String, environmentId: String) async throws(EnvironmentRequestError)
  func cancel(_ runId: String, environmentId: String) async throws(EnvironmentRequestError)
}

extension EnvironmentRegistry: WorkflowSource {
  func detail(_ runId: String, environmentId: String) async throws(EnvironmentRequestError) -> WorkflowRunDetail {
    try await call(WorkflowRunRequest.getTag, WorkflowRunRequest(runId: runId), as: WorkflowRunDetail.self, in: environmentId)
  }

  func answer(_ request: WorkflowAnswerRequest, environmentId: String) async throws(EnvironmentRequestError) {
    _ = try await call(WorkflowAnswerRequest.rpcTag, request, as: JSONValue.self, in: environmentId)
  }

  func resume(_ runId: String, environmentId: String) async throws(EnvironmentRequestError) {
    _ = try await call(WorkflowRunRequest.resumeTag, WorkflowRunRequest(runId: runId), as: JSONValue.self, in: environmentId)
  }

  func cancel(_ runId: String, environmentId: String) async throws(EnvironmentRequestError) {
    _ = try await call(WorkflowCancelRequest.rpcTag, WorkflowCancelRequest(runId: runId), as: JSONValue.self, in: environmentId)
  }

  private func call<Response: Decodable & Sendable>(
    _ tag: String, _ payload: some Encodable & Sendable, as type: Response.Type, in environmentId: String
  ) async throws(EnvironmentRequestError) -> Response {
    guard let environment = environment(environmentId), environment.status.isConnected else { throw .notConnected }
    let host = EnvironmentTerminalHost(registry: self, environmentId: environmentId)
    guard let channel = await host.channel(after: nil)?.channel else { throw .notConnected }
    do {
      return try await channel.call(tag, payload: payload, as: type)
    } catch {
      throw EnvironmentRequestError(error)
    }
  }
}

/// Every computer's workflow runs (`workflows.subscribe`, RN `workflowsLiveAcross`), followed
/// across reconnects while the Workflows screen shows.
@MainActor @Observable
final class WorkflowsModel {
  struct Computer: Identifiable {
    let id: String
    var label: String
    var snapshot: WorkflowRunsSnapshot?
    var error: String?
    /// Goes up with every snapshot: steps do not move a run's `updatedAt`, so a run under way is
    /// read again on any change (RN `workflowRunRefreshKey`).
    var revision = 0
  }

  let source: any WorkflowSource
  private(set) var computers: [Computer] = []
  /// A fixture session without `orchestration:operate` (Debug).
  var readonlyFixture = false
  @ObservationIgnored private let registry: EnvironmentRegistry?
  @ObservationIgnored private var runs: [String: Task<Void, Never>] = [:]

  init(registry: EnvironmentRegistry?, source: any WorkflowSource) {
    self.registry = registry
    self.source = source
  }

  /// Fixture computers (Debug).
  init(fixture: [Computer], source: any WorkflowSource) {
    registry = nil
    self.source = source
    computers = fixture
  }

  var isSettled: Bool { computers.allSatisfy { $0.snapshot != nil || $0.error != nil } }

  func snapshot(_ environmentId: String) -> WorkflowRunsSnapshot? { computers.first { $0.id == environmentId }?.snapshot }

  /// What a run's detail is read again on: every snapshot while it runs, its own change once ended.
  func refreshKey(_ runId: String, environmentId: String) -> String {
    guard let computer = computers.first(where: { $0.id == environmentId }),
      let run = computer.snapshot?.runs.first(where: { $0.runId == runId })
    else { return "" }
    return run.hasEnded ? "ended:\(run.updatedAt.rawValue)" : "live:\(computer.revision)"
  }

  /// Whether this device may answer, resume or cancel runs there (RN `permissionAtom`).
  func canOperate(_ environmentId: String) -> Bool {
    guard let registry else { return !readonlyFixture }
    return registry.environment(environmentId)?.allows(WorkflowScope.operate) ?? false
  }

  func start() {
    guard let registry else { return }
    let environments = registry.environments.filter(\.isEnabled)
    computers = environments.map { environment in
      computers.first { $0.id == environment.id } ?? Computer(id: environment.id, label: environment.label)
    }
    for environment in environments where runs[environment.id] == nil {
      let id = environment.id
      runs[id] = Task { [weak self] in await self?.follow(id, host: EnvironmentTerminalHost(registry: registry, environmentId: id)) }
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
        for try await snapshot in try await next.channel.stream(WorkflowRunsSnapshot.rpcTag, payload: EmptyObject(), of: WorkflowRunsSnapshot.self) {
          update(environmentId) {
            $0.snapshot = snapshot
            $0.error = nil
            $0.revision += 1
          }
        }
      } catch is CancellationError {
        return
      } catch {
        // A refusal (workflows off, no permission) is shown; a dropped socket keeps the last list.
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
}

/// One run's steps (`workflows.get`), read again whenever the live list changes while it runs,
/// or once more when an ended run changes (RN `workflowRunRefreshKey`).
@MainActor @Observable
final class WorkflowRunModel {
  let environmentId: String
  let runId: String
  private(set) var detail: WorkflowRunDetail?
  private(set) var error: String?
  /// An answer, resume or cancel is on its way (a second tap is ignored).
  private(set) var busy: String?
  @ObservationIgnored private let source: any WorkflowSource

  init(environmentId: String, runId: String, source: any WorkflowSource) {
    self.environmentId = environmentId
    self.runId = runId
    self.source = source
  }

  func load() async {
    do {
      detail = try await source.detail(runId, environmentId: environmentId)
      error = nil
    } catch {
      self.error = WorkflowCopy.describe(error)
    }
  }

  enum Action: Equatable {
    case answer(name: String, choice: String)
    case resume
    case cancel

    var key: String {
      switch self {
      case .answer(_, let choice): "answer:\(choice)"
      case .resume: "resume"
      case .cancel: "cancel"
      }
    }
  }

  /// Runs an action; returns why it failed, nil on success.
  func perform(_ action: Action) async -> String? {
    guard busy == nil else { return nil }
    busy = action.key
    defer { busy = nil }
    do {
      switch action {
      case .answer(let name, let choice):
        try await source.answer(WorkflowAnswerRequest(runId: runId, name: name, choice: choice), environmentId: environmentId)
      case .resume: try await source.resume(runId, environmentId: environmentId)
      case .cancel: try await source.cancel(runId, environmentId: environmentId)
      }
      await load()
      return nil
    } catch {
      return WorkflowCopy.describe(error)
    }
  }
}
