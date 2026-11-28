import AnkielKit
import Foundation

/// Debug launch hooks for workflows (README, "Workflows"). `ANKIEL_DEBUG_WORKFLOWS=fixture` shows
/// synthetic runs (a question, a pause, a finished run with an agent step) with a fake sink that
/// records actions instead of a computer; `readonly` also withholds `orchestration:operate`.
/// `ANKIEL_DEBUG_WORKFLOWS_OPEN=list` opens Workflows over home, `run:<runId>` one run (live too).
@MainActor
enum WorkflowsDebug {
  static let environmentId = "debug-workflows"

  static var opensAtLaunch: Bool {
    #if DEBUG
      ProcessInfo.processInfo.environment["ANKIEL_DEBUG_WORKFLOWS_OPEN"] != nil
    #else
      false
    #endif
  }

  static var openedRun: WorkflowRunRoute? {
    #if DEBUG
      guard let value = ProcessInfo.processInfo.environment["ANKIEL_DEBUG_WORKFLOWS_OPEN"], value.hasPrefix("run:") else { return nil }
      let runId = String(value.dropFirst(4))
      let environmentId =
        ProcessInfo.processInfo.environment["ANKIEL_DEBUG_WORKFLOWS"] == nil
        ? ProcessInfo.processInfo.environment["ANKIEL_DEBUG_WORKFLOWS_ENVIRONMENT"] ?? "" : environmentId
      return WorkflowRunRoute(environmentId: environmentId, runId: runId)
    #else
      nil
    #endif
  }

  static func model() -> WorkflowsModel? {
    #if DEBUG
      guard let mode = ProcessInfo.processInfo.environment["ANKIEL_DEBUG_WORKFLOWS"] else { return nil }
      let source = FixtureWorkflowSource(readonly: mode == "readonly")
      return FixtureWorkflowsModel.make(source: source)
    #else
      nil
    #endif
  }
}

#if DEBUG
  /// Synthetic runs about a made-up tide-chart app.
  @MainActor
  final class FixtureWorkflowSource: WorkflowSource {
    let readonly: Bool
    private(set) var actions: [String] = []

    init(readonly: Bool) { self.readonly = readonly }

    static func ago(_ minutes: Double) -> WireTimestamp { WireTimestamp(Date.now.addingTimeInterval(-minutes * 60)) }

    static let runs: [WorkflowRun] = [
      WorkflowRun(
        runId: "run-ask", workflow: "tide-release", title: "Release tide chart v1.4", status: .waiting, detail: "ship",
        startedAt: ago(12), updatedAt: ago(2)),
      WorkflowRun(
        runId: "run-paused", workflow: "tide-release", title: "Release tide chart v1.5", status: .paused,
        detail: "publish: registry answered 503", pauses: 1, resumesAt: ago(-5), startedAt: ago(30), updatedAt: ago(20)),
      WorkflowRun(
        runId: "run-busy", workflow: "nightly-report", title: "Tide accuracy report", status: .waiting, detail: "agent review",
        startedAt: ago(4), updatedAt: ago(1)),
      WorkflowRun(
        runId: "run-done", workflow: "issue-triage", title: "Triage #412 leap-day tides", status: .completed,
        result: ["verdict": "bug", "fix": "#418"], startedAt: ago(180), updatedAt: ago(150), endedAt: ago(150)),
    ]

    static let questions = [
      WorkflowQuestion(
        runId: "run-ask", name: "ship",
        request: ["title": "Ship tide chart v1.4?", "choices": ["Ship", "Hold"], "data": ["body": "3 fixes and a **chart** tweak. The build is green."]],
        askedAt: ago(2), thread: .init(threadId: "thread-tide-review", environmentId: nil)),
    ]

    func detail(_ runId: String, environmentId: String) async throws(EnvironmentRequestError) -> WorkflowRunDetail {
      let run = Self.runs.first { $0.runId == runId } ?? Self.runs[0]
      let start = run.startedAt.date ?? .now
      func at(_ seconds: Double) -> WireTimestamp { WireTimestamp(start.addingTimeInterval(seconds)) }
      var steps: [JSONValue] = [
        Self.step("notes", "step", at(0), at(0.2)),
        Self.step("build", "step", at(0.2), at(42), result: ["size": "2.1 MB", "warnings": 0]),
        Self.step(
          "review", "agent", at(42), run.runId == "run-busy" ? nil : at(260), threadId: "thread-tide-review",
          result: ["verdict": "ship", "risk": "low", "summary": "Leap-day tides now come from the 2028 table, and the chart redraws once per minute instead of every frame."],
          said: "The fixes look right. I checked the leap-day table and the redraw timer."),
      ]
      switch run.runId {
      case "run-ask": steps.append(Self.step("ship", "ask", at(261), nil))
      case "run-paused": steps.append(Self.step("publish", "step", at(261), at(262), status: "failed", detail: "registry answered 503"))
      case "run-done": steps.append(Self.step("label", "step", at(261), at(261.4)))
      default: break
      }
      let json: JSONValue = ["run": Self.encode(run), "steps": .array(steps), "references": []]
      do {
        return try JSONDecoder().decode(WorkflowRunDetail.self, from: JSONEncoder().encode(json))
      } catch {
        throw .failed("fixture")
      }
    }

    static func step(
      _ name: String, _ kind: String, _ from: WireTimestamp, _ to: WireTimestamp?, status: String? = nil, detail: String? = nil,
      threadId: String? = nil, result: JSONValue? = nil, said: String? = nil
    ) -> JSONValue {
      [
        "name": .string(name), "kind": .string(kind), "status": .string(status ?? (to == nil ? "running" : "completed")),
        "attempts": 1, "detail": detail.map(JSONValue.string) ?? .null, "threadId": threadId.map(JSONValue.string) ?? .null,
        "environmentId": .null, "result": result ?? .null, "said": said.map(JSONValue.string) ?? .null,
        "startedAt": .string(from.rawValue), "endedAt": to.map { .string($0.rawValue) } ?? .null,
      ]
    }

    static func encode(_ run: WorkflowRun) -> JSONValue {
      [
        "runId": .string(run.runId), "workflow": .string(run.workflow), "version": 1, "title": .string(run.title),
        "status": .string(run.status.rawValue), "detail": run.detail.map(JSONValue.string) ?? .null, "result": run.result ?? .null,
        "pauses": .number(Double(run.pauses)), "retired": false, "resumesAt": run.resumesAt.map { .string($0.rawValue) } ?? .null,
        "parentRunId": .null, "parentStep": .null, "startedAt": .string(run.startedAt.rawValue),
        "updatedAt": .string(run.updatedAt.rawValue), "endedAt": run.endedAt.map { .string($0.rawValue) } ?? .null,
      ]
    }

    func answer(_ request: WorkflowAnswerRequest, environmentId: String) async throws(EnvironmentRequestError) {
      actions.append("answer \(request.name) \(request.choice)")
    }

    func resume(_ runId: String, environmentId: String) async throws(EnvironmentRequestError) {
      actions.append("resume \(runId)")
    }

    func cancel(_ runId: String, environmentId: String) async throws(EnvironmentRequestError) {
      actions.append("cancel \(runId)")
    }
  }

  @MainActor
  enum FixtureWorkflowsModel {
    static func make(source: FixtureWorkflowSource) -> WorkflowsModel {
      let snapshot = WorkflowRunsSnapshot(
        workflows: [
          WorkflowSummary(name: "tide-release", triggers: ["webhook tags"]),
          WorkflowSummary(name: "nightly-report", triggers: ["daily at 09:00"]),
          WorkflowSummary(name: "issue-triage", triggers: ["new issues"]),
        ],
        runs: FixtureWorkflowSource.runs, questions: FixtureWorkflowSource.questions)
      let model = WorkflowsModel(
        fixture: [.init(id: WorkflowsDebug.environmentId, label: "Fixture Mac", snapshot: snapshot)], source: source)
      model.readonlyFixture = source.readonly
      return model
    }
  }
#endif
