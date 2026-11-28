import Foundation
import Synchronization

#if DEBUG

/// A scripted engine: it "hears" `words` one at a time, revising each as volatile text first,
/// with a stepped level. For tests, and for debug builds (`ANKIEL_DEBUG_VOICE`) since the
/// simulator has no microphone to drive.
public final class FakeDictationEngine: DictationEngine {
  public enum Mode: String, Sendable {
    case listen, download, unsupported, unavailable, fail, interrupt
  }

  public let mode: Mode
  public let words: [String]
  public let interval: Duration
  private let state = Mutex<State>(State())

  private struct State {
    var continuation: AsyncThrowingStream<DictationEvent, any Error>.Continuation?
    var heard: [String] = []
    var finished = false
    var installed = false
  }

  public init(mode: Mode = .listen, words: [String] = FakeDictationEngine.sample, interval: Duration = .milliseconds(450)) {
    self.mode = mode
    self.words = words
    self.interval = interval
  }

  public static let sample = "Add a regression test for the midnight tide drift and check the harbor offset".split(separator: " ")
    .map(String.init)

  public func availability(_ locales: [String]) async -> DictationAvailability {
    let locale = locales.first ?? "en-US"
    switch mode {
    case .unsupported: return .unsupportedLanguage
    case .unavailable: return .unavailable
    case .download where !state.withLock(\.installed): return .needsDownload(locale: locale)
    default: return .ready(locale: locale)
    }
  }

  public func prepare(_ locales: [String], progress: @escaping @Sendable (Double) -> Void) async throws(DictationFailure) -> String {
    let locale = locales.first ?? "en-US"
    switch mode {
    case .unsupported: throw .unsupportedLanguage
    case .unavailable: throw .unavailable
    case .download where !state.withLock(\.installed):
      for step in 1...4 {
        try? await Task.sleep(for: interval)
        progress(Double(step) / 4)
      }
      state.withLock { $0.installed = true }
    default: break
    }
    return locale
  }

  public func start(locale: String) async throws(DictationFailure) -> AsyncThrowingStream<DictationEvent, any Error> {
    if mode == .fail { throw .startFailed("The microphone could not start.") }
    let (stream, continuation) = AsyncThrowingStream<DictationEvent, any Error>.makeStream()
    state.withLock {
      $0.continuation = continuation
      $0.heard = []
      $0.finished = false
    }
    let words = words
    let interval = interval
    let mode = mode
    Task { [self] in
      for (index, word) in words.enumerated() {
        try? await Task.sleep(for: interval)
        let done = self.state.withLock { state -> Bool in
          guard !state.finished, let continuation = state.continuation else { return true }
          continuation.yield(.level([2, 4, 3, 5, 1][index % 5]))
          continuation.yield(.text(final: state.heard.joined(separator: " "), volatile: word))
          state.heard.append(word)
          return false
        }
        if done { return }
        if mode == .interrupt, index == 2 {
          self.state.withLock { state in
            state.continuation?.finish(throwing: DictationFailure.interrupted)
            state.continuation = nil
          }
          return
        }
      }
    }
    return stream
  }

  public func finish() async {
    state.withLock { state in
      state.finished = true
      state.continuation?.yield(.text(final: state.heard.joined(separator: " "), volatile: ""))
      state.continuation?.finish()
      state.continuation = nil
    }
  }

  public func cancel() async {
    state.withLock { state in
      state.finished = true
      state.continuation?.finish()
      state.continuation = nil
    }
  }
}
#endif
