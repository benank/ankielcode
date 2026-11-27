import Foundation
import Observation

/// What a speech engine reports while it listens.
public enum DictationEvent: Sendable, Hashable {
  /// The transcript so far: settled text, then the guess still being revised.
  case text(final: String, volatile: String)
  /// The input level, already stepped to `0...DictationLevel.steps`; sent only when it changes.
  case level(Int)
}

/// Whether this device can transcribe the language, before anything starts.
public enum DictationAvailability: Sendable, Hashable {
  case ready(locale: String)
  /// Supported, but the on-device model must be downloaded first.
  case needsDownload(locale: String)
  /// None of the user's languages is supported.
  case unsupportedLanguage
  /// No on-device transcription on this device or OS.
  case unavailable
}

public enum DictationFailure: Error, Sendable, Hashable {
  case microphoneDenied(canAsk: Bool)
  case unavailable
  case unsupportedLanguage
  case downloadFailed(String)
  case startFailed(String)
  case interrupted
  case transcriptionFailed(String)
}

/// On-device speech-to-text (Apple's `SpeechAnalyzer` in the app; a scripted fake in tests and
/// debug builds). One listening session at a time.
public protocol DictationEngine: Sendable {
  func availability(_ locales: [String]) async -> DictationAvailability
  /// Downloads the model when needed, reporting `0...1`; returns the locale it will use.
  func prepare(_ locales: [String], progress: @escaping @Sendable (Double) -> Void) async throws(DictationFailure) -> String
  /// Starts listening. The stream ends after `finish()` has delivered the last text, or throws.
  func start(locale: String) async throws(DictationFailure) -> AsyncThrowingStream<DictationEvent, any Error>
  /// Stops the microphone and settles what was heard.
  func finish() async
  /// Stops at once, dropping anything unsettled.
  func cancel() async
}

/// Microphone permission, behind a seam so the fake can deny it.
public enum MicrophoneAccess: Sendable, Hashable { case granted, undetermined, denied }

/// The app's one dictation (RN `VoiceInputController`, reworked for live text): the draft's text
/// when it started stays fixed, the transcript streams after it, and finishing commits once.
/// The field is frozen while it runs, so nothing else edits the draft underneath it.
@MainActor @Observable
public final class Dictation {
  public enum Phase: Sendable, Equatable {
    case idle
    /// Asking for access or loading the model; `download` is the model download's progress.
    case preparing(download: Double?)
    case listening
    /// Settling the last words after Done.
    case finishing
    case failed(DictationFailure)
  }

  public static let limit: Duration = .seconds(5 * 60)

  public private(set) var phase = Phase.idle
  /// The draft key that owns the session.
  public private(set) var owner: String?
  public private(set) var level = 0
  public private(set) var elapsedSeconds = 0
  /// Settled plus volatile transcript of the current session.
  public private(set) var transcript = ""
  public private(set) var locale: String?
  /// False once a check found no on-device transcription here; the microphone hides (RN).
  public private(set) var isSupported = true

  @ObservationIgnored private var checkedSupport = false

  @ObservationIgnored private let engine: any DictationEngine
  @ObservationIgnored private let access: @MainActor () async -> MicrophoneAccess
  @ObservationIgnored private let locales: @MainActor () -> [String]
  @ObservationIgnored private var base = ""
  @ObservationIgnored private var commit: ((String) -> Void)?
  @ObservationIgnored private var session: Task<Void, Never>?
  @ObservationIgnored private var timer: Task<Void, Never>?
  @ObservationIgnored private var generation = 0

  public init(
    engine: any DictationEngine, access: @escaping @MainActor () async -> MicrophoneAccess,
    locales: @escaping @MainActor () -> [String]
  ) {
    self.engine = engine
    self.access = access
    self.locales = locales
  }

  /// Checks once whether this device can transcribe at all.
  public func checkSupport() async {
    guard !checkedSupport else { return }
    checkedSupport = true
    isSupported = await engine.availability(locales()) != .unavailable
  }

  /// The session is using the microphone or settling (sending waits for it).
  public var isBusy: Bool {
    switch phase {
    case .preparing, .listening, .finishing: true
    case .idle, .failed: false
    }
  }

  public func isBusy(_ key: String) -> Bool { owner == key && isBusy }

  /// What the field shows for `key`: the draft, or while this key dictates, the draft it started
  /// from with the transcript so far.
  public func display(_ key: String, draft: String) -> String {
    guard owner == key, isBusy else { return draft }
    return DictationText.compose(base: base, transcript: transcript, locale: locale)
  }

  public func failure(_ key: String) -> DictationFailure? {
    guard owner == key, case .failed(let failure) = phase else { return nil }
    return failure
  }

  /// Starts dictating into `key`'s draft. `commit` receives the draft with the transcript once,
  /// when the session settles; a cancel or a failure leaves the draft as it was.
  public func start(_ key: String, draft: String, commit: @escaping (String) -> Void) {
    guard !isBusy else { return }
    generation += 1
    let current = generation
    owner = key
    base = draft
    transcript = ""
    level = 0
    elapsedSeconds = 0
    self.commit = commit
    phase = .preparing(download: nil)
    session = Task { await run(current) }
  }

  /// Done: stop listening and keep what was heard.
  public func finish() {
    switch phase {
    case .listening:
      phase = .finishing
      stopTimer()
      Task { await engine.finish() }
    case .preparing:
      cancel()
    default:
      break
    }
  }

  /// Ends `key`'s session, keeping its text (the composer leaving, the app backgrounding).
  public func finish(_ key: String) {
    guard owner == key else { return }
    finish()
  }

  public func cancel() {
    guard isBusy || phase != .idle else { return }
    generation += 1
    let wasListening = isBusy
    reset()
    if wasListening { Task { await engine.cancel() } }
  }

  /// Clears a failure shown under `key`'s composer.
  public func dismissFailure(_ key: String) {
    if failure(key) != nil { reset() }
  }

  private func reset() {
    session?.cancel()
    stopTimer()
    session = nil
    commit = nil
    owner = nil
    phase = .idle
    transcript = ""
    level = 0
  }

  private func run(_ current: Int) async {
    switch await access() {
    case .granted: break
    case .undetermined: return fail(.microphoneDenied(canAsk: true), current)
    case .denied: return fail(.microphoneDenied(canAsk: false), current)
    }
    guard current == generation else { return }
    let wanted = locales()
    switch await engine.availability(wanted) {
    case .unavailable: return fail(.unavailable, current)
    case .unsupportedLanguage: return fail(.unsupportedLanguage, current)
    case .needsDownload: phase = .preparing(download: 0)
    case .ready: break
    }
    let stream: AsyncThrowingStream<DictationEvent, any Error>
    do {
      let chosen = try await engine.prepare(wanted) { [weak self] value in
        Task { @MainActor in
          guard let self, current == self.generation, case .preparing = self.phase else { return }
          self.phase = .preparing(download: value)
        }
      }
      guard current == generation else { return }
      locale = chosen
      stream = try await engine.start(locale: chosen)
    } catch {
      return fail(error, current)
    }
    guard current == generation else {
      await engine.cancel()
      return
    }
    phase = .listening
    startTimer(current)
    do {
      for try await event in stream {
        guard current == generation else { return }
        switch event {
        case .text(let final, let volatile):
          transcript = DictationText.join(final, volatile)
        case .level(let step):
          if step != level { level = step }
        }
      }
      guard current == generation else { return }
      settle()
    } catch {
      guard current == generation else { return }
      // Whatever was heard before the interruption is still the user's.
      if !transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        settle()
      } else {
        fail(error as? DictationFailure ?? .transcriptionFailed(error.localizedDescription), current)
      }
    }
  }

  private func settle() {
    let heard = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
    let text = DictationText.compose(base: base, transcript: heard, locale: locale)
    let commit = commit
    reset()
    if !heard.isEmpty { commit?(text) }
  }

  private func fail(_ failure: DictationFailure, _ current: Int) {
    guard current == generation else { return }
    let key = owner
    reset()
    owner = key
    phase = .failed(failure)
  }

  private func startTimer(_ current: Int) {
    let start = ContinuousClock.now
    timer = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(1))
        guard let self, current == self.generation, !Task.isCancelled else { return }
        let elapsed = ContinuousClock.now - start
        self.elapsedSeconds = Int(elapsed.components.seconds)
        if elapsed >= Self.limit {
          self.finish()
          return
        }
      }
    }
  }

  private func stopTimer() {
    timer?.cancel()
    timer = nil
  }
}

/// Joining a transcript to the draft (RN `resolveTranscriptCommit`, for insertion at the end).
public enum DictationText {
  /// Languages written without spaces between words.
  static let spaceless: Set<String> = ["ja", "zh", "yue", "th", "lo", "km", "my"]

  public static func compose(base: String, transcript: String, locale: String?) -> String {
    let spoken = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !spoken.isEmpty else { return base }
    guard let last = base.last else { return spoken }
    let language = locale?.split(whereSeparator: { $0 == "-" || $0 == "_" }).first.map { $0.lowercased() } ?? ""
    if last.isWhitespace || spaceless.contains(language) { return base + spoken }
    return base + " " + spoken
  }

  static func join(_ final: String, _ volatile: String) -> String {
    let settled = final.trimmingCharacters(in: .whitespaces)
    let guess = volatile.trimmingCharacters(in: .whitespaces)
    if settled.isEmpty { return guess }
    if guess.isEmpty { return settled }
    return settled + " " + guess
  }
}

/// The input meter's steps (RN `normalizeVoiceInputDecibels`, then stepped so the meter only
/// redraws when the level crosses a step).
public enum DictationLevel {
  public static let steps = 5
  static let noiseFloor: Float = -60

  public static func step(decibels: Float) -> Int {
    guard decibels.isFinite, decibels > noiseFloor else { return 0 }
    if decibels >= 0 { return steps }
    let floor = powf(10, noiseFloor / 20)
    let amplitude = powf(10, decibels / 20)
    let normalized = sqrtf((amplitude - floor) / (1 - floor))
    return min(steps, max(0, Int((normalized * Float(steps)).rounded())))
  }

  /// Decibels from 32-bit float samples (root mean square).
  public static func decibels(_ samples: UnsafeBufferPointer<Float>) -> Float {
    guard !samples.isEmpty else { return -.infinity }
    var sum: Float = 0
    for sample in samples { sum += sample * sample }
    let rms = sqrtf(sum / Float(samples.count))
    return 20 * log10f(max(rms, .leastNonzeroMagnitude))
  }
}
