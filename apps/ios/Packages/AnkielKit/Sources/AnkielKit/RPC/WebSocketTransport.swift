import Foundation
import Synchronization

/// Why the socket did not open. Upgrade refusals are plain HTTP responses: 401 for a bad ticket or
/// DPoP proof, 426 for a protocol mismatch.
public enum WebSocketOpenError: Error, Sendable, Hashable {
  case httpStatus(Int)
  case failed(String)
  case timedOut
}

/// `URLSessionWebSocketTask` as an `RpcTransport`. URLSession offers `permessage-deflate` itself.
public final class WebSocketTransport: NSObject, RpcTransport, URLSessionWebSocketDelegate, Sendable {
  public let incoming: AsyncThrowingStream<String, any Error>
  private let incomingContinuation: AsyncThrowingStream<String, any Error>.Continuation
  private let opening = Mutex<CheckedContinuation<Void, any Error>?>(nil)
  private let state = Mutex<(session: URLSession?, task: URLSessionWebSocketTask?)>((nil, nil))

  private override init() {
    (incoming, incomingContinuation) = AsyncThrowingStream.makeStream(of: String.self)
    super.init()
  }

  /// Opens a socket and waits for the upgrade, up to `timeout`.
  public static func connect(
    to url: URL, timeout: Duration = .seconds(15)
  ) async throws -> WebSocketTransport {
    let transport = WebSocketTransport()
    try await transport.open(url, timeout: timeout)
    return transport
  }

  private func open(_ url: URL, timeout: Duration) async throws {
    let configuration = URLSessionConfiguration.ephemeral
    // Dev URL protocols must not intercept the upgrade.
    configuration.protocolClasses = []
    configuration.httpCookieStorage = nil
    let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    var request = URLRequest(url: url)
    request.timeoutInterval = timeout / .seconds(1)
    let task = session.webSocketTask(with: request)
    // Without frame parts a thread snapshot can be several MB in one message.
    task.maximumMessageSize = 128 * 1024 * 1024
    state.withLock { $0 = (session, task) }

    let timer = Task { [weak self] in
      try? await Task.sleep(for: timeout)
      self?.finishOpening(.failure(WebSocketOpenError.timedOut))
    }
    defer { timer.cancel() }
    do {
      try await withCheckedThrowingContinuation { continuation in
        opening.withLock { $0 = continuation }
        task.resume()
      }
    } catch {
      await close()
      throw error
    }
    receiveNext(task)
  }

  private func finishOpening(_ result: Result<Void, any Error>) {
    opening.withLock { pending in
      pending?.resume(with: result)
      pending = nil
    }
  }

  private func receiveNext(_ task: URLSessionWebSocketTask) {
    task.receive { [weak self] result in
      guard let self else { return }
      switch result {
      case .success(.string(let text)):
        incomingContinuation.yield(text)
        receiveNext(task)
      case .success(.data(let data)):
        incomingContinuation.yield(String(decoding: data, as: UTF8.self))
        receiveNext(task)
      case .success:
        receiveNext(task)
      case .failure(let error):
        incomingContinuation.finish(throwing: error)
      }
    }
  }

  public func send(_ text: String) async throws {
    guard let task = state.withLock({ $0.task }) else { throw WebSocketOpenError.failed("Closed.") }
    try await task.send(.string(text))
  }

  public func close() async {
    let (session, task) = state.withLock { current in
      defer { current = (nil, nil) }
      return current
    }
    task?.cancel(with: .normalClosure, reason: nil)
    session?.invalidateAndCancel()
    incomingContinuation.finish()
  }

  // MARK: URLSessionWebSocketDelegate

  public func urlSession(
    _: URLSession, webSocketTask _: URLSessionWebSocketTask, didOpenWithProtocol _: String?
  ) {
    finishOpening(.success(()))
  }

  public func urlSession(
    _: URLSession, webSocketTask _: URLSessionWebSocketTask,
    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason _: Data?
  ) {
    incomingContinuation.finish(throwing: WebSocketOpenError.failed("Closed with code \(closeCode.rawValue)."))
  }

  public func urlSession(_: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
    if let status = (task.response as? HTTPURLResponse)?.statusCode, status != 101 {
      finishOpening(.failure(WebSocketOpenError.httpStatus(status)))
    } else {
      finishOpening(.failure(WebSocketOpenError.failed(error?.localizedDescription ?? "The socket closed.")))
    }
    incomingContinuation.finish(throwing: error ?? WebSocketOpenError.failed("The socket closed."))
  }
}
