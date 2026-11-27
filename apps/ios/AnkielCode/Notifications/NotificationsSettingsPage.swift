import AnkielKit
import SwiftUI
import UIKit

/// Settings → Notifications (RN `SettingsNotificationsRouteScreen`): the switch, which alerts,
/// and whether each computer can deliver them.
struct NotificationsSettingsPage: View {
  @Environment(AppModel.self) private var model
  @Environment(PushCoordinator.self) private var push
  @Environment(\.openURL) private var openURL
  @State private var preparing = false

  private static let kinds: [(PushAlertKind, LocalizedStringResource)] = [
    (.completed, LocalizedStringResource("Finished", comment: "push alert kind: an agent finished its work")),
    (.failed, LocalizedStringResource("Failed", comment: "push alert kind: an agent's run failed")),
    (.approval, LocalizedStringResource("Needs approval", comment: "push alert kind")),
    (.input, LocalizedStringResource("Needs input", comment: "push alert kind")),
  ]

  var body: some View {
    List {
      Section {
        Toggle(isOn: enabled) {
          VStack(alignment: .leading, spacing: Spacing.xxs) {
            Text("Push notifications")
            Text("Get an alert when an agent finishes, fails or needs you.")
              .font(Typography.footnote)
              .foregroundStyle(Palette.textSecondary)
          }
        }
        .disabled(preparing)
        .accessibilityIdentifier("notifications.enabled")
      } footer: {
        if push.isEnabled, push.deviceStatus == .unavailable {
          Text("Push notifications aren't available in this build.")
        }
      }

      if push.permission == .denied {
        Section {
          Button {
            if let url = URL(string: UIApplication.openNotificationSettingsURLString) { openURL(url) }
          } label: {
            Label("Open notification settings", systemImage: "gearshape")
          }
          .accessibilityIdentifier("notifications.openSettings")
        } footer: {
          Text("Notifications are turned off for Ankiel Code in iOS Settings.")
        }
      }

      if push.isEnabled {
        Section {
          ForEach(Self.kinds, id: \.0) { kind, label in
            Toggle(isOn: kindBinding(kind)) { Text(label) }
              .accessibilityIdentifier("notifications.kind.\(kind.rawValue)")
          }
        } header: {
          Text("Alerts", comment: "settings section listing which push alerts to send")
        }

        if !model.registry.environments.isEmpty {
          Section {
            ForEach(model.registry.environments) { environment in
              ComputerPushRow(label: environment.label, state: push.state(environment))
            }
          } header: {
            Text("Computers")
          }
        }
      }

      Section {
      } footer: {
        Text(
          "Alerts are delivered through each computer's own Cloudflare relay, so a computer without a relay can't send them. They stay quiet for the thread you have open."
        )
      }
    }
    .navigationTitle("Notifications")
    .navigationBarTitleDisplayMode(.inline)
    .task(id: model.registry.environments.map { $0.activeRoute?.id }) {
      await push.refreshPermission()
      push.refreshStatuses()
    }
    .motion(Motion.microFast, value: push.isEnabled)
  }

  private var enabled: Binding<Bool> {
    Binding(
      get: { push.isEnabled },
      set: { on in
        preparing = true
        Task {
          await push.setEnabled(on)
          preparing = false
        }
      })
  }

  private func kindBinding(_ kind: PushAlertKind) -> Binding<Bool> {
    Binding(get: { push.preference.effectiveKinds.contains(kind) }, set: { push.setKind(kind, $0) })
  }
}

/// One computer and whether its alerts reach this phone.
private struct ComputerPushRow: View {
  let label: String
  let state: PushComputerState

  var body: some View {
    HStack(spacing: Spacing.md) {
      Image(systemName: "desktopcomputer")
        .font(.body)
        .foregroundStyle(Palette.textSecondary)
        .frame(width: 28)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: Spacing.xxs) {
        Text(label)
          .foregroundStyle(Palette.textPrimary)
        HStack(spacing: Spacing.xs) {
          Circle()
            .fill(tone)
            .frame(width: 7, height: 7)
            .accessibilityHidden(true)
          Text(detail)
            .font(Typography.footnote)
            .foregroundStyle(Palette.textSecondary)
            .contentTransition(.opacity)
        }
      }
    }
    .padding(.vertical, Spacing.xxs)
    .accessibilityElement(children: .combine)
  }

  private var detail: String {
    switch state {
    case .notConnected: String(localized: "Not connected", comment: "push notification status")
    case .checking: String(localized: "Checking…", comment: "push notification status")
    case .relayNotSetUp: String(localized: "Relay not set up on this computer")
    case .relayOffline: String(localized: "Relay offline")
    case .noPushKey: String(localized: "Relay has no push key")
    case .notRegisteredYet: String(localized: "Not registered yet", comment: "push notification status")
    case .on: String(localized: "On", comment: "push notification status")
    case .failed(let message?): message
    case .failed(nil): String(localized: "Couldn't read this computer's alert status.")
    }
  }

  private var tone: Color {
    switch state {
    case .on: Palette.success
    case .notConnected, .checking, .notRegisteredYet: Palette.textTertiary
    case .relayNotSetUp, .relayOffline, .noPushKey, .failed: Palette.attention
    }
  }
}

/// The one-time offer after the first new thread (presented over home).
struct PushOfferModifier: ViewModifier {
  @Environment(PushCoordinator.self) private var push

  func body(content: Content) -> some View {
    @Bindable var push = push
    content.alert("Get alerts from your agents?", isPresented: $push.offerVisible) {
      Button("Turn on") { Task { await push.setEnabled(true) } }
      Button("Not now", role: .cancel) {}
    } message: {
      Text("Ankiel Code can tell you when an agent finishes, fails or needs you. You can change this in Settings → Notifications.")
    }
  }
}
