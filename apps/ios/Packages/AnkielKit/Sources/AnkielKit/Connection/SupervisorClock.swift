import Foundation

/// Wall time and sleeping, injected so the supervisor's timing is testable. Sleeping takes a
/// deadline (not a duration), so a test clock that has already passed it returns at once no matter
/// when the sleeper registered.
public protocol SupervisorClock: Sendable {
  var now: Date { get }
  /// Throws `CancellationError` when the calling task is cancelled.
  func sleep(until deadline: Date) async throws
}

public struct SystemSupervisorClock: SupervisorClock {
  public init() {}

  public var now: Date { .now }

  public func sleep(until deadline: Date) async throws {
    let seconds = deadline.timeIntervalSinceNow
    if seconds > 0 { try await Task.sleep(for: .seconds(seconds)) }
    try Task.checkCancellation()
  }
}

extension SupervisorClock {
  func sleep(for seconds: TimeInterval) async throws {
    try await sleep(until: now.addingTimeInterval(seconds))
  }

  /// Runs `operation`, failing with `TimeoutError` when it has not finished after `seconds`. The
  /// operation is cancelled on timeout.
  func withTimeout<Value: Sendable>(
    _ seconds: TimeInterval, _ operation: @escaping @Sendable () async throws -> Value
  ) async throws -> Value {
    try await withDeadline(now.addingTimeInterval(seconds), operation)
  }

  /// Runs `operation`, failing with `TimeoutError` when it has not finished by `deadline`.
  func withDeadline<Value: Sendable>(
    _ deadline: Date, _ operation: @escaping @Sendable () async throws -> Value
  ) async throws -> Value {
    try await withThrowingTaskGroup(of: Value.self) { group in
      group.addTask { try await operation() }
      group.addTask {
        try await self.sleep(until: deadline)
        throw TimeoutError()
      }
      defer { group.cancelAll() }
      guard let first = try await group.next() else { throw CancellationError() }
      return first
    }
  }
}

public struct TimeoutError: Error, Sendable {}
