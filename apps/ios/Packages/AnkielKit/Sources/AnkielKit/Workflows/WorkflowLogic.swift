import Foundation

/// A run with the runs it invoked and its open questions (RN `WorkflowRunNode`).
public struct WorkflowRunNode: Sendable, Hashable, Identifiable {
  public var run: WorkflowRun
  /// The runs it invoked, in the order they started.
  public var children: [WorkflowRunNode]
  public var questions: [WorkflowQuestion]

  public var id: String { run.runId }

  /// A question is open here or below, or this or a run below is paused.
  public var needsPerson: Bool {
    !questions.isEmpty || run.status == .paused || children.contains { $0.needsPerson }
  }

  /// Every run below this one, parents before the runs they invoked.
  public var descendants: [WorkflowRunNode] { children.flatMap { [$0] + $0.descendants } }

  /// Whether this run is of `workflow` or invoked one that is.
  public func involves(_ workflow: String) -> Bool {
    run.workflow == workflow || children.contains { $0.involves(workflow) }
  }
}

/// One workflow and its runs that nobody has to act on.
public struct WorkflowSection: Sendable, Hashable {
  public var name: String
  /// What starts it, in words; nil for one this server no longer has registered.
  public var triggers: [String]?
  public var active: [WorkflowRunNode]
  public var finished: [WorkflowRunNode]
  /// Every run of it was invoked by another workflow's run.
  public var invokedOnly: Bool
  public var neverRan: Bool
}

public struct WorkflowRunGroups: Sendable, Hashable {
  /// Runs a person has to act on: a question open or paused, itself or below it.
  public var needsYou: [WorkflowRunNode]
  /// Every workflow, busiest first.
  public var workflows: [WorkflowSection]

  /// Every listed run, parents before the runs they invoked.
  public var allNodes: [WorkflowRunNode] {
    (needsYou + workflows.flatMap { $0.active + $0.finished }).flatMap { [$0] + $0.descendants }
  }

  public func node(_ runId: String) -> WorkflowRunNode? { allNodes.first { $0.run.runId == runId } }
}

public enum WorkflowListTab: String, Sendable, Hashable, CaseIterable {
  case needsYou = "needs-you", running, all
}

/// How a run's state reads, as the thread list's lights would show it.
public enum WorkflowRunTone: Sendable, Hashable { case input, failed, working, quiet, done }

public enum WorkflowRunWord: Sendable, Hashable {
  case needsYou, paused, working, sleeping, waiting, done, stopped, skipped, cancelled, unknown
}

/// What a run is at now, as the line under its title (RN `workflowRunNow`); the app words it.
public indirect enum WorkflowRunNow: Sendable, Hashable {
  case asks(question: String, more: Int)
  /// The run's own words (a pause or an early end), first line only.
  case detail(String)
  case stepFailed
  case runningOwnSteps
  case child(title: String, now: WorkflowRunNow)
  case agentWorking(step: String)
  case sleepingAt(step: String)
  case runsOne(title: String)
  case runsMany(count: Int)
  case waiting
  case waitingFor(step: String)
  case finished
  case result(String)
  case endedEarly
}

public struct WorkflowQuestionView: Sendable, Hashable {
  public var title: String
  public var choices: [String]
  public var body: String?
}

/// RN `client-runtime/workflows.ts`, the parts the phone shows.
public enum Workflows {
  /// A question's title, choices and body; parts of another shape are left out.
  public static func read(_ question: WorkflowQuestion) -> WorkflowQuestionView {
    let title = question.request?["title"]?.stringValue
    let choices: [String] =
      if case .array(let values)? = question.request?["choices"] { values.compactMap(\.stringValue) } else { [] }
    let body = question.request?["data"]?["body"]?.stringValue
    return WorkflowQuestionView(
      title: title.map { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? question.name : $0 } ?? question.name,
      choices: choices,
      body: body.flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 })
  }

  /// The runs a list shows: without those a workflow skipped as not its to do, unless asked. A
  /// skipped run another run invoked stays, as a step of that one.
  public static func listed(_ runs: [WorkflowRun], showSkipped: Bool) -> (runs: [WorkflowRun], skipped: Int) {
    let hidden = { (run: WorkflowRun) in run.status == .skipped && run.parentRunId == nil }
    return (showSkipped ? runs : runs.filter { !hidden($0) }, runs.count(where: hidden))
  }

  public static func group(
    workflows: [WorkflowSummary], runs: [WorkflowRun], questions: [WorkflowQuestion]
  ) -> WorkflowRunGroups {
    let listed = Set(runs.map(\.runId))
    var childrenOf: [String: [WorkflowRun]] = [:]
    var roots: [WorkflowRun] = []
    for run in runs {
      if let parent = run.parentRunId, listed.contains(parent) {
        childrenOf[parent, default: []].append(run)
      } else {
        roots.append(run)
      }
    }
    func node(_ run: WorkflowRun) -> WorkflowRunNode {
      WorkflowRunNode(
        run: run,
        children: (childrenOf[run.runId] ?? []).sorted { $0.startedAt.rawValue < $1.startedAt.rawValue }.map(node),
        questions: questions.filter { $0.runId == run.runId })
    }
    var needsYou: [WorkflowRunNode] = []
    var order: [String] = []
    var sections: [String: (active: [WorkflowRunNode], finished: [WorkflowRunNode])] = [:]
    for root in roots.map(node) {
      if root.needsPerson {
        needsYou.append(root)
        continue
      }
      if sections[root.run.workflow] == nil {
        sections[root.run.workflow] = ([], [])
        order.append(root.run.workflow)
      }
      if root.run.hasEnded { sections[root.run.workflow]!.finished.append(root) } else { sections[root.run.workflow]!.active.append(root) }
    }
    let registered = Dictionary(workflows.map { ($0.name, $0) }, uniquingKeysWith: { first, _ in first })
    let hasRuns = Set(runs.map(\.workflow))
    let hasRootRuns = Set(roots.map(\.workflow))
    var names: [String] = []
    for name in order + workflows.map(\.name) + runs.map(\.workflow) where !names.contains(name) { names.append(name) }
    func rank(_ name: String) -> Int {
      guard let section = sections[name] else { return 2 }
      return section.active.isEmpty ? (section.finished.isEmpty ? 2 : 1) : 0
    }
    let list = names.map { name in
      WorkflowSection(
        name: name, triggers: registered[name]?.triggers, active: sections[name]?.active ?? [],
        finished: sections[name]?.finished ?? [], invokedOnly: hasRuns.contains(name) && !hasRootRuns.contains(name),
        neverRan: !hasRuns.contains(name))
    }
    .sorted { rank($0.name) != rank($1.name) ? rank($0.name) < rank($1.name) : $0.name < $1.name }
    return WorkflowRunGroups(needsYou: needsYou, workflows: list)
  }

  /// The three lists, each whole pieces of work, newest change first.
  public static func lists(_ groups: WorkflowRunGroups) -> [WorkflowListTab: [WorkflowRunNode]] {
    let byChange = { (nodes: [WorkflowRunNode]) in nodes.sorted { $0.run.updatedAt.rawValue > $1.run.updatedAt.rawValue } }
    let needsYou = byChange(groups.needsYou)
    let running = byChange(groups.workflows.flatMap(\.active))
    let finished = byChange(groups.workflows.flatMap(\.finished))
    return [.needsYou: needsYou, .running: running, .all: needsYou + running + finished]
  }

  /// The list to open on: what waits on a person, else what is under way, else everything.
  public static func defaultTab(_ groups: WorkflowRunGroups) -> WorkflowListTab {
    if !groups.needsYou.isEmpty { return .needsYou }
    return groups.workflows.contains { !$0.active.isEmpty } ? .running : .all
  }

  /// A workflow's two-letter mark.
  public static func chip(_ name: String) -> String {
    let parts = name.split { !($0.isLetter || $0.isNumber) }.map(String.init)
    let letters =
      parts.count > 1 ? "\(parts[0].prefix(1))\(parts[1].prefix(1))" : String((parts.first ?? name).prefix(2))
    return letters.uppercased()
  }

  public static func state(_ node: WorkflowRunNode) -> (word: WorkflowRunWord, tone: WorkflowRunTone) {
    if !node.questions.isEmpty { return (.needsYou, .input) }
    switch node.run.status.known {
    case .paused: return (.paused, .failed)
    case .running: return (.working, .working)
    case .waiting:
      let detail = node.run.detail ?? ""
      if detail.hasPrefix("agent ") { return (.working, .working) }
      if detail.hasPrefix("sleep ") { return (.sleeping, .quiet) }
      // Something below it holds it up; say that, not that it idles.
      if node.children.contains(where: \.needsPerson) { return (.needsYou, .input) }
      return (.waiting, .quiet)
    case .completed: return (.done, .done)
    case .stopped: return (.stopped, .quiet)
    case .skipped: return (.skipped, .quiet)
    case .cancelled: return (.cancelled, .quiet)
    case nil: return (.unknown, .quiet)
    }
  }

  static func firstLine(_ text: String) -> String {
    text.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: "\n", omittingEmptySubsequences: false)
      .first.map { $0.trimmingCharacters(in: .whitespaces) } ?? ""
  }

  public static func now(_ node: WorkflowRunNode) -> WorkflowRunNow {
    let run = node.run
    let detail = run.detail?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if let asked = node.questions.first {
      return .asks(question: read(asked).title, more: node.questions.count - 1)
    }
    let below = node.descendants
    let holding = below.first { !$0.questions.isEmpty || $0.run.status == .paused }
    switch run.status.known {
    case .paused:
      return detail.isEmpty ? .stepFailed : .detail(firstLine(detail))
    case .running:
      return .runningOwnSteps
    case .waiting:
      if let holding { return .child(title: holding.run.title, now: now(holding)) }
      if detail.hasPrefix("agent ") { return .agentWorking(step: String(detail.dropFirst(6))) }
      if detail.hasPrefix("sleep ") { return .sleepingAt(step: String(detail.dropFirst(6))) }
      let open = below.filter { !$0.run.hasEnded }
      if open.count == 1 { return .runsOne(title: open[0].run.title) }
      if open.count > 1 { return .runsMany(count: open.count) }
      return detail.isEmpty ? .waiting : .waitingFor(step: detail)
    case .completed:
      guard let line = resultLines(run.result).first else { return .finished }
      return .result(firstLine(line.label.map { "\($0): \(line.value)" } ?? line.value))
    case .stopped, .skipped, .cancelled, nil:
      return detail.isEmpty ? .endedEarly : .detail(firstLine(detail))
    }
  }

  /// A result as lines a person can read: a sentence, or the fields of an object. Fields come in
  /// key order (Foundation does not keep the server's order).
  public static func resultLines(_ result: JSONValue?) -> [(label: String?, value: String)] {
    guard let result else { return [] }
    switch result {
    case .null: return []
    case .object(let fields):
      return fields.keys.sorted().map { key in (key, fields[key]?.stringValue ?? compact(fields[key] ?? .null)) }
    case .array: return [(nil, compact(result))]
    case .string(let text): return [(nil, text)]
    default: return [(nil, compact(result))]
    }
  }

  /// JSON as JavaScript's `String`/`JSON.stringify` would show it.
  static func compact(_ value: JSONValue) -> String {
    switch value {
    case .null: "null"
    case .bool(let flag): flag ? "true" : "false"
    case .number(let number): number.rounded() == number && abs(number) < 1e15 ? String(Int(number)) : String(number)
    case .string(let text): text
    default:
      (try? JSONEncoder.sortedWire.encode(value)).map { String(decoding: $0, as: UTF8.self) } ?? ""
    }
  }

  /// A person's answer to a question, when a step's result is one.
  public static func answer(_ result: JSONValue?) -> (choice: String, reason: String?)? {
    guard let choice = result?["choice"]?.stringValue else { return nil }
    let reason = result?["reason"]?.stringValue
    return (choice, reason.flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0 })
  }

  // MARK: Steps

  /// A step this short is bookkeeping between the parts of a run that take time.
  static let quickStepMs = 1_000.0

  /// A run's steps as its story: beats, with quick steps between them folded into one row, and
  /// an invoked run in place of the two steps that started and awaited it.
  public static func timeline(run: WorkflowRun, steps: [WorkflowStep], children: [WorkflowRun], now: Date) -> WorkflowTimeline {
    var childByStep: [String: WorkflowRun] = [:]
    for child in children where child.parentRunId == run.runId {
      if let step = child.parentStep { childByStep[step] = child }
    }
    let ms = { (stamp: WireTimestamp?) in (stamp?.date?.timeIntervalSince1970 ?? 0) * 1000 }
    let startMs = ms(run.startedAt)
    // A caller's clock can be a minute old. Now is never before anything the run has done.
    let nowMs = ([now.timeIntervalSince1970 * 1000, startMs] + steps.map { ms($0.endedAt ?? $0.startedAt) }).max()!
    let endMs = run.endedAt == nil ? nowMs : ms(run.endedAt)
    var rows: [WorkflowTimelineRow] = []
    var beats: [WorkflowBeat] = []
    var quick: [WorkflowStep] = []
    func flush() {
      guard let first = quick.first, let last = quick.last else { return }
      rows.append(.quick(WorkflowQuickSteps(steps: quick, startMs: ms(first.startedAt), endMs: ms(last.endedAt ?? last.startedAt))))
      quick = []
    }
    for step in steps {
      if step.kind == .step, step.name.hasSuffix("/start"), childByStep[String(step.name.dropLast(6))] != nil { continue }
      let stepStart = ms(step.startedAt)
      let stepEnd = step.endedAt == nil ? nowMs : ms(step.endedAt)
      let childRun = step.kind == .wait ? childByStep[step.name] : nil
      let isBeat = step.kind != .step || step.status != .completed || step.attempts > 1 || stepEnd - stepStart >= quickStepMs
      guard isBeat else {
        quick.append(step)
        continue
      }
      flush()
      let beat = WorkflowBeat(
        kind: childRun == nil ? WorkflowBeat.Kind(step.kind) : .run, name: step.name,
        status: step.status.known ?? .running, attempts: step.attempts, detail: step.detail, result: step.result,
        said: step.said, startMs: stepStart, endMs: max(stepStart, stepEnd), threadId: step.threadId,
        threadEnvironmentId: step.environmentId, childRun: childRun, parallel: false)
      beats.append(beat)
      rows.append(.beat(beat))
    }
    flush()
    func overlaps(_ left: WorkflowBeat, _ right: WorkflowBeat) -> Bool {
      left.startMs < right.openEnd && right.startMs < left.openEnd
    }
    let marked: [WorkflowTimelineRow] = rows.enumerated().map { offset, row in
      guard case .beat(var beat) = row else { return row }
      let index = beats.firstIndex(where: { $0.name == beat.name && $0.startMs == beat.startMs }) ?? offset
      beat.parallel = beats.enumerated().contains { $0.offset != index && overlaps(beat, $0.element) }
      return .beat(beat)
    }
    return WorkflowTimeline(rows: marked, startMs: startMs, endMs: max(endMs, beats.map(\.endMs).max() ?? 0, startMs + 1))
  }

  /// Beats that overlapped become one row, so two reviewers at once read as such.
  public static func feed(_ timeline: WorkflowTimeline) -> [WorkflowFeedRow] {
    var rows: [WorkflowFeedRow] = []
    var together: [WorkflowBeat] = []
    var until = 0.0
    func flush() {
      if together.count == 1 { rows.append(.beat(together[0])) } else if together.count > 1 { rows.append(.together(together)) }
      together = []
    }
    for row in timeline.rows {
      switch row {
      case .quick(let quick):
        flush()
        rows.append(.quick(quick))
      case .beat(let beat):
        if !together.isEmpty, beat.parallel, beat.startMs < until {
          together.append(beat)
          until = max(until, beat.openEnd)
          continue
        }
        flush()
        together = [beat]
        until = beat.openEnd
      }
    }
    flush()
    return rows
  }

  /// The step a paused run stopped at: the last that failed, unless the run went on after it.
  public static func pausedBeat(_ rows: [WorkflowFeedRow], status: WireEnum<WorkflowRunStatus>) -> WorkflowBeat? {
    guard status == .paused, let failed = rows.flatMap(\.beats).last(where: { $0.status == .failed }) else { return nil }
    let wentOn = rows.contains { row in
      switch row {
      case .together(let beats): beats.contains { $0 != failed && $0.startMs >= failed.endMs }
      case .beat(let beat): beat != failed && beat.startMs >= failed.endMs
      case .quick(let quick): quick.startMs >= failed.endMs
      }
    }
    return wentOn ? nil : failed
  }

  private static let factLength = 48
  private static let factsShown = 6
  private static let proseLength = 80

  static func words(_ key: String) -> String {
    key.replacing(/([a-z0-9])([A-Z])/) { "\($0.1) \($0.2)" }.replacing(/[_-]+/, with: " ").lowercased()
  }

  static func factValue(_ value: JSONValue) -> String? {
    switch value {
    case .bool(let flag): return flag ? "yes" : "no"
    case .number: return compact(value)
    case .string(let text):
      let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
      return !text.isEmpty && text.count <= factLength && !text.contains("\n") ? text : nil
    case .array(let values) where !values.isEmpty && values.count <= 4:
      let parts = values.map(factValue)
      guard parts.allSatisfy({ $0 != nil }) else { return nil }
      let joined = parts.compactMap(\.self).joined(separator: ", ")
      return joined.count <= factLength ? joined : nil
    default: return nil
    }
  }

  /// What an agent step has to say: its closing words and the short facts of its result.
  public static func agentSummary(result: JSONValue?, said: String?) -> (said: String?, facts: [(label: String, value: String)]) {
    let kept = said?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    switch result {
    case .string(let text)?:
      let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
      return (kept.isEmpty ? (text.isEmpty ? nil : text) : kept, [])
    case .object(let fields)?:
      let keys = fields.keys.sorted()
      let prose =
        kept.isEmpty
        ? keys.compactMap { key in fields[key]?.stringValue.flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).count >= proseLength ? $0 : nil } }
          .max { $0.count < $1.count }
        : nil
      let facts = keys.compactMap { key in fields[key].flatMap(factValue).map { (words(key), $0) } }
      return (kept.isEmpty ? prose?.trimmingCharacters(in: .whitespacesAndNewlines) : kept, Array(facts.prefix(factsShown)))
    default:
      return (kept.isEmpty ? nil : kept, [])
    }
  }

  /// A step's time in one shape down a column: 0.3s, 9.7s, 12s, then minutes.
  public static func stepTime(_ ms: Double) -> String {
    if ms < 10_000, ms.truncatingRemainder(dividingBy: 1000) != 0 {
      return String(format: "%.1fs", max(ms, 100) / 1000)
    }
    if ms < 60_000 { return "\(Int((ms / 1000).rounded()))s" }
    let total = Int((ms / 1000).rounded())
    let (hours, minutes, seconds) = (total / 3600, (total % 3600) / 60, total % 60)
    var parts: [String] = []
    if hours > 0 { parts.append("\(hours)h") }
    if minutes > 0 { parts.append("\(minutes)m") }
    if seconds > 0 || minutes > 0 { parts.append("\(seconds)s") }
    return parts.joined(separator: " ")
  }

  /// A reply's first sentence as plain words.
  public static func oneLine(_ text: String) -> String {
    let line =
      text.split(separator: "\n", omittingEmptySubsequences: false)
      .map { $0.trimmingCharacters(in: .whitespaces) }
      .first { !$0.isEmpty && !$0.hasPrefix("#") && !$0.hasPrefix("```") && !$0.hasPrefix("|") }?
      .replacing(/^([-*>]|\d+\.)\s+/, with: "") ?? ""
    let plain = line.replacing(/\[([^\]]*)\]\([^)]*\)/) { String($0.1) }
      .replacing(/`([^`]*)`/) { String($0.1) }
      .replacing(/(\*\*|__|\*|_)(\S(?:.*?\S)?)\1/) { String($0.2) }
    guard let end = plain.firstMatch(of: /[.!?](\s|$)/) else { return plain }
    return String(plain[..<plain.index(after: end.range.lowerBound)])
  }

  /// What a reference is called: `#412` for an issue or pull request, a tracker key, else its
  /// title (or kind).
  public static func referenceLabel(_ reference: WorkflowRunReference) -> String {
    if reference.kind == "pullRequest", let number = reference.address?["number"]?.intValue { return "#\(number)" }
    if reference.kind == "issue", let key = reference.address?["key"]?.stringValue {
      return key.allSatisfy(\.isNumber) && !key.isEmpty ? "#\(key)" : key
    }
    return reference.title.isEmpty ? reference.kind : reference.title
  }

  public static func stepReferences(_ references: [WorkflowRunReference], step: String) -> [WorkflowRunReference] {
    references.filter { $0.steps.contains(step) }
  }
}

/// One part of a run that took time or involved someone.
public struct WorkflowBeat: Sendable, Hashable, Identifiable {
  public enum Kind: Sendable, Hashable {
    case step, wait, agent, ask, sleep, run, unknown
    init(_ kind: WireEnum<WorkflowStep.Kind>) {
      switch kind.known {
      case .step: self = .step
      case .wait: self = .wait
      case .agent: self = .agent
      case .ask: self = .ask
      case .sleep: self = .sleep
      case nil: self = .unknown
      }
    }
  }

  public var kind: Kind
  public var name: String
  public var status: WorkflowStep.Status
  public var attempts: Int
  public var detail: String?
  public var result: JSONValue?
  public var said: String?
  public var startMs: Double
  public var endMs: Double
  public var threadId: String?
  public var threadEnvironmentId: String?
  public var childRun: WorkflowRun?
  public var parallel: Bool

  public var id: String { "\(name)@\(startMs)" }
  /// One still under way never stops overlapping what starts after it.
  var openEnd: Double { status == .running ? .infinity : endMs }
}

public struct WorkflowQuickSteps: Sendable, Hashable {
  public var steps: [WorkflowStep]
  public var startMs: Double
  public var endMs: Double
}

public enum WorkflowTimelineRow: Sendable, Hashable {
  case beat(WorkflowBeat)
  case quick(WorkflowQuickSteps)
}

public struct WorkflowTimeline: Sendable, Hashable {
  public var rows: [WorkflowTimelineRow]
  public var startMs: Double
  public var endMs: Double
}

public enum WorkflowFeedRow: Sendable, Hashable, Identifiable {
  case beat(WorkflowBeat)
  case quick(WorkflowQuickSteps)
  case together([WorkflowBeat])

  public var beats: [WorkflowBeat] {
    switch self {
    case .beat(let beat): [beat]
    case .together(let beats): beats
    case .quick: []
    }
  }

  public var id: String {
    switch self {
    case .beat(let beat): beat.id
    case .together(let beats): beats.map(\.id).joined(separator: "+")
    case .quick(let quick): "quick@\(quick.startMs):\(quick.steps.first?.name ?? "")"
    }
  }
}
