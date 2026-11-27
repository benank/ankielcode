/// The items of one streaming RPC. Releasing the iterator (breaking out of `for try await`) or
/// cancelling the consuming task sends `Interrupt`; a plain `AsyncThrowingStream` cannot notice
/// the drop because the client holds its continuation.
public struct RpcStream<Element: Sendable>: AsyncSequence, Sendable {
  let base: AsyncThrowingStream<Element, any Error>
  let stop: @Sendable () -> Void

  public func makeAsyncIterator() -> Iterator {
    Iterator(base: base.makeAsyncIterator(), token: StopToken(stop))
  }

  public struct Iterator: AsyncIteratorProtocol {
    var base: AsyncThrowingStream<Element, any Error>.Iterator
    let token: StopToken

    public mutating func next() async throws -> Element? {
      try await base.next(isolation: #isolation)
    }

    public mutating func next(isolation actor: isolated (any Actor)?) async throws(any Error) -> Element? {
      try await base.next(isolation: actor)
    }
  }

  final class StopToken: Sendable {
    private let stop: @Sendable () -> Void
    init(_ stop: @escaping @Sendable () -> Void) { self.stop = stop }
    deinit { stop() }
  }
}
