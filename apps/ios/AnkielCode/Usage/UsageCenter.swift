import AnkielKit
import Foundation
import Observation
import UIKit
import WidgetKit

/// Provider usage limits for the whole app: refreshes them (on demand, when a computer connects,
/// and every five minutes while the app is active, like RN's widget refresher) and publishes the
/// subscription usage widget's snapshot whenever the limits change.
@MainActor @Observable
final class UsageCenter {
  let refresher: UsageRefresher
  @ObservationIgnored private let registry: EnvironmentRegistry
  @ObservationIgnored private let store = UsageWidgetStore.shared
  @ObservationIgnored private var tasks: [Task<Void, Never>] = []
  @ObservationIgnored private var writing: Task<Void, Never>?
  /// Canned computers from `ANKIEL_DEBUG_USAGE`, shown instead of the live ones.
  private(set) var fixture: [LimitSource]?

  init(registry: EnvironmentRegistry) {
    self.registry = registry
    #if DEBUG
      if let fixture = UsageDebug.sources() {
        self.fixture = fixture
        refresher = UsageRefresher { _ throws(EnvironmentRequestError) in try? await Task.sleep(for: .milliseconds(600)) }
        return
      }
    #endif
    refresher = UsageRefresher(registry: registry)
  }

  /// Connected computers' providers, as the usage sheet and Settings show them.
  var sources: [LimitSource] { fixture ?? registry.connectedLimitSources }

  var isRefreshing: Bool { !refresher.refreshing.isEmpty }

  /// Labels of computers whose last refresh failed.
  var failedLabels: [String] {
    sources.filter { refresher.failed.contains($0.environmentId) }.map(\.label)
  }

  /// The highest spend across connected accounts, for the header ring.
  var highestUsedPercent: Double? { UsageLimits.highestUsedPercent(UsageLimits.accounts(sources)) }

  /// A manual refresh (pull to refresh, the refresh button) of every connected computer.
  func refresh() async {
    await refresher.refresh(sources.map(\.environmentId))
  }

  func start() {
    guard tasks.isEmpty else { return }
    // Publish the widget's snapshot whenever any computer's limits change.
    tasks.append(
      Task { [weak self] in
        guard let registry = self?.registry else { return }
        let fixture = self?.fixture
        for await sources in Observations({ fixture ?? registry.widgetLimitSources }) {
          self?.publish(sources)
        }
      })
    // A computer that connects (and finishes loading its list) gets fresh limits.
    tasks.append(
      Task { [weak self] in
        guard let registry = self?.registry else { return }
        for await live in Observations({ Set(registry.environments.filter(\.isShellLive).map(\.id)) }) {
          await self?.refresher.refresh(Array(live), automatic: true)
        }
      })
    tasks.append(
      Task { [weak self] in
        for await _ in NotificationCenter.default.notifications(named: UIApplication.didBecomeActiveNotification) {
          await self?.refreshAutomatically()
        }
      })
    tasks.append(
      Task { [weak self] in
        while !Task.isCancelled {
          try? await Task.sleep(for: .seconds(UsageWidgetSnapshot.refreshInterval))
          guard UIApplication.shared.applicationState == .active else { continue }
          await self?.refreshAutomatically()
        }
      })
  }

  private func refreshAutomatically() async {
    guard fixture == nil else { return }
    await refresher.refresh(registry.environments.filter(\.isShellLive).map(\.id), automatic: true)
  }

  /// Before any computer has sent its config this launch there is nothing new to say, so the
  /// widget keeps the last snapshot instead of flashing "no limits".
  private func publish(_ sources: [LimitSource]) {
    guard !sources.isEmpty || registry.environments.isEmpty else { return }
    let snapshot = UsageWidgetSnapshot.build(sources)
    let store = store
    let previous = writing
    // Encoding and the file write stay off the main actor; writes keep their order.
    writing = Task.detached(priority: .utility) {
      await previous?.value
      if store.write(snapshot) { WidgetCenter.shared.reloadTimelines(ofKind: UsageWidgetStore.widgetKind) }
    }
  }
}

/// The usage page's links: `…://settings/usage` (the widget's and RN's, any `?tab=`) and `…://usage`.
enum UsageLink {
  static func matches(_ url: URL) -> Bool {
    guard let scheme = url.scheme?.lowercased(), scheme.wholeMatch(of: /ankielcode(?:-[a-z]+)?/) != nil else { return false }
    let path = ([url.host()].compactMap { $0 } + url.pathComponents.filter { $0 != "/" }).joined(separator: "/")
    return path == "settings/usage" || path == "usage"
  }
}
