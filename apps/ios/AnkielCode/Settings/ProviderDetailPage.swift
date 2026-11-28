import AnkielKit
import SwiftUI

/// One provider on one computer (RN `SettingsProviderAccountsRouteScreen` row, expanded): status,
/// version and update, the account, and which models it offers there. Read only: signing in, out
/// or switching accounts happens in web or desktop Settings, where the provider's sign-in runs.
struct ProviderDetailPage: View {
  @Environment(AppModel.self) private var model
  let environment: EnvironmentModel
  let instanceId: String
  @State private var revealed = false

  private var provider: ServerProvider? { environment.providers.first { $0.instanceId == instanceId } }

  var body: some View {
    ThemedList {
      if let provider {
        Section {
          LabeledContent("Status") {
            Text(ProviderCopy.status(provider))
              .foregroundStyle(ProviderCopy.tint(provider))
          }
          if provider.installed {
            LabeledContent("Version", value: provider.version ?? String(localized: "Version unknown"))
            if provider.isBehindLatest, let latest = provider.latestVersion {
              LabeledContent("Latest", value: latest)
            }
          }
          if let account = provider.authEmail ?? provider.authLabel {
            LabeledContent("Account") {
              Text(revealed || provider.authEmail == nil ? account : ProviderCopy.masked(account))
                .textSelection(.enabled)
                .contentTransition(.opacity)
            }
            .onTapGesture { revealed.toggle() }
            .accessibilityHint(revealed ? Text("Hides the account email") : Text("Reveals the account email"))
            .accessibilityAddTraits(.isButton)
          }
          if provider.authLabel != nil, provider.authEmail != nil {
            LabeledContent("Plan", value: provider.authLabel ?? "")
          }
        } footer: {
          if let note = provider.unavailableReason ?? provider.message {
            Text(note)
          } else if provider.isBehindLatest {
            Text("Update \(provider.label) on \(environment.label) to get the newest models and fixes.")
          }
        }

        let models = provider.models.filter { !$0.isLegacy }
        if !models.isEmpty {
          Section {
            ForEach(models) { item in
              ModelAvailabilityRow(
                model: item, hidden: environment.settings.hiddenModels[instanceId]?.contains(item.slug) == true,
                needsUpdate: provider.updateRequiredModelSlugs.contains(item.slug),
                isDefault: environment.settings.defaultModelSelection?.instanceId == instanceId
                  && environment.settings.defaultModelSelection?.model == item.slug)
            }
          } header: {
            Text("Models")
          } footer: {
            Text("Hidden models stay out of the model picker. Change which models show in web or desktop Settings.")
          }
        }

        if provider.authStatus != "authenticated", provider.installed, provider.enabled {
          Section {
          } footer: {
            Text("Configure a provider with in-app sign-in in web or desktop Settings.")
          }
        }
      } else {
        ContentUnavailableView("\(environment.label) no longer reports this provider.", systemImage: "person.crop.circle.badge.questionmark")
          .listRowBackground(Color.clear)
      }
    }
    .navigationTitle(provider?.label ?? String(localized: "Provider"))
    .navigationBarTitleDisplayMode(.inline)
    .refreshable { await model.usage.refresher.refresh([environment.id]) }
  }
}

private struct ModelAvailabilityRow: View {
  let model: ServerProviderModel
  let hidden: Bool
  let needsUpdate: Bool
  let isDefault: Bool

  var body: some View {
    HStack(spacing: Spacing.md) {
      VStack(alignment: .leading, spacing: Spacing.xxs) {
        Text(model.name)
          .foregroundStyle(hidden ? Palette.textSecondary : Palette.textPrimary)
        Text(verbatim: model.slug)
          .font(Typography.monoSmall)
          .foregroundStyle(Palette.textTertiary)
      }
      Spacer(minLength: Spacing.sm)
      if let badge {
        Text(badge)
          .font(Typography.caption.weight(.medium))
          .foregroundStyle(needsUpdate ? Palette.attention : Palette.textSecondary)
          .padding(.horizontal, Spacing.sm)
          .padding(.vertical, Spacing.xxs)
          .background(Palette.fill, in: .capsule)
          .fixedSize()
      }
    }
    .accessibilityElement(children: .combine)
  }

  private var badge: String? {
    if needsUpdate { return String(localized: "Needs update") }
    if isDefault { return String(localized: "Default", comment: "the default model badge") }
    if hidden { return String(localized: "Hidden") }
    return nil
  }
}

/// Provider status words shared by the list and the detail page.
enum ProviderCopy {
  static func status(_ provider: ServerProvider) -> String {
    if !provider.installed { return String(localized: "Not installed") }
    if !provider.enabled { return String(localized: "Turned off") }
    return switch provider.authStatus {
    case "authenticated": String(localized: "Signed in")
    case "unauthenticated": String(localized: "Not signed in")
    default: String(localized: "Installed")
    }
  }

  static func tint(_ provider: ServerProvider) -> Color {
    if !provider.installed || provider.authStatus == "unauthenticated" { return Palette.attention }
    return provider.authStatus == "authenticated" ? Palette.success : Palette.textSecondary
  }

  /// `h•••@example.com`: emails stay hidden until tapped (RN reveals them the same way).
  static func masked(_ account: String) -> String {
    guard let at = account.firstIndex(of: "@"), at > account.startIndex else { return account }
    return String(account[account.startIndex]) + "•••" + account[at...]
  }
}
