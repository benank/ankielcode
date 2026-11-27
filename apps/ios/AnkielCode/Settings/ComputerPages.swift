import AnkielKit
import SwiftUI

/// The saved computers as rows: status, route, swipe to retry. Shared by Settings' root and the
/// Computers page.
struct ComputerRows: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    ForEach(model.registry.environments) { environment in
      NavigationLink(value: SettingsRoute.computer(environment.id)) {
        ComputerRow(environment: environment)
      }
      .accessibilityIdentifier("settings.computer.\(environment.id)")
      .swipeActions(edge: .trailing) {
        if environment.isEnabled {
          Button("Retry", systemImage: "arrow.clockwise") { model.registry.retry(environment.id) }
            .tint(Palette.working)
        }
      }
    }
  }
}

/// Every saved computer, with Add (the page home's "Computers" links open).
struct ComputersPage: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    List {
      Section {
        ComputerRows()
      } footer: {
        if !model.registry.environments.isEmpty {
          Text("Ankiel Code keeps every saved computer connected and reconnects on its own.")
        }
      }
    }
    .overlay {
      if model.registry.environments.isEmpty {
        ContentUnavailableView {
          Label("No computers", systemImage: "desktopcomputer")
        } description: {
          Text("Add an environment to load projects and start coding sessions.")
        } actions: {
          Button { model.showPairingLink() } label: {
            Text("Add a computer").foregroundStyle(Palette.onAccent)
          }
          .buttonStyle(.glassProminent)
        }
      }
    }
    .navigationTitle("Computers")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .primaryAction) {
        Button("Add a computer", systemImage: "plus") { model.showPairingLink() }
      }
    }
  }
}

private struct ComputerRow: View {
  let environment: EnvironmentModel
  @Environment(\.dynamicTypeSize) private var typeSize

  var body: some View {
    HStack(spacing: Spacing.md) {
      ConnectionDot(status: environment.status)
      VStack(alignment: .leading, spacing: Spacing.xxs) {
        // At accessibility sizes the badge goes under the name so the name stays readable.
        let layout = typeSize.isAccessibilitySize
          ? AnyLayout(VStackLayout(alignment: .leading, spacing: Spacing.xxs)) : AnyLayout(HStackLayout(spacing: Spacing.sm))
        layout {
          Text(environment.label)
            .font(Typography.body.weight(.medium))
            .foregroundStyle(Palette.textPrimary)
            .lineLimit(typeSize.isAccessibilitySize ? 3 : 1)
          if environment.isEnabled, let route = environment.displayRoute {
            RouteBadge(kind: route.kind)
          }
        }
        Text(ConnectionPresentation.statusText(environment.status, host: environment.label))
          .font(Typography.footnote)
          .foregroundStyle(Palette.textSecondary)
          .lineLimit(typeSize.isAccessibilitySize ? 4 : 2)
          .contentTransition(.opacity)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .padding(.vertical, Spacing.xxs)
    .motion(Motion.micro, value: environment.status)
    .accessibilityElement(children: .combine)
  }
}

/// A small status dot: green connected, amber retrying, red blocked, gray off. Changes cross-fade once.
struct ConnectionDot: View {
  let status: ConnectionStatus

  var body: some View {
    Circle()
      .fill(ConnectionPresentation.tint(status))
      .frame(width: 9, height: 9)
      .motion(Motion.micro, value: status)
      .accessibilityHidden(true)
  }
}

struct RouteBadge: View {
  let kind: ConnectionRouteKind

  var body: some View {
    HStack(spacing: Spacing.xs) {
      Image(systemName: ConnectionPresentation.routeSymbol(kind))
        .imageScale(.small)
        .accessibilityHidden(true)
      Text(ConnectionPresentation.routeName(kind))
    }
    .font(Typography.caption.weight(.medium))
    .foregroundStyle(Palette.textSecondary)
    .padding(.horizontal, Spacing.sm)
    .padding(.vertical, Spacing.xxs)
    .background(Palette.fill, in: .capsule)
    .lineLimit(1)
    .fixedSize()
  }
}

/// One computer: status and diagnosis, on/off on this device, its name and addresses, this
/// device's permissions there, its Ankiel Code version and updates, and removal.
struct ComputerDetailView: View {
  @Environment(AppModel.self) private var model
  @Environment(PushCoordinator.self) private var push
  @Environment(\.dismiss) private var dismiss
  let environment: EnvironmentModel
  @State private var name = ""
  @State private var confirmingRemoval = false
  @FocusState private var editingName: Bool

  private var diagnosis: ConnectionDiagnosis? {
    guard environment.isEnabled, !environment.status.isConnected else { return nil }
    return ConnectionDiagnosis(
      status: environment.status, host: environment.label, serverVersion: environment.record.serverVersion)
  }

  private var enabled: Binding<Bool> {
    Binding(
      get: { environment.isEnabled },
      set: { on in
        let id = environment.id
        Task { await model.registry.setEnabled(id, on) }
      })
  }

  var body: some View {
    List {
      Section {
        HStack(alignment: .firstTextBaseline, spacing: Spacing.md) {
          ConnectionDot(status: environment.status)
          VStack(alignment: .leading, spacing: Spacing.xs) {
            Text(diagnosis?.headline ?? ConnectionPresentation.statusText(environment.status, host: environment.label))
              .font(Typography.headline)
              .foregroundStyle(Palette.textPrimary)
              .contentTransition(.opacity)
            if diagnosis != nil {
              Text(ConnectionPresentation.statusText(environment.status, host: environment.label))
                .font(Typography.footnote)
                .foregroundStyle(Palette.textSecondary)
            }
            if environment.status.attempt > 0 {
              Text("Retrying · attempt \(environment.status.attempt)")
                .font(Typography.footnote)
                .foregroundStyle(Palette.textTertiary)
                .contentTransition(.numericText())
            }
          }
        }
        .motion(Motion.micro, value: environment.status)
        .accessibilityElement(children: .combine)
        if environment.isEnabled, !environment.status.isConnected {
          Button("Retry now", systemImage: "arrow.clockwise") { model.registry.retry(environment.id) }
        }
        if case .needsPairing = environment.status {
          Button("Pair again", systemImage: "qrcode.viewfinder") { model.showScanner(updating: environment.id) }
            .accessibilityIdentifier("computer.pairAgain")
        }
        Toggle(isOn: enabled) {
          Text("Connect on this device")
        }
        .accessibilityIdentifier("computer.enabled")
      } footer: {
        if !environment.isEnabled {
          Text("This device doesn't connect to \(environment.label) or show its threads. Its sign-in stays saved.")
        }
      }

      if let diagnosis {
        DiagnosisSection(diagnosis: diagnosis, host: environment.label)
      }

      Section("Name") {
        TextField(text: $name, prompt: Text(environment.record.serverLabel)) { Text("Name") }
          .focused($editingName)
          .submitLabel(.done)
          .onSubmit { model.registry.rename(environment.id, to: name) }
          .onChange(of: editingName) { _, editing in
            if !editing { model.registry.rename(environment.id, to: name) }
          }
      }

      Section {
        ForEach(environment.record.routes, id: \.id) { route in
          HStack {
            VStack(alignment: .leading, spacing: Spacing.xxs) {
              RouteBadge(kind: route.kind)
              Text(PairingLinkView.displayAddress(route.endpoint))
                .font(Typography.monoSmall)
                .foregroundStyle(Palette.textSecondary)
                .lineLimit(1)
                .truncationMode(.middle)
                .textSelection(.enabled)
              if route.learned {
                Text("Found automatically")
                  .font(Typography.caption)
                  .foregroundStyle(Palette.textTertiary)
              }
            }
            Spacer()
            if environment.activeRoute?.id == route.id {
              Text("In use")
                .font(Typography.footnote)
                .foregroundStyle(Palette.success)
            }
          }
          .accessibilityElement(children: .combine)
        }
      } header: {
        Text("Addresses")
      } footer: {
        Text("Addresses the computer reports, such as its local network address, are tried first and checked before any credential is sent.")
      }

      if let scopes = environment.grantedScopes {
        PermissionsSection(scopes: scopes)
      }

      if environment.allows(AuthScope.accessRead) {
        Section {
          NavigationLink(value: SettingsRoute.access(environment.id)) {
            Label("Sharing & access", systemImage: "person.2.badge.key")
          }
          .accessibilityIdentifier("computer.access")
        } footer: {
          Text("The devices signed in to \(environment.label), and links to pair a new one.")
        }
      }

      ServerVersionSection(environment: environment)

      Section {
        if let connected = environment.record.lastConnectedAt {
          LabeledContent("Last connected") {
            Text(connected, format: .relative(presentation: .named))
          }
        }
        LabeledContent("Paired") {
          Text(environment.record.pairedAt, format: .dateTime.day().month().year())
        }
      }

      Section {
        Button("Remove \(environment.label)", systemImage: "trash", role: .destructive) {
          confirmingRemoval = true
        }
        .accessibilityIdentifier("computer.remove")
      } footer: {
        Text("Removing forgets this computer's sign-in and cached threads on this device. \(environment.label) keeps listing this device until you revoke it there.")
      }
    }
    .navigationTitle(environment.label)
    .navigationBarTitleDisplayMode(.inline)
    .onAppear { name = environment.record.customLabel ?? "" }
    .confirmationDialog(
      "Remove \(environment.label)?", isPresented: $confirmingRemoval, titleVisibility: .visible
    ) {
      Button("Remove", role: .destructive) {
        let id = environment.id
        dismiss()
        Task {
          await push.unregisterBeforeRemoval(id)
          await model.registry.remove(id)
        }
      }
    } message: {
      Text("You'll need a new pairing link to add it again.")
    }
  }
}

/// What this device may do on the computer (RN `EnvironmentRoutesSection` "Your permissions").
private struct PermissionsSection: View {
  let scopes: Set<String>
  @State private var expanded = false

  var body: some View {
    Section {
      DisclosureGroup(isExpanded: $expanded) {
        ForEach(AuthScope.grants, id: \.self) { scope in
          LabeledContent {
            Text(scopes.contains(scope) ? String(localized: "Allowed") : String(localized: "Not granted"))
              .foregroundStyle(scopes.contains(scope) ? Palette.textSecondary : Palette.textTertiary)
          } label: {
            Text(verbatim: scope).font(Typography.monoSmall)
          }
        }
      } label: {
        LabeledContent("Your permissions") {
          Text("\(AuthScope.grants.filter(scopes.contains).count) of \(AuthScope.grants.count)")
            .monospacedDigit()
        }
      }
    } footer: {
      Text("Set when the pairing link was made. To change them, pair again with a link that grants more.")
    }
  }
}

/// The computer's Ankiel Code version, the update check and, where the host can update itself,
/// the update (RN `SettingsEnvironmentDetailRouteScreen` "Ankiel Code" and
/// `OutdatedServerUpdateSection`).
private struct ServerVersionSection: View {
  @Environment(AppModel.self) private var model
  let environment: EnvironmentModel
  @State private var check: Check = .idle
  @State private var confirmingUpdate: String?

  enum Check: Equatable {
    case idle, checking
    case result(from: String, newer: String?)
    case failed(String)
  }

  private var version: String { environment.record.serverVersion }
  private var outdated: Bool {
    if case .incompatible(let failure) = environment.status, case .serverTooOld = failure.cause { return true }
    return false
  }
  private var canUpdate: Bool {
    environment.status.isConnected && environment.holds(AuthScope.environmentMaintain)
      && (environment.selfUpdateMethod == "boot-service" || environment.selfUpdateMethod == "respawn")
  }
  private var updating: Bool { if case .restarting = environment.serverUpdate { true } else { false } }

  var body: some View {
    Section {
      VStack(alignment: .leading, spacing: Spacing.xs) {
        Text("Version \(version)")
          .font(Typography.body)
          .foregroundStyle(Palette.textPrimary)
        if let line = statusLine {
          Text(line)
            .font(Typography.footnote)
            .foregroundStyle(statusIsError ? Palette.danger : Palette.textSecondary)
            .textSelection(.enabled)
            .contentTransition(.opacity)
        }
      }
      .padding(.vertical, Spacing.xxs)
      .motion(Motion.micro, value: statusLine)
      .accessibilityElement(children: .combine)

      Button {
        Task { await runCheck() }
      } label: {
        HStack {
          Label("Check for updates", systemImage: "arrow.clockwise")
          Spacer()
          if check == .checking { ProgressView() }
        }
      }
      .disabled(check == .checking || updating)
      .accessibilityIdentifier("computer.checkUpdates")

      if case .result(let from, let newer?) = check, from == version, canUpdate {
        Button("Update to \(newer)", systemImage: "arrow.up.circle") { confirmingUpdate = newer }
          .disabled(updating)
          .accessibilityIdentifier("computer.update")
      }
    } header: {
      Text(verbatim: "Ankiel Code")
    } footer: {
      if let footer { Text(footer) }
    }
    .confirmationDialog(
      "Update \(environment.label)?", isPresented: Binding(get: { confirmingUpdate != nil }, set: { if !$0 { confirmingUpdate = nil } }),
      titleVisibility: .visible, presenting: confirmingUpdate
    ) { target in
      Button("Update", role: .destructive) {
        let id = environment.id
        Task { await model.registry.updateServer(id, to: target) }
      }
    } message: { target in
      Text("Install Ankiel Code \(target). The server will restart and reconnect. Running threads may be interrupted.")
    }
  }

  private var statusLine: String? {
    switch environment.serverUpdate {
    case .restarting: return String(localized: "Restarting and reconnecting…")
    case .updated(let version): return String(localized: "Updated to \(version).")
    case .notUpdated(let version): return String(localized: "\(environment.label) came back still on \(version). Try again, or update it on that machine.")
    case .failed(let message): return message.isEmpty ? String(localized: "Update failed") : message
    case .idle: break
    }
    switch check {
    case .idle: return outdated ? String(localized: "This app needs a newer version of Ankiel Code on this machine.") : nil
    case .checking: return String(localized: "Checking…")
    case .result(_, let newer?): return String(localized: "Version \(newer) is available.")
    case .result(_, nil): return String(localized: "You are up to date.")
    case .failed(let message): return message
    }
  }

  private var statusIsError: Bool {
    if case .failed = check { return true }
    if case .failed = environment.serverUpdate { return true }
    return false
  }

  private var footer: String? {
    guard case .result(_, _?) = check, !canUpdate else { return nil }
    if environment.selfUpdateMethod == "desktop-managed" { return String(localized: "Update the desktop app on this machine.") }
    if !environment.status.isConnected { return String(localized: "Update and restart Ankiel Code on this machine.") }
    if !environment.holds(AuthScope.environmentMaintain) {
      return String(localized: "This connection does not have permission to manage the environment.")
    }
    return String(localized: "Update and restart Ankiel Code on this machine.")
  }

  private func runCheck() async {
    check = .checking
    let from = version
    do {
      check = .result(from: from, newer: try await model.releaseLookup.newerVersion(than: from))
    } catch {
      check = .failed(Self.describe(error))
    }
  }

  static func describe(_ failure: ReleaseLookup.Failure) -> String {
    switch failure {
    case .http(let status): String(localized: "Could not check releases (\(status)). Try again.")
    case .noRelease(let channel): String(localized: "No \(channel.rawValue) release was found.")
    case .unreadable, .unreachable: String(localized: "Could not check for updates.")
    }
  }
}

private struct DiagnosisSection: View {
  let diagnosis: ConnectionDiagnosis
  let host: String
  @State private var copied = false

  var body: some View {
    Section("What to try") {
      VStack(alignment: .leading, spacing: Spacing.xs) {
        ForEach(diagnosis.hops) { hop in
          HStack(spacing: Spacing.sm) {
            Image(systemName: symbol(hop.result))
              .font(.footnote.weight(.semibold))
              .foregroundStyle(hop.result == .failed ? Palette.danger : Palette.textTertiary)
              .frame(width: 16)
              .accessibilityHidden(true)
            Text(label(hop))
              .font(Typography.subheadline)
              .foregroundStyle(Palette.textSecondary)
          }
        }
      }
      ForEach(Array(diagnosis.steps.enumerated()), id: \.offset) { index, step in
        HStack(alignment: .firstTextBaseline, spacing: Spacing.sm) {
          Text("\(index + 1).")
            .font(Typography.subheadline.monospacedDigit())
            .foregroundStyle(Palette.textTertiary)
          Text(step)
            .font(Typography.subheadline)
            .foregroundStyle(Palette.textPrimary)
        }
      }
      Text(diagnosis.facts.map { "\($0.label): \($0.value)" }.joined(separator: "\n"))
        .font(Typography.monoSmall)
        .foregroundStyle(Palette.textSecondary)
        .textSelection(.enabled)
      Button(copied ? "Copied" : "Copy diagnostics", systemImage: copied ? "checkmark" : "doc.on.doc") {
        UIPasteboard.general.string = diagnosis.text(host: host)
        copied = true
      }
      .contentTransition(.symbolEffect(.replace))
      .sensoryFeedback(.success, trigger: copied) { _, new in new }
    }
  }

  private func symbol(_ result: ConnectionDiagnosis.HopResult) -> String {
    switch result {
    case .ok: "checkmark"
    case .failed: "xmark"
    case .unchecked: "minus"
    }
  }

  private func label(_ hop: ConnectionDiagnosis.Hop) -> String {
    switch hop.result {
    case .ok: hop.label
    case .failed: String(localized: "\(hop.label) · Failed", comment: "connection hop status")
    case .unchecked: String(localized: "\(hop.label) · Not checked")
    }
  }
}
