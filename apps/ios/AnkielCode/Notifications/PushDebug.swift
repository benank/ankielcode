#if DEBUG
  import AnkielKit
  import Foundation

  /// `ANKIEL_DEBUG_PUSH` (debug builds): Settings → Notifications in a canned state, with its own
  /// `UserDefaults` suite. Nothing registers with a computer and the badge is left alone.
  ///   `on`        push on, every kind; computers show On, Relay not set up, Relay has no push key
  ///   `on-more`   push on; computers show Relay offline, Not connected, a refused status read
  ///   `denied`    iOS notifications turned off for the app
  ///   `unavailable` push on but no token (a build without the push entitlement)
  ///   `offer`     the one-time offer shows at launch
  enum PushDebug {
    enum Mode: String {
      case on, onMore = "on-more", denied, unavailable, offer

      init?(_ raw: String?) {
        guard let raw, let mode = Mode(rawValue: raw) else { return nil }
        self = mode
      }
    }

    static let defaults = UserDefaults(suiteName: "ankiel.debug.push") ?? .standard

    static let device = PushDevice(token: String(repeating: "0f", count: 32), appId: "com.ankiel.code.native", apnsEnvironment: .sandbox)

    @MainActor static func apply(_ mode: Mode, to push: PushCoordinator) {
      switch mode {
      case .on, .onMore:
        push.debugSet(permission: .granted, device: device, preference: PushPreference(enabled: true, kinds: [.completed, .approval, .input]))
      case .denied:
        push.debugSet(permission: .denied, device: nil, preference: PushPreference(enabled: false))
      case .unavailable:
        push.debugSet(permission: .granted, device: nil, preference: PushPreference(enabled: true))
      case .offer:
        push.debugSet(permission: .undetermined, device: nil, preference: PushPreference())
        push.offerVisible = true
      }
    }

    static func state(_ mode: Mode, index: Int) -> PushComputerState {
      let states: [PushComputerState] =
        mode == .onMore
        ? [.relayOffline, .notConnected, .failed(nil)]
        : [.on, .relayNotSetUp, .noPushKey]
      return states[index % states.count]
    }
  }
#endif
