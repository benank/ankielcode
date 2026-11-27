import Foundation

/// How a terminal is named in menus (RN `resolveTerminalSessionLabel`): the running process, or
/// "Terminal N" for the client's numbered ids, or the id itself.
public enum TerminalName: Sendable, Hashable {
  case process(String)
  case numbered(String)
  case id(String)
}

/// One terminal in the thread's and the terminal screen's menus (RN `TerminalMenuSession`).
public struct TerminalMenuEntry: Sendable, Hashable, Identifiable {
  public var terminalId: String
  public var cwd: String?
  public var status: TerminalStatus
  public var hasRunningSubprocess: Bool
  public var name: TerminalName

  public var id: String { terminalId }

  public init(terminalId: String, cwd: String?, status: TerminalStatus, hasRunningSubprocess: Bool, name: TerminalName) {
    self.terminalId = terminalId
    self.cwd = cwd
    self.status = status
    self.hasRunningSubprocess = hasRunningSubprocess
    self.name = name
  }
}

/// The RN terminal menu rules (`terminalMenu.ts`, `@ankielcode/shared/terminalLabels`).
public enum TerminalMenu {
  /// The number in `term-3` / `terminal-3` / `term-3-<uuid>`.
  public static func number(_ terminalId: String) -> String? {
    let pattern = /^term(?:inal)?-(\d+)(?:-[\da-fA-F]{8}(?:-[\da-fA-F]{4}){3}-[\da-fA-F]{12})?$/
    return (try? pattern.ignoresCase().wholeMatch(in: terminalId)).map { String($0.output.1) }
  }

  /// The server's English idle label (`getTerminalLabel` in `terminalLabels.ts`).
  static func serverDefaultLabel(_ terminalId: String) -> String {
    number(terminalId).map { "Terminal \($0)" } ?? terminalId
  }

  public static func name(_ terminalId: String) -> TerminalName {
    number(terminalId).map(TerminalName.numbered) ?? .id(terminalId)
  }

  /// The process label when one runs, else "Terminal N".
  public static func name(_ terminalId: String, label: String?, hasRunningSubprocess: Bool) -> TerminalName {
    let trimmed = label?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let idleDefault = !hasRunningSubprocess && trimmed == serverDefaultLabel(terminalId)
    return !trimmed.isEmpty && !idleDefault ? .process(trimmed) : name(terminalId)
  }

  /// The first free `term-N`; a suffix keeps ids unique when the list could not be read.
  public static func nextId(_ existing: [String], uniqueSuffix: String? = nil) -> String {
    let used = Set(existing.compactMap(number))
    var index = 1
    while used.contains(String(index)) { index += 1 }
    return "term-\(index)" + (uniqueSuffix.map { "-\($0)" } ?? "")
  }

  /// Counts the shown terminal before the list loads, so "new" never reopens it.
  public static func nextOpenId(listed: [String], active: String?, uniqueSuffix: String? = nil) -> String {
    let listed = listed.filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
    guard let active, !active.trimmingCharacters(in: .whitespaces).isEmpty, !listed.contains(active) else {
      return nextId(listed, uniqueSuffix: uniqueSuffix)
    }
    return nextId(listed + [active], uniqueSuffix: uniqueSuffix)
  }

  /// Live terminals of a thread plus the one on screen, in numeric id order.
  public static func entries(
    _ summaries: [TerminalSummary], threadId: String, current: TerminalMenuEntry? = nil
  ) -> [TerminalMenuEntry] {
    var byId: [String: TerminalMenuEntry] = [:]
    for summary in summaries where summary.threadId == threadId {
      let status = summary.status.known ?? .closed
      guard status.isLive || summary.terminalId == current?.terminalId else { continue }
      byId[summary.terminalId] = TerminalMenuEntry(
        terminalId: summary.terminalId, cwd: summary.cwd, status: status,
        hasRunningSubprocess: summary.hasRunningSubprocess,
        name: name(summary.terminalId, label: summary.label, hasRunningSubprocess: summary.hasRunningSubprocess))
    }
    if let current, byId[current.terminalId] == nil { byId[current.terminalId] = current }
    return byId.values.sorted { order($0.terminalId, $1.terminalId) }
  }

  /// Where to go when a shell exits: the nearest live terminal below it, else the first; nil
  /// leaves the terminal screen.
  public static func previousLive(_ entries: [TerminalMenuEntry], exited: String) -> String? {
    let live = entries.filter { $0.terminalId != exited && $0.status.isLive }.sorted { order($0.terminalId, $1.terminalId) }
    return (live.last { order($0.terminalId, exited) } ?? live.first)?.terminalId
  }

  /// The running shell a thread's Terminal opens when none is named: `term-1` first.
  public static func bootstrap(_ summaries: [TerminalSummary], threadId: String) -> String? {
    let running = summaries.filter { $0.threadId == threadId && ($0.status.known?.isLive ?? false) }
      .sorted { order($0.terminalId, $1.terminalId) }
    return (running.first { $0.terminalId == defaultTerminalId } ?? running.first)?.terminalId
  }

  /// `localeCompare(…, { numeric: true })` for terminal ids.
  static func order(_ left: String, _ right: String) -> Bool {
    left.compare(right, options: [.numeric]) == .orderedAscending
  }

  /// The folder name shown beside a terminal (RN `basename`).
  public static func basename(_ path: String?) -> String? {
    guard let path, !path.isEmpty else { return nil }
    var trimmed = path
    while trimmed.hasSuffix("/") { trimmed.removeLast() }
    if trimmed.isEmpty { return "/" }
    return trimmed.split(separator: "/").last.map(String.init) ?? trimmed
  }
}
