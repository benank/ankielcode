import AnkielKit
import Foundation

/// `--workflows [--run <runId>]`: read-only. The first `workflows.subscribe` snapshot, grouped the
/// way the app lists it, and one run's detail (`workflows.get`) as its feed.
func probeWorkflows(_ session: EnvironmentSession) async throws {
  var snapshot: WorkflowRunsSnapshot?
  for try await item in try await session.rpc.stream(WorkflowRunsSnapshot.rpcTag, payload: EmptyObject(), of: WorkflowRunsSnapshot.self) {
    snapshot = item
    break
  }
  guard let snapshot else { throw ProbeFailure(description: "no workflows snapshot") }
  print("workflows:         \(snapshot.workflows.map { "\($0.name)@\($0.version) \($0.triggers)" })")
  print("runs:              \(snapshot.runs.count), questions \(snapshot.questions.count)")
  let groups = Workflows.group(workflows: snapshot.workflows, runs: snapshot.runs, questions: snapshot.questions)
  let lists = Workflows.lists(groups)
  print("lists:             needs-you \(lists[.needsYou]?.count ?? 0), running \(lists[.running]?.count ?? 0), all \(lists[.all]?.count ?? 0); opens on \(Workflows.defaultTab(groups).rawValue)")
  for node in (lists[.all] ?? []).prefix(8) {
    print("  [\(Workflows.chip(node.run.workflow))] \(node.run.title.prefix(50)) · \(Workflows.state(node).word) · \(Workflows.now(node))")
  }
  guard let runId = argument("--run") ?? lists[.all]?.first?.run.runId else { return }
  let detail = try await session.rpc.call(WorkflowRunRequest.getTag, payload: WorkflowRunRequest(runId: runId), as: WorkflowRunDetail.self)
  let children = snapshot.runs.filter { $0.parentRunId == runId }
  let feed = Workflows.feed(Workflows.timeline(run: detail.run, steps: detail.steps, children: children, now: .now))
  print("run \(runId):  \(detail.steps.count) steps, \(detail.references.count) references, \(feed.count) feed rows")
  for row in feed {
    switch row {
    case .quick(let quick): print("  quick: \(quick.steps.map(\.name))")
    case .beat(let beat): print("  \(beat.kind) \(beat.name) \(beat.status) \(Workflows.stepTime(beat.endMs - beat.startMs)) thread=\(beat.threadId ?? "-")")
    case .together(let beats): print("  together: \(beats.map(\.name))")
    }
  }
}

/// `--workflow-setup <file.ts>`: turns workflows on (a Labs setting) and saves the file as a
/// definition of the dev server. `--workflow-teardown <file name>` deletes it and turns them off.
/// Runs stay in the server's history (there is no delete); cancel them first.
func probeWorkflowSetup(_ session: EnvironmentSession, file: String?, teardown: String?) async throws {
  if let file {
    _ = try await session.rpc.call("server.updateSettings", payload: ["patch": ["workflowsEnabled": true]] as JSONValue, as: JSONValue.self)
    let source = try String(contentsOfFile: file, encoding: .utf8)
    let name = URL(filePath: file).lastPathComponent
    let result = try await session.rpc.call(
      "workflows.saveDefinition", payload: ["name": .string(name), "source": .string(source)] as JSONValue, as: JSONValue.self)
    print("saved \(name):      \(result)")
  }
  if let teardown {
    let result = try await session.rpc.call("workflows.deleteDefinition", payload: ["name": .string(teardown)] as JSONValue, as: JSONValue.self)
    print("deleted \(teardown): \(result)")
    _ = try await session.rpc.call("server.updateSettings", payload: ["patch": ["workflowsEnabled": false]] as JSONValue, as: JSONValue.self)
    print("workflows:         off")
  }
}
