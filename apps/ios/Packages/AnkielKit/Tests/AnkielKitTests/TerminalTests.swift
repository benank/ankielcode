import Foundation
import Synchronization
import Testing

@testable import AnkielKit

/// Terminal wire shapes (compared with `Fixtures/commands/terminal-*.json`, which
/// `check-schemas.mjs` decodes with the server's schemas), the RN menu, input and paste rules,
/// the replay buffer, and the session model against a fake channel.
@Suite("Terminal")
struct TerminalTests {
  static let thread = "0b7e4f2a-9c1d-4e8b-a6f3-5d2c1b0a9e87"
  static let cwd = "/Users/dev/tide-chart"

  static let samples: [(name: String, schema: String, value: any Encodable & Sendable)] = [
    (
      "terminal-attach", "terminalAttach",
      TerminalAttachRequest(
        threadId: thread, terminalId: "term-1", cwd: cwd, worktreePath: nil, cols: 62, rows: 30, env: nil,
        resume: nil, maxHistoryBytes: terminalHistoryBytes)
    ),
    (
      "terminal-attach-resume", "terminalAttach",
      TerminalAttachRequest(
        threadId: thread, terminalId: "term-2", cwd: "\(cwd)/.worktrees/tides", worktreePath: "\(cwd)/.worktrees/tides",
        cols: 80, rows: 24, env: ["ANKIEL_PROJECT_ROOT": cwd], resume: true, maxHistoryBytes: terminalHistoryBytes)
    ),
    (
      "terminal-open", "terminalOpen",
      TerminalOpenRequest(threadId: thread, terminalId: "term-1", cwd: cwd, worktreePath: nil, cols: 62, rows: 30, env: nil)
    ),
    ("terminal-write", "terminalWrite", TerminalWriteRequest(threadId: thread, terminalId: "term-1", data: "ls -la\r")),
    ("terminal-resize", "terminalResize", TerminalResizeRequest(threadId: thread, terminalId: "term-1", cols: 44, rows: 18)),
    ("terminal-clear", "terminalClear", TerminalTargetRequest(threadId: thread, terminalId: "term-1")),
    ("terminal-close", "terminalClose", TerminalCloseRequest(threadId: thread, terminalId: "term-1", deleteHistory: true)),
    ("terminal-metadata", "terminalMetadata", TerminalMetadataRequest()),
  ]

  static var directory: URL {
    URL(filePath: #filePath).deletingLastPathComponent().appending(path: "Fixtures/commands", directoryHint: .isDirectory)
  }

  @Test("each request encodes exactly as its checked-in fixture", arguments: samples.map(\.name))
  func matchesFixture(_ name: String) throws {
    let sample = try #require(Self.samples.first { $0.name == name })
    let encoded = try JSONEncoder.wire.encode(sample.value)
    let url = Self.directory.appending(path: "\(name).json")
    if ProcessInfo.processInfo.environment["ANKIEL_WRITE_COMMAND_FIXTURES"] == "1" {
      let pretty = JSONEncoder()
      pretty.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
      let value = try JSONDecoder().decode(JSONValue.self, from: encoded)
      let document: JSONValue = ["schema": .string(sample.schema), "value": value]
      try pretty.encode(document).write(to: url)
    }
    let fixture = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url))
    #expect(fixture["schema"] == .string(sample.schema))
    #expect(try JSONDecoder().decode(JSONValue.self, from: encoded) == fixture["value"])
  }

  // MARK: Decoding

  @Test("attach events decode, unknown types included")
  func events() throws {
    let snapshot = try decode(
      TerminalEvent.self,
      json: """
        {"type":"snapshot","snapshot":{"threadId":"t","terminalId":"term-1","cwd":"/w","worktreePath":null,
        "status":"running","pid":42,"history":"$ ","exitCode":null,"exitSignal":null,"label":"zsh",
        "updatedAt":"2026-11-27T10:00:00.000Z","cols":62,"rows":30}}
        """)
    guard case .snapshot(let value) = snapshot else { Issue.record("not a snapshot"); return }
    #expect(value.history == "$ ")
    #expect(value.grid == TerminalGrid(cols: 62, rows: 30))
    #expect(value.status == .running)
    #expect(try decode(TerminalEvent.self, json: #"{"type":"output","threadId":"t","terminalId":"term-1","data":"hi"}"#) == .output("hi"))
    #expect(
      try decode(TerminalEvent.self, json: #"{"type":"activity","threadId":"t","terminalId":"x","hasRunningSubprocess":true,"label":"vim","cols":80,"rows":24}"#)
        == .activity(hasRunningSubprocess: true, label: "vim", grid: TerminalGrid(cols: 80, rows: 24)))
    #expect(try decode(TerminalEvent.self, json: #"{"type":"bell","threadId":"t","terminalId":"x"}"#) == .unknown("bell"))
  }

  @Test("metadata events keep a thread's terminals current")
  func metadata() throws {
    let a = TerminalSummary(threadId: "t", terminalId: "term-1", cwd: "/w", status: .running)
    let b = TerminalSummary(threadId: "t", terminalId: "term-2", cwd: "/w", status: .running)
    var list = TerminalMetadataEvent.snapshot([a]).applied(to: [])
    list = TerminalMetadataEvent.upsert(b).applied(to: list)
    var exited = a
    exited.status = .known(.exited)
    list = TerminalMetadataEvent.upsert(exited).applied(to: list)
    #expect(list.map(\.terminalId) == ["term-2", "term-1"])
    #expect(list.last?.status == .exited)
    list = TerminalMetadataEvent.remove(threadId: "t", terminalId: "term-2").applied(to: list)
    #expect(list.map(\.terminalId) == ["term-1"])
    let decoded = try decode(
      TerminalMetadataEvent.self,
      json: #"{"type":"snapshot","terminals":[{"threadId":"t","terminalId":"term-1","cwd":"/w","worktreePath":null,"status":"running","pid":1,"exitCode":null,"exitSignal":null,"hasRunningSubprocess":false,"label":"Terminal 1","updatedAt":"x"},{"bad":true}],"managerId":"m"}"#)
    guard case .snapshot(let terminals) = decoded else { Issue.record("not a snapshot"); return }
    #expect(terminals.count == 1)
  }

  // MARK: Menu (RN terminalMenu.test.ts)

  @Test("new terminals never reuse an unseen or mounted id")
  func nextIds() {
    let first = TerminalMenu.nextOpenId(listed: [], active: nil, uniqueSuffix: "783c91cc-a413-47c7-8312-c2a5a1f05e40")
    let next = TerminalMenu.nextOpenId(listed: [], active: nil, uniqueSuffix: "102315fc-ceef-45c4-b978-c4d4947d3c26")
    #expect(first != defaultTerminalId)
    #expect(first != next)
    #expect(TerminalMenu.nextOpenId(listed: [], active: defaultTerminalId) == "term-2")
    #expect(TerminalMenu.nextId(["term-1", "term-3"]) == "term-2")
    #expect(TerminalMenu.number("term-4-783c91cc-a413-47c7-8312-c2a5a1f05e40") == "4")
    #expect(TerminalMenu.number("terminal-12") == "12")
    #expect(TerminalMenu.number("scratch") == nil)
  }

  static func entry(_ id: String, _ status: TerminalStatus) -> TerminalMenuEntry {
    TerminalMenuEntry(terminalId: id, cwd: nil, status: status, hasRunningSubprocess: false, name: TerminalMenu.name(id))
  }

  @Test("an exited shell hands off to the nearest live terminal below, else above")
  func previousLive() {
    let below = [Self.entry("term-1", .running), Self.entry("term-2", .running), Self.entry("term-3", .exited), Self.entry("term-4", .running)]
    #expect(TerminalMenu.previousLive(below, exited: "term-3") == "term-2")
    let above = [Self.entry("term-1", .exited), Self.entry("term-2", .starting), Self.entry("term-4", .running)]
    #expect(TerminalMenu.previousLive(above, exited: "term-1") == "term-2")
    #expect(TerminalMenu.previousLive([Self.entry("term-1", .exited)], exited: "term-1") == nil)
  }

  @Test("menus list live terminals in numeric order with their process names")
  func entries() {
    let summaries = [
      TerminalSummary(threadId: "t", terminalId: "term-10", cwd: "/w/a", status: .running, hasRunningSubprocess: true, label: "npm"),
      TerminalSummary(threadId: "t", terminalId: "term-2", cwd: "/w/b", status: .running, label: "Terminal 2"),
      TerminalSummary(threadId: "t", terminalId: "term-3", cwd: "/w/c", status: .exited),
      TerminalSummary(threadId: "other", terminalId: "term-1", cwd: "/w", status: .running),
    ]
    let entries = TerminalMenu.entries(summaries, threadId: "t")
    #expect(entries.map(\.terminalId) == ["term-2", "term-10"])
    #expect(entries.map(\.name) == [.numbered("2"), .process("npm")])
    let withCurrent = TerminalMenu.entries(summaries, threadId: "t", current: Self.entry("term-3", .exited))
    #expect(withCurrent.map(\.terminalId) == ["term-2", "term-3", "term-10"])
    #expect(TerminalMenu.bootstrap(summaries, threadId: "t") == "term-2")
    #expect(TerminalMenu.basename("/w/tide-chart/") == "tide-chart")
  }

  // MARK: Input (RN terminalInput.test.ts)

  @Test("held modifiers encode arrows, chords and the host's paste")
  func modifiers() {
    for arrow in ["A", "B", "C", "D"] {
      #expect(TerminalInput.resolve("\u{1B}[\(arrow)", modifier: .ctrl, host: .linux) == .write("\u{1B}[1;5\(arrow)"))
      #expect(TerminalInput.resolve("\u{1B}[\(arrow)", modifier: .meta, host: .linux) == .write("\u{1B}[1;3\(arrow)"))
    }
    for data in ["a", "", "\u{1B}", "\u{1B}[H", "\u{1B}[1;5D", "\u{1B}[D\n"] {
      #expect(TerminalInput.resolve(data, modifier: .meta, host: .linux) == .write("\u{1B}\(data)"))
    }
    for host in [TerminalHostPlatform.windows, .linux, .unknown] {
      #expect(TerminalInput.resolve("v", modifier: .ctrl, host: host) == .paste)
      #expect(TerminalInput.resolve("V", modifier: .ctrl, host: host) == .paste)
    }
    #expect(TerminalInput.resolve("v", modifier: .meta, host: .mac) == .paste)
    #expect(TerminalInput.resolve("v", modifier: .ctrl, host: .mac) == .write("\u{16}"))
    #expect(TerminalInput.resolve("c", modifier: .ctrl, host: .mac) == .write("\u{03}"))
    #expect(TerminalInput.hardwareKey(input: "c", control: true, shift: false, option: false) == "\u{03}")
    #expect(TerminalInput.hardwareKey(input: "\t", control: false, shift: true, option: false) == "\u{1B}[Z")
    #expect(TerminalInput.hardwareKey(input: "x", control: false, shift: false, option: false) == nil)
  }

  @Test("a plain paste is safe for raw-mode programs")
  func plainPaste() {
    #expect(TerminalInput.plainPaste("one\ntwo\r\nthree\n") == "one\rtwo\rthree\r")
    #expect(TerminalInput.plainPaste("a\u{0}b\u{1B}c\u{7F}d\te") == "a b c d\te")
    #expect(TerminalInput.plainPaste("safe\u{1B}[201~; rm -rf /\n") == "safe [201~; rm -rf /\r")
  }

  @Test("writes split by UTF-16 units and never inside a surrogate pair")
  func chunks() {
    #expect(TerminalInput.chunks("abcdef", limit: 4) == ["abcd", "ef"])
    let emoji = "ab😀cd"
    #expect(TerminalInput.chunks(emoji, limit: 3) == ["ab", "😀c", "d"])
    #expect(TerminalInput.chunks(emoji, limit: 3).joined() == emoji)
    #expect(TerminalInput.chunks(String(repeating: "x", count: 65_537)).map(\.utf16.count) == [65_536, 1])
  }

  @Test("a recomposed syllable goes out as DELs and the new suffix")
  func fieldEdits() {
    #expect(TerminalInput.fieldEdit(sent: "", field: "ㅎ") == "ㅎ")
    #expect(TerminalInput.fieldEdit(sent: "ㅎ", field: "하") == "\u{7F}하")
    #expect(TerminalInput.fieldEdit(sent: "ab", field: "ab\n") == "\r")
  }

  // MARK: Replay

  @Test("the replay keeps the newest bytes and skips a sequence its trim cut")
  func replay() {
    var replay = TerminalReplay(limit: 8)
    replay.append("12345")
    replay.append("678")
    #expect(replay.text == "12345678")
    replay.append("9")
    #expect(replay.text == "23456789")
    // A trim inside `ESC[31m` must not leave "31m" to be printed.
    var cut = TerminalReplay(limit: 6)
    cut.append("ab\u{1B}[31mXY")
    #expect(cut.text == "XY")
    // A trim never splits a UTF-8 character.
    var wide = TerminalReplay(limit: 4)
    wide.append("aé漢")
    #expect(wide.text == "漢")
    wide.reset("$ ")
    #expect(wide.text == "$ ")
  }

  // MARK: Lifecycle

  @Test("an attached shell that ends is closed; a visited ended shell reopens once")
  func lifecycle() {
    var attached = TerminalLifecycle()
    #expect(attached.status(.running, version: 0) == nil)
    #expect(attached.status(.running, version: 1) == nil)
    #expect(attached.status(.exited, version: 2) == .exit)
    var visited = TerminalLifecycle()
    #expect(visited.status(.exited, version: 1) == .reopen)
    #expect(visited.status(.exited, version: 2) == nil)
    visited.reopenFailed()
    #expect(visited.status(.closed, version: 3) == .reopen)
    #expect(visited.status(.running, version: 4) == nil)
  }

  // MARK: Session

  static let target = TerminalTarget(environmentId: "env", threadId: thread, terminalId: "term-1")

  @MainActor
  @Test("attach, replay, ordered writes, resize after each snapshot, resume on reattach")
  func session() async throws {
    let host = FakeTerminalHost()
    let model = TerminalSessionModel(target: Self.target, location: TerminalLocation(cwd: Self.cwd, worktreePath: nil), host: host)
    var screen: [TerminalOutput] = []
    model.output = { screen.append($0) }
    model.start()
    let first = try await host.channel.nextAttach()
    #expect(first["resume"] == nil)
    #expect(first["maxHistoryBytes"] == .number(Double(terminalHistoryBytes)))
    model.reportGrid(TerminalGrid(cols: 40, rows: 20))
    host.channel.send(.snapshot(TerminalSnapshot(threadId: Self.thread, terminalId: "term-1", cwd: Self.cwd, status: .running, history: "$ ")))
    await eventually { model.isLive }
    await eventuallyAsync { await host.channel.calls(TerminalResizeRequest.rpcTag).count == 1 }
    #expect(await host.channel.calls(TerminalResizeRequest.rpcTag).first?["cols"] == .number(40))
    host.channel.send(.output("ls\r\n"))
    await eventually { screen.count == 2 }
    #expect(screen == [.reset("$ "), .append("ls\r\n")])

    // Keystrokes typed while a write is in flight go out together, in order.
    await host.channel.holdWrites()
    model.write("a")
    await eventuallyAsync { await host.channel.calls(TerminalWriteRequest.rpcTag).count == 1 }
    model.write("b")
    model.write("c")
    await host.channel.releaseWrites()
    await eventuallyAsync { await host.channel.calls(TerminalWriteRequest.rpcTag).count == 2 }
    #expect(await host.channel.calls(TerminalWriteRequest.rpcTag).map { $0["data"] } == [.string("a"), .string("bc")])

    // A renderer attached later starts from the replay.
    var late: [TerminalOutput] = []
    model.output = { late.append($0) }
    #expect(late == [.reset("$ ls\r\n")])

    // A reconnect resumes, replaces the screen, and resizes again.
    host.channel.dropAttach()
    host.reconnect()
    let second = try await host.channel.nextAttach()
    #expect(second["resume"] == .bool(true))
    #expect(second["cols"] == .number(40))
    host.channel.send(.snapshot(TerminalSnapshot(threadId: Self.thread, terminalId: "term-1", cwd: Self.cwd, status: .running, history: "$ ls\r\nREADME\r\n$ ")))
    await eventually { late.count == 2 }
    #expect(late.last == .reset("$ ls\r\nREADME\r\n$ "))
    await eventuallyAsync { await host.channel.calls(TerminalResizeRequest.rpcTag).count == 2 }
    model.stop()
  }

  @MainActor
  @Test("a shell that exits while shown is closed and left; a refusal shows the server's words")
  func exitAndRefusal() async throws {
    let host = FakeTerminalHost()
    let model = TerminalSessionModel(target: Self.target, location: TerminalLocation(cwd: Self.cwd, worktreePath: nil), host: host)
    var exits = 0
    model.onExit = { exits += 1 }
    model.start()
    _ = try await host.channel.nextAttach()
    host.channel.send(.snapshot(TerminalSnapshot(threadId: Self.thread, terminalId: "term-1", cwd: Self.cwd, status: .running)))
    await eventually { model.isLive }
    host.channel.send(.exited)
    await eventually { exits == 1 }
    await eventuallyAsync { await host.channel.calls(TerminalCloseRequest.rpcTag).count == 1 }
    #expect(await host.channel.calls(TerminalCloseRequest.rpcTag).first?["deleteHistory"] == nil)
    model.write("ignored")
    #expect(await host.channel.calls(TerminalWriteRequest.rpcTag).isEmpty)
    model.stop()

    let refused = TerminalSessionModel(target: Self.target, location: TerminalLocation(cwd: "/gone", worktreePath: nil), host: host)
    refused.start()
    _ = try await host.channel.nextAttach()
    host.channel.failAttach(["_tag": "TerminalCwdNotFoundError", "cwd": "/gone"])
    await eventually { refused.phase != .attaching && refused.phase != .waiting }
    #expect(refused.phase == .failed("Terminal folder does not exist: /gone"))
    refused.stop()
  }

  @MainActor
  @Test("an ended shell visited on purpose starts again")
  func reopen() async throws {
    let host = FakeTerminalHost()
    let model = TerminalSessionModel(target: Self.target, location: TerminalLocation(cwd: Self.cwd, worktreePath: nil), host: host)
    model.start()
    _ = try await host.channel.nextAttach()
    host.channel.send(.snapshot(TerminalSnapshot(threadId: Self.thread, terminalId: "term-1", cwd: Self.cwd, status: .exited, history: "bye")))
    await eventuallyAsync { await host.channel.calls(TerminalOpenRequest.rpcTag).count == 1 }
    host.channel.send(.restarted(TerminalSnapshot(threadId: Self.thread, terminalId: "term-1", cwd: Self.cwd, status: .running)))
    await eventually { model.isLive }
    model.stop()
  }
}

/// A computer whose session the test replaces with `reconnect()`.
@MainActor
final class FakeTerminalHost: TerminalHost {
  let channel = FakeTerminalChannel()
  var canOperate = true
  private final class Token {}
  private var token = Token()
  private var waiters: [CheckedContinuation<Void, Never>] = []

  func reconnect() {
    token = Token()
    for waiter in waiters { waiter.resume() }
    waiters = []
  }

  func channel(after previous: ObjectIdentifier?) async -> (id: ObjectIdentifier, channel: any TerminalChannel)? {
    while ObjectIdentifier(token) == previous {
      guard !Task.isCancelled else { return nil }
      await withCheckedContinuation { waiters.append($0) }
    }
    return (ObjectIdentifier(token), channel)
  }
}

/// Records calls; the test drives the attach stream.
actor FakeTerminalChannel: TerminalChannel {
  private var log: [(tag: String, payload: JSONValue)] = []
  private var attaches: [JSONValue] = []
  private var attachWaiters: [CheckedContinuation<JSONValue, Never>] = []
  private let continuation = Mutex<AsyncThrowingStream<TerminalEvent, any Error>.Continuation?>(nil)
  private var held = false
  private var heldWrites: [CheckedContinuation<Void, Never>] = []

  func call<Response: Decodable & Sendable>(
    _ tag: String, payload: some Encodable & Sendable, as _: Response.Type
  ) async throws -> Response {
    log.append((tag, try JSONDecoder().decode(JSONValue.self, from: JSONEncoder.wire.encode(payload))))
    if tag == TerminalWriteRequest.rpcTag, held { await withCheckedContinuation { heldWrites.append($0) } }
    return try JSONDecoder().decode(Response.self, from: Data("null".utf8))
  }

  func stream<Item: Decodable & Sendable>(
    _ tag: String, payload: some Encodable & Sendable, of _: Item.Type
  ) async throws -> RpcStream<Item> {
    let value = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder.wire.encode(payload))
    let (stream, continuation) = AsyncThrowingStream.makeStream(of: TerminalEvent.self)
    self.continuation.withLock { $0 = continuation }
    if attachWaiters.isEmpty { attaches.append(value) } else { attachWaiters.removeFirst().resume(returning: value) }
    let items = stream.map { $0 as! Item }
    let (out, outContinuation) = AsyncThrowingStream.makeStream(of: Item.self)
    let pump = Task {
      do {
        for try await item in items { outContinuation.yield(item) }
        outContinuation.finish()
      } catch { outContinuation.finish(throwing: error) }
    }
    return RpcStream(base: out, stop: { pump.cancel() })
  }

  func nextAttach() async throws -> JSONValue {
    if !attaches.isEmpty { return attaches.removeFirst() }
    return await withCheckedContinuation { attachWaiters.append($0) }
  }

  func calls(_ tag: String) -> [JSONValue] { log.filter { $0.tag == tag }.map(\.payload) }

  func holdWrites() { held = true }

  func releaseWrites() {
    held = false
    for waiter in heldWrites { waiter.resume() }
    heldWrites = []
  }

  nonisolated func send(_ event: TerminalEvent) { _ = continuation.withLock { $0?.yield(event) } }
  nonisolated func dropAttach() {
    continuation.withLock { $0?.finish(throwing: RpcError.connectionClosed("dropped")) }
  }
  nonisolated func failAttach(_ error: JSONValue) {
    continuation.withLock { $0?.finish(throwing: RpcError.failed(RpcFailure(error: error))) }
  }
}
