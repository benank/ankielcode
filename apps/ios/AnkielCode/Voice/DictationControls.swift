import AnkielKit
import SwiftUI
import UIKit

/// The composer's microphone, beside send (RN `ComposerDictationStartAction`).
struct DictationMicButton: View {
  var disabled = false
  let start: () -> Void

  var body: some View {
    let dictation = VoiceInput.dictation
    Button(action: start) {
      Image(systemName: "mic")
        .font(Typography.subheadline.weight(.semibold))
        .foregroundStyle(disabled ? Palette.textTertiary : Palette.textPrimary)
        .frame(width: 34, height: 34)
        .frame(width: 44, height: 44)
        .contentShape(.circle)
    }
    .buttonStyle(.plain)
    .disabled(disabled || dictation.isBusy)
    .accessibilityLabel(Text("Start dictation"))
    .accessibilityIdentifier("composer.mic")
  }
}

/// Replaces the composer's toolbar while dictating: Cancel, the status (a stepped level meter
/// and the elapsed time, or what is being prepared), and Done (RN `ComposerDictationToolbar`).
struct DictationBar: View {
  let dictation: Dictation

  var body: some View {
    HStack(spacing: Spacing.sm) {
      Button {
        dictation.cancel()
      } label: {
        Image(systemName: "xmark")
          .font(Typography.subheadline.weight(.semibold))
          .foregroundStyle(Palette.textPrimary)
          .frame(width: 34, height: 34)
          .background(Palette.fill, in: .circle)
          .frame(width: 44, height: 44)
          .contentShape(.circle)
      }
      .buttonStyle(.plain)
      .accessibilityLabel(Text("Cancel dictation"))
      .accessibilityIdentifier("dictation.cancel")

      status
        .frame(maxWidth: .infinity)

      Button {
        dictation.finish()
      } label: {
        Image(systemName: "checkmark")
          .font(Typography.subheadline.weight(.bold))
          .foregroundStyle(canFinish ? Palette.onPrimaryButton : Palette.textTertiary)
          .frame(width: 34, height: 34)
          .background(canFinish ? Palette.primaryButton : Palette.fill, in: .circle)
          .frame(width: 44, height: 44)
          .contentShape(.circle)
      }
      .buttonStyle(.plain)
      .disabled(!canFinish)
      .accessibilityLabel(Text("Finish dictation"))
      .accessibilityIdentifier("dictation.done")
    }
    .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
  }

  private var canFinish: Bool { dictation.phase == .listening }

  @ViewBuilder private var status: some View {
    switch dictation.phase {
    case .preparing(let download?):
      VStack(spacing: Spacing.xxs) {
        Text("Downloading speech model")
          .font(Typography.footnote.weight(.medium))
          .foregroundStyle(Palette.textSecondary)
        ProgressView(value: download)
          .frame(maxWidth: 160)
      }
      .accessibilityElement(children: .combine)
      .accessibilityIdentifier("dictation.download")
    case .preparing:
      Text("Preparing", comment: "voice input status")
        .font(Typography.footnote.weight(.medium))
        .foregroundStyle(Palette.textSecondary)
    case .finishing:
      Text("Transcribing", comment: "voice input status")
        .font(Typography.footnote.weight(.medium))
        .foregroundStyle(Palette.textSecondary)
    default:
      HStack(spacing: Spacing.sm) {
        LevelMeter(level: dictation.level)
        Text(Self.time(dictation.elapsedSeconds))
          .font(Typography.footnote.weight(.medium).monospacedDigit())
          .foregroundStyle(Palette.textSecondary)
          .contentTransition(.numericText())
      }
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(Text("Recording \(Self.time(dictation.elapsedSeconds))"))
      .accessibilityIdentifier("dictation.status")
    }
  }

  static func time(_ seconds: Int) -> String {
    String(format: "%d:%02d", seconds / 60, seconds % 60)
  }
}

/// Five bars that move one step at a time when the level changes, and are still otherwise.
private struct LevelMeter: View {
  let level: Int

  var body: some View {
    HStack(spacing: 3) {
      ForEach(0..<DictationLevel.steps, id: \.self) { index in
        Capsule()
          .fill(index < level ? Palette.textPrimary : Palette.textTertiary.opacity(0.5))
          .frame(width: 3, height: 6 + CGFloat(min(index, 3)) * 3 + (index < level ? 4 : 0))
      }
    }
    .frame(height: 20)
    .motion(Motion.microFast, value: level)
    .accessibilityHidden(true)
  }
}

/// A dictation that could not start, with what to do about it.
struct DictationFailureNotice: View {
  let failure: DictationFailure
  let retry: () -> Void
  let dismiss: () -> Void

  var body: some View {
    HStack(spacing: Spacing.sm) {
      Text(message)
        .font(Typography.footnote)
        .foregroundStyle(Palette.textSecondary)
        .frame(maxWidth: .infinity, alignment: .leading)
      if case .microphoneDenied(canAsk: false) = failure {
        Button("Open Settings") { VoiceInput.openSystemSettings() }
          .font(Typography.footnote.weight(.semibold))
          .accessibilityIdentifier("dictation.openSettings")
      } else if retryable {
        Button("Try again", action: retry)
          .font(Typography.footnote.weight(.semibold))
      }
      Button(action: dismiss) {
        Image(systemName: "xmark")
          .font(Typography.caption.weight(.semibold))
          .foregroundStyle(Palette.textTertiary)
          .frame(width: 44, height: 44)
          .contentShape(.rect)
      }
      .buttonStyle(.plain)
      .accessibilityLabel(Text("Dismiss voice input error"))
    }
    .padding(.leading, Spacing.lg)
  }

  private var retryable: Bool {
    switch failure {
    case .unavailable, .unsupportedLanguage: false
    default: true
    }
  }

  private var message: String {
    switch failure {
    case .microphoneDenied(canAsk: true): String(localized: "Microphone access is required for voice input.")
    case .microphoneDenied(canAsk: false):
      String(localized: "Turn on microphone access for Ankiel Code in Settings to use voice input.")
    case .unavailable:
      String(
        localized:
          "Dictation on this device needs iOS 26 or later, a supported device, and a supported language. Your keyboard’s dictation is separate.")
    case .unsupportedLanguage: String(localized: "Voice transcription does not support any of your languages.")
    case .downloadFailed: String(localized: "Voice transcription could not prepare this language.")
    case .startFailed: String(localized: "Could not start voice recording.")
    case .interrupted, .transcriptionFailed: String(localized: "Voice transcription failed.")
    }
  }
}

/// Dictation's side effects for one composer: haptics on start and stop, the screen kept awake
/// while listening, and the session finished (text kept) when the composer goes away or the
/// app leaves the foreground.
struct DictationLifecycle: ViewModifier {
  let draftKey: String
  @Environment(\.scenePhase) private var scenePhase

  func body(content: Content) -> some View {
    let dictation = VoiceInput.dictation
    let listening = dictation.owner == draftKey && dictation.phase == .listening
    content
      .sensoryFeedback(trigger: listening) { _, now in now ? .start : .stop }
      .onChange(of: listening) { _, now in UIApplication.shared.isIdleTimerDisabled = now }
      .onChange(of: scenePhase) { _, phase in
        if phase == .background { dictation.finish(draftKey) }
      }
      .onDisappear { dictation.finish(draftKey) }
      .task { await dictation.checkSupport() }
  }
}
