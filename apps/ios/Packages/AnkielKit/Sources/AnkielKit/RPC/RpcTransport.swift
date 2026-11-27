/// A text-frame socket. The RPC client owns exactly one and reads `incoming` once.
public protocol RpcTransport: Sendable {
  /// Text messages from the server, in order. Finishes or throws when the socket closes.
  var incoming: AsyncThrowingStream<String, any Error> { get }
  func send(_ text: String) async throws
  func close() async
}
