import Foundation

/// What a work-log row did, as a semantic value the app turns into copy (`WorkCopy`). A port of
/// the labels in `apps/mobile/src/lib/threadActivity.ts` (`itemSummary`, `singleToolCallLabel`,
/// `liveToolActivitySummary`) without the Ankiel MCP tool sentences and the shell parser.
public enum ActivityLabel: Sendable, Hashable {
  /// A shell command, shown as its text.
  case command(String)
  /// A command while it runs or after it ended, named by its program ("Running rg").
  case program(String, TurnItem.Lifecycle)
  /// A reasoning block: its first line, or nil for "Thinking"/"Thought".
  case thought(String?, live: Bool)
  case changedFile(String)
  case changedFiles(Int)
  case read(String?)
  case searchedCode(String?)
  case searchedWeb(String?)
  case tool(String)
  /// The provider's own title for the item.
  case titled(String)
  case approvalRequested
  case inputRequested
  case interruptRequested
  case interrupted
  case checkpoint
  case plan
  case todo
  case providerError
  case usageLimit
  case notice(String)
  case compaction(before: Int?, after: Int?)
  case handoff(model: String?)
  case forked
  case threadCreated
  case secret(String)
  case link(String)
  case subagent(String?)
  case unknown(type: String, title: String?)
}

/// The action a tool call counts as in a group summary (`ToolGroupAction`, generic actions only).
public enum WorkAction: String, Sendable, Hashable, CaseIterable {
  case read, edit, command, search, codeSearch, threadCreate, other, update

  /// Lower sorts first when a summary picks its two clauses (`summaryActionPriority`).
  var priority: Int {
    switch self {
    case .command, .edit, .threadCreate: 0
    case .other, .update: 2
    default: 1
    }
  }
}

/// A collapsed group's one-line summary (`summarizeToolGroup`): up to two clauses and a count of
/// the rest, or a reasoning-only group.
public struct WorkSummary: Sendable, Hashable {
  public struct Clause: Sendable, Hashable {
    public var action: WorkAction
    public var count: Int
  }

  public var clauses: [Clause]
  public var otherCount: Int
  /// Set for a group of only reasoning: how many thoughts.
  public var thoughts: Int?
  public var hasFailure: Bool
}

/// The broad kind of a work row, for its icon.
public enum WorkKind: String, Sendable, Hashable {
  case command, edit, read, search, web, tool, thinking, agent, approval, question, notice, warning, error, stop
  case check, plan, link, lock, unknown
}

/// How a row ended, for its status mark.
public enum WorkOutcome: Sendable, Hashable {
  case success, failure, neutral
}

/// What an expanded work row shows.
public enum WorkDetail: Sendable, Hashable {
  /// The command, its exit code, and its output when the item carries it (the stream strips it;
  /// `outputOmitted` means the server has more).
  case command(input: String, exitCode: Int?, output: String?, outputOmitted: Bool)
  case files([FileStat], additions: Int?, deletions: Int?)
  case text(String)
  case search(patterns: [String], results: [String])
  case tool(name: String?, input: String?)

  public struct FileStat: Sendable, Hashable {
    public var path: String
    public var operation: String?
  }
}

/// One work-log item, ready to render.
public struct WorkActivity: Sendable, Hashable, Identifiable {
  /// The feed id (`visibility:sourceThread:sourceItem`).
  public var id: String
  public var itemId: String
  public var runId: String?
  public var attemptId: String?
  public var type: String
  public var kind: WorkKind
  public var label: ActivityLabel
  public var outcome: WorkOutcome?
  public var lifecycle: TurnItem.Lifecycle
  public var detail: WorkDetail?
  public var toolLike: Bool
  public var prominent: Bool
  public var action: WorkAction
  public var changedFiles: [String]
  public var startedAt: WireTimestamp
  public var revision: Int

  /// `threadFeedActivityIsVisible`: in-progress tool rows hide unless the run is working on them.
  var isSettledVisible: Bool {
    prominent || lifecycle == .stopped || lifecycle == .idle || !(toolLike && outcome == .neutral)
  }

  var isReasoning: Bool { type == "reasoning" }
}

extension WorkActivity {
  init(row: ProjectedTurnItem, attemptId: String?) {
    let item = row.item
    id = row.feedId
    itemId = item.id
    runId = item.runId
    self.attemptId = attemptId
    type = item.type
    lifecycle = item.lifecycle
    startedAt = item.displayStart
    revision = item.revision
    toolLike = Self.isToolLike(item.body)
    prominent = Self.isProminent(item)
    action = Self.action(item)
    changedFiles = if case .fileChange(let change) = item.body { change.paths } else { [] }
    kind = Self.kind(item)
    label = Self.label(item)
    detail = Self.detail(item)
    outcome = Self.outcome(item, toolLike: toolLike)
  }

  static func isToolLike(_ body: TurnItemBody) -> Bool {
    switch body {
    case .reasoning, .commandExecution, .fileChange, .fileSearch, .webSearch, .approvalRequest, .userInputRequest,
      .dynamicTool, .subagent:
      true
    default:
      false
    }
  }

  static func isProminent(_ item: TurnItem) -> Bool {
    switch item.body {
    case .fork, .threadCreated, .systemNotice, .proposedPlan, .secretRequest: true
    case .error: item.status == .failed
    default: false
    }
  }

  /// `workEntryDisplayIndicatesToolFailure`, for commands: the server's failure flag or a nonzero exit.
  static func indicatesFailure(_ item: TurnItem) -> Bool {
    guard case .commandExecution(let command) = item.body else { return false }
    if command.outputIndicatesFailure == true { return true }
    if let exit = command.exitCode { return exit != 0 }
    return false
  }

  static func outcome(_ item: TurnItem, toolLike: Bool) -> WorkOutcome? {
    switch item.body {
    case .notification(let notification):
      return notification.outcome == "failed" ? .failure : nil
    case .error(let error):
      if item.status == .failed { return error.failure.isUsageLimit ? .neutral : .failure }
      return item.status == .completed ? .success : .neutral
    default:
      guard toolLike else { return nil }
      if indicatesFailure(item) { return .failure }
      if item.status == .failed { return .failure }
      return item.status == .completed ? .success : .neutral
    }
  }

  // MARK: Classification

  /// `computeToolGroupAction` for the generic actions, with `classifyToolActivity`'s tool names.
  static func action(_ item: TurnItem) -> WorkAction {
    switch item.body {
    case .threadCreated: return .threadCreate
    case .commandExecution: return .command
    case .fileChange: return .edit
    case .fileSearch: return .codeSearch
    case .webSearch:
      return (item.title ?? "").range(of: #"\bgrep\b"#, options: [.regularExpression, .caseInsensitive]) != nil
        ? .codeSearch : .search
    case .approvalRequest(let request):
      return request.requestKind == "file-read" ? .read : .other
    case .userInputRequest: return .other
    case .dynamicTool(let tool):
      if tool.viewedImagePath != nil { return .read }
      switch toolNameToken(tool.toolName) {
      case "terminal", "bash", "shell", "execcommand": return .command
      case "read", "readfile", "view", "viewimage", "notebookread": return .read
      case "find", "grep", "glob", "rg", "ls", "search", "codesearch": return .codeSearch
      case "edit", "write", "multiedit", "applypatch", "strreplace", "notebookedit", "writefile": return .edit
      case "websearch", "webfetch", "fetch": return .search
      default: return .other
      }
    case .subagent: return .other
    default: return .update
    }
  }

  /// `toolNameToken`: a bare tool name, lowercased without separators; namespaced names (MCP
  /// `server__tool`, dotted or slashed) are not classified.
  static func toolNameToken(_ name: String?) -> String? {
    guard let trimmed = name?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty,
      !trimmed.contains("__"), !trimmed.contains("."), !trimmed.contains("/")
    else { return nil }
    return trimmed.lowercased().filter { $0 != "_" && $0 != "-" && $0 != " " }
  }

  static func kind(_ item: TurnItem) -> WorkKind {
    switch item.body {
    case .reasoning: .thinking
    case .commandExecution: .command
    case .fileChange: .edit
    case .fileSearch: .search
    case .webSearch: .web
    case .approvalRequest(let request): request.requestKind == "permission" ? .lock : .approval
    case .userInputRequest: .question
    case .dynamicTool:
      switch action(item) {
      case .read: .read
      case .codeSearch: .search
      case .command: .command
      case .edit: .edit
      case .search: .web
      default: .tool
      }
    case .subagent: .agent
    case .systemNotice(let notice): notice.level == "info" || notice.level == nil ? .notice : .warning
    case .runInterruptRequest, .runInterruptResult: .stop
    case .error(let error): error.failure.isUsageLimit ? (item.status == .completed ? .check : .warning) : .error
    case .checkpoint, .todoList: .check
    case .proposedPlan: .plan
    case .compaction, .handoff, .fork, .threadCreated, .notification: .notice
    case .secretRequest: .lock
    case .linkRequest: .link
    case .userMessage, .assistantMessage: .notice
    case .unknown: .unknown
    }
  }

  static func label(_ item: TurnItem) -> ActivityLabel {
    let title = item.title?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
    switch item.body {
    case .notification(let notification): return .notice(notification.summary)
    case .systemNotice(let notice): return .notice(notice.message)
    case .compaction(let compaction):
      return .compaction(before: compaction.beforeTokenCount, after: compaction.afterTokenCount)
    case .subagent: return .subagent(title)
    case .reasoning(let reasoning):
      return .thought(Self.thoughtLine(reasoning.text), live: item.lifecycle == .inProgress)
    case .commandExecution(let command):
      return .command(Self.compact(command.input))
    case .fileChange(let change):
      let paths = change.paths
      return paths.count > 1 ? .changedFiles(paths.count) : .changedFile(paths.first ?? change.fileName)
    case .fileSearch(let search): return .searchedCode(title ?? search.pattern)
    case .webSearch(let search): return .searchedWeb(search.patterns?.joined(separator: ", "))
    case .dynamicTool(let tool):
      if let title { return .titled(Self.capitalized(title)) }
      switch action(item) {
      case .read: return .read(Self.toolPath(tool))
      case .codeSearch: return .searchedCode(Self.toolPattern(tool))
      default: return .tool(tool.toolName ?? "")
      }
    case .approvalRequest: return .approvalRequested
    case .userInputRequest: return .inputRequested
    case .checkpoint: return .checkpoint
    case .runInterruptRequest: return .interruptRequested
    case .runInterruptResult: return .interrupted
    case .error(let error): return error.failure.isUsageLimit ? .usageLimit : .providerError
    case .handoff(let handoff): return .handoff(model: handoff.toModel)
    case .fork: return .forked
    case .threadCreated: return .threadCreated
    case .secretRequest(let request): return .secret(request.label)
    case .linkRequest(let request): return .link(request.reason)
    case .proposedPlan: return .plan
    case .todoList: return .todo
    case .userMessage, .assistantMessage: return .titled(title ?? "")
    case .unknown(let type): return .unknown(type: type, title: title)
    }
  }

  /// The row label once a group shows one call alone or the call is live.
  static func liveLabel(_ activity: WorkActivity) -> ActivityLabel {
    switch activity.label {
    case .command(let command):
      guard let program = programName(command) else { return activity.label }
      return .program(program, activity.lifecycle)
    default:
      return activity.label
    }
  }

  static func detail(_ item: TurnItem) -> WorkDetail? {
    switch item.body {
    case .reasoning(let reasoning):
      return reasoning.text.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty.map(WorkDetail.text)
    case .commandExecution(let command):
      return .command(
        input: command.input, exitCode: command.exitCode, output: command.output,
        outputOmitted: command.outputOmitted == true)
    case .fileChange(let change):
      let files = (change.changes?.elements ?? []).map { WorkDetail.FileStat(path: $0.path, operation: $0.operation) }
      return .files(
        files.isEmpty ? [WorkDetail.FileStat(path: change.fileName, operation: nil)] : files,
        additions: change.additions, deletions: change.deletions)
    case .fileSearch(let search):
      return .search(
        patterns: search.pattern.map { [$0] } ?? [],
        results: (search.results?.elements ?? []).map { result in
          result.line.map { "\(result.fileName):\($0)" } ?? result.fileName
        })
    case .webSearch(let search):
      return .search(
        patterns: search.patterns ?? [],
        results: (search.results?.elements ?? []).compactMap { $0.title ?? $0.url })
    case .dynamicTool(let tool):
      return .tool(name: tool.toolName, input: tool.input.flatMap(Self.preview))
    case .approvalRequest(let request):
      return [request.prompt, request.reason].compactMap { $0?.nilIfEmpty }.joined(separator: "\n\n").nilIfEmpty
        .map(WorkDetail.text)
    case .userInputRequest(let request):
      return request.questions.elements.map(\.question).joined(separator: "\n").nilIfEmpty.map(WorkDetail.text)
    case .subagent(let call):
      return (call.result ?? call.progress ?? call.prompt).nilIfEmpty.map(WorkDetail.text)
    case .notification(let notification):
      return notification.detail?.nilIfEmpty.map(WorkDetail.text)
    case .error(let error):
      return error.failure.message.nilIfEmpty.map(WorkDetail.text)
    case .systemNotice, .compaction, .handoff, .fork, .threadCreated, .secretRequest, .linkRequest,
      .runInterruptRequest, .runInterruptResult, .checkpoint, .proposedPlan, .todoList, .userMessage,
      .assistantMessage, .unknown:
      return nil
    }
  }

  // MARK: Text helpers

  static let labelLimit = 200

  /// Collapses whitespace and caps a label (`compactWorkEntryText`).
  static func compact(_ text: String) -> String {
    let collapsed = text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    return collapsed.count > labelLimit ? String(collapsed.prefix(labelLimit - 1)) + "…" : collapsed
  }

  static func capitalized(_ text: String) -> String {
    guard let first = text.first else { return text }
    return first.uppercased() + text.dropFirst()
  }

  /// `liveThoughtLine`: a bold lead heading, else the first sentence, without markdown marks.
  static func thoughtLine(_ markdown: String) -> String? {
    let trimmed = markdown.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    if let match = trimmed.firstMatch(of: /^\*\*([^*\r\n]+)\*\*[ \t]*(?:\r?\n|$)/) {
      return compact(String(match.1))
    }
    var text = trimmed
      .replacing(/!?\[([^\]]*)\]\([^)]*\)/) { String($0.1) }
      .replacing(/(?m)^[ \t]*(?:#{1,6}|[-*+]|\d+\.)[ \t]+/, with: "")
      .replacing(/`+|\*\*|~~/, with: "")
    text = text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    if let end = text.firstMatch(of: /[.?!]["'”’)]?(?=\s)|[。！？]/) {
      text = String(text[..<end.range.upperBound])
    }
    return compact(text)
  }

  /// The program a command runs, for "Running rg": the first word of its last `&&`/`;` step,
  /// skipping `cd`, environment assignments and `sudo`/`env`/`time` wrappers. nil when unclear.
  static func programName(_ command: String) -> String? {
    let firstLine = command.split(separator: "\n").first.map(String.init) ?? command
    let steps = firstLine.split(separator: /&&|;|\|\|/).map { $0.trimmingCharacters(in: .whitespaces) }
    guard let step = steps.last(where: { !$0.hasPrefix("cd ") && $0 != "cd" }) ?? steps.last else { return nil }
    for token in step.split(separator: " ") {
      let word = String(token)
      if word.contains("=") || ["sudo", "env", "time", "exec", "nohup", "command"].contains(word) { continue }
      let name = word.split(separator: "/").last.map(String.init) ?? word
      let cleaned = name.trimmingCharacters(in: CharacterSet(charactersIn: "\"'()"))
      return cleaned.isEmpty || cleaned.count > 40 ? nil : cleaned
    }
    return nil
  }

  static func toolPath(_ tool: TurnItemBody.DynamicTool) -> String? {
    if let path = tool.viewedImagePath { return path }
    for key in ["file_path", "path", "filePath", "file", "notebook_path"] {
      if let value = tool.input?[key]?.stringValue, !value.isEmpty { return value }
    }
    return nil
  }

  static func toolPattern(_ tool: TurnItemBody.DynamicTool) -> String? {
    for key in ["pattern", "query", "glob", "regex"] {
      if let value = tool.input?[key]?.stringValue, !value.isEmpty { return value }
    }
    return nil
  }

  /// A short JSON preview of a tool input.
  static func preview(_ value: JSONValue) -> String? {
    if case .object(let object) = value, object.isEmpty { return nil }
    if let string = value.stringValue { return string.nilIfEmpty }
    let text = value.compactDescription
    return text.count > 2000 ? String(text.prefix(2000)) + "…" : text
  }
}

extension WorkSummary {
  /// `summarizeToolGroup` over the generic actions.
  init(_ activities: [WorkActivity]) {
    let tools = activities.filter { !$0.isReasoning }
    hasFailure = tools.contains { $0.outcome == .failure }
    if !activities.isEmpty, tools.isEmpty {
      clauses = []
      otherCount = 0
      thoughts = activities.count
      return
    }
    thoughts = nil
    var order: [WorkAction] = []
    var members: [WorkAction: [WorkActivity]] = [:]
    for activity in tools {
      if members[activity.action] == nil { order.append(activity.action) }
      members[activity.action, default: []].append(activity)
    }
    let all = order.enumerated().map { index, action in
      (index: index, action: action, count: Self.count(action, members[action] ?? []), members: members[action]?.count ?? 0)
    }
    let selected = all.sorted { ($0.action.priority, $0.index) < ($1.action.priority, $1.index) }
      .prefix(2).sorted { $0.index < $1.index }
    clauses = selected.map { Clause(action: $0.action, count: $0.count) }
    otherCount = tools.count - selected.reduce(0) { $0 + $1.members }
  }

  /// An edit clause counts distinct files, plus edits that named none (`toolGroupActionCount`).
  private static func count(_ action: WorkAction, _ activities: [WorkActivity]) -> Int {
    guard action == .edit else { return activities.count }
    var files = Set<String>()
    var unnamed = 0
    for activity in activities {
      if activity.changedFiles.isEmpty { unnamed += 1 } else { files.formUnion(activity.changedFiles) }
    }
    return files.count + unnamed
  }
}

extension String {
  var nilIfEmpty: String? { isEmpty ? nil : self }
}
