import AnkielKit
import SwiftUI

/// The saved computers (environments): status, route, retry, rename, remove, add another.
struct ComputersView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  @State private var adding = false

  var body: some View {
    @Bindable var model = model
    NavigationStack(path: $model.computersPath) {
      List {
        Section {
          ForEach(model.registry.environments) { environment in
            NavigationLink(value: environment.id) {
              ComputerRow(environment: environment)
            }
            .swipeActions(edge: .trailing) {
              Button("Retry", systemImage: "arrow.clockwise") { model.registry.retry(environment.id) }
                .tint(Palette.working)
            }
          }
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
            Button { adding = true } label: {
              Text("Add a computer").foregroundStyle(Palette.onAccent)
            }
            .buttonStyle(.glassProminent)
          }
        }
      }
      .navigationTitle("Computers")
      .navigationBarTitleDisplayMode(.inline)
      .navigationDestination(for: String.self) { id in
        if let environment = model.registry.environment(id) {
          ComputerDetailView(environment: environment)
        }
      }
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Done", systemImage: "xmark") { dismiss() }
        }
        ToolbarItem(placement: .primaryAction) {
          Button("Add a computer", systemImage: "plus") { adding = true }
        }
      }
      .sheet(isPresented: $adding) {
        PairingLinkView()
      }
    }
  }
}

private struct ComputerRow: View {
  let environment: EnvironmentModel

  var body: some View {
    HStack(spacing: Spacing.md) {
      ConnectionDot(status: environment.status)
      VStack(alignment: .leading, spacing: Spacing.xxs) {
        HStack(spacing: Spacing.sm) {
          Text(environment.label)
            .font(Typography.body.weight(.medium))
            .foregroundStyle(Palette.textPrimary)
            .lineLimit(1)
          if let route = environment.displayRoute {
            RouteBadge(kind: route.kind)
          }
        }
        Text(ConnectionPresentation.statusText(environment.status, host: environment.label))
          .font(Typography.footnote)
          .foregroundStyle(Palette.textSecondary)
          .lineLimit(2)
          .contentTransition(.opacity)
      }
    }
    .padding(.vertical, Spacing.xxs)
    .motion(Motion.micro, value: environment.status)
    .accessibilityElement(children: .combine)
  }
}

/// A small status dot: green connected, amber retrying, red blocked. Changes cross-fade once.
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

/// One computer: status and diagnosis, its routes, rename, retry and remove.
struct ComputerDetailView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  let environment: EnvironmentModel
  @State private var name = ""
  @State private var confirmingRemoval = false
  @FocusState private var editingName: Bool

  private var diagnosis: ConnectionDiagnosis? {
    guard !environment.status.isConnected else { return nil }
    return ConnectionDiagnosis(
      status: environment.status, host: environment.label, serverVersion: environment.record.serverVersion)
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
        Button("Retry now", systemImage: "arrow.clockwise") { model.registry.retry(environment.id) }
        if case .needsPairing = environment.status {
          Button("Pair again", systemImage: "qrcode.viewfinder") { model.sheet = .scanner }
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
                .textSelection(.enabled)
            }
            Spacer()
            if environment.activeRoute?.id == route.id {
              Text("In use")
                .font(Typography.footnote)
                .foregroundStyle(Palette.success)
            }
          }
        }
      } header: {
        Text("Addresses")
      } footer: {
        Text("Addresses the computer reports, such as its local network address, are tried first and checked before any credential is sent.")
      }

      Section {
        LabeledContent("Version", value: environment.record.serverVersion)
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
      } footer: {
        Text("Removing forgets this computer's sign-in and cached threads on this device. Nothing changes on the computer.")
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
        Task { await model.registry.remove(id) }
      }
    } message: {
      Text("You'll need a new pairing link to add it again.")
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
