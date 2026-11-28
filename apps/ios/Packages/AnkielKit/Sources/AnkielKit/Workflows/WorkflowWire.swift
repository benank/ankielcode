import Foundation

/// `WorkflowRunStatus` (`packages/contracts/src/workflow.ts`).
public enum WorkflowRunStatus: String, Sendable, Hashable, CaseIterable {
  case running, waiting, paused, completed, stopped, skipped, cancelled
}

/// `WorkflowRun`: one run of a workflow on a computer.
public struct WorkflowRun: Sendable, Hashable, Decodable, Identifiable {
  public var runId: String
  public var workflow: String
  public var version: Int
  public var title: String
  public var status: WireEnum<WorkflowRunStatus>
  /// Why it is paused, what it waits on, or how it ended.
  public var detail: String?
  public var result: JSONValue?
  public var pauses: Int
  /// Its version is no longer registered, so it cannot go on until that version is back.
  public var retired: Bool
  /// When a paused run resumes by itself; nil when it waits for a person.
  public var resumesAt: WireTimestamp?
  public var parentRunId: String?
  public var parentStep: String?
  public var startedAt: WireTimestamp
  public var updatedAt: WireTimestamp
  public var endedAt: WireTimestamp?

  public var id: String { runId }

  public init(
    runId: String, workflow: String = "release", version: Int = 1, title: String? = nil,
    status: WorkflowRunStatus = .running, detail: String? = nil, result: JSONValue? = nil, pauses: Int = 0,
    retired: Bool = false, resumesAt: WireTimestamp? = nil, parentRunId: String? = nil, parentStep: String? = nil,
    startedAt: WireTimestamp, updatedAt: WireTimestamp? = nil, endedAt: WireTimestamp? = nil
  ) {
    self.runId = runId
    self.workflow = workflow
    self.version = version
    self.title = title ?? runId
    self.status = .known(status)
    self.detail = detail
    self.result = result
    self.pauses = pauses
    self.retired = retired
    self.resumesAt = resumesAt
    self.parentRunId = parentRunId
    self.parentStep = parentStep
    self.startedAt = startedAt
    self.updatedAt = updatedAt ?? startedAt
    self.endedAt = endedAt
  }

  enum CodingKeys: String, CodingKey {
    case runId, workflow, version, title, status, detail, result, pauses, retired, resumesAt, parentRunId, parentStep
    case startedAt, updatedAt, endedAt
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    runId = try c.decode(String.self, forKey: .runId)
    workflow = c.loose(String.self, .workflow) ?? ""
    version = c.loose(Double.self, .version).map { Int($0) } ?? 0
    title = c.loose(String.self, .title) ?? runId
    status = c.loose(WireEnum<WorkflowRunStatus>.self, .status) ?? .unknown("")
    detail = c.loose(String.self, .detail)
    result = (try? c.decodeIfPresent(JSONValue.self, forKey: .result)).flatMap { $0 == .null ? nil : $0 }
    pauses = c.loose(Double.self, .pauses).map { Int($0) } ?? 0
    retired = c.loose(Bool.self, .retired) ?? false
    resumesAt = c.loose(WireTimestamp.self, .resumesAt)
    parentRunId = c.loose(String.self, .parentRunId)
    parentStep = c.loose(String.self, .parentStep)
    startedAt = c.loose(WireTimestamp.self, .startedAt) ?? WireTimestamp(rawValue: "")
    updatedAt = c.loose(WireTimestamp.self, .updatedAt) ?? startedAt
    endedAt = c.loose(WireTimestamp.self, .endedAt)
  }

  public var hasEnded: Bool { endedAt != nil }
}

/// `WorkflowStep`.
public struct WorkflowStep: Sendable, Hashable, Decodable {
  public enum Kind: String, Sendable, Hashable { case step, wait, agent, ask, sleep }
  public enum Status: String, Sendable, Hashable { case running, completed, failed }

  public var name: String
  public var kind: WireEnum<Kind>
  public var status: WireEnum<Status>
  public var attempts: Int
  /// A failure's reason, or when a sleep wakes (ISO time).
  public var detail: String?
  /// The thread an agent step ran in.
  public var threadId: String?
  public var environmentId: String?
  public var result: JSONValue?
  public var said: String?
  public var startedAt: WireTimestamp
  public var endedAt: WireTimestamp?

  public init(
    name: String, kind: Kind, status: Status? = nil, attempts: Int = 1, detail: String? = nil, threadId: String? = nil,
    result: JSONValue? = nil, said: String? = nil, startedAt: WireTimestamp, endedAt: WireTimestamp?
  ) {
    self.name = name
    self.kind = .known(kind)
    self.status = .known(status ?? (endedAt == nil ? .running : .completed))
    self.attempts = attempts
    self.detail = detail
    self.threadId = threadId
    self.environmentId = nil
    self.result = result
    self.said = said
    self.startedAt = startedAt
    self.endedAt = endedAt
  }

  enum CodingKeys: String, CodingKey {
    case name, kind, status, attempts, detail, threadId, environmentId, result, said, startedAt, endedAt
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    name = try c.decode(String.self, forKey: .name)
    kind = c.loose(WireEnum<Kind>.self, .kind) ?? .unknown("")
    status = c.loose(WireEnum<Status>.self, .status) ?? .unknown("")
    attempts = c.loose(Double.self, .attempts).map { Int($0) } ?? 1
    detail = c.loose(String.self, .detail)
    threadId = c.loose(String.self, .threadId)
    environmentId = c.loose(String.self, .environmentId)
    result = (try? c.decodeIfPresent(JSONValue.self, forKey: .result)).flatMap { $0 == .null ? nil : $0 }
    said = c.loose(String.self, .said)
    startedAt = c.loose(WireTimestamp.self, .startedAt) ?? WireTimestamp(rawValue: "")
    endedAt = c.loose(WireTimestamp.self, .endedAt)
  }
}

/// `WorkflowQuestion`: a question a run asked a person.
public struct WorkflowQuestion: Sendable, Hashable, Decodable {
  public struct Thread: Sendable, Hashable, Decodable {
    public var threadId: String
    public var environmentId: String?

    public init(threadId: String, environmentId: String?) {
      self.threadId = threadId
      self.environmentId = environmentId
    }
  }

  public var runId: String
  public var name: String
  public var request: JSONValue?
  public var askedAt: WireTimestamp
  /// The run's latest agent thread, for talking it through before answering.
  public var thread: Thread?

  public init(runId: String, name: String = "approve", request: JSONValue?, askedAt: WireTimestamp, thread: Thread? = nil) {
    self.runId = runId
    self.name = name
    self.request = request
    self.askedAt = askedAt
    self.thread = thread
  }

  enum CodingKeys: String, CodingKey { case runId, name, request, askedAt, thread }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    runId = try c.decode(String.self, forKey: .runId)
    name = try c.decode(String.self, forKey: .name)
    request = try? c.decodeIfPresent(JSONValue.self, forKey: .request)
    askedAt = c.loose(WireTimestamp.self, .askedAt) ?? WireTimestamp(rawValue: "")
    thread = c.loose(Thread.self, .thread)
  }
}

/// `WorkflowSummary`: a registered workflow and what starts it, in words.
public struct WorkflowSummary: Sendable, Hashable, Decodable {
  public var name: String
  public var version: Int
  public var triggers: [String]

  public init(name: String, version: Int = 1, triggers: [String]) {
    self.name = name
    self.version = version
    self.triggers = triggers
  }

  enum CodingKeys: String, CodingKey { case name, version, triggers }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    name = try c.decode(String.self, forKey: .name)
    version = c.loose(Double.self, .version).map { Int($0) } ?? 0
    triggers = c.loose([String].self, .triggers) ?? []
  }
}

/// `WorkflowRunsSnapshot`, each item of `workflows.subscribe {}` (newest runs first).
public struct WorkflowRunsSnapshot: Sendable, Hashable, Decodable {
  public static let rpcTag = "workflows.subscribe"

  public var workflows: [WorkflowSummary]
  public var runs: [WorkflowRun]
  public var questions: [WorkflowQuestion]

  public init(workflows: [WorkflowSummary] = [], runs: [WorkflowRun] = [], questions: [WorkflowQuestion] = []) {
    self.workflows = workflows
    self.runs = runs
    self.questions = questions
  }

  enum CodingKeys: String, CodingKey { case workflows, runs, questions }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    workflows = c.loose(LossyArray<WorkflowSummary>.self, .workflows)?.elements ?? []
    runs = c.loose(LossyArray<WorkflowRun>.self, .runs)?.elements ?? []
    questions = c.loose(LossyArray<WorkflowQuestion>.self, .questions)?.elements ?? []
  }
}

/// `WorkflowRunReference`: something a run touched (an issue, or a kind this client does not know).
public struct WorkflowRunReference: Sendable, Hashable, Decodable {
  public var kind: String
  public var key: String
  public var address: JSONValue?
  public var title: String
  public var url: String?
  public var state: String?
  public var steps: [String]

  public init(kind: String, key: String, address: JSONValue?, title: String = "", url: String? = nil, steps: [String] = []) {
    self.kind = kind
    self.key = key
    self.address = address
    self.title = title
    self.url = url
    self.state = nil
    self.steps = steps
  }

  enum CodingKeys: String, CodingKey { case kind, key, address, title, url, state, steps }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    kind = c.loose(String.self, .kind) ?? ""
    key = c.loose(String.self, .key) ?? ""
    address = try? c.decodeIfPresent(JSONValue.self, forKey: .address)
    title = c.loose(String.self, .title) ?? ""
    url = c.loose(String.self, .url)
    state = c.loose(String.self, .state)
    steps = c.loose([String].self, .steps) ?? []
  }
}

/// `WorkflowRunDetail`, the answer to `workflows.get {runId}`.
public struct WorkflowRunDetail: Sendable, Hashable, Decodable {
  public var run: WorkflowRun
  public var steps: [WorkflowStep]
  public var references: [WorkflowRunReference]

  enum CodingKeys: String, CodingKey { case run, steps, references }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    run = try c.decode(WorkflowRun.self, forKey: .run)
    steps = c.loose(LossyArray<WorkflowStep>.self, .steps)?.elements ?? []
    references = c.loose(LossyArray<WorkflowRunReference>.self, .references)?.elements ?? []
  }
}

/// `workflows.get {runId}`, `workflows.resume {runId}`.
public struct WorkflowRunRequest: Sendable, Hashable, Encodable {
  public static let getTag = "workflows.get"
  public static let resumeTag = "workflows.resume"
  public var runId: String
  public init(runId: String) { self.runId = runId }
}

/// `workflows.cancel {runId, reason?}`.
public struct WorkflowCancelRequest: Sendable, Hashable, Encodable {
  public static let rpcTag = "workflows.cancel"
  public var runId: String
  public var reason: String?
  public init(runId: String, reason: String? = nil) {
    self.runId = runId
    self.reason = reason
  }
}

/// `workflows.answer {runId, name, choice, reason?}`.
public struct WorkflowAnswerRequest: Sendable, Hashable, Encodable {
  public static let rpcTag = "workflows.answer"
  public var runId: String
  public var name: String
  public var choice: String
  public var reason: String?
  public init(runId: String, name: String, choice: String, reason: String? = nil) {
    self.runId = runId
    self.name = name
    self.choice = choice
    self.reason = reason
  }
}

/// Starting, resuming, cancelling or answering a run needs `orchestration:operate` (and, for MCP
/// callers, the broadest runtime mode; RN gates the UI on the scope alone).
public enum WorkflowScope {
  public static let operate = "orchestration:operate"
}
