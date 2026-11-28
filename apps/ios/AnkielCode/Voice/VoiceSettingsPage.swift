import AnkielKit
import SwiftUI

/// Settings → Voice (RN `SettingsVoiceRouteScreen`, on-device path only): where dictation is
/// transcribed, the language and whether its speech model is on this device, and microphone
/// access. Transcribing on a computer or with a cloud provider is not in this app yet.
struct VoiceSettingsPage: View {
  @Environment(\.scenePhase) private var scenePhase
  @State private var availability: DictationAvailability?
  @State private var access = VoiceInput.access
  @State private var download: Double?
  @State private var downloadFailed = false

  var body: some View {
    ThemedList {
      Section {
        Label {
          VStack(alignment: .leading, spacing: Spacing.xxs) {
            Text("This device")
              .foregroundStyle(Palette.textPrimary)
            Text("Audio stays on this device and is transcribed here.")
              .font(Typography.footnote)
              .foregroundStyle(Palette.textSecondary)
          }
        } icon: {
          Image(systemName: "checkmark")
            .foregroundStyle(Palette.accent)
        }
        .accessibilityAddTraits(.isSelected)
      } header: {
        Text("Transcribe on")
      } footer: {
        Text("Sending recordings to a computer or a cloud provider for transcription is not available in this app yet.")
      }

      Section {
        LabeledContent {
          Text(languageName)
        } label: {
          Text("Language")
        }
        LabeledContent {
          modelStatus
        } label: {
          Text("Speech model")
        }
        .accessibilityIdentifier("voice.model")
        if case .needsDownload = availability {
          if let download {
            ProgressView(value: download) {
              Text("Downloading speech model")
            }
          } else {
            Button("Download now", systemImage: "arrow.down.circle") { startDownload() }
              .accessibilityIdentifier("voice.download")
          }
        }
      } footer: {
        if downloadFailed {
          Text("Voice transcription could not prepare this language.")
        } else if availability == .unavailable {
          Text("Dictation on this device needs iOS 26 or later, a supported device, and a supported language. Your keyboard’s dictation is separate.")
        } else {
          Text("Dictation listens in the app’s language. Change it in the Settings app under Ankiel Code → Language.")
        }
      }

      if access != .granted {
        Section {
          Button(access == .undetermined ? "Allow microphone access" : "Open Settings", systemImage: "mic") {
            if access == .undetermined {
              Task { access = await VoiceInput.requestAccess() }
            } else {
              VoiceInput.openSystemSettings()
            }
          }
          .accessibilityIdentifier("voice.microphone")
        } header: {
          Text("Microphone access")
        } footer: {
          Text(access == .undetermined
            ? "Allow microphone access to dictate messages."
            : "Turn on microphone access for Ankiel Code in Settings to use voice input.")
        }
      }
    }
    .navigationTitle("Voice")
    .navigationBarTitleDisplayMode(.inline)
    .task { await refresh() }
    .onChange(of: scenePhase) { _, phase in
      if phase == .active { Task { await refresh() } }
    }
  }

  private var languageName: String {
    let id: String? =
      switch availability {
      case .ready(let locale), .needsDownload(let locale): locale
      default: VoiceInput.languages.first
      }
    guard let id else { return "" }
    return Locale.current.localizedString(forIdentifier: id) ?? id
  }

  @ViewBuilder private var modelStatus: some View {
    switch availability {
    case nil: ProgressView()
    case .ready: Text("On this device")
    case .needsDownload: Text("Not downloaded")
    case .unsupportedLanguage: Text("Not supported")
    case .unavailable: Text("Unavailable")
    }
  }

  private func refresh() async {
    access = VoiceInput.access
    availability = await VoiceInput.engine.availability(VoiceInput.languages)
  }

  private func startDownload() {
    download = 0
    downloadFailed = false
    Task {
      do {
        _ = try await VoiceInput.engine.prepare(VoiceInput.languages) { value in
          Task { @MainActor in download = value }
        }
      } catch {
        downloadFailed = true
      }
      download = nil
      await refresh()
    }
  }
}
