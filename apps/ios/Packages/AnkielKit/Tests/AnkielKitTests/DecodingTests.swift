import Foundation
import Testing

@testable import AnkielKit

@Suite struct TolerantDecodingTests {
  enum Color: String, Sendable { case red, blue }

  @Test func `unknown enum values decode to unknown and round-trip`() throws {
    let value = try decode([WireEnum<Color>].self, json: #"["red","violet"]"#)
    #expect(value == [.known(.red), .unknown("violet")])
    #expect(value[0] == .red)
    #expect(String(decoding: try JSONEncoder().encode(value), as: UTF8.self) == #"["red","violet"]"#)
  }

  @Test func `non-finite numbers decode from strings`() throws {
    let values = try decode([WireNumber].self, json: #"[1.5,"Infinity","-Infinity","NaN"]"#)
    #expect(values[0].value == 1.5)
    #expect(values[1].value == .infinity)
    #expect(values[2].value == -.infinity)
    #expect(values[3].value.isNaN)
    #expect(String(decoding: try JSONEncoder().encode(values[1]), as: UTF8.self) == #""Infinity""#)
  }

  @Test func `lossy arrays skip unreadable elements`() throws {
    let value = try decode(LossyArray<Int>.self, json: #"[1,"two",3,{"x":4}]"#)
    #expect(value.elements == [1, 3])
    #expect(value.droppedCount == 2)
  }

  @Test func `a thread row tolerates unknown fields, null optionals and unknown enum cases`() throws {
    let base = try Fixture.json("thread-shell")
    let row = base
      .setting("someFutureField", ["nested": true])
      .setting("status", "hibernating")
      .setting("latestRunStartedAt", nil)
      .setting("lastError", .null)
      .setting("activityRunStatus", "running")
      .setting("createdBy", "robot")
    let thread = try decode(ThreadShell.self, from: encode(row))
    #expect(thread.status == .unknown("hibernating"))
    #expect(thread.createdBy == .unknown("robot"))
    #expect(thread.activityRunStatus == .running)
    #expect(thread.lastError == nil)
    #expect(thread.latestRunStartedAt == nil)
    #expect(thread.pendingBackgroundTasks == nil)
  }

  @Test func `an unreadable forward-compatible field drops the field, not the row`() throws {
    let row = try Fixture.json("thread-shell")
      .setting("issues", [["tracker": "github"]])
      .setting("goal", "not an object")
      .setting("pendingRuntimeRequest", ["id": "r1", "kind": "brand-new-kind", "createdAt": "2026-11-26T12:00:00.000Z"])
    let thread = try decode(ThreadShell.self, from: encode(row))
    #expect(thread.issues == nil)
    #expect(thread.goal == nil)
    #expect(thread.pendingRuntimeRequest?.kind == .unknown("brand-new-kind"))
  }

  @Test func `a snapshot skips a malformed row and counts it`() throws {
    let good = try Fixture.json("thread-shell")
    let bad = good.setting("id", nil)
    let snapshot: JSONValue = [
      "schemaVersion": 1, "snapshotSequence": 7, "threads": [good, bad], "archivedThreads": [],
      "projects": [try Fixture.json("project-shell")],
    ]
    let decoded = try decode(ShellSnapshot.self, from: encode(snapshot))
    #expect(decoded.threads.count == 1)
    #expect(decoded.projects.count == 1)
    #expect(decoded.droppedRows.count == 1)
    #expect(decoded.droppedRows.firstReason?.contains("id") == true)
  }

  @Test func `shell items decode by kind, unknown kinds and broken bodies are kept apart`() throws {
    let thread = try Fixture.json("thread-shell")
    let items = try decode(
      [ShellStreamItem].self,
      from: encode([
        ["kind": "synchronized"],
        ["kind": "snapshot-required"],
        ["kind": "thread.updated", "sequence": 3, "location": "active", "thread": thread],
        ["kind": "thread.removed", "sequence": 4, "location": "archive", "threadId": "t"],
        ["kind": "project.removed", "sequence": 5, "projectId": "p"],
        ["kind": "future.event", "sequence": 9],
        ["kind": "thread.updated", "sequence": 6, "location": "active"],
      ]))
    #expect(items[0] == .synchronized)
    #expect(items[1] == .snapshotRequired)
    #expect(items[2] == .delta(.threadUpdated(sequence: 3, location: .known(.active), thread: try Fixture.thread)))
    #expect(items[3] == .delta(.threadRemoved(sequence: 4, location: .known(.archive), threadId: "t")))
    #expect(items[4] == .delta(.projectRemoved(sequence: 5, projectId: "p")))
    #expect(items[5] == .unknown(kind: "future.event"))
    guard case .undecodable(kind: "thread.updated", _) = items[6] else {
      Issue.record("Expected undecodable, got \(items[6])")
      return
    }
  }

  @Test func `model selection decodes legacy shapes`() throws {
    let legacy = try decode(ModelSelection.self, json: #"{"provider":"codex","model":"gpt","options":{"effort":"high","fast":true}}"#)
    #expect(legacy.instanceId == "codex")
    #expect(legacy.options == [.init(id: "effort", value: "high"), .init(id: "fast", value: true)])
    let encoded = try decode(JSONValue.self, from: try JSONEncoder().encode(legacy))
    #expect(encoded["instanceId"] == "codex")
    #expect(encoded["provider"] == nil)
  }

  @Test func `descriptor and server config decode the live shapes`() throws {
    let descriptor = try decode(
      EnvironmentDescriptor.self,
      json: #"{"environmentId":"env_1","label":"Mac","platform":{"os":"darwin","arch":"arm64","machine":"laptop"},"serverVersion":"0.1.11","orchestrationProtocolVersion":2,"capabilities":{"accessTokenRenewal":true,"fileAttachments":{"maxUploadBytes":52428800}}}"#)
    #expect(descriptor.capability("accessTokenRenewal"))
    #expect(!descriptor.capability("threadSnooze"))
    #expect(descriptor.platform?.os == .darwin)
    #expect(try decode(EnvironmentDescriptor.self, json: #"{"environmentId":"e","label":"l","serverVersion":"1","capabilities":{}}"#).protocolVersion == 1)

    let event = try decode(
      ServerConfigEvent.self,
      json: #"{"version":1,"type":"snapshot","config":{"environment":{"environmentId":"env_1","label":"Mac","serverVersion":"0.1.11","orchestrationProtocolVersion":2,"capabilities":{}},"cwd":"/x","shellThreadFamilies":true,"shellOlderSettled":true,"directEndpoints":[{"kind":"lan","httpBaseUrl":"http://192.168.1.2:3773/"},{"kind":"carrier-pigeon","httpBaseUrl":"x"},5],"providers":[{"unread":true}]}}"#)
    guard case .snapshot(let config) = event else {
      Issue.record("Expected a snapshot")
      return
    }
    #expect(config.directEndpoints.count == 2)
    #expect(config.directEndpoints[1].kind == .unknown("carrier-pigeon"))
    #expect(config.shellSubscription == ShellSubscription(requestCompletionMarker: true, omitIdleSubagents: true, omitOlderSettled: true))
    guard case .other(type: "providerStatuses") = try decode(ServerConfigEvent.self, json: #"{"version":1,"type":"providerStatuses","providers":[]}"#) else {
      Issue.record("Expected other")
      return
    }
  }

  @Test func `timestamps compare by instant`() {
    let earlier = WireTimestamp(rawValue: "2026-11-26T12:00:00.000Z")
    let later = WireTimestamp(rawValue: "2026-11-26T12:00:01Z")
    #expect(earlier < later)
    #expect(earlier.date != nil && later.date != nil)
  }
}
