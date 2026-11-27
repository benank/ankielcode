import Foundation
import os

/// An Effect RPC client over one socket: unary calls, acknowledged streams, interrupts and pings.
public actor RpcClient {
  public struct Options: Sendable {
    /// How often to send `Ping`; nil turns pinging and the liveness check off (tests).
    public var pingInterval: Duration?
    /// The socket counts as dead when no frame of any kind arrived for this long.
    public var livenessTimeout: Duration

    public init(pingInterval: Duration? = .seconds(5), livenessTimeout: Duration = .seconds(15)) {
      self.pingInterval = pingInterval
      self.livenessTimeout = livenessTimeout
    }
  }

  private enum Route {
    case unary(CheckedContinuation<Data, any Error>)
    case stream(StreamRoute)
  }

  private struct StreamRoute {
    let deliver: @Sendable (Data) throws -> Void
    let finish: @Sendable (Data) -> Void
    let fail: @Sendable (RpcError) -> Void
  }

  private let transport: any RpcTransport
  private let options: Options
  private let outbox: AsyncStream<String>.Continuation
  private let outboxStream: AsyncStream<String>
  private var nextId = 0
  private var routes: [Int: Route] = [:]
  private var joiner = FrameJoiner()
  private var lastFrameAt = ContinuousClock.now
  private var lastHeartbeatAt = ContinuousClock.now
  private var closeReason: RpcError?
  private var closeWaiters: [CheckedContinuation<RpcError, Never>] = []
  private var tasks: [Task<Void, Never>] = []
  private var started = false
  private static let log = Logger(subsystem: "com.ankiel.code", category: "rpc")

  public init(transport: any RpcTransport, options: Options = Options()) {
    self.transport = transport
    self.options = options
    (outboxStream, outbox) = AsyncStream.makeStream(of: String.self)
  }

  /// Starts reading, writing and pinging. Call once, before the first request.
  public func start() {
    guard !started else { return }
    started = true
    lastFrameAt = .now
    lastHeartbeatAt = .now
    let transport = transport
    let outboxStream = outboxStream
    tasks.append(Task { [weak self] in
      do {
        for try await text in transport.incoming {
          await self?.receive(text)
        }
        await self?.shutdown(.connectionClosed("The socket closed."))
      } catch {
        await self?.shutdown(.connectionClosed(String(describing: error)))
      }
    })
    tasks.append(Task { [weak self] in
      for await text in outboxStream {
        do {
          try await transport.send(text)
        } catch {
          await self?.shutdown(.connectionClosed("Send failed: \(error)"))
          return
        }
      }
    })
    if let interval = options.pingInterval {
      tasks.append(Task { [weak self] in
        while !Task.isCancelled {
          try? await Task.sleep(for: interval)
          guard let self, await self.heartbeat() else { return }
        }
      })
    }
  }

  /// A unary call. Cancelling the calling task sends `Interrupt`.
  public func call<Response: Decodable & Sendable>(
    _ tag: String,
    payload: some Encodable & Sendable = EmptyObject(),
    as _: Response.Type = Response.self
  ) async throws -> Response {
    if let closeReason { throw closeReason }
    try Task.checkCancellation()
    let id = allocateId()
    let frame = try ClientFrame.request(id: id, tag: tag, payload: payload)
    let data = try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Data, any Error>) in
        routes[id] = .unary(continuation)
        outbox.yield(frame)
      }
    } onCancel: {
      Task { await self.cancelUnary(id) }
    }
    return try Self.decodeExit(data, as: Response.self)
  }

  /// A streaming call. Each chunk is acknowledged after its items are queued; ending iteration
  /// early (or cancelling the consumer) sends `Interrupt`.
  public func stream<Item: Decodable & Sendable>(
    _ tag: String,
    payload: some Encodable & Sendable = EmptyObject(),
    of _: Item.Type = Item.self
  ) throws -> RpcStream<Item> {
    let (stream, continuation) = AsyncThrowingStream.makeStream(of: Item.self)
    if let closeReason {
      continuation.finish(throwing: closeReason)
      return RpcStream(base: stream, stop: {})
    }
    let id = allocateId()
    let frame = try ClientFrame.request(id: id, tag: tag, payload: payload)
    routes[id] = .stream(
      StreamRoute(
        deliver: { data in
          let chunk = try JSONDecoder().decode(ChunkFrame<Item>.self, from: data)
          for value in chunk.values { continuation.yield(value) }
        },
        finish: { data in
          do {
            _ = try Self.decodeExit(data, as: RpcVoid.self)
            continuation.finish()
          } catch {
            continuation.finish(throwing: error)
          }
        },
        fail: { error in continuation.finish(throwing: error) }
      ))
    continuation.onTermination = { termination in
      if case .cancelled = termination {
        Task { await self.stopStream(id) }
      }
    }
    outbox.yield(frame)
    return RpcStream(base: stream, stop: { Task { await self.stopStream(id) } })
  }

  /// Suspends until the socket closes, and returns why.
  public func closed() async -> RpcError {
    if let closeReason { return closeReason }
    return await withCheckedContinuation { closeWaiters.append($0) }
  }

  public var isClosed: Bool { closeReason != nil }

  public func close() {
    shutdown(.connectionClosed("Closed by the client."))
  }

  // MARK: - Internals

  private func allocateId() -> Int {
    defer { nextId += 1 }
    return nextId
  }

  private func cancelUnary(_ id: Int) {
    guard case .unary(let continuation) = routes.removeValue(forKey: id) else { return }
    outbox.yield(ClientFrame.interrupt(id))
    continuation.resume(throwing: CancellationError())
  }

  private func stopStream(_ id: Int) {
    guard routes.removeValue(forKey: id) != nil else { return }
    outbox.yield(ClientFrame.interrupt(id))
  }

  private func heartbeat() -> Bool {
    guard closeReason == nil else { return false }
    let now = ContinuousClock.now
    // A tick far later than its interval means the app was suspended. Silence while suspended
    // says nothing about the socket, and the supervisor's resume probe decides; restart the
    // window instead of killing the socket on the first tick after resuming.
    if let interval = options.pingInterval, now - lastHeartbeatAt > interval * 3 {
      lastFrameAt = now
    }
    lastHeartbeatAt = now
    if now - lastFrameAt > options.livenessTimeout {
      shutdown(.connectionClosed("No frames from the server for \(options.livenessTimeout)."))
      return false
    }
    outbox.yield(ClientFrame.ping)
    return true
  }

  /// Handles one text message from the socket (exposed for tests through the transport).
  func receive(_ text: String) {
    lastFrameAt = .now
    guard let frame = joiner.accept(text) else { return }
    let data = Data(frame.utf8)
    if data.first == UInt8(ascii: "[") {
      // The Effect parser also accepts a batch of messages in one frame.
      guard let batch = try? JSONDecoder().decode([JSONValue].self, from: data) else { return }
      for message in batch {
        if let encoded = try? JSONEncoder().encode(message) { handle(encoded) }
      }
      return
    }
    handle(data)
  }

  private func handle(_ data: Data) {
    guard let header = try? JSONDecoder().decode(ServerFrameHeader.self, from: data) else {
      Self.log.error("Dropped an unreadable frame (\(data.count) bytes)")
      return
    }
    switch header.tag {
    case "Chunk":
      guard let id = header.requestId, case .stream(let route) = routes[id] else { return }
      do {
        try route.deliver(data)
        outbox.yield(ClientFrame.ack(id))
      } catch {
        routes[id] = nil
        outbox.yield(ClientFrame.interrupt(id))
        route.fail(.decoding(describeDecodingError(error)))
      }
    case "Exit":
      guard let id = header.requestId, let route = routes.removeValue(forKey: id) else { return }
      switch route {
      case .unary(let continuation): continuation.resume(returning: data)
      case .stream(let route): route.finish(data)
      }
    case "Defect":
      let defect = (try? JSONDecoder().decode(DefectFrame.self, from: data))?.defect ?? .null
      failAll(.protocolDefect(defect))
    default:
      break  // Pong and future frame types only count as liveness.
    }
  }

  private func failAll(_ error: RpcError) {
    let open = routes
    routes = [:]
    for route in open.values {
      switch route {
      case .unary(let continuation): continuation.resume(throwing: error)
      case .stream(let route): route.fail(error)
      }
    }
  }

  private func shutdown(_ reason: RpcError) {
    guard closeReason == nil else { return }
    closeReason = reason
    failAll(reason)
    for waiter in closeWaiters { waiter.resume(returning: reason) }
    closeWaiters = []
    outbox.finish()
    for task in tasks { task.cancel() }
    tasks = []
    let transport = transport
    Task { await transport.close() }
  }

  private static func decodeExit<Response: Decodable>(_ data: Data, as _: Response.Type) throws -> Response {
    let frame: ExitFrame<Response>
    do {
      frame = try JSONDecoder().decode(ExitFrame<Response>.self, from: data)
    } catch {
      throw RpcError.decoding(describeDecodingError(error))
    }
    switch frame.exit {
    case .success(let value?):
      return value
    case .success(nil):
      do {
        return try JSONDecoder().decode(Response.self, from: Data("null".utf8))
      } catch {
        throw RpcError.decoding("Expected a value, got none.")
      }
    case .failure(let cause):
      throw RpcError(cause: cause)
    }
  }
}

/// `{}`: the payload of RPCs that take no input.
public struct EmptyObject: Codable, Sendable, Hashable {
  public init() {}
}

/// A success value the caller ignores (stream ends are `null`).
public struct RpcVoid: Decodable, Sendable {
  public init(from _: any Decoder) throws {}
}
