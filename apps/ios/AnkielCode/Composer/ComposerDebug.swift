#if DEBUG
  import AnkielKit
  import Foundation
  import UIKit

  /// `ANKIEL_DEBUG_COMPOSER`: the composer sends to this fake instead of a computer, so sending,
  /// uploads, failures and the new-thread flow can be exercised and screenshotted without a
  /// server. Its drafts and outbox live in their own folder, never the real one. Modes:
  /// `fake` (accepts after a short wait and shows the message in fixture threads), `slow` (never
  /// answers), `fail` (refuses), `offline` (no computer connected). Attachments named `*fail*`
  /// fail to upload and `*slow*` stall at 40 %. Documented in `apps/ios/README.md`.
  @MainActor
  final class FakeComposerSink: ComposerSink {
    enum Mode: String { case fake, slow, fail, offline }

    let mode: Mode
    weak var registry: EnvironmentRegistry?

    init(mode: Mode) { self.mode = mode }

    func canSend(to environmentId: String) -> Bool { mode != .offline }

    private func answer() async throws(EnvironmentRequestError) {
      switch mode {
      case .slow:
        try? await Task.sleep(for: .seconds(3600))
        throw .notConnected
      case .fail:
        try? await Task.sleep(for: .milliseconds(500))
        throw .rejected(message: String(localized: "The computer refused this message.", comment: "debug: fake refusal"))
      case .offline:
        throw .notConnected
      case .fake:
        try? await Task.sleep(for: .milliseconds(700))
      }
    }

    func send(_ command: ThreadCommand, in environmentId: String) async throws(EnvironmentRequestError) -> Int {
      try? await Task.sleep(for: .milliseconds(200))
      let ref = ThreadRef(environmentId: environmentId, threadId: command.threadId)
      if ThreadDebug.isFixture(ref), let model = ThreadDebug.existing(ref) {
        switch command.action {
        case .cancelQueuedRun(let runId), .startQueuedRun(let runId), .promoteQueuedRun(let runId, _):
          model.enqueue { await $0.debugRemoveRun(runId) }
        default: break
        }
      }
      return 1
    }

    func send(_ message: MessageDispatch, in environmentId: String) async throws(EnvironmentRequestError) -> Int {
      try await answer()
      let ref = ThreadRef(environmentId: environmentId, threadId: message.threadId)
      if ThreadDebug.isFixture(ref), let model = ThreadDebug.existing(ref) {
        let id = message.messageId
        let text = message.text
        let attachments = message.attachments
        if message.delivery == .queue {
          model.enqueue { await $0.debugAppendQueuedMessage(runId: "run:queued:\(id)", messageId: id, text: text) }
        } else {
          model.enqueue { await $0.debugAppendUserMessage(messageId: id, text: text, attachments: attachments) }
        }
      }
      return 2
    }

    func launch(_ launch: ThreadLaunch, in environmentId: String) async throws(EnvironmentRequestError) -> ThreadLaunchResult {
      try await answer()
      if environmentId == ThreadDebug.environmentId {
        ThreadDebug.registerLaunched(launch)
      }
      return ThreadLaunchResult(threadId: launch.threadId, sequence: 1)
    }

    func threadLaunched(_ result: ThreadLaunchResult, in environmentId: String) {}

    func upload(
      _ file: UploadFile, in environmentId: String, progress: @escaping @Sendable (Double) -> Void
    ) async throws(EnvironmentRequestError) -> String {
      let name = file.name.lowercased()
      for step in 1...8 {
        if name.contains("slow"), step > 3 {
          try? await Task.sleep(for: .seconds(3600))
          throw .notConnected
        }
        try? await Task.sleep(for: .milliseconds(120))
        if Task.isCancelled { throw .failed("Cancelled.") }
        progress(Double(step) / 10)
      }
      if name.contains("fail") {
        throw .rejected(message: String(localized: "The upload was refused.", comment: "debug: fake upload refusal"))
      }
      return "att_fake_\(UUID().uuidString.prefix(8).lowercased())"
    }

    func discardUpload(_ attachmentId: String, in environmentId: String) async {}
  }

  /// A provider catalog for fixture threads and the fake computer.
  enum DebugCatalog {
    static let environmentLabel = "Fixture Mac"

    static var providers: [ServerProvider] {
      let effort = OptionDescriptor(
        id: "effort", label: "Effort", kind: .select,
        choices: [
          .init(id: "low", label: "Low"), .init(id: "medium", label: "Medium"), .init(id: "high", label: "High", isDefault: true),
          .init(id: "xhigh", label: "Extra high"),
        ], role: "reasoning")
      let fast = OptionDescriptor(id: "fastMode", label: "Fast mode", kind: .boolean)
      var opus = ServerProviderModel(slug: "claude-opus-5-5", name: "Claude Opus 5.5", isDefault: true, optionDescriptors: [effort, fast])
      opus.shortName = "Opus 5.5"
      var sonnet = ServerProviderModel(slug: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", optionDescriptors: [effort])
      sonnet.shortName = "Sonnet 5.5"
      var haiku = ServerProviderModel(slug: "claude-haiku-5-5", name: "Claude Haiku 5.5")
      haiku.shortName = "Haiku 5.5"
      var claude = ServerProvider(instanceId: "claudeAgent", driver: "claudeAgent", displayName: "Claude", models: [opus, sonnet, haiku])
      claude.supportedRuntimeModes = [.approvalRequired, .autoAcceptEdits, .auto, .fullAccess]
      let codex = ServerProvider(
        instanceId: "codex", driver: "codex", displayName: "Codex",
        models: [
          ServerProviderModel(slug: "gpt-5.4", name: "GPT-5.4", optionDescriptors: [effort]),
          ServerProviderModel(slug: "gpt-5.4-mini", name: "GPT-5.4 mini"),
        ])
      let replay = ServerProvider(
        instanceId: "devReplay", driver: "devReplay", displayName: "Replay (dev)",
        models: [ServerProviderModel(slug: "replay", name: "Replay")])
      return [claude, codex, replay]
    }

    static var projects: [ProjectShell] {
      [project("fx-tidewater", "tidewater"), project("fx-harbor", "harbor-api"), project("fx-buoy", "buoy-firmware")]
    }

    private static func project(_ id: String, _ title: String) -> ProjectShell {
      let json = #"{"id":"\#(id)","title":"\#(title)","workspaceRoot":"/src/\#(title)","defaultModelSelection":null,"scripts":[],"createdAt":"2026-11-01T00:00:00.000Z","updatedAt":"2026-11-01T00:00:00.000Z"}"#
      return try! JSONDecoder().decode(ProjectShell.self, from: Data(json.utf8))
    }

    /// A small generated image (no bundled photos needed) for attachment presets.
    static func sampleImage(hue: CGFloat) -> Data {
      let renderer = UIGraphicsImageRenderer(size: CGSize(width: 240, height: 240))
      return renderer.pngData { context in
        UIColor(hue: hue, saturation: 0.45, brightness: 0.85, alpha: 1).setFill()
        context.fill(CGRect(x: 0, y: 0, width: 240, height: 240))
        UIColor(hue: hue, saturation: 0.6, brightness: 0.55, alpha: 1).setFill()
        context.cgContext.fillEllipse(in: CGRect(x: 60, y: 60, width: 120, height: 120))
      }
    }
  }
#endif
