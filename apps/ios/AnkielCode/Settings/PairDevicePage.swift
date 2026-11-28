import AnkielKit
import SwiftUI
import UniformTypeIdentifiers

/// "Pair a device" (RN `SettingsEnvironmentPairDeviceRouteScreen`): a one-time invite another
/// device picks up by Handoff, an `.ankielpair` file or a link; both screens then show one code and
/// this device approves or denies. Leaving with a live invite denies it.
struct PairDevicePage: View {
  @Environment(AppModel.self) private var model
  let environment: EnvironmentModel
  let service: any PairingInviteService
  @State private var relay: RelayStatus?
  @State private var relayLoaded = false
  @State private var session: PairingInviteSession?

  private var connected: Bool { environment.status.isConnected }
  private var canReadAccess: Bool { environment.allows(AuthScope.accessRead) }

  /// RN `readyBaseUrl`: where the other device reaches this computer, once the relay answered.
  private var readyBaseURL: String? {
    guard connected, environment.holds(AuthScope.accessWrite), relayLoaded || !canReadAccess else { return nil }
    #if DEBUG
      if let override = PairDeviceDebug.baseURL { return override }
    #endif
    return PairingInviteRules.shareableBaseURL(relay: relay, routes: environment.record.routes, activeRoute: environment.activeRoute)
  }

  var body: some View {
    ThemedList {
      if let session {
        PairDeviceFlow(environment: environment, session: session, restart: restart)
      } else if !connected {
        PairDeviceNotice(
          symbol: "wifi.slash", title: "Environment disconnected", message: "Connect this environment before pairing another device.",
          action: "Back to environment")
      } else if !environment.holds(AuthScope.accessWrite) {
        PairDeviceNotice(
          symbol: "exclamationmark.circle", title: "Permission required",
          message: "This connection does not have permission to pair other devices.", action: "Back to environment")
      } else if !relayLoaded, canReadAccess {
        PairDevicePreparing(environment: environment)
      } else {
        PairDeviceNotice(
          symbol: "wifi.slash", title: "No shareable route found",
          message: "Configure Cloudflare Relay or a network route before pairing another device.", action: "Configure routes")
      }
    }
    .navigationTitle("Pair a device")
    .navigationBarTitleDisplayMode(.inline)
    .task(id: connected) { await loadRelay() }
    .onChange(of: readyBaseURL, initial: true) { _, url in
      if session == nil, let url { begin(url) }
    }
    .onDisappear {
      session?.stop()
      PairingInviteFile.sweep()
    }
  }

  private func begin(_ baseURL: String) {
    let next = PairingInviteSession(
      service: service, environmentId: environment.id, label: environment.label, baseURL: baseURL,
      scopes: PairingInviteRules.defaultScopes(held: environment.grantedScopes))
    next.setConnected(connected)
    session = next
    next.start()
  }

  /// "Try again" and "Pair another device": a fresh invite at the address that works now.
  private func restart() {
    session?.stop()
    session = nil
    if let url = readyBaseURL { begin(url) }
  }

  private func loadRelay() async {
    guard connected, canReadAccess else { return }
    #if DEBUG
      if model.isSettingsFixture {
        relay = RelayStatus(
          configured: true, connected: true, relayOrigin: "https://ankiel-relay.example.workers.dev",
          publicBaseUrl: "https://ankiel-relay.example.workers.dev/h/abcdefghijklmnopqrstuvwxyz/")
        relayLoaded = true
        return
      }
    #endif
    relay = try? await model.registry.relayStatus(environment.id)
    relayLoaded = true
  }
}

extension PairDevicePage {
  @MainActor static func service(for environment: EnvironmentModel, model: AppModel) -> any PairingInviteService {
    #if DEBUG
      if model.isSettingsFixture { return PairDeviceDebug.service() }
    #endif
    return EnvironmentPairingInviteService(registry: model.registry, environmentId: environment.id)
  }
}

/// One invite on screen, from creating to its end.
private struct PairDeviceFlow: View {
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var scenePhase
  let environment: EnvironmentModel
  let session: PairingInviteSession
  let restart: () -> Void

  private var connected: Bool { environment.status.isConnected }

  var body: some View {
    Group {
      if !connected, session.invite != nil || session.phase == .creating {
        Section {
          Label {
            Text("Reconnecting to \(environment.label)...")
          } icon: {
            ProgressView().controlSize(.small)
          }
          .font(Typography.footnote.weight(.medium))
          .foregroundStyle(Palette.textSecondary)
        }
      }
      switch session.phase {
      case .creating: PairDevicePreparing(environment: environment)
      case .pending(let invite, let expiresAt): ready(invite, expiresAt: expiresAt)
      case .claimed(_, let claim, let scopes): claimed(claim, scopes: scopes)
      case .approved: approved
      case .ended(let reason): ended(reason)
      case .failed(let error): failed(error)
      }
    }
    .motion(Motion.transition, value: PhaseKey(session.phase))
    .userActivity(PairingInviteWire.activityType, element: session.invite) { invite, activity in
      activity.title = String(localized: "Pair \(environment.label)")
      activity.userInfo = invite.userInfo
      activity.requiredUserInfoKeys = Set(invite.userInfo.keys)
      activity.expirationDate = invite.expiresAt.flatMap { WireTimestamp(rawValue: $0).date }
      activity.isEligibleForHandoff = true
      activity.isEligibleForSearch = false
      activity.isEligibleForPublicIndexing = false
      activity.isEligibleForPrediction = false
    }
    .onChange(of: scenePhase, initial: true) { _, phase in session.setActive(phase == .active) }
    .onChange(of: connected) { _, connected in session.setConnected(connected) }
    .sensoryFeedback(.warning, trigger: session.claims)
    .sensoryFeedback(.success, trigger: session.approvals)
    #if DEBUG
      .onChange(of: session.invite, initial: true) { _, invite in
        if let invite { PairDeviceDebug.write(invite) }
      }
    #endif
  }

  // MARK: States

  private func ready(_ invite: PairingInvitePayload, expiresAt: Date) -> some View {
    Group {
      Section {
        VStack(alignment: .leading, spacing: Spacing.md) {
          HStack(spacing: Spacing.md) {
            PairDeviceBadge(symbol: "laptopcomputer")
            Text("Ready for Handoff")
              .font(Typography.headline)
              .foregroundStyle(Palette.textPrimary)
              .frame(maxWidth: .infinity, alignment: .leading)
          }
          Text("Click \(Text(verbatim: "Ankiel Code").font(Typography.subheadline.weight(.semibold))) in your Mac's Dock to continue.")
            .font(Typography.subheadline)
            .foregroundStyle(Palette.textSecondary)
          // The system redraws a timer text once a second; nothing else repaints.
          Text("Expires in \(Text(timerInterval: min(Date.now, expiresAt)...expiresAt, countsDown: true))")
            .font(Typography.footnote.weight(.medium))
            .monospacedDigit()
            .foregroundStyle(Palette.textSecondary)
            .padding(.horizontal, Spacing.sm)
            .padding(.vertical, Spacing.xxs)
            .background(Palette.fillStrong, in: .capsule)
            .accessibilityIdentifier("pairDevice.countdown")
        }
        .padding(.vertical, Spacing.xs)
        .accessibilityElement(children: .combine)
      } footer: {
        Text("Share the invite file or link to your other device, then confirm the code here.")
      }
      .accessibilityIdentifier("pairDevice.ready")

      Section {
        ShareLink(
          item: PairingInviteFile(invite: invite),
          preview: SharePreview(String(localized: "Pair \(environment.label)"), image: Image(systemName: "laptopcomputer"))
        ) {
          Label("AirDrop to Mac", systemImage: "square.and.arrow.up")
        }
        .accessibilityIdentifier("pairDevice.shareFile")
        ShareLink(item: invite.appLink()) {
          Label("Share link", systemImage: "link")
        }
        .accessibilityIdentifier("pairDevice.shareLink")
      }

      Section {
        Button("Cancel", role: .cancel) {
          session.stop()
          dismiss()
        }
        .frame(maxWidth: .infinity)
        .accessibilityIdentifier("pairDevice.cancel")
      }
    }
  }

  private func claimed(_ claim: PairingInviteClaim, scopes: [String]) -> some View {
    let fallback = PairDeviceCopy.deviceName(claim)
    let title = claim.clientLabel ?? fallback
    let os = claim.clientOs.trimmingCharacters(in: .whitespaces)
    let subtitle: String? =
      claim.clientLabel != nil ? fallback : (!os.isEmpty && os.lowercased() != "unknown" && fallback != os ? os : nil)
    return Group {
      Section {
        HStack(spacing: Spacing.md) {
          PairDeviceBadge(symbol: claim.clientDeviceType == "mobile" || claim.clientDeviceType == "tablet" ? "iphone" : "desktopcomputer")
          VStack(alignment: .leading, spacing: Spacing.xxs) {
            Text(title)
              .font(Typography.headline)
              .foregroundStyle(Palette.textPrimary)
            if let subtitle {
              Text(subtitle)
                .font(Typography.footnote)
                .foregroundStyle(Palette.textSecondary)
            }
            Text("Needs approval")
              .font(Typography.caption.weight(.medium))
              .foregroundStyle(Palette.textSecondary)
              .padding(.horizontal, Spacing.sm)
              .padding(.vertical, Spacing.xxs)
              .background(Palette.fillStrong, in: .capsule)
              .padding(.top, Spacing.xxs)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .combine)

        VStack(spacing: Spacing.sm) {
          Text("Verification code")
            .font(Typography.footnote.weight(.medium))
            .foregroundStyle(Palette.textSecondary)
          Text(verbatim: claim.verificationCode)
            .font(Typography.monoFont(34, .largeTitle).weight(.semibold))
            .tracking(2)
            .foregroundStyle(Palette.textPrimary)
            .contentTransition(.numericText())
            .textSelection(.enabled)
            .minimumScaleFactor(0.6)
            .lineLimit(1)
            .accessibilityLabel(Text(verbatim: claim.verificationCode.map(String.init).joined(separator: " ")))
            .accessibilityIdentifier("pairDevice.code")
          Text("Confirm this code matches your other device before approving.")
            .font(Typography.footnote)
            .foregroundStyle(Palette.textSecondary)
            .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, Spacing.md)
      } footer: {
        Text(PairDeviceCopy.scopeSummary(scopes, environment: environment.label))
      }
      .accessibilityIdentifier("pairDevice.claimed")

      if let error = session.actionError {
        Section {
          Label(PairDeviceCopy.message(error, fallback: session.failedDecision == .deny ? .deny : .approve), systemImage: "exclamationmark.triangle")
            .font(Typography.footnote)
            .foregroundStyle(Palette.danger)
        }
      }

      Section {
        Button {
          Task { await session.approve() }
        } label: {
          HStack {
            if session.decision == .approve { ProgressView().tint(Palette.onAccent) }
            Label("Approve", systemImage: "checkmark")
          }
          .font(Typography.body.weight(.semibold))
          .foregroundStyle(Palette.onAccent)
          .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.glassProminent)
        .disabled(session.decision != nil || !connected)
        .accessibilityIdentifier("pairDevice.approve")
        Button {
          Task { await session.deny() }
        } label: {
          HStack {
            if session.decision == .deny { ProgressView() }
            Label("Deny", systemImage: "xmark")
          }
          .font(Typography.body.weight(.medium))
          .foregroundStyle(Palette.textPrimary)
          .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.glass)
        .disabled(session.decision != nil || !connected)
        .accessibilityIdentifier("pairDevice.deny")
      }
      .listRowBackground(Color.clear)
      .listRowInsets(EdgeInsets(top: Spacing.xs, leading: 0, bottom: Spacing.xs, trailing: 0))
    }
  }

  private var approved: some View {
    Group {
      PairDeviceOutcome(
        symbol: "checkmark.circle.fill", tint: Palette.success, title: "Device paired",
        message: String(localized: "Your device is connecting now. You can manage or revoke its access anytime in Sharing & access."))
        .accessibilityIdentifier("pairDevice.approved")
      endButtons(primary: "Done", secondary: "Pair another device", primaryAction: { dismiss() }, secondaryAction: restart)
    }
  }

  private func ended(_ reason: PairingInviteSession.EndReason) -> some View {
    Group {
      switch reason {
      case .expired:
        PairDeviceOutcome(
          symbol: "clock", title: "Pairing invite expired",
          message: String(localized: "This invite timed out before another device completed pairing."))
          .accessibilityIdentifier("pairDevice.expired")
      case .denied:
        PairDeviceOutcome(
          symbol: "exclamationmark.circle", title: "Pairing request denied",
          message: String(localized: "No access was granted to the requesting device."))
          .accessibilityIdentifier("pairDevice.denied")
      case .cancelled:
        PairDeviceOutcome(
          symbol: "exclamationmark.circle", title: "Pairing cancelled",
          message: String(localized: "The pairing invite was cancelled before completion."))
          .accessibilityIdentifier("pairDevice.cancelled")
      }
      tryAgainButtons
    }
  }

  private func failed(_ error: PairingInviteError) -> some View {
    Group {
      PairDeviceOutcome(
        symbol: "exclamationmark.circle", title: "Could not start pairing", message: PairDeviceCopy.message(error, fallback: .create))
        .accessibilityIdentifier("pairDevice.failed")
      tryAgainButtons
    }
  }

  private var tryAgainButtons: some View {
    endButtons(primary: "Try again", primarySymbol: "arrow.clockwise", secondary: "Done", primaryAction: restart, secondaryAction: { dismiss() })
  }

  private func endButtons(
    primary: LocalizedStringKey, primarySymbol: String? = nil, secondary: LocalizedStringKey, primaryAction: @escaping () -> Void,
    secondaryAction: @escaping () -> Void
  ) -> some View {
    Section {
      Button(action: primaryAction) {
        Group {
          if let primarySymbol { Label(primary, systemImage: primarySymbol) } else { Text(primary) }
        }
        .font(Typography.body.weight(.semibold))
        .foregroundStyle(Palette.onAccent)
        .frame(maxWidth: .infinity, minHeight: 44)
      }
      .buttonStyle(.glassProminent)
      .accessibilityIdentifier("pairDevice.primary")
      Button(action: secondaryAction) {
        Text(secondary)
          .font(Typography.body.weight(.medium))
          .foregroundStyle(Palette.textPrimary)
          .frame(maxWidth: .infinity, minHeight: 44)
      }
      .buttonStyle(.glass)
      .accessibilityIdentifier("pairDevice.secondary")
    }
    .listRowBackground(Color.clear)
    .listRowInsets(EdgeInsets(top: Spacing.xs, leading: 0, bottom: Spacing.xs, trailing: 0))
  }
}

/// The phase without its payload, so a countdown refresh does not animate.
private enum PhaseKey: Equatable {
  case creating, pending, claimed, approved, ended, failed

  init(_ phase: PairingInviteSession.Phase) {
    switch phase {
    case .creating: self = .creating
    case .pending: self = .pending
    case .claimed: self = .claimed
    case .approved: self = .approved
    case .ended: self = .ended
    case .failed: self = .failed
    }
  }
}

private struct PairDeviceBadge: View {
  let symbol: String

  var body: some View {
    Image(systemName: symbol)
      .font(.system(size: 20, weight: .medium))
      .foregroundStyle(Palette.textPrimary)
      .frame(width: 44, height: 44)
      .background(Palette.fillStrong, in: .rect(cornerRadius: Radius.medium, style: .continuous))
      .accessibilityHidden(true)
  }
}

private struct PairDevicePreparing: View {
  let environment: EnvironmentModel

  var body: some View {
    Section {
      VStack(spacing: Spacing.md) {
        ProgressView()
        Text("Preparing pairing invite…")
          .font(Typography.body.weight(.medium))
          .foregroundStyle(Palette.textPrimary)
        Text("Setting up a one-time invite for \(environment.label).")
          .font(Typography.footnote)
          .foregroundStyle(Palette.textSecondary)
          .multilineTextAlignment(.center)
      }
      .frame(maxWidth: .infinity)
      .padding(.vertical, Spacing.xl)
      .accessibilityElement(children: .combine)
    }
    .accessibilityIdentifier("pairDevice.preparing")
  }
}

/// An end state: a symbol, a title and what happened.
private struct PairDeviceOutcome: View {
  let symbol: String
  var tint = Palette.textTertiary
  let title: LocalizedStringKey
  let message: String

  var body: some View {
    Section {
      VStack(spacing: Spacing.sm) {
        Image(systemName: symbol)
          .font(.system(size: 40, weight: .regular))
          .foregroundStyle(tint)
          .symbolEffect(.bounce, options: .nonRepeating, value: symbol)
          .padding(.bottom, Spacing.xs)
          .accessibilityHidden(true)
        Text(title)
          .font(Typography.title)
          .foregroundStyle(Palette.textPrimary)
          .multilineTextAlignment(.center)
        Text(message)
          .font(Typography.subheadline)
          .foregroundStyle(Palette.textSecondary)
          .multilineTextAlignment(.center)
      }
      .frame(maxWidth: .infinity)
      .padding(.vertical, Spacing.lg)
      .accessibilityElement(children: .combine)
    }
  }
}

/// Why the page cannot start, and the way back.
private struct PairDeviceNotice: View {
  @Environment(\.dismiss) private var dismiss
  let symbol: String
  let title: LocalizedStringKey
  let message: LocalizedStringKey
  let action: LocalizedStringKey

  var body: some View {
    Section {
      VStack(spacing: Spacing.sm) {
        Image(systemName: symbol)
          .font(.system(size: 34))
          .foregroundStyle(Palette.textTertiary)
          .padding(.bottom, Spacing.xs)
          .accessibilityHidden(true)
        Text(title)
          .font(Typography.headline)
          .foregroundStyle(Palette.textPrimary)
          .multilineTextAlignment(.center)
        Text(message)
          .font(Typography.subheadline)
          .foregroundStyle(Palette.textSecondary)
          .multilineTextAlignment(.center)
      }
      .frame(maxWidth: .infinity)
      .padding(.vertical, Spacing.lg)
      .accessibilityElement(children: .combine)
    }
    .accessibilityIdentifier("pairDevice.notice")
    Section {
      Button(action) { dismiss() }
        .frame(maxWidth: .infinity)
    }
  }
}

enum PairDeviceCopy {
  enum Action { case create, approve, deny }

  /// RN `pairingInviteErrorMessage`, then the server's words, then a per-action fallback.
  static func message(_ error: PairingInviteError, fallback: Action) -> String {
    switch (error.tag, error.reason) {
    case ("EnvironmentResourceNotFoundError", "pairing_invite_not_found"):
      return String(localized: "This pairing invite was not found or has already expired. Start a new pairing request on your other device.")
    case ("EnvironmentOperationForbiddenError", "pairing_invite_invalid_state"):
      return String(localized: "This pairing invite is no longer active or has already been claimed. Start a new pairing request on your other device.")
    case ("EnvironmentOperationForbiddenError", "pairing_invite_limit_reached"):
      return String(localized: "Too many pairing invites are currently active on this environment. Wait a moment or cancel one before trying again.")
    case ("EnvironmentRequestInvalidError", "pairing_invite_verification_code_mismatch"):
      return String(localized: "The verification code did not match. Start a new pairing request.")
    default: break
    }
    if case .notConnected = error { return String(localized: "Connect this environment before pairing another device.") }
    if case .rejected(_, _, let message?) = error, !message.trimmingCharacters(in: .whitespaces).isEmpty { return message }
    return switch fallback {
    case .create: String(localized: "Could not create a pairing invite. Try again.")
    case .approve: String(localized: "Could not approve this pairing request.")
    case .deny: String(localized: "Could not deny this pairing request.")
    }
  }

  /// RN `formatClaimDeviceFallback`.
  static func deviceName(_ claim: PairingInviteClaim) -> String {
    switch PairingInviteRules.deviceFallback(type: claim.clientDeviceType, os: claim.clientOs) {
    case .desktop(let os?): String(localized: "\(os) desktop")
    case .desktop(nil): String(localized: "Desktop device")
    case .mobile(let os?): String(localized: "\(os) mobile")
    case .mobile(nil): String(localized: "Mobile device")
    case .tablet(let os?): String(localized: "\(os) tablet")
    case .tablet(nil): String(localized: "Tablet device")
    case .bot: String(localized: "Automated client")
    case .other(let os?): os
    case .other(nil): String(localized: "Another device")
    }
  }

  static func scopeSummary(_ scopes: [String], environment: String) -> String {
    PairingInviteRules.grantsEverything(scopes)
      ? String(localized: "Grants full client access to \(environment).")
      : String(localized: "Grants \(scopes.count) permissions to \(environment).")
  }
}

/// The `.ankielpair` file AirDrop and the share sheet send: written to the temporary folder when
/// shared and left there for sharingd, which can still be sending it after the sheet closes; the
/// next share or leaving the page sweeps old ones (RN `sharePairingInviteFile`).
struct PairingInviteFile: Transferable {
  let invite: PairingInvitePayload

  static let type = UTType(importedAs: PairingInviteWire.fileType, conformingTo: .json)
  private static let prefix = "ankiel-pair-"

  static var transferRepresentation: some TransferRepresentation {
    FileRepresentation(exportedContentType: type) { file in
      sweep()
      let safe = String(file.invite.inviteId.filter { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }.prefix(64))
      let url = URL.temporaryDirectory.appending(path: "\(prefix)\(safe.isEmpty ? "invite" : safe).\(PairingInviteWire.fileExtension)")
      try Data(file.invite.fileJSON.utf8).write(to: url, options: .atomic)
      return SentTransferredFile(url)
    }
    .suggestedFileName { "\(prefix)\($0.invite.inviteId).\(PairingInviteWire.fileExtension)" }
  }

  static func sweep() {
    let folder = URL.temporaryDirectory
    guard let names = try? FileManager.default.contentsOfDirectory(atPath: folder.path()) else { return }
    for name in names where name.hasPrefix(prefix) && name.hasSuffix(".\(PairingInviteWire.fileExtension)") {
      try? FileManager.default.removeItem(at: folder.appending(path: name))
    }
  }
}

#if DEBUG
  /// `ANKIEL_DEBUG_PAIR_DEVICE=ready|claimed|expired|fail|limit` (with `ANKIEL_DEBUG_SETTINGS`)
  /// picks the fake invite; `noaccess` and `unsupported` take `access:write` or the capability off
  /// the fixture computer. Against a real server, `ANKIEL_DEBUG_PAIR_BASE_URL` stands in for the
  /// shareable address (the simulator's is loopback) and `ANKIEL_DEBUG_PAIR_INVITE_OUT=<path>`
  /// writes each live invite's file there, for `ankiel-probe --claim-invite`.
  enum PairDeviceDebug {
    static var mode: String? { ProcessInfo.processInfo.environment["ANKIEL_DEBUG_PAIR_DEVICE"] }
    static var baseURL: String? { ProcessInfo.processInfo.environment["ANKIEL_DEBUG_PAIR_BASE_URL"] }

    @MainActor static func service() -> FakePairingInviteService {
      FakePairingInviteService(mode: mode.flatMap(FakePairingInviteService.Mode.init(rawValue:)) ?? .ready, claimAfter: 4)
    }

    static func write(_ invite: PairingInvitePayload) {
      guard let path = ProcessInfo.processInfo.environment["ANKIEL_DEBUG_PAIR_INVITE_OUT"] else { return }
      try? Data(invite.fileJSON.utf8).write(to: URL(filePath: path), options: .atomic)
    }
  }
#endif
