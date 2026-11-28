import Foundation
import Testing

@testable import AnkielKit

/// Every command the composer sends, encoded and compared with `Fixtures/commands/*.json`. The same
/// files are decoded with the real Effect schemas by `Fixtures/commands/check-schemas.mjs` (run it
/// from `packages/contracts`), so a passing pair means the server accepts what this client sends.
/// `ANKIEL_WRITE_COMMAND_FIXTURES=1 swift test --filter CommandEncoding` rewrites the files.
@Suite("Command encoding")
struct CommandEncodingTests {
  static let model = ModelSelection(
    instanceId: "claudeAgent", model: "claude-opus-5-5", options: [.init(id: "effort", value: .string("high"))])
  static let image = ChatAttachment(type: "image", id: "att_7k2m", name: "screenshot.png", mimeType: "image/png", sizeBytes: 182_044)
  static let file = ChatAttachment(type: "file", id: "att_9q1z", name: "notes.txt", mimeType: "text/plain", sizeBytes: 812)
  static let thread = "0b7e4f2a-9c1d-4e8b-a6f3-5d2c1b0a9e87"
  static let command = CommandID("9d2e6a1f-3b4c-4d5e-8f70-1a2b3c4d5e6f")

  static func dispatch(_ delivery: MessageDelivery) -> MessageDispatch {
    MessageDispatch(
      commandId: command, threadId: thread, messageId: "c41f0e2d-7a6b-4c5d-9e8f-0a1b2c3d4e5f",
      text: "Also add a regression test.", attachments: [image, file], modelSelection: model,
      titleSeed: "Also add a regression test.", delivery: delivery)
  }

  static func thread(_ action: ThreadAction, _ suffix: String = "") -> ThreadCommand {
    ThreadCommand(action, threadId: thread, commandId: CommandID(command.rawValue + suffix))
  }

  /// `[fixture name: (schema, value)]`; the schema names what `check-schemas.mjs` decodes with.
  static let samples: [(name: String, schema: String, value: any Encodable & Sendable)] = [
    ("dispatch-start", "command", dispatch(.start)),
    ("dispatch-steer", "command", dispatch(.steer)),
    ("dispatch-queue", "command", dispatch(.queue)),
    ("dispatch-restart", "command", dispatch(.restart)),
    (
      "dispatch-text-only", "command",
      MessageDispatch(commandId: command, threadId: thread, messageId: "m-1", text: "Hello", delivery: .start)
    ),
    (
      "dispatch-fresh-session", "command",
      MessageDispatch(commandId: command, threadId: thread, messageId: "m-2", text: "Start over from the spec", delivery: .start, freshContext: true)
    ),
    (
      "launch-thread-worktree", "launch",
      ThreadLaunch(
        commandId: command, threadId: thread, projectId: "1895f07d-b00d-4d5a-9710-94981773dffb", title: "Try the new parser",
        modelSelection: model, runtimeMode: .auto, messageId: "m-3", text: "Try the new parser",
        workspace: .worktree(baseRef: "main", startFromOrigin: true))
    ),
    (
      "launch-thread", "launch",
      ThreadLaunch(
        commandId: command, threadId: thread, projectId: "1895f07d-b00d-4d5a-9710-94981773dffb",
        title: "Fix the flaky login test", modelSelection: model, runtimeMode: .auto, messageId: "a2c4e6f8-1b3d-4f5a-8c7e-9d0b1a2c3e4f",
        text: "Fix the flaky login test", attachments: [image])
    ),
    ("runtime-mode-set", "command", thread(.setRuntimeMode(.fullAccess), ":runtime-mode")),
    ("interaction-mode-set", "command", thread(.setInteractionMode(.default), ":interaction-mode")),
    ("model-selection-set", "command", thread(.setModelSelection(model))),
    ("thread-stop", "command", thread(.stop)),
    ("thread-active-reorder", "command", thread(.reorderActive(orderKey: "a0V"))),
    ("run-interrupt", "command", thread(.interruptRun(runId: "run:thread:0b7e:ordinal:3"))),
    ("queued-run-cancel", "command", thread(.cancelQueuedRun(runId: "run:thread:0b7e:ordinal:4"))),
    ("queued-run-start", "command", thread(.startQueuedRun(runId: "run:thread:0b7e:ordinal:4"))),
    (
      "queued-run-promote", "command",
      thread(.promoteQueuedRun(queuedRunId: "run:thread:0b7e:ordinal:4", targetRunId: "run:thread:0b7e:ordinal:3"))
    ),
    ("queued-run-edit", "command", thread(.editQueuedRun(runId: "run:thread:0b7e:ordinal:4", text: "Use the staging database."))),
    (
      "upload-url-image", "uploadUrl",
      UploadURLRequest(UploadFile(url: URL(filePath: "/tmp/a.png"), kind: .image, name: "photo.jpg", mimeType: "image/jpeg", sizeBytes: 482_113))
    ),
    (
      "upload-url-file", "uploadUrl",
      UploadURLRequest(UploadFile(url: URL(filePath: "/tmp/a.txt"), kind: .file, name: "notes.txt", mimeType: "text/plain", sizeBytes: 812))
    ),
    ("attachment-delete", "attachmentDelete", DeleteAttachmentRequest(attachmentId: "att_7k2m")),
    ("respond-accept", "command", respond(.decision("accept"))),
    ("respond-accept-always", "command", respond(.decision("acceptAlways"))),
    ("respond-decline-feedback", "command", respond(.decision("decline", feedback: "Run it against the staging copy instead."))),
    (
      "respond-answers", "command",
      respond(.answers(["framework": .text("SwiftUI"), "targets": .choices(["iPhone", "iPad"]), "notes": .text("")]))
    ),
    (
      "respond-answers-attachments", "command",
      respond(.answers(["shot": .text("")], attachments: ["shot": [image, file]]))
    ),
    ("user-input-dismiss", "command", respond(.dismiss)),
    ("secret-save", "secretAnswer", SecretAnswer(threadId: thread, turnItemId: "turn-item:secret:1", reply: .secret("tok_synthetic_0000"))),
    (
      "secret-save-fields", "secretAnswer",
      SecretAnswer(threadId: thread, turnItemId: "turn-item:secret:2", reply: .values(["user": "harbor-bot", "password": "synthetic-0000"]))
    ),
    ("secret-decline", "secretAnswer", SecretAnswer(threadId: thread, turnItemId: "turn-item:secret:1", reply: .decline)),
    ("settings-auto-settle-off", "updateSettings", UpdateSettingsRequest(patch: .autoSettleAfterDays(nil))),
    ("settings-auto-settle-days", "updateSettings", UpdateSettingsRequest(patch: .autoSettleAfterDays(14))),
    ("settings-auto-settle-merge", "updateSettings", UpdateSettingsRequest(patch: .autoSettleOnMerge(false))),
    ("settings-auto-resume", "updateSettings", UpdateSettingsRequest(patch: .autoResumeLimitedThreads(true))),
    ("settings-snooze-limited", "updateSettings", UpdateSettingsRequest(patch: .snoozeLimitedThreads(true))),
    ("settings-runtime-mode", "updateSettings", UpdateSettingsRequest(patch: .defaultRuntimeMode(.autoAcceptEdits))),
    ("server-update", "serverUpdate", ServerUpdateRequest(targetVersion: "0.1.12")),
  ]

  static func respond(_ reply: RequestCommand.Reply) -> RequestCommand {
    RequestCommand(reply, threadId: thread, requestId: "runtime-request:synthetic:1", commandId: command)
  }

  static var directory: URL {
    URL(filePath: #filePath).deletingLastPathComponent().appending(path: "Fixtures/commands", directoryHint: .isDirectory)
  }

  @Test("each command encodes exactly as its checked-in fixture", arguments: samples.map(\.name))
  func matchesFixture(_ name: String) throws {
    let sample = try #require(Self.samples.first { $0.name == name })
    let encoded = try JSONEncoder.wire.encode(sample.value)
    let url = Self.directory.appending(path: "\(name).json")
    if ProcessInfo.processInfo.environment["ANKIEL_WRITE_COMMAND_FIXTURES"] == "1" {
      let pretty = JSONEncoder()
      pretty.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
      let value = try JSONDecoder().decode(JSONValue.self, from: encoded)
      let document: JSONValue = ["schema": .string(sample.schema), "value": value]
      try FileManager.default.createDirectory(at: Self.directory, withIntermediateDirectories: true)
      try pretty.encode(document).write(to: url)
    }
    let fixture = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url))
    #expect(fixture["schema"] == .string(sample.schema))
    #expect(try JSONDecoder().decode(JSONValue.self, from: encoded) == fixture["value"])
  }

  @Test("turning auto-settle off sends an explicit null, not an absent key")
  func explicitNull() throws {
    let encoded = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder.wire.encode(UpdateSettingsRequest(patch: .autoSettleAfterDays(nil))))
    #expect(encoded == ["patch": ["sidebarAutoSettleAfterDays": .null]])
    let days = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder.wire.encode(ServerSettingsPatch.autoSettleAfterDays(900)))
    // The server refuses anything over MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS (90), live-checked.
    #expect(days == ["sidebarAutoSettleAfterDays": 90])
  }

  @Test("idle sends omit the delivery intent and title seed; follow-ups carry them")
  func deliveryRules() throws {
    func json(_ delivery: MessageDelivery) throws -> JSONValue {
      try JSONDecoder().decode(JSONValue.self, from: JSONEncoder.wire.encode(Self.dispatch(delivery)))
    }
    #expect(try json(.start)["deliveryIntent"] == nil)
    #expect(try json(.start)["titleSeed"] == nil)
    #expect(try json(.start)["dispatchMode"] == ["type": "start_immediately"])
    #expect(try json(.queue)["dispatchMode"] == ["type": "queue_after_active"])
    #expect(try json(.queue)["deliveryIntent"] == nil)
    #expect(try json(.steer)["deliveryIntent"] == "steer")
    #expect(try json(.restart)["deliveryIntent"] == "restart")
    #expect(try json(.steer)["creationSource"] == "mobile")
  }

  @Test("title seeds follow RN deriveThreadTitleSeed")
  func titleSeeds() {
    #expect(ThreadTitleSeed.make(text: "  Fix   the\nlogin  ", attachments: []) == "Fix the login")
    #expect(ThreadTitleSeed.make(text: String(repeating: "a", count: 60), attachments: []) == String(repeating: "a", count: 50) + "...")
    #expect(ThreadTitleSeed.make(text: "", attachments: [Self.image]) == "Attached image")
    #expect(ThreadTitleSeed.make(text: "", attachments: [Self.image, Self.image]) == "Attached images")
    #expect(ThreadTitleSeed.make(text: "", attachments: [Self.file]) == "File: notes.txt")
    #expect(ThreadTitleSeed.make(text: " ", attachments: []) == "New thread")
  }
}
