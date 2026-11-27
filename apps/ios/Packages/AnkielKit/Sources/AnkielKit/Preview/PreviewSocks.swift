import Foundation
import Network

/// Why the latest tunnel failed (RN `AnkielTunnelFailure`, plus the server's switch and scope).
public enum PreviewTunnelFailure: String, Sendable, Hashable {
  /// The computer could not be reached, or gave no tunnel URL (not connected).
  case environment
  /// Nothing listens on the port there (or it is the server's own port).
  case port
  /// A server from before the tunnel answered the route like any page.
  case outdated
  /// The computer turned the tunnel off (`enablePreviewTunnel`).
  case disabled
  /// This device's session may not open tunnels (`terminal:operate`).
  case permission

  /// The server marks a dead port and a switched-off tunnel with headers; a 403 without either is
  /// the session's scope. A pre-tunnel server answers like any page; anything else (a rejected
  /// ticket's 401, a proxy's 502) means the computer is out of reach.
  public static func classify(status: Int?, portRefused: Bool, disabled: Bool) -> PreviewTunnelFailure {
    if portRefused { return .port }
    if disabled { return .disabled }
    guard let status else { return .environment }
    if status == 403 { return .permission }
    return (200..<300).contains(status) || status == 404 ? .outdated : .environment
  }
}

/// What the proxy saw, shown with a page error so a report carries it (and proves a page went
/// through the tunnel).
public struct PreviewTunnelCounts: Sendable, Hashable {
  public var accepted = 0
  public var asked = 0
  public var granted = 0
  public var denied = 0
  public var opened = 0
  public var refused: String?
  public var tunnelError: String?

  public init() {}

  public var summary: String {
    "accepted \(accepted), asked \(asked), granted \(granted), denied \(denied), opened \(opened), refused \(refused ?? "-"), tunnel \(tunnelError ?? "-")"
  }
}

/// The SOCKS5 parts of the listener, pure for tests.
public enum PreviewSocks {
  public enum Request: Sendable, Equatable {
    case connect(port: UInt16, consumed: Int)
    case refuse(UInt8)
  }

  public static let succeeded: UInt8 = 0
  public static let failure: UInt8 = 1
  public static let notAllowed: UInt8 = 2
  public static let commandNotSupported: UInt8 = 7
  public static let addressNotSupported: UInt8 = 8

  public static func reply(_ code: UInt8) -> Data { Data([5, code, 0, 1, 0, 0, 0, 0, 0, 0]) }

  /// The web view names the host as typed, so IP literals can also arrive as domain names.
  static func isLoopbackName(_ name: String) -> Bool {
    name.lowercased() == PreviewLoopback.standInHost || PreviewURLs.isAnyLoopback(name)
  }

  /// A CONNECT request; nil until it has all arrived. Only loopback is carried.
  public static func parseConnect(_ data: [UInt8]) -> Request? {
    guard data.count >= 5 else { return nil }
    let hostLength: Int
    switch data[3] {
    case 1: hostLength = 4
    case 4: hostLength = 16
    case 3: hostLength = 1 + Int(data[4])
    default: return .refuse(addressNotSupported)
    }
    let end = 4 + hostLength + 2
    guard data.count >= end else { return nil }
    guard data[0] == 5, data[1] == 1 else { return .refuse(commandNotSupported) }
    let host = Array(data[4..<(4 + hostLength)])
    let loopback: Bool
    switch data[3] {
    case 1: loopback = host[0] == 127
    case 4: loopback = IPv6Address(Data(host))?.isLoopback ?? false
    default: loopback = isLoopbackName(String(decoding: host.dropFirst(), as: UTF8.self))
    }
    guard loopback else { return .refuse(notAllowed) }
    let port = UInt16(data[end - 2]) << 8 | UInt16(data[end - 1])
    return .connect(port: port, consumed: end)
  }

  /// The tunnel URL for one connection: the ticketed base plus `port`.
  public static func tunnelURL(base: URL, port: UInt16) -> URL? {
    guard var components = URLComponents(url: base, resolvingAgainstBaseURL: false) else { return nil }
    components.queryItems = (components.queryItems ?? []) + [URLQueryItem(name: "port", value: String(port))]
    return components.url
  }
}

/// Swaps one string for another of the same length within each chunk (RN `AnkielHostSwap`).
/// Holding back a partial match could stall a reply ending in its first letters, so a match split
/// across chunks is missed; the Host header always arrives whole.
public struct PreviewHostSwap: Sendable {
  private let from: [UInt8]
  private let to: [UInt8]
  public private(set) var isDecided = false
  public private(set) var isEnabled = false

  public init(from: String, to: String) {
    self.from = Array(from.utf8)
    self.to = Array(to.utf8)
    precondition(self.from.count == self.to.count, "a swap must keep message lengths")
  }

  public mutating func decide(_ enabled: Bool) {
    isDecided = true
    isEnabled = enabled
  }

  public func apply(_ data: Data) -> Data {
    var bytes = [UInt8](data)
    var index = 0
    while index + from.count <= bytes.count {
      if bytes[index..<(index + from.count)].elementsEqual(from) {
        bytes.replaceSubrange(index..<(index + from.count), with: to)
        index += from.count
      } else {
        index += 1
      }
    }
    return Data(bytes)
  }
}

/// A SOCKS5 listener on 127.0.0.1 that carries each loopback CONNECT over its own WebSocket to the
/// computer's `/api/preview/tunnel` (RN `AnkielSocksListener`). It never connects anywhere on this
/// device, so a failed tunnel is a connection error, never one of this device's own servers.
///
/// State is confined to `queue` (hence `@unchecked Sendable`); each direction asks for the next
/// chunk only after the previous one is written, so a slow side slows the other.
public final class PreviewSocksListener: @unchecked Sendable {
  /// A fresh ticketed tunnel URL for one connection, or nil when the computer is out of reach.
  public typealias Access = @Sendable () async -> URL?

  private let queue = DispatchQueue(label: "com.ankiel.preview-tunnel")
  private let access: Access
  private let session: URLSession
  private var listener: NWListener?
  private var connections: [ObjectIdentifier: PreviewSocksConnection] = [:]
  private var failure: PreviewTunnelFailure?
  private var counts = PreviewTunnelCounts()

  public init(session: URLSession = .shared, access: @escaping Access) {
    self.session = session
    self.access = access
  }

  /// Why the latest tunnel failed, nil once one opened.
  public var lastFailure: PreviewTunnelFailure? { queue.sync { failure } }
  public var diagnostics: PreviewTunnelCounts { queue.sync { counts } }
  public var isListening: Bool { queue.sync { listener?.state == .ready } }

  /// `port` asks for a specific port, so a restarted listener keeps the address WebKit was given.
  /// `onFailed` runs when the system tears the socket down (a suspended app can lose it).
  public func start(
    port: UInt16? = nil, onReady: @escaping @Sendable (UInt16) -> Void, onFailed: @escaping @Sendable () -> Void = {}
  ) {
    queue.async { [self] in
      let parameters = NWParameters.tcp
      parameters.allowLocalEndpointReuse = true
      parameters.requiredLocalEndpoint = .hostPort(
        host: "127.0.0.1", port: port.flatMap(NWEndpoint.Port.init(rawValue:)) ?? .any)
      guard let listener = try? NWListener(using: parameters) else { return onFailed() }
      self.listener = listener
      listener.stateUpdateHandler = { [weak listener] state in
        switch state {
        case .ready: if let port = listener?.port?.rawValue { onReady(port) }
        case .failed: onFailed()
        default: break
        }
      }
      listener.newConnectionHandler = { [weak self] connection in
        guard let self else { return connection.cancel() }
        self.accept(connection)
      }
      listener.start(queue: queue)
    }
  }

  public func stop() {
    queue.async { [self] in
      listener?.cancel()
      listener = nil
      for socks in connections.values { socks.close() }
      connections.removeAll()
    }
  }

  private func accept(_ connection: NWConnection) {
    counts.accepted += 1
    let socks = PreviewSocksConnection(
      connection: connection, queue: queue, session: session, access: access,
      note: { [weak self] update in self?.queue.async { [weak self] in if let self { update(&self.counts) } } },
      onOutcome: { [weak self] failure in self?.failure = failure },
      onClose: { [weak self] socks in self?.connections.removeValue(forKey: ObjectIdentifier(socks)) })
    connections[ObjectIdentifier(socks)] = socks
    socks.start()
  }
}

private final class PreviewSocksConnection: @unchecked Sendable {
  private let connection: NWConnection
  private let queue: DispatchQueue
  private let session: URLSession
  private let access: PreviewSocksListener.Access
  private let note: @Sendable (@escaping @Sendable (inout PreviewTunnelCounts) -> Void) -> Void
  private let onOutcome: (PreviewTunnelFailure?) -> Void
  private let onClose: (PreviewSocksConnection) -> Void
  private var received: [UInt8] = []
  private var greeted = false
  private var tunnel: URLSessionWebSocketTask?
  private var closed = false
  // Plain HTTP only: the page names the stand-in host, the computer's servers expect localhost.
  private var toServer = PreviewHostSwap(from: PreviewLoopback.standInHost, to: "localhost")
  private var toPage = PreviewHostSwap(from: "localhost", to: PreviewLoopback.standInHost)

  init(
    connection: NWConnection, queue: DispatchQueue, session: URLSession, access: @escaping PreviewSocksListener.Access,
    note: @escaping @Sendable (@escaping @Sendable (inout PreviewTunnelCounts) -> Void) -> Void,
    onOutcome: @escaping (PreviewTunnelFailure?) -> Void, onClose: @escaping (PreviewSocksConnection) -> Void
  ) {
    self.connection = connection
    self.queue = queue
    self.session = session
    self.access = access
    self.note = note
    self.onOutcome = onOutcome
    self.onClose = onClose
  }

  func start() {
    connection.stateUpdateHandler = { [weak self] state in
      switch state {
      case .failed, .cancelled: self?.close()
      default: break
      }
    }
    connection.start(queue: queue)
    readHandshake()
  }

  func close() {
    guard !closed else { return }
    closed = true
    tunnel?.cancel(with: .normalClosure, reason: nil)
    connection.cancel()
    onClose(self)
  }

  /// Sends the final bytes, then closes once they are written.
  private func finish(_ data: Data?) {
    connection.send(
      content: data, contentContext: .finalMessage, isComplete: true,
      completion: .contentProcessed { [weak self] _ in self?.queue.async { [weak self] in self?.close() } })
  }

  private func readHandshake() {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 4096) { [weak self] data, _, isComplete, error in
      guard let self, !closed else { return }
      if let data { received.append(contentsOf: data) }
      if !greeted {
        guard received.count >= 2, received.count >= 2 + Int(received[1]) else {
          return isComplete || error != nil ? close() : readHandshake()
        }
        let methods = received[2..<(2 + Int(received[1]))]
        guard received[0] == 5, methods.contains(0) else { return finish(Data([5, 0xff])) }
        connection.send(content: Data([5, 0]), completion: .idempotent)
        received.removeFirst(2 + Int(received[1]))
        greeted = true
      }
      switch PreviewSocks.parseConnect(received) {
      case nil:
        if isComplete || error != nil { close() } else { readHandshake() }
      case .refuse(let code):
        note { $0.refused = "\(code)" }
        finish(PreviewSocks.reply(code))
      case .connect(let port, let consumed):
        received.removeFirst(consumed)
        note { $0.asked += 1 }
        let access = access
        Task { [weak self] in
          let url = await access()
          self?.note { url == nil ? ($0.denied += 1) : ($0.granted += 1) }
          self?.queue.async { [weak self] in self?.openTunnel(base: url, port: port) }
        }
      }
    }
  }

  private func openTunnel(base: URL?, port: UInt16) {
    guard !closed else { return }
    guard let base, let url = PreviewSocks.tunnelURL(base: base, port: port) else {
      onOutcome(.environment)
      return finish(PreviewSocks.reply(PreviewSocks.failure))
    }
    // The same budget as the access request, so a stalled upgrade refuses the page promptly.
    let tunnel = session.webSocketTask(with: URLRequest(url: url, timeoutInterval: 15))
    tunnel.maximumMessageSize = 16 * 1024 * 1024
    self.tunnel = tunnel
    tunnel.resume()
    // A pong is the first sign the handshake succeeded; until then the page gets no reply.
    tunnel.sendPing { [weak self] error in
      let message = error?.localizedDescription
      self?.queue.async { [weak self] in
        guard let self, !self.closed else { return }
        if let message {
          self.note { $0.tunnelError = message }
          let response = tunnel.response as? HTTPURLResponse
          self.onOutcome(
            PreviewTunnelFailure.classify(
              status: response?.statusCode,
              portRefused: response?.value(forHTTPHeaderField: "x-ankiel-tunnel-port-refused") != nil,
              disabled: response?.value(forHTTPHeaderField: "x-ankiel-tunnel-disabled") != nil))
          return self.finish(PreviewSocks.reply(PreviewSocks.failure))
        }
        self.note { $0.opened += 1 }
        self.onOutcome(nil)
        self.connection.send(content: PreviewSocks.reply(PreviewSocks.succeeded), completion: .idempotent)
        if !self.received.isEmpty {
          let early = Data(self.received)
          self.received = []
          tunnel.send(.data(self.swapToServer(early))) { _ in }
        }
        self.pumpToTunnel(tunnel)
        self.pumpFromTunnel(tunnel)
      }
    }
  }

  /// The page's first bytes decide: a TLS handshake is left alone, anything else is plain HTTP.
  private func swapToServer(_ data: Data) -> Data {
    if !toServer.isDecided {
      let plain = data.first != 0x16
      toServer.decide(plain)
      toPage.decide(plain)
    }
    return toServer.isEnabled ? toServer.apply(data) : data
  }

  private func pumpToTunnel(_ tunnel: URLSessionWebSocketTask) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, isComplete, error in
      guard let self, !closed else { return }
      if let data, !data.isEmpty {
        tunnel.send(.data(swapToServer(data))) { [weak self] error in
          let failed = error != nil
          self?.queue.async { [weak self] in
            guard let self, !self.closed else { return }
            if failed || isComplete { self.close() } else { self.pumpToTunnel(tunnel) }
          }
        }
      } else if isComplete || error != nil {
        close()
      } else {
        pumpToTunnel(tunnel)
      }
    }
  }

  private func pumpFromTunnel(_ tunnel: URLSessionWebSocketTask) {
    tunnel.receive { [weak self] result in
      let data: Data? =
        switch result {
        case .failure: nil
        case .success(.data(let bytes)): bytes
        case .success(.string(let text)): Data(text.utf8)
        case .success: Data()
        }
      self?.queue.async { [weak self] in
        guard let self, !self.closed else { return }
        // The computer closed its side; flush what the page has not read yet.
        guard let data else { return self.finish(nil) }
        self.connection.send(
          content: self.toPage.isEnabled ? self.toPage.apply(data) : data,
          completion: .contentProcessed { [weak self] error in
            let failed = error != nil
            self?.queue.async { [weak self] in
              guard let self, !self.closed else { return }
              if failed { self.close() } else { self.pumpFromTunnel(tunnel) }
            }
          })
      }
    }
  }
}
