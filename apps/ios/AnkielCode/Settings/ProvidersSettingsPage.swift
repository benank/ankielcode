import AnkielKit
import SwiftUI

/// Each computer's coding agents as its server last reported them: installed, signed in, version
/// and models (RN `SettingsProviderAccountsRouteScreen`, read-only here).
struct ProvidersSettingsPage: View {
  @Environment(AppModel.self) private var model

  private var computers: [EnvironmentModel] { model.registry.environments.filter(\.isEnabled) }

  var body: some View {
    ThemedList {
      if computers.isEmpty {
        ContentUnavailableView("Select a connected environment.", systemImage: "desktopcomputer")
          .listRowBackground(Color.clear)
      }
      ForEach(computers) { computer in
        Section {
          let providers = computer.providers.filter { $0.enabled || $0.installed }
          if providers.isEmpty {
            Text(computer.hasConfig ? String(localized: "No providers reported.") : String(localized: "Connect to load models"))
              .font(Typography.subheadline)
              .foregroundStyle(Palette.textSecondary)
          }
          ForEach(providers) { provider in
            NavigationLink(value: SettingsRoute.provider(computer.id, provider.instanceId)) {
              ProviderRow(provider: provider)
            }
            .accessibilityIdentifier("providers.\(computer.id).\(provider.instanceId)")
          }
        } header: {
          HStack(spacing: Spacing.sm) {
            ConnectionDot(status: computer.status)
            Text(computer.label)
          }
        } footer: {
          if !computer.status.isConnected, !computer.providers.isEmpty {
            Text("As \(computer.label) reported them when it was last connected.")
          } else if model.usage.refresher.failed.contains(computer.id) {
            Text("Could not refresh \(computer.label). These are its last reported providers.")
          }
        }
      }
      if !computers.isEmpty {
        Section {
        } footer: {
          Text("Configure a provider with in-app sign-in in web or desktop Settings.")
        }
      }
    }
    .navigationTitle("Providers")
    .navigationBarTitleDisplayMode(.inline)
    // Re-probes every provider on each connected computer (`server.refreshProviders`).
    .refreshable { await model.usage.refresher.refresh(computers.filter(\.status.isConnected).map(\.id)) }
  }
}

private struct ProviderRow: View {
  let provider: ServerProvider

  var body: some View {
    VStack(alignment: .leading, spacing: Spacing.xs) {
      HStack(alignment: .firstTextBaseline) {
        Text(provider.label)
          .font(Typography.body.weight(.medium))
          .foregroundStyle(Palette.textPrimary)
        Spacer(minLength: Spacing.sm)
        Text(status)
          .font(Typography.footnote)
          .foregroundStyle(statusTint)
      }
      if let detail {
        Text(detail)
          .font(Typography.footnote)
          .foregroundStyle(Palette.textSecondary)
          .textSelection(.enabled)
      }
      if let note = provider.unavailableReason ?? provider.message {
        Text(note)
          .font(Typography.footnote)
          .foregroundStyle(Palette.textTertiary)
          .textSelection(.enabled)
      }
    }
    .padding(.vertical, Spacing.xxs)
    .accessibilityElement(children: .combine)
  }

  private var status: String { ProviderCopy.status(provider) }
  private var statusTint: Color { ProviderCopy.tint(provider) }

  /// Version (and the latest when behind), the account, and how many models it offers.
  private var detail: String? {
    var parts: [String] = []
    if provider.installed {
      let version = provider.version ?? String(localized: "Version unknown")
      if provider.isBehindLatest, let latest = provider.latestVersion {
        parts.append(String(localized: "\(version) · Latest \(latest)"))
      } else {
        parts.append(version)
      }
    }
    if let email = provider.authEmail { parts.append(ProviderCopy.masked(email)) } else if let label = provider.authLabel { parts.append(label) }
    let models = provider.models.filter { !$0.isLegacy }.count
    if models > 0 { parts.append(models == 1 ? String(localized: "1 model") : String(localized: "\(models) models")) }
    return parts.isEmpty ? nil : parts.joined(separator: " · ")
  }
}
