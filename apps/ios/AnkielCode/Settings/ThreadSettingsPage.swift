import AnkielKit
import SwiftUI

/// Which computers a server settings page reads and writes. One computer at a time, or every
/// connected one as an explicit bulk edit; an unavailable computer is never swapped for another.
enum SettingsScope: Hashable {
  case computer(String)
  case all
}

/// Defaults that live on each computer's server (RN Threads page: `SettingsServerControlsRouteScreen`
/// "threads" and `AutoSettleSettingsRows`).
struct ThreadSettingsPage: View {
  @Environment(AppModel.self) private var model
  @State private var scope: SettingsScope?
  @State private var failures: [SettingsWriteFailure] = []
  @State private var writes = 0

  private var computers: [EnvironmentModel] { model.registry.environments.filter(\.isEnabled) }

  private var resolvedScope: SettingsScope? {
    if let scope {
      if case .computer(let id) = scope, model.registry.environment(id) == nil { return nil }
      return scope
    }
    return (computers.first { $0.status.isConnected } ?? computers.first).map { .computer($0.id) }
  }

  /// The computers the page writes to.
  private var targets: [EnvironmentModel] {
    switch resolvedScope {
    case .computer(let id)?: model.registry.environment(id).map { [$0] } ?? []
    case .all?: computers.filter { $0.status.isConnected }
    case nil: []
    }
  }

  /// The computer whose values the page shows.
  private var reference: EnvironmentModel? { targets.first }
  private var settings: ServerSettings { reference?.effectiveSettings ?? ServerSettings() }
  private var canWrite: Bool { !targets.isEmpty && targets.allSatisfy(\.canWriteSettings) }

  var body: some View {
    List {
      if computers.count > 1 || resolvedScope == nil {
        Section {
          Picker("Computer", selection: Binding(get: { resolvedScope }, set: { scope = $0 })) {
            ForEach(computers) { computer in
              Text(computer.label).tag(Optional(SettingsScope.computer(computer.id)))
            }
            if computers.count > 1 {
              Text("All connected computers").tag(Optional(SettingsScope.all))
            }
          }
          .accessibilityIdentifier("threads.scope")
        } footer: {
          if resolvedScope == .all {
            Text("Changes here are written to every connected computer now. Computers that are offline keep their own values.")
          }
        }
      }

      if let notice {
        Section {
          Text(notice)
            .font(Typography.subheadline)
            .foregroundStyle(Palette.textSecondary)
        }
      }

      if let reference, reference.hasConfig {
        permissionsSection
        usageLimitsSection
        autoSettleSection
        if let differing, !differing.isEmpty {
          Section("Across computers") {
            Text("\(differing.map(\.label).formatted(.list(type: .and))) use different values. These rows show \(reference.label).")
              .font(Typography.footnote)
              .foregroundStyle(Palette.textSecondary)
          }
        }
      }
    }
    .navigationTitle(Text("Threads", comment: "settings page title"))
    .navigationBarTitleDisplayMode(.inline)
    .sensoryFeedback(.selection, trigger: writes)
    .alert(
      "Could not save settings", isPresented: Binding(get: { !failures.isEmpty }, set: { if !$0 { failures = [] } })
    ) {
      Button("OK", role: .cancel) {}
    } message: {
      Text(failures.map { "\($0.label): \(Self.describe($0.error))" }.joined(separator: "\n\n"))
    }
  }

  // MARK: Sections

  private var permissionsSection: some View {
    Section {
      ChoiceRows(selection: write(\.defaultRuntimeMode, default: .approvalRequired) { .defaultRuntimeMode($0) }, options: Self.runtimeModes)
        .disabled(!canWrite)
    } header: {
      Text("Default permissions")
    } footer: {
      Text("New threads start with these permissions. You can change them for one thread from its composer.")
    }
  }

  private var usageLimitsSection: some View {
    Section("Usage limits") {
      Toggle(isOn: write(\.autoResumeLimitedThreads) { .autoResumeLimitedThreads($0) }) {
        SettingText(
          "Resume after usage limits",
          "Automatically resume threads when their usage limits reset. You can cancel auto-resume in each thread.")
      }
      Toggle(isOn: write(\.snoozeLimitedThreads) { .snoozeLimitedThreads($0) }) {
        SettingText(
          "Snooze until limits reset",
          "Snooze threads until their usage limits reset. Enable auto-resume to continue the agent after the reset.")
      }
    }
    .disabled(!canWrite)
  }

  private var autoSettleSection: some View {
    Section {
      Toggle("Auto-settle merged threads", isOn: write(\.autoSettleOnMerge) { .autoSettleOnMerge($0) })
      Toggle(
        "Auto-settle inactive threads",
        isOn: Binding(
          get: { settings.autoSettleAfterDays != nil },
          set: { on in send(.autoSettleAfterDays(on ? ServerSettings.defaultAutoSettleDays : nil)) }))
      if let days = settings.autoSettleAfterDays {
        Stepper(
          value: Binding(get: { days }, set: { send(.autoSettleAfterDays($0)) }), in: ServerSettings.autoSettleDays
        ) {
          LabeledContent("Inactive days") {
            Text(days, format: .number)
              .monospacedDigit()
              .contentTransition(.numericText(value: Double(days)))
          }
        }
        .transition(.opacity)
      }
    } header: {
      Text("Auto-settle")
    } footer: {
      Text("Settled threads move to the Settled shelf. Nothing is deleted.")
    }
    .disabled(!canWrite)
    .motion(Motion.microSlow, value: settings.autoSettleAfterDays == nil)
  }

  // MARK: Writing

  private func write<Value>(
    _ key: KeyPath<ServerSettings, Value?>, default fallback: Value, _ patch: @escaping (Value) -> ServerSettingsPatch
  ) -> Binding<Value> {
    Binding(get: { settings[keyPath: key] ?? fallback }, set: { send(patch($0)) })
  }

  private func write(_ key: KeyPath<ServerSettings, Bool>, _ patch: @escaping (Bool) -> ServerSettingsPatch) -> Binding<Bool> {
    Binding(get: { settings[keyPath: key] }, set: { send(patch($0)) })
  }

  private func send(_ patch: ServerSettingsPatch) {
    let targets = targets
    writes += 1
    Task {
      let failed = await model.settingsWriter.write(patch, to: targets)
      if !failed.isEmpty { failures = failed }
    }
  }

  // MARK: Copy

  /// Why the rows are read-only, or nil when they can be changed.
  private var notice: String? {
    guard let reference else {
      return computers.isEmpty
        ? String(localized: "Add a computer to change its defaults.")
        : String(localized: "Connect a computer to change its defaults.")
    }
    if !reference.hasConfig {
      return String(localized: "Connect \(reference.label) to see and change its defaults.")
    }
    if targets.contains(where: { !$0.status.isConnected }) {
      return String(localized: "Connect \(reference.label) to manage it. These are the values it reported when it was last connected.")
    }
    if !canWrite {
      return String(localized: "This connection does not have permission to change settings on \(reference.label).")
    }
    return nil
  }

  /// With every computer selected: the ones whose values differ from the shown one.
  private var differing: [EnvironmentModel]? {
    guard resolvedScope == .all, let reference else { return nil }
    let shown = reference.effectiveSettings
    return targets.dropFirst().filter { target in
      let other = target.effectiveSettings
      return other.defaultRuntimeMode != shown.defaultRuntimeMode || other.autoSettleAfterDays != shown.autoSettleAfterDays
        || other.autoSettleOnMerge != shown.autoSettleOnMerge || other.autoResumeLimitedThreads != shown.autoResumeLimitedThreads
        || other.snoozeLimitedThreads != shown.snoozeLimitedThreads
    }
  }

  static let runtimeModes: [(RuntimeMode, LocalizedStringResource, LocalizedStringResource)] = [
    (.approvalRequired, "Supervised", "Ask before commands and file changes."),
    (.autoAcceptEdits, "Auto-accept edits", "Auto-approve edits, ask before other actions."),
    (.auto, "Auto", "Supported providers approve routine actions; others still ask."),
    (.fullAccess, "Full access", "Allow commands and edits without prompts."),
  ]

  static func describe(_ error: EnvironmentRequestError) -> String {
    switch error {
    case .notConnected: String(localized: "Not connected.")
    case .rejected(let message, _): message ?? String(localized: "The computer refused the change.")
    case .failed(let message): message
    }
  }
}

/// A setting's name with a sentence under it.
struct SettingText: View {
  let title: LocalizedStringResource
  let detail: LocalizedStringResource

  init(_ title: LocalizedStringResource, _ detail: LocalizedStringResource) {
    self.title = title
    self.detail = detail
  }

  var body: some View {
    VStack(alignment: .leading, spacing: Spacing.xxs) {
      Text(title)
      Text(detail)
        .font(Typography.footnote)
        .foregroundStyle(Palette.textSecondary)
    }
  }
}
