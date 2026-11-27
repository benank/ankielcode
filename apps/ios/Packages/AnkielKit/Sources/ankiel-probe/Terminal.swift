import AnkielKit
import Foundation

/// `--terminal <cwd> [--thread <id>]`: a real shell through the app's `TerminalSessionModel`.
/// Opens a terminal, runs `echo`, floods past the stream's ack window, resizes and reads the size
/// back, detaches and reattaches to check the scrollback, then closes it with its history. Run it
/// only in a throwaway folder: the shell is real. `ZDOTDIR` and history files point into it.
@MainActor
func probeTerminal(_ session: EnvironmentSession, cwd: String) async throws {
  try FileManager.default.createDirectory(atPath: cwd, withIntermediateDirectories: true)
  let threadId = argument("--thread") ?? "ankiel-probe-terminal"
  let terminalId = TerminalMenu.nextId([], uniqueSuffix: UUID().uuidString.lowercased())
  let target = TerminalTarget(environmentId: session.environmentId, threadId: threadId, terminalId: terminalId)
  let location = TerminalLocation(
    // zsh then skips the user's rc files, which may point HISTFILE at their home.
    cwd: cwd, worktreePath: nil, env: ["ZDOTDIR": cwd, "HISTFILE": "\(cwd)/.probe_history", "LESSHISTFILE": "-"])
  let host = FixedTerminalHost(channel: session.rpc)
  print("terminal:          \(threadId) / \(terminalId) in \(cwd)")

  var received = 0
  var resets = 0
  let model = TerminalSessionModel(target: target, location: location, host: host)
  model.output = { output in
    switch output {
    case .reset(let text): resets += 1; received += text.utf8.count
    case .append(let text): received += text.utf8.count
    }
  }
  model.start()
  defer { model.stop() }
  try await wait("attached and running", seconds: 20) { model.isLive }
  model.reportGrid(TerminalGrid(cols: 72, rows: 20))
  print("attached:          status=\(model.status) grid=\(model.sharedGrid.map { "\($0.cols)x\($0.rows)" } ?? "-")")

  model.write("echo ankiel-probe-$((40+2))\r")
  try await wait("echo output", seconds: 15) { model.replay.text.contains("ankiel-probe-42") }
  print("echo:              \(lastLines(model.replay.text, 2))")

  let before = received
  model.write("head -c 300000 /dev/zero | tr '\\0' x; echo; echo flood-$((1+1))-done\r")
  try await wait("flood", seconds: 30) { model.replay.text.contains("flood-2-done") }
  print("flood:             \(received - before) bytes streamed (ack window is 64 KiB), replay holds \(model.replay.byteCount) bytes (limit \(terminalHistoryBytes))")

  model.reportGrid(TerminalGrid(cols: 100, rows: 30))
  model.write("clear; sleep 0.5; stty size\r")
  try await wait("stty size", seconds: 10) { model.replay.text.contains("30 100") }
  print("resize:            stty says \"30 100\", shared grid \(model.sharedGrid.map { "\($0.cols)x\($0.rows)" } ?? "-")")

  model.write("echo before-reattach\r")
  try await wait("marker", seconds: 10) { lastLines(model.replay.text, 3).contains("before-reattach") }
  model.stop()

  var restored = ""
  let again = TerminalSessionModel(target: target, location: location, host: FixedTerminalHost(channel: session.rpc))
  again.output = { if case .reset(let text) = $0 { restored = text } }
  again.start()
  try await wait("reattach", seconds: 15) { again.isLive && !restored.isEmpty }
  print("reattach:          snapshot history \(restored.utf8.count) bytes, has marker=\(restored.contains("before-reattach")), resets=\(resets)")

  try await again.close()
  again.stop()
  print("closed:            deleteHistory=true")
}

private func lastLines(_ text: String, _ count: Int) -> String {
  text.split(whereSeparator: \.isNewline).suffix(count).map { $0.trimmingCharacters(in: .whitespaces) }.joined(separator: " | ")
}

@MainActor
private func wait(_ what: String, seconds: Double, _ condition: () -> Bool) async throws {
  let deadline = Date.now.addingTimeInterval(seconds)
  while !condition() {
    guard Date.now < deadline else { throw ProbeFailure(description: "timed out waiting for \(what)") }
    try await Task.sleep(for: .milliseconds(50))
  }
}

/// `--terminal-list <threadId> [--close <id,id>]`: a thread's terminals from
/// `subscribeTerminalMetadata`, and closes (with history) the ones named.
@MainActor
func probeTerminalList(_ session: EnvironmentSession, threadId: String) async throws {
  let directory = TerminalDirectory(host: FixedTerminalHost(channel: session.rpc))
  directory.start()
  defer { directory.stop() }
  try await wait("terminal list", seconds: 10) { directory.terminals != nil }
  for terminal in directory.terminals ?? [] where terminal.threadId == threadId {
    print("  \(terminal.terminalId) \(terminal.status) running=\(terminal.hasRunningSubprocess) label=\(terminal.label) cwd=\(terminal.cwd)")
  }
  for id in (argument("--close") ?? "").split(separator: ",").map(String.init) {
    let model = TerminalSessionModel(
      target: TerminalTarget(environmentId: session.environmentId, threadId: threadId, terminalId: id),
      location: TerminalLocation(cwd: "/tmp", worktreePath: nil), host: FixedTerminalHost(channel: session.rpc))
    model.start()
    try await wait("attach \(id)", seconds: 10) { model.version > 0 }
    try await model.close()
    model.stop()
    print("closed \(id)")
  }
}
