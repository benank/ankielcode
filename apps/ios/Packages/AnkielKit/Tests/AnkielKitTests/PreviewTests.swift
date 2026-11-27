import Foundation
import Testing

@testable import AnkielKit

/// Device previews: addresses (RN `browserTabs.test.ts`, shared `preview.test.ts`), the proxy's
/// SOCKS parsing and host swap, failure classes, tunnel URLs, and the thread's tab list reducer.
@Suite("Preview")
struct PreviewTests {
  @Test("only the computer's loopback pages open through the tunnel")
  func loopbackForDevice() {
    #expect(PreviewURLs.loopbackURLForDevice("http://localhost:5173/app?x=1")?.absoluteString == "http://localhost:5173/app?x=1")
    #expect(PreviewURLs.loopbackURLForDevice("http://127.0.0.1:3000/")?.absoluteString == "http://127.0.0.1:3000/")
    #expect(PreviewURLs.loopbackURLForDevice("http://[::1]:3000/")?.absoluteString == "http://[::1]:3000/")
    // The unspecified address would name the phone's own interfaces.
    #expect(PreviewURLs.loopbackURLForDevice("http://0.0.0.0:3000/")?.absoluteString == "http://localhost:3000/")
    #expect(PreviewURLs.loopbackURLForDevice("http://[::]:3000/")?.absoluteString == "http://localhost:3000/")
    #expect(PreviewURLs.loopbackURLForDevice("http://localhost:5173")?.absoluteString == "http://localhost:5173/")
    #expect(PreviewURLs.loopbackURLForDevice("https://example.com/") == nil)
    #expect(PreviewURLs.loopbackURLForDevice("http://192.168.1.5:3000/") == nil)
    #expect(PreviewURLs.loopbackURLForDevice("file:///tmp/a.html") == nil)
    #expect(PreviewURLs.loopbackURLForDevice("") == nil)
  }

  @Test("a device preview loads http and https and nothing else")
  func localForDevice() {
    #expect(PreviewURLs.localPreviewURLForDevice("http://0.0.0.0:3000/")?.absoluteString == "http://localhost:3000/")
    #expect(PreviewURLs.localPreviewURLForDevice("https://example.com/docs")?.absoluteString == "https://example.com/docs")
    #expect(PreviewURLs.localPreviewURLForDevice(" JavaScript:void(0)") == nil)
    #expect(PreviewURLs.localPreviewURLForDevice("file:///tmp/a.html") == nil)
    #expect(PreviewURLs.localPreviewURLForDevice("data:text/html,hello") == nil)
    #expect(PreviewURLs.localPreviewURLForDevice("") == nil)
  }

  @Test("the address bar adds http for loopback, https otherwise, and refuses other schemes")
  func normalize() throws {
    #expect(try PreviewURLs.normalize("localhost:3000").absoluteString == "http://localhost:3000/")
    #expect(try PreviewURLs.normalize("127.0.0.2:3000/path").absoluteString == "http://127.0.0.2:3000/path")
    #expect(try PreviewURLs.normalize("127.255.255.254:443/path").absoluteString == "http://127.255.255.254:443/path")
    #expect(try PreviewURLs.normalize("[::1]:8080").absoluteString == "http://[::1]:8080/")
    #expect(try PreviewURLs.normalize("devbox:8080").absoluteString == "https://devbox:8080/")
    #expect(try PreviewURLs.normalize("example.com").absoluteString == "https://example.com/")
    #expect(try PreviewURLs.normalize("  http://localhost:5173/a?b=1  ").absoluteString == "http://localhost:5173/a?b=1")
    #expect(throws: PreviewURLs.NormalizationError.empty) { try PreviewURLs.normalize("  ") }
    for scheme in ["about:blank", "mailto:a@b.c", "javascript:alert(1)", "ws://localhost:1", "file:///etc"] {
      #expect(throws: PreviewURLs.NormalizationError.self) { try PreviewURLs.normalize(scheme) }
    }
  }

  @Test("loopback pages load under the stand-in host and show localhost")
  func standIn() throws {
    // The stand-in must be as long as `localhost`, so the proxy can swap them in place.
    #expect(PreviewLoopback.standInHost.utf8.count == "localhost".utf8.count)
    let url = try #require(URL(string: "http://localhost:5173/a?b=1#c"))
    let standIn = PreviewLoopback.standIn(url)
    #expect(standIn.absoluteString == "http://\(PreviewLoopback.standInHost):5173/a?b=1#c")
    #expect(PreviewLoopback.shown(standIn) == url)
    #expect(PreviewLoopback.isTunnelled(standIn))
    #expect(PreviewLoopback.standIn(URL(string: "http://127.0.0.1:3000/")!).host() == PreviewLoopback.standInHost)
    #expect(PreviewLoopback.standIn(URL(string: "http://app.localhost:3000/")!).host() == PreviewLoopback.standInHost)
    #expect(PreviewLoopback.standIn(URL(string: "https://example.com/")!).absoluteString == "https://example.com/")
  }

  @Test("the host swap keeps lengths and replaces every whole match in a chunk")
  func hostSwap() {
    var swap = PreviewHostSwap(from: PreviewLoopback.standInHost, to: "localhost")
    #expect(!swap.isDecided)
    swap.decide(true)
    let request = "GET / HTTP/1.1\r\nHost: \(PreviewLoopback.standInHost):5173\r\nOrigin: http://\(PreviewLoopback.standInHost):5173\r\n\r\n"
    let swapped = String(decoding: swap.apply(Data(request.utf8)), as: UTF8.self)
    #expect(swapped == "GET / HTTP/1.1\r\nHost: localhost:5173\r\nOrigin: http://localhost:5173\r\n\r\n")
    #expect(swapped.utf8.count == request.utf8.count)
  }

  @Test("CONNECT is carried only for loopback, and waits for the whole request")
  func parseConnect() {
    func domain(_ name: String, port: UInt16) -> [UInt8] {
      [5, 1, 0, 3, UInt8(name.utf8.count)] + Array(name.utf8) + [UInt8(port >> 8), UInt8(port & 0xff)]
    }
    let standIn = domain(PreviewLoopback.standInHost, port: 5173)
    #expect(PreviewSocks.parseConnect(standIn) == .connect(port: 5173, consumed: standIn.count))
    #expect(PreviewSocks.parseConnect(Array(standIn.dropLast())) == nil)
    #expect(PreviewSocks.parseConnect(domain("localhost", port: 80)) == .connect(port: 80, consumed: 16))
    #expect(PreviewSocks.parseConnect(domain("127.0.0.1", port: 3000)) == .connect(port: 3000, consumed: 16))
    #expect(PreviewSocks.parseConnect(domain("example.com", port: 443)) == .refuse(PreviewSocks.notAllowed))
    #expect(PreviewSocks.parseConnect([5, 1, 0, 1, 127, 0, 0, 1, 0x1f, 0x90]) == .connect(port: 8080, consumed: 10))
    #expect(PreviewSocks.parseConnect([5, 1, 0, 1, 10, 0, 0, 1, 0, 80]) == .refuse(PreviewSocks.notAllowed))
    let ipv6 = [5, 1, 0, 4] + [UInt8](repeating: 0, count: 15) + [1, 0, 80]
    #expect(PreviewSocks.parseConnect(ipv6) == .connect(port: 80, consumed: 22))
    #expect(PreviewSocks.parseConnect([5, 2, 0, 1, 127, 0, 0, 1, 0, 80]) == .refuse(PreviewSocks.commandNotSupported))
    #expect(PreviewSocks.parseConnect([5, 1, 0, 9, 0, 0]) == .refuse(PreviewSocks.addressNotSupported))
  }

  @Test("a refused tunnel says why, from its headers first")
  func classify() {
    #expect(PreviewTunnelFailure.classify(status: 403, portRefused: true, disabled: false) == .port)
    #expect(PreviewTunnelFailure.classify(status: 403, portRefused: false, disabled: true) == .disabled)
    #expect(PreviewTunnelFailure.classify(status: 403, portRefused: false, disabled: false) == .permission)
    #expect(PreviewTunnelFailure.classify(status: 401, portRefused: false, disabled: false) == .environment)
    #expect(PreviewTunnelFailure.classify(status: 200, portRefused: false, disabled: false) == .outdated)
    #expect(PreviewTunnelFailure.classify(status: 404, portRefused: false, disabled: false) == .outdated)
    #expect(PreviewTunnelFailure.classify(status: 502, portRefused: false, disabled: false) == .environment)
    #expect(PreviewTunnelFailure.classify(status: nil, portRefused: false, disabled: false) == .environment)
  }

  @Test("the tunnel URL keeps the relay prefix, escapes the ticket and adds the port")
  func tunnelURLs() throws {
    let relay = try #require(EnvironmentEndpoint(httpBaseURL: URL(string: "https://relay.example.workers.dev/h/abcdefghijklmnopqrstuvwxyz/")!))
    let base = try #require(PreviewTunnel.baseURL(endpoint: relay, ticket: "abc.def+/="))
    #expect(base.absoluteString == "wss://relay.example.workers.dev/h/abcdefghijklmnopqrstuvwxyz/api/preview/tunnel?wsTicket=abc.def%2B%2F%3D")
    let lan = try #require(EnvironmentEndpoint(httpBaseURL: URL(string: "http://192.168.1.5:3773/")!))
    let lanBase = try #require(PreviewTunnel.baseURL(endpoint: lan, ticket: "t"))
    let tunnel = try #require(PreviewSocks.tunnelURL(base: lanBase, port: 5173))
    #expect(tunnel.absoluteString == "ws://192.168.1.5:3773/api/preview/tunnel?wsTicket=t&port=5173")
    let now = Date(timeIntervalSince1970: 1_000)
    #expect(PreviewTunnel.isReusable(expiresAt: now.addingTimeInterval(31), now: now))
    #expect(!PreviewTunnel.isReusable(expiresAt: now.addingTimeInterval(30), now: now))
    #expect(!PreviewTunnel.isReusable(expiresAt: nil, now: now))
  }

  @Test("preview.list encodes as its checked-in fixture")
  func listRequestFixture() throws {
    let url = URL(filePath: #filePath).deletingLastPathComponent().appending(path: "Fixtures/commands/preview-list.json")
    let fixture = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url))
    #expect(fixture["schema"] == .string("previewList"))
    let encoded = try JSONEncoder.wire.encode(PreviewListRequest(threadId: "thread-tide-1"))
    #expect(try JSONDecoder().decode(JSONValue.self, from: encoded) == fixture["value"])
  }

  // MARK: Tabs

  static func tab(_ id: String, url: String = "http://localhost:5173/", title: String = "Tide", runtime: String = "server", at time: String = "2026-11-27T10:00:00.000Z") -> String {
    """
    {"threadId":"thread-tide-1","tabId":"\(id)","navStatus":{"_tag":"Success","url":"\(url)","title":"\(title)"},
    "canGoBack":false,"canGoForward":false,"runtime":"\(runtime)","updatedAt":"\(time)","futureField":1}
    """
  }

  static func event(_ type: String, tab id: String, revision: Int, epoch: String = "epoch-1", body: String = "") throws -> PreviewEvent {
    try decode(
      PreviewEvent.self,
      json: """
        {"threadId":"thread-tide-1","tabId":"\(id)","createdAt":"2026-11-27T10:05:00.000Z","serverEpoch":"\(epoch)",
        "revision":\(revision),"type":"\(type)"\(body)}
        """)
  }

  @Test("a listing decodes tolerantly and keeps only server tabs for the phone")
  func listDecode() throws {
    let list = try decode(
      PreviewList.self,
      json: """
        {"sessions":[\(Self.tab("tab-1")),\(Self.tab("tab-2", runtime: "desktop")),{"tabId":"broken"},
        {"threadId":"thread-tide-1","tabId":"tab-3","navStatus":{"_tag":"Idle"},"canGoBack":false,"canGoForward":false,"runtime":"server","updatedAt":"2026-11-27T11:00:00.000Z"}],
        "serverEpoch":"epoch-1","revision":4}
        """)
    #expect(list.sessions.map(\.tabId) == ["tab-1", "tab-2", "tab-3"])
    var state = PreviewTabsState()
    #expect(!state.listed)
    state.apply(list: list)
    #expect(state.listed)
    #expect(state.serverTabs.map(\.tabId) == ["tab-1", "tab-3"])
    #expect(state.latest?.tabId == "tab-3")
    #expect(state.serverTabs.last?.displayTitle == nil)
    #expect(state.serverTabs.first?.displayTitle == "Tide")
  }

  @Test("events open, navigate, fail and close tabs, and stale ones are ignored")
  func events() throws {
    var state = PreviewTabsState()
    state.apply(list: try decode(PreviewList.self, json: #"{"sessions":[\#(Self.tab("tab-1"))],"serverEpoch":"epoch-1","revision":2}"#))
    #expect(!state.apply(event: try Self.event("opened", tab: "tab-2", revision: 3, body: #","snapshot":\#(Self.tab("tab-2", title: ""))"#)))
    #expect(state.serverTabs.map(\.tabId) == ["tab-1", "tab-2"])
    #expect(state.serverTabs.last?.displayTitle == "localhost:5173")
    state.apply(event: try Self.event("failed", tab: "tab-1", revision: 4, body: #","url":"http://localhost:9/","title":"","code":-102,"description":"refused""#))
    #expect(state.serverTabs.first?.navStatus == .loadFailed(url: "http://localhost:9/", title: "", code: -102, description: "refused"))
    // Revision 4 again (a replay) changes nothing.
    state.apply(event: try Self.event("closed", tab: "tab-1", revision: 4))
    #expect(state.serverTabs.count == 2)
    state.apply(event: try Self.event("closed", tab: "tab-1", revision: 5))
    #expect(state.serverTabs.map(\.tabId) == ["tab-2"])
    state.apply(event: try Self.event("someday", tab: "tab-2", revision: 6))
    #expect(state.revision == 6)
  }

  @Test("a list that lands after newer events replays them, and an older list is ignored")
  func listAfterEvents() throws {
    var state = PreviewTabsState()
    state.apply(event: try Self.event("opened", tab: "tab-2", revision: 3, body: #","snapshot":\#(Self.tab("tab-2"))"#))
    state.apply(list: try decode(PreviewList.self, json: #"{"sessions":[\#(Self.tab("tab-1"))],"serverEpoch":"epoch-1","revision":2}"#))
    #expect(state.serverTabs.map(\.tabId) == ["tab-1", "tab-2"])
    #expect(state.revision == 3)
    state.apply(list: try decode(PreviewList.self, json: #"{"sessions":[],"serverEpoch":"epoch-1","revision":1}"#))
    #expect(state.serverTabs.count == 2)
  }

  @Test("a restarted server asks for a fresh list")
  func newEpoch() throws {
    var state = PreviewTabsState()
    state.apply(list: try decode(PreviewList.self, json: #"{"sessions":[\#(Self.tab("tab-1"))],"serverEpoch":"epoch-1","revision":9}"#))
    #expect(state.apply(event: try Self.event("closed", tab: "tab-1", revision: 1, epoch: "epoch-2")))
    #expect(state.serverTabs.count == 1)
    state.apply(list: try decode(PreviewList.self, json: #"{"sessions":[],"serverEpoch":"epoch-2","revision":0}"#))
    #expect(state.serverTabs.isEmpty)
  }
}
