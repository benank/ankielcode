import AnkielKit
import CoreImage.CIFilterBuiltins
import SwiftUI

/// One computer's pairing links and signed-in devices (web Settings "Sharing & access"): who can
/// reach it, revoking another device, and a one-time link for a new one. Reading needs
/// `access:read`; changing anything needs `access:write`.
struct SharingAccessPage: View {
  @Environment(AppModel.self) private var model
  let environment: EnvironmentModel
  @State private var directory: AccessDirectory
  @State private var creating = false
  @State private var sharing: ShareTarget?
  @State private var inspecting: AccessClientSession?
  @State private var confirmingRevoke: RevokeTarget?
  @State private var failure: String?
  @State private var revokes = 0

  init(environment: EnvironmentModel, service: any AccessService) {
    self.environment = environment
    _directory = State(initialValue: AccessDirectory(service: service))
  }

  private var canWrite: Bool { environment.status.isConnected && environment.holds(AuthScope.accessWrite) }

  var body: some View {
    ThemedList {
      if let notice {
        Section {
          Text(notice)
            .font(Typography.subheadline)
            .foregroundStyle(Palette.textSecondary)
        }
      }
      if case .denied = directory.state {
      } else {
        linksSection
        devicesSection
      }
    }
    .navigationTitle("Sharing & access")
    .navigationBarTitleDisplayMode(.inline)
    .overlay {
      if directory.state == .loading, environment.status.isConnected {
        ProgressView()
      }
    }
    .onAppear {
      directory.start()
      #if DEBUG
        debugOpen()
      #endif
    }
    .onDisappear { directory.stop() }
    .onChange(of: directory.justCreated) { _, id in
      guard let id else { return }
      directory.justCreated = nil
      sharing = ShareTarget(id: id)
    }
    .sheet(isPresented: $creating) {
      CreatePairingLinkSheet(environment: environment, directory: directory)
    }
    .sheet(item: $sharing) { target in
      PairingShareSheet(environment: environment, directory: directory, linkId: target.id)
    }
    .sheet(item: $inspecting) { session in
      AccessSessionSheet(session: session, canWrite: canWrite) {
        inspecting = nil
        confirmingRevoke = .session(session)
      }
    }
    .confirmationDialog(
      confirmTitle, isPresented: Binding(get: { confirmingRevoke != nil }, set: { if !$0 { confirmingRevoke = nil } }),
      titleVisibility: .visible, presenting: confirmingRevoke
    ) { target in
      Button("Revoke", role: .destructive) { revoke(target) }
        .accessibilityIdentifier("access.confirmRevoke")
    } message: { target in
      switch target {
      case .session(let session):
        Text("\(session.displayName) is signed out of \(environment.label) and needs a new pairing link to come back.")
      case .link:
        Text("Nobody can pair with this link any more.")
      }
    }
    .alert("Could not change access", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
      Button("OK", role: .cancel) {}
    } message: {
      Text(failure ?? "")
    }
    .sensoryFeedback(.success, trigger: revokes)
  }

  // MARK: Sections

  private var linksSection: some View {
    Section {
      ForEach(directory.snapshot.openLinks(at: .now)) { link in
        Button {
          sharing = ShareTarget(id: link.id)
        } label: {
          PairingLinkRow(link: link, hasCode: directory.codes[link.id] != nil)
        }
        .tint(.primary)
        .disabled(directory.codes[link.id] == nil)
        .accessibilityIdentifier("access.link.\(link.id)")
        .swipeActions(edge: .trailing) {
          if canWrite {
            Button("Revoke", role: .destructive) { confirmingRevoke = .link(link) }
          }
        }
      }
      if canWrite {
        Button("Create pairing link", systemImage: "qrcode") { creating = true }
          .accessibilityIdentifier("access.createLink")
      }
    } header: {
      Text("Pairing links")
    } footer: {
      Text("A pairing link works once, for a few minutes. A link made on another device can only be shared from there.")
    }
  }

  private var devicesSection: some View {
    Section {
      ForEach(directory.snapshot.sortedSessions) { session in
        Button {
          inspecting = session
        } label: {
          AccessSessionRow(session: session)
        }
        .tint(.primary)
        .accessibilityIdentifier("access.session.\(session.sessionId)")
        .swipeActions(edge: .trailing) {
          if canWrite, !session.current {
            Button("Revoke", role: .destructive) { confirmingRevoke = .session(session) }
          }
        }
      }
    } header: {
      Text("Devices")
    } footer: {
      if canWrite {
        Text("Swipe a device to revoke it. Revoking signs it out; it needs a new pairing link to come back.")
      }
    }
  }

  // MARK: Actions

  private func revoke(_ target: RevokeTarget) {
    Task {
      do throws(EnvironmentRequestError) {
        switch target {
        case .session(let session): try await directory.revokeSession(session.sessionId)
        case .link(let link): try await directory.revokeLink(link.id)
        }
        revokes += 1
      } catch {
        failure = Self.describe(error)
      }
    }
  }

  private var confirmTitle: String {
    switch confirmingRevoke {
    case .session(let session)?: String(localized: "Revoke \(session.displayName)?")
    case .link?: String(localized: "Revoke this pairing link?")
    case nil: ""
    }
  }

  /// Why the page shows less than everything, or nil.
  private var notice: String? {
    if case .denied = directory.state {
      return String(localized: "This connection does not have permission to see who can access \(environment.label).")
    }
    if !environment.status.isConnected {
      return String(localized: "Connect \(environment.label) to see who can access it.")
    }
    if case .failed(let message) = directory.state {
      return message.isEmpty ? String(localized: "Could not read the access list.") : message
    }
    if !environment.holds(AuthScope.accessWrite), environment.grantedScopes != nil {
      return String(localized: "This connection can see access but not change it.")
    }
    return nil
  }

  static func describe(_ error: EnvironmentRequestError) -> String {
    switch error {
    case .notConnected: return String(localized: "Not connected.")
    case .rejected(let message, let tag):
      switch tag {
      case "EnvironmentOperationForbiddenError": return String(localized: "A device cannot revoke itself. Remove the computer on this device instead.")
      case "EnvironmentScopeRequiredError", "EnvironmentAuthorizationError":
        return String(localized: "This connection does not have permission to manage access.")
      default: return message ?? String(localized: "The computer refused the change.")
      }
    case .failed(let message): return message
    }
  }

  #if DEBUG
    private func debugOpen() {
      guard !AccessDebug.opened, let open = AccessDebug.open else { return }
      AccessDebug.opened = true
      switch open {
      case "create": creating = true
      case "share": Task { try? await directory.createLink(label: "Deck tablet", scopes: PairingScopes.readOnly) }
      default: break
      }
    }
  #endif

  struct ShareTarget: Identifiable {
    let id: String
  }

  enum RevokeTarget {
    case session(AccessClientSession)
    case link(AccessPairingLink)
  }
}

// MARK: - Rows

private struct PairingLinkRow: View {
  let link: AccessPairingLink
  let hasCode: Bool

  var body: some View {
    HStack(spacing: Spacing.md) {
      Image(systemName: "link")
        .font(Typography.body.weight(.medium))
        .foregroundStyle(Palette.textSecondary)
        .frame(width: 28)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: Spacing.xxs) {
        Text(link.label ?? String(localized: "Pairing link"))
          .font(Typography.body.weight(.medium))
          .foregroundStyle(Palette.textPrimary)
        TimelineView(.periodic(from: .now, by: 30)) { context in
          Text(AccessCopy.linkSummary(link, now: context.date))
            .font(Typography.footnote)
            .foregroundStyle(Palette.textSecondary)
        }
      }
      Spacer(minLength: Spacing.sm)
      if hasCode {
        Image(systemName: "qrcode")
          .foregroundStyle(Palette.accent)
          .accessibilityHidden(true)
      }
    }
    .padding(.vertical, Spacing.xxs)
    .accessibilityElement(children: .combine)
    .accessibilityHint(hasCode ? Text("Shows the link to scan or send") : Text("Made on another device"))
  }
}

private struct AccessSessionRow: View {
  let session: AccessClientSession

  var body: some View {
    HStack(spacing: Spacing.md) {
      Image(systemName: AccessCopy.symbol(session.client.deviceType))
        .font(Typography.title)
        .foregroundStyle(Palette.textSecondary)
        .frame(width: 28)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: Spacing.xxs) {
        HStack(spacing: Spacing.sm) {
          Text(session.displayName)
            .font(Typography.body.weight(.medium))
            .foregroundStyle(Palette.textPrimary)
            .lineLimit(2)
          if session.current {
            Text("This device")
              .font(Typography.caption.weight(.medium))
              .foregroundStyle(Palette.textSecondary)
              .padding(.horizontal, Spacing.sm)
              .padding(.vertical, Spacing.xxs)
              .background(Palette.fill, in: .capsule)
              .fixedSize()
          }
        }
        if let details = AccessCopy.details(session) {
          Text(details)
            .font(Typography.footnote)
            .foregroundStyle(Palette.textSecondary)
        }
        HStack(spacing: Spacing.xs) {
          Circle()
            .fill(session.isLive ? Palette.success : Palette.textTertiary.opacity(0.5))
            .frame(width: 7, height: 7)
            .accessibilityHidden(true)
          Text(AccessCopy.seen(session))
          Text(verbatim: "·").accessibilityHidden(true)
          Text(AccessCopy.permissionCount(session.scopes.count))
        }
        .font(Typography.footnote)
        .foregroundStyle(Palette.textTertiary)
      }
      Spacer(minLength: 0)
    }
    .padding(.vertical, Spacing.xxs)
    .accessibilityElement(children: .combine)
  }
}

// MARK: - Session detail

private struct AccessSessionSheet: View {
  @Environment(\.dismiss) private var dismiss
  let session: AccessClientSession
  let canWrite: Bool
  let onRevoke: () -> Void

  var body: some View {
    NavigationStack {
      ThemedList(background: Palette.sheet) {
        Section {
          LabeledContent("Device", value: AccessCopy.deviceName(session.client.deviceType))
          if let os = session.client.os { LabeledContent("System", value: os) }
          if let browser = session.client.browser { LabeledContent("Browser", value: browser) }
          if let address = session.client.ipAddress {
            LabeledContent("Address") { Text(verbatim: address).textSelection(.enabled) }
          }
          LabeledContent("Last seen", value: AccessCopy.seen(session))
          if let issued = session.issuedAt.date {
            LabeledContent("Paired") { Text(issued, format: .dateTime.day().month().year()) }
          }
          if let expires = session.expiresAt.date {
            LabeledContent("Signed in until") { Text(expires, format: .dateTime.day().month().year()) }
          }
        }
        Section {
          ForEach(AuthScope.grants.filter(session.scopes.contains), id: \.self) { scope in
            VStack(alignment: .leading, spacing: Spacing.xxs) {
              Text(AccessCopy.scopeTitle(scope))
              Text(verbatim: scope)
                .font(Typography.monoSmall)
                .foregroundStyle(Palette.textTertiary)
            }
            .accessibilityElement(children: .combine)
          }
        } header: {
          Text("Permissions")
        }
        if canWrite, !session.current {
          Section {
            Button("Revoke access", systemImage: "xmark.shield", role: .destructive) {
              dismiss()
              onRevoke()
            }
            .accessibilityIdentifier("access.session.revoke")
          }
        } else if session.current {
          Section {
          } footer: {
            Text("This is the device you are using. To sign it out, remove the computer on this device.")
          }
        }
      }
      .navigationTitle(session.displayName)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") { dismiss() }
        }
      }
    }
    .presentationDetents([.medium, .large])
  }
}

// MARK: - Create

/// Name and permissions for a new one-time link (web "Create pairing link"). A link can only
/// grant what this device holds there.
struct CreatePairingLinkSheet: View {
  @Environment(\.dismiss) private var dismiss
  let environment: EnvironmentModel
  let directory: AccessDirectory
  @State private var name = ""
  @State private var chosen = Set(PairingScopes.standard)
  @State private var busy = false
  @State private var failure: String?

  private var held: Set<String> { environment.grantedScopes ?? [] }
  private var offered: [String] { AuthScope.grants.filter(held.contains) }
  private var selected: [String] { PairingScopes.delegatable(chosen, holding: held) }

  private var preset: Binding<Preset> {
    Binding(
      get: {
        if Set(selected) == Set(PairingScopes.delegatable(Set(PairingScopes.standard), holding: held)) { return .standard }
        if Set(selected) == Set(PairingScopes.delegatable(Set(PairingScopes.readOnly), holding: held)) { return .readOnly }
        return .custom
      },
      set: { next in
        switch next {
        case .standard: chosen = Set(PairingScopes.standard)
        case .readOnly: chosen = Set(PairingScopes.readOnly)
        case .custom: break
        }
      })
  }

  enum Preset: Hashable { case standard, readOnly, custom }

  var body: some View {
    NavigationStack {
      ThemedList(background: Palette.sheet) {
        Section {
          TextField("Name", text: $name, prompt: Text("e.g. Living room iPad"))
            .submitLabel(.done)
            .accessibilityIdentifier("access.create.name")
        } footer: {
          Text("Shown in the device list on \(environment.label). Optional.")
        }

        Section {
          Picker("Permissions", selection: preset) {
            Text("Standard", comment: "standard permission preset").tag(Preset.standard)
            Text("Read only").tag(Preset.readOnly)
            if preset.wrappedValue == .custom {
              Text("Custom", comment: "permission preset").tag(Preset.custom)
            }
          }
          .accessibilityIdentifier("access.create.preset")
          ForEach(offered, id: \.self) { scope in
            Toggle(isOn: Binding(get: { chosen.contains(scope) }, set: { on in
              if on { chosen.insert(scope) } else { chosen.remove(scope) }
            })) {
              VStack(alignment: .leading, spacing: Spacing.xxs) {
                Text(AccessCopy.scopeTitle(scope))
                Text(AccessCopy.scopeDetail(scope))
                  .font(Typography.footnote)
                  .foregroundStyle(Palette.textSecondary)
              }
            }
          }
        } header: {
          Text("Permissions")
        } footer: {
          if selected.isEmpty {
            Text("Select at least one permission.").foregroundStyle(Palette.danger)
          } else if selected.contains(AuthScope.accessWrite) {
            Text("The new device can create or revoke access for other devices.")
          } else if selected.contains("terminal:operate") {
            Text("Terminal commands can read or change files within the server account’s permissions.")
          }
        }
      }
      .disabled(busy)
      .navigationTitle("Create pairing link")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
        }
        ToolbarItem(placement: .confirmationAction) {
          if busy {
            ProgressView()
          } else {
            Button("Create") { create() }
              .disabled(selected.isEmpty)
              .accessibilityIdentifier("access.create.submit")
          }
        }
      }
      .alert("Could not create pairing link", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
        Button("OK", role: .cancel) {}
      } message: {
        Text(failure ?? "")
      }
    }
    .interactiveDismissDisabled(busy)
  }

  private func create() {
    busy = true
    Task {
      do throws(EnvironmentRequestError) {
        try await directory.createLink(label: name, scopes: selected)
        dismiss()
      } catch {
        failure = SharingAccessPage.describe(error)
      }
      busy = false
    }
  }
}

// MARK: - Share

/// The new link as a QR code to scan and as a link or code to send, through an address the other
/// device can reach.
struct PairingShareSheet: View {
  @Environment(\.dismiss) private var dismiss
  let environment: EnvironmentModel
  let directory: AccessDirectory
  let linkId: String
  @State private var routeId: String?
  @State private var copied: Copied?
  @State private var confirmingRevoke = false

  enum Copied { case link, code }

  private var code: String? { directory.codes[linkId] }
  private var link: AccessPairingLink? { directory.snapshot.pairingLinks.first { $0.id == linkId } }
  private var routes: [EnvironmentRoute] { PairingShare.shareableRoutes(environment.record.routes) }
  private var route: EnvironmentRoute? { routes.first { $0.id == routeId } ?? routes.first }
  private var pairingURL: URL? {
    guard let code, let route else { return nil }
    return PairingShare.pairingURL(endpoint: route.endpoint, code: code)
  }

  var body: some View {
    NavigationStack {
      ThemedList(background: Palette.sheet) {
        Section {
          VStack(spacing: Spacing.md) {
            if let url = pairingURL, let appLink = PairingShare.appLink(url), let image = QRCode.image(appLink.absoluteString) {
              Image(uiImage: image)
                .interpolation(.none)
                .resizable()
                .scaledToFit()
                .frame(maxWidth: 220)
                .padding(Spacing.md)
                .background(.white, in: .rect(cornerRadius: Radius.medium, style: .continuous))
                .accessibilityLabel(Text("Pairing link. Scan to open on another device"))
                .accessibilityIdentifier("access.share.qr")
              Text("Scan with the Camera or the Ankiel Code app on the other device.")
                .font(Typography.footnote)
                .foregroundStyle(Palette.textSecondary)
                .multilineTextAlignment(.center)
            } else if code != nil {
              Image(systemName: "qrcode")
                .font(.system(size: 44))
                .foregroundStyle(Palette.textTertiary)
                .accessibilityHidden(true)
              Text("This device reaches \(environment.label) at an address only it can use, so there is no QR code. Send the code and pair with an address the other device can reach.")
                .font(Typography.footnote)
                .foregroundStyle(Palette.textSecondary)
                .multilineTextAlignment(.center)
            } else {
              Text("This link was made on another device. Create a new one to share it from here.")
                .font(Typography.footnote)
                .foregroundStyle(Palette.textSecondary)
                .multilineTextAlignment(.center)
            }
            if let link {
              TimelineView(.periodic(from: .now, by: 30)) { context in
                Text(AccessCopy.linkSummary(link, now: context.date))
                  .font(Typography.footnote.weight(.medium))
                  .foregroundStyle(Palette.textTertiary)
              }
            }
          }
          .frame(maxWidth: .infinity)
          .padding(.vertical, Spacing.sm)
        }

        if routes.count > 1 {
          Section {
            Picker("Reach this computer via", selection: Binding(get: { route?.id }, set: { routeId = $0 })) {
              ForEach(routes, id: \.id) { route in
                VStack(alignment: .leading) {
                  Text(ConnectionPresentation.routeName(route.kind))
                  Text(PairingLinkView.displayAddress(route.endpoint))
                    .font(Typography.footnote)
                    .foregroundStyle(Palette.textSecondary)
                }
                .tag(Optional(route.id))
              }
            }
            .pickerStyle(.inline)
            .labelsHidden()
          } header: {
            Text("Reach this computer via")
          } footer: {
            Text("A relay or tailnet address also works away from this network.")
          }
        }

        if let code {
          Section {
            if let url = pairingURL {
              ShareLink(item: url) {
                Label("Share link", systemImage: "square.and.arrow.up")
              }
              Button(copied == .link ? "Copied" : "Copy link", systemImage: copied == .link ? "checkmark" : "link") {
                UIPasteboard.general.string = url.absoluteString
                copied = .link
              }
              .accessibilityIdentifier("access.share.copyLink")
            }
            Button(copied == .code ? "Copied" : "Copy code", systemImage: copied == .code ? "checkmark" : "number") {
              UIPasteboard.general.string = code
              copied = .code
            }
            .accessibilityIdentifier("access.share.copyCode")
          } footer: {
            Text(verbatim: code)
              .font(Typography.monoSmall)
              .textSelection(.enabled)
          }
          .contentTransition(.symbolEffect(.replace))
        }

        if link != nil, environment.holds(AuthScope.accessWrite) {
          Section {
            Button("Revoke link", systemImage: "xmark.circle", role: .destructive) { confirmingRevoke = true }
              .accessibilityIdentifier("access.share.revoke")
          }
        }
      }
      .navigationTitle(link?.label ?? String(localized: "Pairing link"))
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") { dismiss() }
            .accessibilityIdentifier("access.share.done")
        }
      }
      .sensoryFeedback(.success, trigger: copied) { _, new in new != nil }
      .confirmationDialog("Revoke this pairing link?", isPresented: $confirmingRevoke, titleVisibility: .visible) {
        Button("Revoke", role: .destructive) {
          Task {
            try? await directory.revokeLink(linkId)
            dismiss()
          }
        }
      } message: {
        Text("Nobody can pair with this link any more.")
      }
    }
  }
}

/// A QR code drawn by Core Image, scaled with nearest-neighbour so it stays sharp.
enum QRCode {
  static func image(_ payload: String) -> UIImage? {
    let filter = CIFilter.qrCodeGenerator()
    filter.message = Data(payload.utf8)
    filter.correctionLevel = "M"
    guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)),
      let cgImage = CIContext().createCGImage(output, from: output.extent)
    else { return nil }
    return UIImage(cgImage: cgImage)
  }
}

// MARK: - Copy

enum AccessCopy {
  static func symbol(_ deviceType: String) -> String {
    switch deviceType {
    case "mobile": "iphone"
    case "tablet": "ipad"
    case "desktop": "laptopcomputer"
    case "bot": "cpu"
    default: "display"
    }
  }

  static func deviceName(_ deviceType: String) -> String {
    switch deviceType {
    case "mobile": String(localized: "Phone")
    case "tablet": String(localized: "Tablet")
    case "desktop": String(localized: "Computer")
    case "bot": String(localized: "Agent", comment: "a non-human client device")
    default: String(localized: "Unknown device")
    }
  }

  /// "iOS · 192.168.1.31".
  static func details(_ session: AccessClientSession) -> String? {
    // Without a label the name is already the OS and browser.
    let named = session.client.label != nil
    let parts = [named ? session.client.os : nil, named ? session.client.browser : nil, session.client.ipAddress].compactMap(\.self)
    return parts.isEmpty ? nil : parts.joined(separator: " · ")
  }

  static func seen(_ session: AccessClientSession) -> String {
    if session.isLive { return String(localized: "Online now") }
    guard let date = session.lastConnectedAt?.date else { return String(localized: "Not connected yet") }
    return String(localized: "Last seen \(date.formatted(.relative(presentation: .named)))")
  }

  static func permissionCount(_ count: Int) -> String {
    String(localized: "\(count) permissions")
  }

  static func linkSummary(_ link: AccessPairingLink, now: Date) -> String {
    let count = permissionCount(link.scopes.count)
    guard let expires = link.expiresAt.date else { return count }
    if expires <= now { return String(localized: "Expired") }
    return String(localized: "Expires \(expires.formatted(.relative(presentation: .named, unitsStyle: .wide))) · \(count)")
  }

  /// Web `AUTH_SCOPE_OPTIONS` titles.
  static func scopeTitle(_ scope: String) -> String {
    switch scope {
    case "orchestration:read": String(localized: "View environment")
    case "orchestration:operate": String(localized: "Operate tasks")
    case "settings:write": String(localized: "Change environment settings")
    case "providers:manage": String(localized: "Manage providers")
    case "environment:maintain": String(localized: "Maintain environment")
    case "preview:operate": String(localized: "Control previews")
    case "diagnostics:read": String(localized: "View diagnostics and usage")
    case "terminal:read": String(localized: "View terminals")
    case "terminal:operate": String(localized: "Use terminals")
    case "source-control:write": String(localized: "Change source control")
    case "filesystem:read": String(localized: "Read files")
    case "filesystem:write": String(localized: "Write files")
    case "access:read": String(localized: "View access")
    case "access:write": String(localized: "Manage access")
    default: scope
    }
  }

  static func scopeDetail(_ scope: String) -> String {
    switch scope {
    case "orchestration:read": String(localized: "Read threads, status, checkpoints, and configuration.")
    case "orchestration:operate": String(localized: "Start, update, and stop tasks.")
    case "settings:write": String(localized: "Edit environment preferences and keybindings.")
    case "providers:manage": String(localized: "Configure, install, sign in to, and update providers and usage sources.")
    case "environment:maintain": String(localized: "Update the server and control environment processes.")
    case "preview:operate": String(localized: "Open browser previews and host browser automation.")
    case "diagnostics:read": String(localized: "Read process diagnostics, resource history, and usage totals.")
    case "terminal:read": String(localized: "Read existing terminal output and status.")
    case "terminal:operate": String(localized: "Create terminals and send input to running shells.")
    case "source-control:write": String(localized: "Commit, push, manage branches and repositories, and change pull requests.")
    case "filesystem:read": String(localized: "Browse host files, search workspaces, and inspect local changes.")
    case "filesystem:write": String(localized: "Edit workspace files and save plans to disk.")
    case "access:read": String(localized: "Inspect pairing links and authorized clients.")
    case "access:write": String(localized: "Issue and revoke credentials for other clients.")
    default: ""
    }
  }
}

extension SharingAccessPage {
  /// The live computer, or the fixture's fake under `ANKIEL_DEBUG_SETTINGS`.
  @MainActor static func service(for environment: EnvironmentModel, model: AppModel) -> any AccessService {
    #if DEBUG
      if model.isSettingsFixture { return AccessDebug.service }
    #endif
    return EnvironmentAccessService(registry: model.registry, environmentId: environment.id)
  }
}

#if DEBUG
  /// `ANKIEL_DEBUG_ACCESS=fail|denied` with `ANKIEL_DEBUG_SETTINGS`: the fake access service
  /// refuses writes, or the session may not read access. `ANKIEL_DEBUG_ACCESS_OPEN=create|share`
  /// opens the create sheet, or creates a link and shows it.
  enum AccessDebug {
    @MainActor static let service: FakeAccessService = {
      let mode: FakeAccessService.Mode =
        switch ProcessInfo.processInfo.environment["ANKIEL_DEBUG_ACCESS"] {
        case "fail": .fail
        case "denied": .denied
        default: .normal
        }
      return FakeAccessService(mode: mode)
    }()

    static var open: String? { ProcessInfo.processInfo.environment["ANKIEL_DEBUG_ACCESS_OPEN"] }
    @MainActor static var opened = false
  }
#endif
