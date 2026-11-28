import ExpoModulesCore
import Foundation

@MainActor
private final class HandoffActivityHolder {
  private var activeActivity: NSUserActivity?

  nonisolated init() {}

  nonisolated func start(
    activityType: String,
    title: String,
    userInfo: [String: String],
    expiresAtEpochMs: Double?
  ) {
    DispatchQueue.main.async {
      self.activeActivity?.invalidate()

      let activity = NSUserActivity(activityType: activityType)
      activity.title = title
      activity.isEligibleForHandoff = true
      activity.isEligibleForSearch = false
      activity.isEligibleForPublicIndexing = false
      activity.userInfo = userInfo
      activity.addUserInfoEntries(from: userInfo)
      activity.requiredUserInfoKeys = Set(userInfo.keys)
      if let expiresAtEpochMs, expiresAtEpochMs.isFinite {
        activity.expirationDate = Date(timeIntervalSince1970: expiresAtEpochMs / 1000.0)
      }
      activity.needsSave = true

      self.activeActivity = activity
      activity.becomeCurrent()
    }
  }

  nonisolated func stop() {
    DispatchQueue.main.async {
      self.activeActivity?.invalidate()
      self.activeActivity = nil
    }
  }
}

/// Publishes and invalidates NSUserActivity instances for Apple Handoff pairing invites.
public final class AnkielHandoffModule: Module {
  private let holder = HandoffActivityHolder()

  public func definition() -> ModuleDefinition {
    Name("AnkielHandoff")

    let holder = self.holder

    Function("startPairingActivity") {
      (activityType: String, title: String, userInfo: [String: String], expiresAtEpochMs: Double?) in
      holder.start(
        activityType: activityType,
        title: title,
        userInfo: userInfo,
        expiresAtEpochMs: expiresAtEpochMs
      )
    }

    Function("stopPairingActivity") {
      holder.stop()
    }

    OnDestroy {
      holder.stop()
    }
  }
}
