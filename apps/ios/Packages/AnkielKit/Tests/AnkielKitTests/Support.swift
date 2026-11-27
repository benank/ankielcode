import Foundation
import Testing

@testable import AnkielKit

enum Fixture {
  static func data(_ name: String) throws -> Data {
    let url = try #require(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"))
    return try Data(contentsOf: url)
  }

  static func json(_ name: String) throws -> JSONValue {
    try JSONDecoder().decode(JSONValue.self, from: data(name))
  }

  static var thread: ThreadShell { get throws { try decode(ThreadShell.self, from: data("thread-shell")) } }
  static var project: ProjectShell { get throws { try decode(ProjectShell.self, from: data("project-shell")) } }

  static func thread(_ id: String, title: String? = nil) throws -> ThreadShell {
    var row = try thread
    row.id = id
    if let title { row.title = title }
    return row
  }
}

func decode<T: Decodable>(_: T.Type, from data: Data) throws -> T {
  try JSONDecoder().decode(T.self, from: data)
}

func decode<T: Decodable>(_: T.Type, json: String) throws -> T {
  try JSONDecoder().decode(T.self, from: Data(json.utf8))
}

func encode(_ value: JSONValue) throws -> Data {
  try JSONEncoder.wire.encode(value)
}

extension JSONValue {
  /// Returns a copy with `key` set (or removed when `value` is nil).
  func setting(_ key: String, _ value: JSONValue?) -> JSONValue {
    guard case .object(var object) = self else { return self }
    object[key] = value
    return .object(object)
  }
}

/// Frames the client wrote, read in order by the test.
actor SentFrames {
  private var buffer: [String] = []
  private var waiters: [CheckedContinuation<String?, Never>] = []
  private var finished = false

  func append(_ frame: String) {
    if waiters.isEmpty { buffer.append(frame) } else { waiters.removeFirst().resume(returning: frame) }
  }

  func finish() {
    finished = true
    for waiter in waiters { waiter.resume(returning: nil) }
    waiters = []
  }

  func next() async -> String? {
    if !buffer.isEmpty { return buffer.removeFirst() }
    if finished { return nil }
    return await withCheckedContinuation { waiters.append($0) }
  }
}

/// An in-memory socket. Tests play the server: `serve` delivers frames, `nextSent` reads what the
/// client wrote.
final class FakeTransport: RpcTransport {
  let incoming: AsyncThrowingStream<String, any Error>
  private let server: AsyncThrowingStream<String, any Error>.Continuation
  let sent = SentFrames()

  init() {
    (incoming, server) = AsyncThrowingStream.makeStream(of: String.self)
  }

  func send(_ text: String) async throws {
    await sent.append(text)
  }

  func close() async {
    server.finish()
    await sent.finish()
  }

  func serve(_ frame: String) {
    server.yield(frame)
  }

  func disconnect() {
    server.finish(throwing: URLError(.networkConnectionLost))
  }

  /// The next frame the client sent, decoded.
  func nextSent() async -> JSONValue? {
    await sent.next().flatMap { try? JSONDecoder().decode(JSONValue.self, from: Data($0.utf8)) }
  }
}
