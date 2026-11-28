import AnkielKit
import SwiftUI

/// What one composer knows about where it sends: a thread (or the new-thread flow), its computer's
/// catalog, and the thread's current settings and runs.
struct ComposerTarget {
  var draftKey: String
  var environmentId: String?
  var environmentLabel: String?
  /// nil in the new-thread flow (the thread id is minted at send).
  var threadRef: ThreadRef?
  var providers: [ServerProvider] = []
  var settings = ServerSettings()
  /// The thread's own picks (nil for a new thread).
  var threadSelection: ModelSelection?
  var threadRuntimeMode: RuntimeMode?
  var threadInteractionMode: InteractionMode?
  /// A started thread keeps its provider (RN `threadAllowsProviderSwitch`).
  var lockedInstance: String?
  var activity = ThreadRunActivity.idle
  var connected = false
  /// `capabilities.threadStop`: stop with `thread.stop` instead of `run.interrupt`.
  var supportsThreadStop = false
  /// The project's default pick and the sticky pick, for a new thread.
  var projectDefault: ModelSelection?
  var canSend = true
  /// Where `@` searches: the thread's worktree, else its project's root.
  var fileContext: FileContext?
  /// `filesystem:read`: the session may search the computer's files.
  var canReadFiles = true
  /// `/clear` can arm a fresh session (`capabilities.freshContext` and a thread that has run).
  var offersFreshSession = false
  /// The thread has messages, so a provider's `/compact` has something to compact.
  var hasConversation = false

  static let newThreadKey = "new-thread"

  var isNewThread: Bool { threadRef == nil }
}

extension ComposerTarget {
  /// The pick the next message sends with.
  func selection(_ draft: ComposerDraft, sticky: ModelSelection?) -> ModelSelection? {
    if let pick = draft.modelSelection { return pick }
    if isNewThread {
      return ModelCatalog.newThreadSelection(
        draft: nil, projectDefault: projectDefault, sticky: sticky, providers: providers, settings: settings)
    }
    return threadSelection
  }

  func runtimeMode(_ draft: ComposerDraft, sticky: RuntimeMode?) -> RuntimeMode {
    draft.runtimeMode ?? threadRuntimeMode ?? (isNewThread ? sticky : nil) ?? settings.defaultRuntimeMode ?? .auto
  }

  var threadSettings: ComposerStore.ThreadSettings {
    .init(modelSelection: threadSelection, runtimeMode: threadRuntimeMode, interactionMode: threadInteractionMode)
  }
}

/// The thread composer's target, from the shell row, the open thread and the computer.
@MainActor
extension ComposerTarget {
  static func thread(_ ref: ThreadRef, detail: ThreadDetailModel?, model: AppModel) -> ComposerTarget {
    let environment = model.registry.environment(ref.environmentId)
    let shell = model.home.thread(ref)
    var target = ComposerTarget(draftKey: ref.key, environmentId: ref.environmentId, environmentLabel: environment?.label, threadRef: ref)
    target.providers = environment?.providers ?? []
    target.settings = environment?.settings ?? ServerSettings()
    target.threadSelection = shell?.modelSelection ?? detail?.state.threadSelection
    target.threadRuntimeMode = shell?.runtimeMode.known
    target.threadInteractionMode = shell?.interactionMode.known
    let started = shell.map { $0.latestRunId != nil || $0.latestUserMessageAt != nil } ?? (detail?.state.timeline.rows.isEmpty == false)
    target.lockedInstance = started ? target.threadSelection?.instanceId : nil
    target.activity = detail?.state.activity ?? .idle
    target.connected = model.composerSink?.canSend(to: ref.environmentId) ?? false
    target.supportsThreadStop = environment?.capabilities["threadStop"]?.boolValue == true
    target.canSend = environment?.allows("orchestration:operate") ?? true
    target.fileContext = threadFileContext(ref, projectId: detail?.state.projectId, registry: model.registry)
    target.canReadFiles = environment?.allows("filesystem:read") ?? true
    target.offersFreshSession = environment?.capabilities["freshContext"]?.boolValue == true && shell?.latestRunId != nil
    target.hasConversation = detail?.state.timeline.rows.isEmpty == false
    #if DEBUG
      if ThreadDebug.isFixture(ref) {
        target.environmentLabel = DebugCatalog.environmentLabel
        target.providers = DebugCatalog.providers
        target.threadSelection = target.threadSelection ?? ModelSelection(instanceId: "claudeAgent", model: "claude-opus-5-5")
        target.threadRuntimeMode = .auto
        target.lockedInstance = "claudeAgent"
        target.supportsThreadStop = true
        target.offersFreshSession = true
        target.fileContext = FileContext(environmentId: ref.environmentId, cwd: "/srv/dev/tidewise", threadId: ref.threadId, title: "tidewise")
        // Without the fake sink a fixture message would wait forever in the real outbox.
        target.canSend = model.isComposerFake
        target.connected = model.isComposerFake && (model.composerSink?.canSend(to: ref.environmentId) ?? false)
      }
    #endif
    return target
  }
}

/// What the composer does, shared by the thread screen and the new-thread flow.
@MainActor
struct ComposerActions {
  let model: AppModel
  let target: ComposerTarget

  var store: ComposerStore { model.composer }

  /// RN `selectThreadModel`: the pick waits in the draft; on a thread already on that provider it
  /// is applied at once, and the draft lets go once the thread shows it (`releaseAppliedPick`).
  func select(_ selection: ModelSelection) {
    let pick = store.memory.options.applying(to: selection)
    store.updateDraft(target.draftKey) { $0.modelSelection = pick }
    apply(pick)
  }

  func setOption(_ id: String, _ value: JSONValue, on selection: ModelSelection) {
    let next = ModelCatalog.setting(id, to: value, in: selection)
    store.remember(next)
    store.updateDraft(target.draftKey) { $0.modelSelection = next }
    apply(next)
  }

  func setRuntimeMode(_ mode: RuntimeMode) {
    store.updateDraft(target.draftKey) { $0.runtimeMode = mode }
  }

  private func apply(_ pick: ModelSelection) {
    guard let ref = target.threadRef, let sink = model.composerSink, sink.canSend(to: ref.environmentId),
      target.threadSelection?.instanceId == pick.instanceId, pick != target.threadSelection
    else { return }
    // On failure the pick stays in the draft and goes out with the next message.
    Task { _ = try? await sink.send(ThreadCommand(.setModelSelection(pick), threadId: ref.threadId), in: ref.environmentId) }
  }

  /// Drops the draft's pick once the thread itself carries it, so a later change from another
  /// client shows.
  func releaseAppliedPick() {
    guard let pick = store.draft(target.draftKey).modelSelection, pick == target.threadSelection else { return }
    store.updateDraft(target.draftKey) { $0.modelSelection = nil }
  }

  /// Stops the turn (§7.5): `thread.stop` when the server has it, else interrupts the active run.
  func stop() {
    guard let ref = target.threadRef, let sink = model.composerSink else { return }
    let action: ThreadAction
    if target.supportsThreadStop {
      action = .stop
    } else if let runId = target.activity.activeRunId {
      action = .interruptRun(runId: runId)
    } else {
      return
    }
    Task { _ = try? await sink.send(ThreadCommand(action, threadId: ref.threadId), in: ref.environmentId) }
  }

  /// A queued message: send it now (steer into the running turn, else start it), or remove it.
  func sendQueuedNow(_ queued: ThreadRunActivity.QueuedMessage) {
    guard let ref = target.threadRef, let sink = model.composerSink else { return }
    let action: ThreadAction =
      target.activity.activeRunId.map { .promoteQueuedRun(queuedRunId: queued.runId, targetRunId: $0) }
      ?? .startQueuedRun(runId: queued.runId)
    Task { _ = try? await sink.send(ThreadCommand(action, threadId: ref.threadId), in: ref.environmentId) }
  }

  func removeQueued(_ queued: ThreadRunActivity.QueuedMessage) {
    guard let ref = target.threadRef, let sink = model.composerSink else { return }
    Task { _ = try? await sink.send(ThreadCommand(.cancelQueuedRun(runId: queued.runId), threadId: ref.threadId), in: ref.environmentId) }
  }

  func editQueued(_ queued: ThreadRunActivity.QueuedMessage, text: String) {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let ref = target.threadRef, let sink = model.composerSink, !trimmed.isEmpty, trimmed != queued.text else { return }
    Task {
      _ = try? await sink.send(ThreadCommand(.editQueuedRun(runId: queued.runId, text: trimmed), threadId: ref.threadId), in: ref.environmentId)
    }
  }
}
