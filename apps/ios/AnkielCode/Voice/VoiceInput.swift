import AnkielKit
import Foundation
import UIKit

/// The app's one dictation, shared by every composer (one microphone, one session).
@MainActor
enum VoiceInput {
  static let dictation = Dictation(engine: engine, access: { await requestAccess() }, locales: { languages })

  #if DEBUG
    /// `ANKIEL_DEBUG_VOICE=listen|download|unsupported|unavailable|fail|interrupt|denied`: a
    /// scripted engine (the simulator has no microphone to drive); `denied` refuses the microphone.
    static let debugMode = ProcessInfo.processInfo.environment["ANKIEL_DEBUG_VOICE"]
  #endif

  static let engine: any DictationEngine = {
    #if DEBUG
      if let debugMode {
        return FakeDictationEngine(mode: FakeDictationEngine.Mode(rawValue: debugMode) ?? .listen)
      }
    #endif
    return AppleDictationEngine()
  }()

  /// The app's language first (it follows the per-app language in iOS Settings), then the
  /// device's languages, so dictation listens for the language the app is shown in.
  static var languages: [String] {
    var seen: Set<String> = []
    return (Bundle.main.preferredLocalizations + Locale.preferredLanguages).filter { seen.insert($0).inserted }
  }

  static var access: MicrophoneAccess {
    #if DEBUG
      if debugMode == "denied" { return .denied }
    #endif
    return MicrophonePermission.current
  }

  static func requestAccess() async -> MicrophoneAccess {
    #if DEBUG
      if debugMode == "denied" { return .denied }
      if debugMode != nil { return .granted }
    #endif
    return await MicrophonePermission.request()
  }

  #if DEBUG
    /// `ANKIEL_DEBUG_AUDIO_SESSION=1` tries the engine's audio session setup and prints the result
    /// (the simulator has no on-device transcriber, but the session call itself runs).
    static func debugAudioSession() {
      guard ProcessInfo.processInfo.environment["ANKIEL_DEBUG_AUDIO_SESSION"] == "1" else { return }
      print("audio session: \(AppleDictationEngine.configureSession().map { "failed: \($0)" } ?? "ok")")
    }
  #endif

  static func openSystemSettings() {
    if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
  }
}
