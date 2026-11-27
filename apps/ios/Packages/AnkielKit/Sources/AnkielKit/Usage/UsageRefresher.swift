import Foundation
import Observation

/// `ServerProviderUpdatedPayload`: the providers after a refresh.
struct RefreshProvidersResult: Sendable, Decodable {
  var providers: LossyArray<ServerProvider>
}

extension EnvironmentRegistry {
  /// `server.refreshProviders {}`: the computer re-probes every provider, limits included. The
  /// fresh list also comes on the config stream; the answer's limits are applied at once so the
  /// screen does not wait for it. Only `usageLimits` is taken from the answer.
  public func refreshProviders(in environmentId: String) async throws(EnvironmentRequestError) {
    let result = try await request(environmentId) { session in
      try await session.call(RefreshProvidersRequest.rpcTag, payload: RefreshProvidersRequest(), as: RefreshProvidersResult.self)
    }
    guard let model = environment(environmentId) else { return }
    let fresh = Dictionary(result.providers.elements.map { ($0.instanceId, $0) }, uniquingKeysWith: { first, _ in first })
    model.providers = model.providers.map { provider in
      guard let updated = fresh[provider.instanceId] else { return provider }
      var next = provider
      next.usageLimits = updated.usageLimits
      return next
    }
  }

  /// `provider.consumeResetCredit`: redeems one banked reset on that computer (`providers:manage`).
  public func consumeResetCredit(
    instanceId: String, in environmentId: String
  ) async throws(EnvironmentRequestError) -> ConsumeResetCreditResult {
    try await request(environmentId) { session in
      try await session.call(
        ConsumeResetCreditRequest.rpcTag, payload: ConsumeResetCreditRequest(instanceId: instanceId), as: ConsumeResetCreditResult.self)
    }
  }
}

/// Keeps limits fresh without hammering computers (RN `refreshUsageLimits`): one refresh per
/// computer at a time, and automatic refreshes at most every five minutes per computer. A manual
/// refresh joins one in flight instead of starting another.
@MainActor @Observable
public final class UsageRefresher {
  public typealias Refresh = @MainActor (String) async throws(EnvironmentRequestError) -> Void

  /// Computers whose last finished refresh failed.
  public private(set) var failed: Set<String> = []
  public private(set) var refreshing: Set<String> = []

  @ObservationIgnored private var inFlight: [String: Task<Bool, Never>] = [:]
  @ObservationIgnored private var refreshAfter: [String: Date] = [:]
  @ObservationIgnored private let perform: Refresh
  @ObservationIgnored private let now: @MainActor () -> Date
  public static let automaticInterval: TimeInterval = 5 * 60

  public init(now: @escaping @MainActor () -> Date = Date.init, perform: @escaping Refresh) {
    self.now = now
    self.perform = perform
  }

  public convenience init(registry: EnvironmentRegistry) {
    self.init { [weak registry] id throws(EnvironmentRequestError) in
      guard let registry else { return }
      try await registry.refreshProviders(in: id)
    }
  }

  /// Refreshes these computers; returns once each has an answer. Returns whether any ran.
  @discardableResult
  public func refresh(_ environmentIds: [String], automatic: Bool = false) async -> Bool {
    var waits: [Task<Bool, Never>] = []
    var ran = false
    for id in Set(environmentIds) {
      if let pending = inFlight[id] {
        if !automatic { waits.append(pending) }
        continue
      }
      if automatic, let after = refreshAfter[id], now() < after { continue }
      ran = true
      refreshing.insert(id)
      let perform = perform
      let task = Task { @MainActor [weak self] in
        var ok = true
        do throws(EnvironmentRequestError) {
          try await perform(id)
        } catch {
          ok = false
        }
        self?.finish(id, ok: ok)
        return ok
      }
      inFlight[id] = task
      waits.append(task)
    }
    for task in waits { _ = await task.value }
    return ran
  }

  private func finish(_ id: String, ok: Bool) {
    inFlight[id] = nil
    refreshing.remove(id)
    refreshAfter[id] = now().addingTimeInterval(Self.automaticInterval)
    if ok { failed.remove(id) } else { failed.insert(id) }
  }
}
