import Foundation
import Testing

@testable import AnkielKit

@Suite struct RpcClientTests {
  let transport = FakeTransport()
  let client: RpcClient

  init() async {
    client = RpcClient(transport: transport, options: .init(pingInterval: nil))
    await client.start()
  }

  struct ProbeResult: Decodable, Sendable, Equatable { let serverTime: String }

  @Test func `unary call encodes the request and decodes Success`() async throws {
    async let result = client.call("server.probe", as: ProbeResult.self)
    let request = try #require(await transport.nextSent())
    #expect(request == ["_tag": "Request", "id": 0, "tag": "server.probe", "payload": [:], "headers": []])
    transport.serve(#"{"_tag":"Exit","requestId":0,"exit":{"_tag":"Success","value":{"serverTime":"2026-11-26T12:00:00.000Z"}}}"#)
    #expect(try await result == ProbeResult(serverTime: "2026-11-26T12:00:00.000Z"))
  }

  @Test func `request ids increase per request`() async throws {
    async let first = client.call("a", as: JSONValue.self)
    let one = try #require(await transport.nextSent())
    async let second = client.call("b", as: JSONValue.self)
    let two = try #require(await transport.nextSent())
    #expect(one["id"] == 0)
    #expect(two["id"] == 1)
    transport.serve(#"{"_tag":"Exit","requestId":"1","exit":{"_tag":"Success","value":2}}"#)
    transport.serve(#"{"_tag":"Exit","requestId":0,"exit":{"_tag":"Success","value":1}}"#)
    #expect(try await first == 1)
    #expect(try await second == 2)
  }

  @Test func `a typed Fail surfaces its tag and fields`() async throws {
    async let result = client.call("server.probe", as: JSONValue.self)
    _ = await transport.nextSent()
    transport.serve(
      #"{"_tag":"Exit","requestId":0,"exit":{"_tag":"Failure","cause":[{"_tag":"Fail","error":{"_tag":"EnvironmentAuthorizationError","message":"The authenticated token is missing required scope: orchestration:read.","requiredScope":"orchestration:read","requiredPermission":"orchestration:read"}}]}}"#
    )
    do {
      _ = try await result
      Issue.record("Expected a failure")
    } catch RpcError.failed(let failure) {
      #expect(failure.tag == "EnvironmentAuthorizationError")
      #expect(failure.error["requiredPermission"] == "orchestration:read")
    }
  }

  @Test(arguments: [
    (#"[{"_tag":"Die","defect":"Expected \"thread.create\" at [\"type\"]"}]"#, RpcError.defect("Expected \"thread.create\" at [\"type\"]")),
    (#"[{"_tag":"Interrupt","fiberId":7}]"#, RpcError.interrupted),
    (#"[{"_tag":"Interrupt","fiberId":null}]"#, RpcError.interrupted),
  ])
  func `defects and interrupts map to their errors`(cause: String, expected: RpcError) async throws {
    let client = client
    let result = Task { try await client.call("x", as: JSONValue.self) }
    _ = await transport.nextSent()
    transport.serve(#"{"_tag":"Exit","requestId":0,"exit":{"_tag":"Failure","cause":\#(cause)}}"#)
    await #expect(throws: expected) { try await result.value }
  }

  @Test func `streams ack every chunk and end on a null Success`() async throws {
    let stream = try await client.stream("orchestration.subscribeShell", payload: ["requestCompletionMarker": true] as JSONValue, of: JSONValue.self)
    let request = try #require(await transport.nextSent())
    #expect(request["payload"] == ["requestCompletionMarker": true])
    let id = try #require(request["id"]?.intValue)

    transport.serve(#"{"_tag":"Chunk","requestId":\#(id),"values":[{"kind":"snapshot"},{"kind":"synchronized"}]}"#)
    #expect(await transport.nextSent() == ["_tag": "Ack", "requestId": .number(Double(id))])
    transport.serve(#"{"_tag":"Chunk","requestId":\#(id),"values":[null]}"#)
    #expect(await transport.nextSent() == ["_tag": "Ack", "requestId": .number(Double(id))])
    transport.serve(#"{"_tag":"Exit","requestId":\#(id),"exit":{"_tag":"Success","value":null}}"#)

    var received: [JSONValue] = []
    for try await value in stream { received.append(value) }
    #expect(received == [["kind": "snapshot"], ["kind": "synchronized"], nil])
  }

  @Test func `a stream that fails throws the typed error`() async throws {
    let stream = try await client.stream("s", of: JSONValue.self)
    _ = await transport.nextSent()
    transport.serve(#"{"_tag":"Exit","requestId":0,"exit":{"_tag":"Failure","cause":[{"_tag":"Fail","error":{"_tag":"KeybindingsConfigError","message":"bad"}}]}}"#)
    await #expect(throws: RpcError.failed(RpcFailure(error: ["_tag": "KeybindingsConfigError", "message": "bad"]))) {
      for try await _ in stream {}
    }
  }

  @Test func `stopping a stream sends Interrupt`() async throws {
    let stream = try await client.stream("s", of: JSONValue.self)
    _ = await transport.nextSent()
    transport.serve(#"{"_tag":"Chunk","requestId":0,"values":[1]}"#)
    for try await _ in stream { break }
    #expect(await transport.nextSent() == ["_tag": "Ack", "requestId": 0])
    #expect(await transport.nextSent() == ["_tag": "Interrupt", "requestId": 0])
  }

  @Test func `cancelling a unary call sends Interrupt`() async throws {
    let client = client
    let call = Task { try await client.call("slow", as: JSONValue.self) }
    _ = await transport.nextSent()
    call.cancel()
    #expect(await transport.nextSent() == ["_tag": "Interrupt", "requestId": 0])
    await #expect(throws: CancellationError.self) { try await call.value }
  }

  @Test func `frame parts are joined before parsing`() async throws {
    async let result = client.call("x", as: JSONValue.self)
    _ = await transport.nextSent()
    transport.serve("\u{1E}{\"_tag\":\"Exit\",\"reque")
    transport.serve("\u{1E}stId\":0,\"exit\":{\"_tag\":\"Succ")
    transport.serve("ess\",\"value\":\"joined\"}}")
    #expect(try await result == "joined")
  }

  @Test func `a batch array frame delivers each message`() async throws {
    async let first = client.call("a", as: JSONValue.self)
    _ = await transport.nextSent()
    async let second = client.call("b", as: JSONValue.self)
    _ = await transport.nextSent()
    transport.serve(
      #"[{"_tag":"Pong"},{"_tag":"Exit","requestId":0,"exit":{"_tag":"Success","value":"a"}},{"_tag":"Exit","requestId":1,"exit":{"_tag":"Success","value":"b"}}]"#
    )
    #expect(try await first == "a")
    #expect(try await second == "b")
  }

  @Test func `a top-level Defect fails every open request`() async throws {
    let client = client
    let call = Task { try await client.call("a", as: JSONValue.self) }
    _ = await transport.nextSent()
    let stream = try await client.stream("s", of: JSONValue.self)
    _ = await transport.nextSent()
    transport.serve(#"{"_tag":"Defect","defect":"bad frame"}"#)
    await #expect(throws: RpcError.protocolDefect("bad frame")) { try await call.value }
    await #expect(throws: RpcError.protocolDefect("bad frame")) { for try await _ in stream {} }
  }

  @Test func `a closed socket fails open requests and later calls`() async throws {
    let client = client
    let call = Task { try await client.call("a", as: JSONValue.self) }
    _ = await transport.nextSent()
    transport.disconnect()
    await #expect(throws: RpcError.self) { try await call.value }
    let reason = await client.closed()
    guard case .connectionClosed = reason else {
      Issue.record("Expected connectionClosed, got \(reason)")
      return
    }
    await #expect(throws: RpcError.self) { try await client.call("b", as: JSONValue.self) }
  }

  @Test func `a chunk that does not decode ends the stream with a decoding error`() async throws {
    struct Strict: Decodable, Sendable { let required: Int }
    let stream = try await client.stream("s", of: Strict.self)
    _ = await transport.nextSent()
    transport.serve(#"{"_tag":"Chunk","requestId":0,"values":[{"other":1}]}"#)
    #expect(await transport.nextSent() == ["_tag": "Interrupt", "requestId": 0])
    await #expect(throws: RpcError.self) { for try await _ in stream {} }
  }
}

@Suite struct FrameJoinerTests {
  @Test func `whole frames pass through and parts join`() {
    var joiner = FrameJoiner()
    #expect(joiner.accept(#"{"_tag":"Pong"}"#) == #"{"_tag":"Pong"}"#)
    #expect(joiner.accept("\u{1E}ab") == nil)
    #expect(joiner.isPending)
    #expect(joiner.accept("\u{1E}cd") == nil)
    #expect(joiner.accept("ef") == "abcdef")
    #expect(!joiner.isPending)
  }
}

@Suite struct ClientFrameTests {
  @Test func `control frames match the Effect encoding`() throws {
    #expect(try decode(JSONValue.self, json: ClientFrame.ack(3)) == ["_tag": "Ack", "requestId": 3])
    #expect(try decode(JSONValue.self, json: ClientFrame.interrupt(3)) == ["_tag": "Interrupt", "requestId": 3])
    #expect(try decode(JSONValue.self, json: ClientFrame.ping) == ["_tag": "Ping"])
  }
}
