import AVFoundation
import AnkielKit
import Foundation
import Speech

/// On-device dictation with iOS 26's `SpeechAnalyzer` and `SpeechTranscriber` (locale and model
/// handling from RN's `AppleSpeechEngine.swift`; live, volatile results instead of a finished
/// file). Audio never leaves the device. A phone call, a lost headset or the media services
/// resetting ends the session and keeps what was heard.
actor AppleDictationEngine: DictationEngine {
  private var audio: AVAudioEngine?
  private var analyzer: SpeechAnalyzer?
  private var input: AsyncStream<AnalyzerInput>.Continuation?
  private var output: AsyncThrowingStream<DictationEvent, any Error>.Continuation?
  private var results: Task<Void, Never>?
  private var observers: [any NSObjectProtocol] = []

  // MARK: Locale and model

  private func supported(_ locales: [String]) async -> Locale? {
    for identifier in locales {
      if let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: identifier)) { return locale }
    }
    return nil
  }

  private static func transcriber(_ locale: Locale) -> SpeechTranscriber {
    SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [.volatileResults], attributeOptions: [])
  }

  func availability(_ locales: [String]) async -> DictationAvailability {
    guard SpeechTranscriber.isAvailable else { return .unavailable }
    guard let locale = await supported(locales) else { return .unsupportedLanguage }
    let id = locale.identifier(.bcp47)
    switch await AssetInventory.status(forModules: [Self.transcriber(locale)]) {
    case .installed: return .ready(locale: id)
    case .supported, .downloading: return .needsDownload(locale: id)
    case .unsupported: return .unsupportedLanguage
    @unknown default: return .unavailable
    }
  }

  func prepare(_ locales: [String], progress: @escaping @Sendable (Double) -> Void) async throws(DictationFailure) -> String {
    guard SpeechTranscriber.isAvailable else { throw .unavailable }
    guard let locale = await supported(locales) else { throw .unsupportedLanguage }
    let transcriber = Self.transcriber(locale)
    do {
      if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
        let watch = Task {
          while !Task.isCancelled {
            progress(request.progress.fractionCompleted)
            try? await Task.sleep(for: .milliseconds(250))
          }
        }
        defer { watch.cancel() }
        try await request.downloadAndInstall()
        progress(1)
      }
    } catch {
      throw .downloadFailed(error.localizedDescription)
    }
    return locale.identifier(.bcp47)
  }

  // MARK: Listening

  func start(locale identifier: String) async throws(DictationFailure) -> AsyncThrowingStream<DictationEvent, any Error> {
    await stopAll()
    let locale = Locale(identifier: identifier)
    let transcriber = Self.transcriber(locale)
    let session = AVAudioSession.sharedInstance()
    if let failure = Self.configureSession() { throw .startFailed(failure) }
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
      throw .startFailed("No audio format for this language.")
    }
    let (inputs, input) = AsyncStream<AnalyzerInput>.makeStream()
    let (events, output) = AsyncThrowingStream<DictationEvent, any Error>.makeStream()
    let audio = AVAudioEngine()
    let node = audio.inputNode
    let source = node.outputFormat(forBus: 0)
    guard source.sampleRate > 0, let converter = AVAudioConverter(from: source, to: format) else {
      throw .startFailed("The microphone is not available.")
    }
    node.installTap(onBus: 0, bufferSize: 2048, format: source, block: Self.tap(converter: converter, target: format, input: input, output: output))
    do {
      try await analyzer.start(inputSequence: inputs)
      audio.prepare()
      try audio.start()
    } catch {
      node.removeTap(onBus: 0)
      await analyzer.cancelAndFinishNow()
      throw .startFailed(error.localizedDescription)
    }
    self.audio = audio
    self.analyzer = analyzer
    self.input = input
    self.output = output
    results = Task {
      var settled = ""
      do {
        for try await result in transcriber.results {
          let text = String(result.text.characters)
          if result.isFinal {
            settled = DictationTextJoin.append(settled, text)
            output.yield(.text(final: settled, volatile: ""))
          } else {
            output.yield(.text(final: settled, volatile: text))
          }
        }
        output.finish()
      } catch {
        output.finish(throwing: DictationFailure.transcriptionFailed(error.localizedDescription))
      }
    }
    observe(session)
    return events
  }

  /// Recording for dictation: other audio ducks, Bluetooth headsets' microphones are allowed.
  /// Returns why it failed, or nil.
  nonisolated static func configureSession() -> String? {
    let session = AVAudioSession.sharedInstance()
    do {
      try session.setCategory(.record, mode: .measurement, options: [.duckOthers, .allowBluetoothHFP])
      try session.setActive(true, options: .notifyOthersOnDeactivation)
      return nil
    } catch {
      return error.localizedDescription
    }
  }

  /// Built outside the actor: the tap runs on the audio thread. Converts each buffer to the
  /// analyzer's format and reports the level only when it crosses a step.
  private nonisolated static func tap(
    converter: AVAudioConverter, target: AVAudioFormat, input: AsyncStream<AnalyzerInput>.Continuation,
    output: AsyncThrowingStream<DictationEvent, any Error>.Continuation
  ) -> AVAudioNodeTapBlock {
    let last = LevelMemory()
    return { buffer, _ in
      if let channel = buffer.floatChannelData?[0] {
        let step = DictationLevel.step(decibels: DictationLevel.decibels(UnsafeBufferPointer(start: channel, count: Int(buffer.frameLength))))
        if step != last.value {
          last.value = step
          output.yield(.level(step))
        }
      }
      let ratio = target.sampleRate / buffer.format.sampleRate
      let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 1
      guard let converted = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
      let fed = FedFlag()
      var error: NSError?
      converter.convert(to: converted, error: &error) { _, status in
        if fed.value {
          status.pointee = .noDataNow
          return nil
        }
        fed.value = true
        status.pointee = .haveData
        return buffer
      }
      if error == nil, converted.frameLength > 0 { input.yield(AnalyzerInput(buffer: converted)) }
    }
  }

  func finish() async {
    guard let analyzer else { return }
    stopAudio()
    input?.finish()
    input = nil
    do {
      try await analyzer.finalizeAndFinishThroughEndOfInput()
    } catch {
      await analyzer.cancelAndFinishNow()
    }
    await results?.value
    await stopAll()
  }

  func cancel() async {
    await stopAll()
  }

  private func stopAudio() {
    audio?.inputNode.removeTap(onBus: 0)
    audio?.stop()
    audio = nil
  }

  private func stopAll() async {
    stopAudio()
    input?.finish()
    input = nil
    if let analyzer { await analyzer.cancelAndFinishNow() }
    analyzer = nil
    results?.cancel()
    results = nil
    output?.finish()
    output = nil
    for observer in observers { NotificationCenter.default.removeObserver(observer) }
    observers = []
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }

  // MARK: Interruptions

  private func observe(_ session: AVAudioSession) {
    let center = NotificationCenter.default
    observers = [
      center.addObserver(forName: AVAudioSession.interruptionNotification, object: session, queue: nil) { [weak self] note in
        let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
        guard raw.flatMap(AVAudioSession.InterruptionType.init) == .began else { return }
        Task { await self?.finish() }
      },
      center.addObserver(forName: AVAudioSession.routeChangeNotification, object: session, queue: nil) { [weak self] note in
        let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
        // The headset in use went away: stop rather than switch to the speakerphone's mic.
        guard raw.flatMap(AVAudioSession.RouteChangeReason.init) == .oldDeviceUnavailable else { return }
        Task { await self?.finish() }
      },
      center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: nil) { [weak self] _ in
        Task { await self?.finish() }
      },
    ]
  }
}

/// The last level step, read and written only on the audio thread.
private nonisolated final class LevelMemory: @unchecked Sendable {
  var value = -1
}

/// One buffer per conversion call, on the audio thread.
private nonisolated final class FedFlag: @unchecked Sendable {
  var value = false
}

nonisolated enum DictationTextJoin {
  static func append(_ settled: String, _ text: String) -> String {
    let piece = text.trimmingCharacters(in: .whitespaces)
    guard !piece.isEmpty else { return settled }
    return settled.isEmpty ? piece : settled + " " + piece
  }
}

/// Microphone permission through `AVAudioApplication`.
enum MicrophonePermission {
  static var current: MicrophoneAccess {
    switch AVAudioApplication.shared.recordPermission {
    case .granted: .granted
    case .denied: .denied
    default: .undetermined
    }
  }

  /// Asks when undetermined; otherwise returns the answer already given.
  static func request() async -> MicrophoneAccess {
    if current == .undetermined {
      return await AVAudioApplication.requestRecordPermission() ? .granted : .denied
    }
    return current
  }
}
