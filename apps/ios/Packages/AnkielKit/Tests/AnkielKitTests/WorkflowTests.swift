import Foundation
import Testing

@testable import AnkielKit

/// Workflow runs as the phone lists and reads them (RN `client-runtime/workflows.test.ts`).
@Suite("Workflows")
struct WorkflowTests {
  static func at(_ minute: Int, _ second: Int = 0) -> WireTimestamp {
    WireTimestamp(rawValue: String(format: "2026-11-01T00:%02d:%02d.000Z", minute, second))
  }

  static func run(
    _ id: String, workflow: String = "release", status: WorkflowRunStatus = .running, detail: String? = nil,
    result: JSONValue? = nil, parent: String? = nil, parentStep: String? = nil, title: String? = nil,
    started: WireTimestamp = at(0), updated: WireTimestamp? = nil, ended: WireTimestamp? = nil
  ) -> WorkflowRun {
    WorkflowRun(
      runId: id, workflow: workflow, title: title, status: status, detail: detail, result: result, parentRunId: parent,
      parentStep: parentStep, startedAt: started, updatedAt: updated, endedAt: ended)
  }

  static func question(_ runId: String, _ request: JSONValue? = ["title": "Ship?"]) -> WorkflowQuestion {
    WorkflowQuestion(runId: runId, request: request, askedAt: at(1))
  }

  static func step(
    _ name: String, _ kind: WorkflowStep.Kind, _ from: WireTimestamp, _ to: WireTimestamp?,
    status: WorkflowStep.Status? = nil, detail: String? = nil, threadId: String? = nil
  ) -> WorkflowStep {
    WorkflowStep(name: name, kind: kind, status: status, detail: detail, threadId: threadId, startedAt: from, endedAt: to)
  }

  /// English for `WorkflowRunNow`, matching RN's copy.
  static func words(_ now: WorkflowRunNow) -> String {
    switch now {
    case .asks(let question, let more): more > 0 ? "Asks: \(question) and \(more) more" : "Asks: \(question)"
    case .detail(let text), .result(let text): text
    case .stepFailed: "A step failed"
    case .runningOwnSteps: "Running its own steps"
    case .child(let title, let now): "\(title): \(words(now))"
    case .agentWorking(let step): "\(step) is working"
    case .sleepingAt(let step): "Sleeping at \(step)"
    case .runsOne(let title): "Runs \(title)"
    case .runsMany(let count): "\(count) runs under way"
    case .waiting: "Waiting"
    case .waitingFor(let step): "Waiting for \(step)"
    case .finished: "Finished"
    case .endedEarly: "Ended early"
    }
  }

  @Test("what waits on a person comes first, then each workflow with its own runs")
  func grouping() {
    let registered = [
      WorkflowSummary(name: "release", triggers: ["webhook tags"]), WorkflowSummary(name: "check", triggers: []),
      WorkflowSummary(name: "report", version: 2, triggers: ["daily at 09:00"]),
    ]
    let groups = Workflows.group(
      workflows: registered,
      runs: [
        Self.run("done", status: .completed, ended: Self.at(9)),
        Self.run("busy"),
        Self.run("parent", status: .waiting, detail: "check"),
        Self.run("child", workflow: "check", status: .paused, parent: "parent", parentStep: "check"),
        Self.run("asks", workflow: "old", status: .waiting, detail: "approve"),
        Self.run("orphan", workflow: "old", status: .completed, parent: "x", ended: Self.at(8)),
      ],
      questions: [Self.question("asks")])
    #expect(groups.needsYou.map(\.run.runId) == ["parent", "asks"])
    #expect(groups.needsYou.first?.children.map(\.run.runId) == ["child"])
    #expect(groups.workflows.map(\.name) == ["release", "old", "check", "report"])
    #expect(groups.workflows.map { ($0.active + $0.finished).map(\.run.runId) } == [["busy", "done"], ["orphan"], [], []])
    #expect(groups.workflows[1].triggers == nil)
    #expect(groups.workflows[2].invokedOnly)
    #expect(groups.workflows[3].neverRan)
    #expect(groups.allNodes.map(\.run.runId) == ["parent", "child", "asks", "busy", "done", "orphan"])
  }

  static func only(_ run: WorkflowRun, questions: [WorkflowQuestion] = []) -> WorkflowRunNode {
    Workflows.group(workflows: [], runs: [run], questions: questions).allNodes[0]
  }

  @Test("a run gets the thread list's word and says what it is at")
  func stateAndNow() {
    func told(_ run: WorkflowRun, _ questions: [WorkflowQuestion] = []) -> String {
      let node = Self.only(run, questions: questions)
      return "\(Workflows.state(node).word): \(Self.words(Workflows.now(node)))"
    }
    #expect(told(Self.run("a", status: .waiting, detail: "agent review")) == "working: review is working")
    #expect(told(Self.run("a", status: .waiting, detail: "sleep night")) == "sleeping: Sleeping at night")
    #expect(told(Self.run("a", status: .waiting, detail: "ci")) == "waiting: Waiting for ci")
    #expect(told(Self.run("a", status: .waiting, detail: "approve"), [Self.question("a")]) == "needsYou: Asks: Ship?")
    #expect(told(Self.run("a", status: .paused, detail: "build: exit 1\n  at build.ts")) == "paused: build: exit 1")
    #expect(told(Self.run("a", status: .completed, result: ["merged": "ba6ac73"], ended: Self.at(1))) == "done: merged: ba6ac73")
    #expect(told(Self.run("a", status: .cancelled, detail: "superseded", ended: Self.at(1))) == "cancelled: superseded")
    #expect(Workflows.state(Self.only(Self.run("a", status: .paused))).tone == .failed)
  }

  @Test("a run waiting on one it invoked says what that one waits on")
  func waitingOnChild() {
    let groups = Workflows.group(
      workflows: [],
      runs: [
        Self.run("child", status: .waiting, parent: "parent", title: "Check web"),
        Self.run("parent", status: .waiting, detail: "check"),
      ],
      questions: [Self.question("child")])
    let parent = groups.allNodes[0]
    #expect(Workflows.state(parent).word == .needsYou)
    #expect(Self.words(Workflows.now(parent)) == "Check web: Asks: Ship?")
  }

  @Test("runs sort into needs you, running and all, newest change first")
  func lists() {
    let groups = Workflows.group(
      workflows: [],
      runs: [
        Self.run("old", status: .completed, updated: Self.at(1), ended: Self.at(1)),
        Self.run("busy", updated: Self.at(2)),
        Self.run("stuck", status: .paused, updated: Self.at(3)),
        Self.run("new", status: .completed, updated: Self.at(4), ended: Self.at(4)),
      ],
      questions: [])
    let lists = Workflows.lists(groups)
    #expect(lists[.needsYou]?.map(\.run.runId) == ["stuck"])
    #expect(lists[.running]?.map(\.run.runId) == ["busy"])
    #expect(lists[.all]?.map(\.run.runId) == ["stuck", "busy", "new", "old"])
    #expect(Workflows.defaultTab(groups) == .needsYou)
    #expect(Workflows.defaultTab(Workflows.group(workflows: [], runs: [Self.run("busy")], questions: [])) == .running)
    #expect(
      Workflows.defaultTab(Workflows.group(workflows: [], runs: [Self.run("old", status: .completed, ended: Self.at(1))], questions: []))
        == .all)
    let invoked = Workflows.lists(
      Workflows.group(
        workflows: [], runs: [Self.run("parent"), Self.run("child", workflow: "check", parent: "parent"), Self.run("other")],
        questions: []))[.all] ?? []
    #expect(invoked.filter { $0.involves("check") }.map(\.run.runId) == ["parent"])
  }

  @Test("skipped runs stay out unless asked, but not a skipped step of another run")
  func skipped() {
    let runs = [
      Self.run("ignored", status: .skipped, ended: Self.at(1)), Self.run("parent"),
      Self.run("child", status: .skipped, parent: "parent", ended: Self.at(1)),
    ]
    let hidden = Workflows.listed(runs, showSkipped: false)
    #expect(hidden.runs.map(\.runId) == ["parent", "child"])
    #expect(hidden.skipped == 1)
    #expect(Workflows.listed(runs, showSkipped: true).runs.count == 3)
  }

  @Test("a workflow's mark is two letters")
  func chip() {
    #expect(Workflows.chip("nightly-report") == "NR")
    #expect(Workflows.chip("issue") == "IS")
  }

  @Test("beats stay, bookkeeping folds, overlaps share a row, and an invoked run replaces its steps")
  func timeline() throws {
    let parent = Self.run("r", started: Self.at(0), ended: Self.at(10))
    let child = Self.run("c", parent: "r", parentStep: "check", title: "Check web")
    let timeline = Workflows.timeline(
      run: parent,
      steps: [
        Self.step("load", .step, Self.at(0), Self.at(0)),
        Self.step("switch", .step, Self.at(0), Self.at(0)),
        Self.step("triage", .agent, Self.at(0), Self.at(3), threadId: "t1"),
        Self.step("review-a", .agent, Self.at(3), Self.at(5)),
        Self.step("review-b", .agent, Self.at(3), Self.at(6)),
        Self.step("record", .step, Self.at(6), Self.at(6)),
        Self.step("check/start", .step, Self.at(6), Self.at(6)),
        Self.step("check", .wait, Self.at(6), Self.at(8)),
        Self.step("build", .step, Self.at(8), Self.at(9)),
        Self.step("publish", .step, Self.at(9), Self.at(9), status: .failed, detail: "503"),
      ],
      children: [child], now: try #require(Self.at(10).date))
    let described = timeline.rows.map { row in
      switch row {
      case .quick(let quick): "quick:\(quick.steps.map(\.name).joined(separator: ","))"
      case .beat(let beat): "\(beat.kind):\(beat.name)\(beat.parallel ? ":parallel" : "")"
      }
    }
    #expect(
      described == [
        "quick:load,switch", "agent:triage", "agent:review-a:parallel", "agent:review-b:parallel", "quick:record", "run:check",
        "step:build", "step:publish",
      ])
    let feed = Workflows.feed(timeline)
    let names = feed.map { row in
      switch row {
      case .together(let beats): beats.map(\.name).joined(separator: "+")
      case .quick: "quick"
      case .beat(let beat): beat.name
      }
    }
    #expect(names == ["quick", "triage", "review-a+review-b", "quick", "check", "build", "publish"])
    #expect(feed.flatMap(\.beats).first { $0.kind == .run }?.childRun?.title == "Check web")
    #expect(Workflows.pausedBeat(feed, status: .known(.paused))?.name == "publish")
    #expect(Workflows.pausedBeat(feed, status: .known(.running)) == nil)
    let caught = Workflows.feed(
      Workflows.timeline(
        run: Self.run("r"),
        steps: [
          Self.step("lint", .agent, Self.at(0), Self.at(2), status: .failed, detail: "timed out"),
          Self.step("build", .agent, Self.at(2), Self.at(4)),
        ], children: [], now: try #require(Self.at(10).date)))
    #expect(Workflows.pausedBeat(caught, status: .known(.paused)) == nil)
  }

  @Test("a step under way is measured up to now, and a late clock never runs time backwards")
  func openStep() throws {
    let timeline = Workflows.timeline(
      run: Self.run("r"), steps: [Self.step("fix", .agent, Self.at(1), nil)], children: [], now: try #require(Self.at(4).date))
    guard case .beat(let fix) = timeline.rows.first else { Issue.record("no beat"); return }
    #expect(fix.endMs - fix.startMs == 180_000)
    let wide = Workflows.timeline(
      run: Self.run("r", started: Self.at(1)),
      steps: [Self.step("a", .sleep, Self.at(1), Self.at(2))] + ["b", "c", "d", "e", "f"].map { Self.step($0, .sleep, Self.at(1), nil) },
      children: [], now: try #require(Self.at(0).date))
    #expect(Workflows.feed(wide).map(\.beats.count) == [6])
  }

  @Test("results, questions, answers and agent summaries read like RN's")
  func reading() {
    #expect(Workflows.resultLines("merged as ba6ac7").map(\.value) == ["merged as ba6ac7"])
    let fields = Workflows.resultLines(["sent": true, "to": "everyone"])
    #expect(fields.map(\.label) == ["sent", "to"])
    #expect(fields.map(\.value) == ["true", "everyone"])
    #expect(Workflows.resultLines(nil).isEmpty)

    let view = Workflows.read(Self.question("r", ["title": "Ship it?", "choices": ["yes", 2], "data": ["body": "Diff is small."]]))
    #expect(view == WorkflowQuestionView(title: "Ship it?", choices: ["yes"], body: "Diff is small."))
    #expect(Workflows.read(Self.question("r", nil)) == WorkflowQuestionView(title: "approve", choices: [], body: nil))

    #expect(Workflows.answer(["choice": "Ship", "reason": " "])?.reason == nil)
    #expect(Workflows.answer(["choice": "Hold", "reason": "Too risky"])?.reason == "Too risky")
    #expect(Workflows.answer("done") == nil)

    let summary = Workflows.agentSummary(
      result: ["kind": "bug", "reproduced": true, "surfaces": ["web", "desktop"], "prUrl": .null], said: "Reproduced on main.")
    #expect(summary.said == "Reproduced on main.")
    #expect(summary.facts.map(\.label) == ["kind", "reproduced", "surfaces"])
    #expect(summary.facts.map(\.value) == ["bug", "yes", "web, desktop"])
    let prose = "The draft is stored per thread id, and a reload before the thread exists drops it for good."
    let spoken = Workflows.agentSummary(result: ["verdict": "merge", "summary": .string(prose)], said: nil)
    #expect(spoken.said == prose)
    #expect(spoken.facts.map(\.value) == ["merge"])
    #expect(Workflows.words("prUrl") == "pr url")
  }

  @Test("references are named by their kind, and steps get what they touched")
  func references() {
    let issue = { (key: String) in
      WorkflowRunReference(kind: "issue", key: key, address: ["projectId": "p1", "key": .string(key)], steps: ["triage"])
    }
    let retired = WorkflowRunReference(kind: "retired", key: "r", address: ["number": 418], title: "Fix leap years", steps: ["fix", "checks"])
    let machine = WorkflowRunReference(kind: "machine", key: "m", address: ["id": 1], title: "box-1")
    #expect([issue("412"), issue("ENG-12"), retired, machine].map(Workflows.referenceLabel) == ["#412", "ENG-12", "Fix leap years", "box-1"])
    #expect(Workflows.referenceLabel(WorkflowRunReference(kind: "machine", key: "m", address: nil)) == "machine")
    #expect(Workflows.stepReferences([issue("412"), retired, machine], step: "checks").map(\.key) == ["r"])
  }

  @Test("step times keep one shape, and a reply's first sentence reads plainly")
  func textHelpers() {
    #expect(Workflows.stepTime(9) == "0.1s")
    #expect(Workflows.stepTime(342) == "0.3s")
    #expect(Workflows.stepTime(9_700) == "9.7s")
    #expect(Workflows.stepTime(4_000) == "4s")
    #expect(Workflows.stepTime(12_400) == "12s")
    #expect(Workflows.stepTime(125_000) == "2m 5s")
    #expect(Workflows.oneLine("## Done\n\nI added `clamp` next to **sum**. Tests pass.") == "I added clamp next to sum.")
    #expect(Workflows.oneLine("- See [the issue](https://x.test/2) first") == "See the issue first")
  }

  @Test("a snapshot and a detail decode tolerantly")
  func decoding() throws {
    let snapshot = try decode(
      WorkflowRunsSnapshot.self,
      json: """
        {"workflows":[{"name":"tide-release","version":1,"triggers":["daily at 09:00"]}],
         "runs":[{"runId":"r1","workflow":"tide-release","version":1,"title":"Release v1.4","status":"someday","detail":null,
           "result":{"shipped":"v1.4"},"pauses":0,"retired":false,"resumesAt":null,"parentRunId":null,"parentStep":null,
           "startedAt":"2026-11-01T00:00:00.000Z","updatedAt":"2026-11-01T00:01:00.000Z","endedAt":null},{"title":"broken"}],
         "questions":[{"runId":"r1","name":"ship","request":{"title":"Ship?","choices":["Ship","Hold"]},"askedAt":"2026-11-01T00:01:00.000Z","thread":{"threadId":"t1","environmentId":null}}],
         "definition":{"revision":3,"problem":null}}
        """)
    #expect(snapshot.runs.map(\.runId) == ["r1"])
    #expect(snapshot.runs[0].status == .unknown("someday"))
    #expect(snapshot.questions.first?.thread?.threadId == "t1")
    let detail = try decode(
      WorkflowRunDetail.self,
      json: """
        {"run":{"runId":"r1","workflow":"w","version":1,"title":"t","status":"paused","detail":"publish: 503","result":null,"pauses":1,
          "retired":false,"resumesAt":"2026-11-01T00:06:00.000Z","parentRunId":null,"parentStep":null,"startedAt":"2026-11-01T00:00:00.000Z",
          "updatedAt":"2026-11-01T00:01:00.000Z","endedAt":null},
         "steps":[{"name":"build","kind":"step","status":"completed","attempts":1,"detail":null,"threadId":null,"environmentId":null,
          "result":{"size":"2.1 MB"},"said":null,"startedAt":"2026-11-01T00:00:00.000Z","endedAt":"2026-11-01T00:00:02.000Z"},{"kind":"step"}],
         "references":[{"kind":"issue","key":"k","address":{"key":"12"},"title":"","url":null,"state":"open","steps":["build"],"origin":"step"}]}
        """)
    #expect(detail.run.status == .paused)
    #expect(detail.run.resumesAt != nil)
    #expect(detail.steps.count == 1)
    #expect(detail.references.first.map(Workflows.referenceLabel) == "#12")
  }

  @Test("requests encode as their checked-in fixtures")
  func fixtures() throws {
    let samples: [(String, any Encodable & Sendable)] = [
      ("workflow-get", WorkflowRunRequest(runId: "run-1")),
      ("workflow-cancel", WorkflowCancelRequest(runId: "run-1")),
      ("workflow-answer", WorkflowAnswerRequest(runId: "run-1", name: "ship", choice: "Ship")),
    ]
    let directory = URL(filePath: #filePath).deletingLastPathComponent().appending(path: "Fixtures/commands")
    for (name, value) in samples {
      let fixture = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: directory.appending(path: "\(name).json")))
      #expect(try JSONDecoder().decode(JSONValue.self, from: JSONEncoder.wire.encode(value)) == fixture["value"], "\(name)")
    }
  }
}
