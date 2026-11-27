import AnkielKit
import SwiftUI

/// A computer's addresses in the order this device prefers them (RN `EnvironmentRoutesSection`):
/// which one is in use, reordering, adding one by hand and removing it again.
struct ComputerRoutesSection: View {
  @Environment(AppModel.self) private var model
  let environment: EnvironmentModel
  @State private var adding = false
  @State private var address = ""
  @State private var busy = false
  @State private var failure: String?
  @State private var removing: EnvironmentRoute?

  private var routes: [EnvironmentRoute] { RouteSelection.preference(environment.record.routes, order: environment.record.routeOrder) }

  var body: some View {
    Section {
      ForEach(Array(routes.enumerated()), id: \.element.id) { index, route in
        RouteRow(route: route, inUse: environment.activeRoute?.id == route.id)
          .contextMenu {
            if routes.count > 1 {
              if index > 0 {
                Button("Use first", systemImage: "arrow.up.to.line") { move(route, to: 0) }
                Button("Move up", systemImage: "arrow.up") { move(route, to: index - 1) }
              }
              if index < routes.count - 1 {
                Button("Move down", systemImage: "arrow.down") { move(route, to: index + 1) }
              }
            }
            Button("Copy address", systemImage: "doc.on.doc") {
              UIPasteboard.general.string = route.endpoint.httpBaseURL.absoluteString
            }
            if RouteSelection.canRemove(route) {
              Button("Remove", systemImage: "trash", role: .destructive) { removing = route }
            }
          }
          .swipeActions(edge: .trailing) {
            if RouteSelection.canRemove(route) {
              Button("Remove", role: .destructive) { removing = route }
            }
          }
          .accessibilityActions {
            if index > 0 { Button("Move up") { move(route, to: index - 1) } }
            if index < routes.count - 1 { Button("Move down") { move(route, to: index + 1) } }
          }
          .accessibilityIdentifier("computer.route.\(index)")
      }
      Button("Add address", systemImage: "plus") {
        address = ""
        adding = true
      }
      .disabled(busy)
      .accessibilityIdentifier("computer.addRoute")
    } header: {
      Text("Addresses")
    } footer: {
      Text("This device uses the first address that answers and moves back up the list when a higher one answers again, such as when you get home. Touch and hold an address to reorder it.")
    }
    .alert("Add address", isPresented: $adding) {
      TextField("Address", text: $address, prompt: Text(verbatim: "https://studio.example.com"))
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .keyboardType(.URL)
      Button("Cancel", role: .cancel) {}
      Button("Add") { add() }
    } message: {
      Text("Another address of \(environment.label), such as its VPN or tunnel address. It is checked before your sign-in is sent there.")
    }
    .alert("Could not add address", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
      Button("OK", role: .cancel) {}
    } message: {
      Text(failure ?? "")
    }
    .confirmationDialog(
      "Remove this address?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
      titleVisibility: .visible, presenting: removing
    ) { route in
      Button("Remove", role: .destructive) { model.registry.removeRoute(route.id, from: environment.id) }
    } message: { route in
      Text(PairingLinkView.displayAddress(route.endpoint))
    }
  }

  private func move(_ route: EnvironmentRoute, to index: Int) {
    var ids = routes.map(\.id)
    ids.removeAll { $0 == route.id }
    ids.insert(route.id, at: min(index, ids.count))
    model.registry.setRouteOrder(ids, for: environment.id)
  }

  private func add() {
    let input = address
    busy = true
    Task {
      do throws(AddRouteError) {
        _ = try await model.registry.addRoute(input, to: environment.id)
      } catch {
        failure = Self.describe(error, host: environment.label)
      }
      busy = false
    }
  }

  static func describe(_ error: AddRouteError, host: String) -> String {
    switch error {
    case .invalid: String(localized: "Enter an address such as https://studio.example.com or 192.168.1.20:3773.")
    case .loopback: String(localized: "A loopback address reaches this device, not \(host).")
    case .duplicate: String(localized: "\(host) already has this address.")
    case .cleartext:
      String(localized: "This address uses plain http outside your network, which would send your sign-in unencrypted. Use https.")
    case .mismatch: String(localized: "Another computer answers at this address, not \(host).")
    case .unreachable(let detail): String(localized: "Nothing answered at this address. \(detail)")
    }
  }
}

private struct RouteRow: View {
  let route: EnvironmentRoute
  let inUse: Bool

  var body: some View {
    HStack {
      VStack(alignment: .leading, spacing: Spacing.xxs) {
        RouteBadge(kind: route.kind)
        Text(PairingLinkView.displayAddress(route.endpoint))
          .font(Typography.monoSmall)
          .foregroundStyle(Palette.textSecondary)
          .lineLimit(1)
          .truncationMode(.middle)
          .textSelection(.enabled)
        if route.manual {
          Text("Added on this device")
            .font(Typography.caption)
            .foregroundStyle(Palette.textTertiary)
        } else if route.learned {
          Text("Found automatically")
            .font(Typography.caption)
            .foregroundStyle(Palette.textTertiary)
        }
      }
      Spacer()
      if inUse {
        Text("In use")
          .font(Typography.footnote)
          .foregroundStyle(Palette.success)
      }
    }
    .accessibilityElement(children: .combine)
  }
}

/// The computer's Cloudflare Relay as it reports it (RN `EnvironmentRelaySection`), read only:
/// setting up or disconnecting the relay changes the computer for every device, so that stays on
/// the computer. When the relay is up but this device has no address through it, one tap adds it.
struct ComputerRelaySection: View {
  @Environment(AppModel.self) private var model
  let environment: EnvironmentModel
  @State private var status: RelayStatus?
  @State private var failure: String?
  @State private var copied = false
  @State private var adding = false

  private var relayRoute: EnvironmentRoute? { environment.record.routes.first { $0.kind == .relay } }

  var body: some View {
    Section {
      VStack(alignment: .leading, spacing: Spacing.xs) {
        HStack {
          Text(verbatim: "Cloudflare Relay")
            .font(Typography.body.weight(.medium))
          Spacer()
          Text(stateText)
            .font(Typography.footnote.weight(.medium))
            .foregroundStyle(status?.connected == true ? Palette.success : Palette.textSecondary)
        }
        Text(description)
          .font(Typography.footnote)
          .foregroundStyle(Palette.textSecondary)
          .textSelection(.enabled)
        if let error = failure ?? (status?.connected == false ? status?.lastError : nil) {
          Text(error)
            .font(Typography.footnote)
            .foregroundStyle(Palette.danger)
            .textSelection(.enabled)
        }
        if status?.source == "env" {
          Text("Configured with environment variables on the computer.")
            .font(Typography.caption)
            .foregroundStyle(Palette.textTertiary)
        }
      }
      .padding(.vertical, Spacing.xxs)
      .accessibilityElement(children: .combine)
      .motion(Motion.micro, value: status)

      if let url = status?.publicBaseUrl, status?.connected == true {
        Button(copied ? "Copied" : "Copy relay address", systemImage: copied ? "checkmark" : "doc.on.doc") {
          UIPasteboard.general.string = url
          copied = true
        }
        .contentTransition(.symbolEffect(.replace))
        if relayRoute == nil {
          Button("Connect through the relay too", systemImage: "globe") { addRelayRoute(url) }
            .disabled(adding)
            .accessibilityIdentifier("computer.addRelayRoute")
        }
      }
    } header: {
      Text("Remote relay")
    } footer: {
      Text(footer)
    }
    .task(id: environment.status.isConnected) { await load() }
    .sensoryFeedback(.success, trigger: copied) { _, new in new }
  }

  private var stateText: String {
    guard let status else { return failure == nil ? String(localized: "Checking…") : "" }
    if status.connected { return String(localized: "Connected") }
    if status.configured { return String(localized: "Connecting…") }
    return String(localized: "Not set up")
  }

  private var description: String {
    guard let status else { return String(localized: "Loading…") }
    if status.connected, let url = status.publicBaseUrl { return url }
    if status.configured { return status.relayOrigin ?? String(localized: "Connecting to remote relay…") }
    return String(localized: "Connect a self-hosted Cloudflare Relay for remote and mobile access.")
  }

  private var footer: String {
    if relayRoute != nil {
      return String(localized: "This device can reach \(environment.label) through the relay when it is away from its network. Set up or change the relay on the computer.")
    }
    return String(localized: "Set up or change the relay on the computer.")
  }

  private func load() async {
    #if DEBUG
      if model.isSettingsFixture {
        status = RelayStatus(
          configured: true, connected: true, relayOrigin: "https://ankiel-relay.example.workers.dev",
          publicBaseUrl: "https://ankiel-relay.example.workers.dev/h/abcdefghijklmnopqrstuvwxyz/", source: "settings")
        return
      }
    #endif
    guard environment.status.isConnected else { return }
    do {
      status = try await model.registry.relayStatus(environment.id)
      failure = nil
    } catch {
      failure = ThreadSettingsPage.describe(error)
    }
  }

  private func addRelayRoute(_ url: String) {
    adding = true
    Task {
      do throws(AddRouteError) {
        _ = try await model.registry.addRoute(url, to: environment.id)
      } catch {
        failure = ComputerRoutesSection.describe(error, host: environment.label)
      }
      adding = false
    }
  }
}
