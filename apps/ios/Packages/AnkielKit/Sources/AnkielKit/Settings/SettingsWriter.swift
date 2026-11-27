import Foundation
import Observation

/// Where settings patches go: the registry (a computer's live session), or a debug fake.
public protocol SettingsSink: AnyObject, Sendable {
  @MainActor func updateSettings(
    _ patch: ServerSettingsPatch, in environmentId: String
  ) async throws(EnvironmentRequestError) -> ServerSettings
}

/// A patch shown before the server confirms it.
public struct PendingSettingsWrite: Sendable, Hashable, Identifiable {
  public let id: UUID
  public let patch: ServerSettingsPatch
}

/// One computer that refused a write, for a single alert.
public struct SettingsWriteFailure: Sendable, Hashable, Identifiable {
  public var id: String { environmentId }
  public let environmentId: String
  public let label: String
  public let error: EnvironmentRequestError
}

/// Writes server settings to one computer or, as an explicit bulk edit, to several. Each target
/// shows the patch at once (`EnvironmentModel.effectiveSettings`); the server's answer replaces
/// the confirmed settings, and a refusal just drops the pending patch, so a config event that
/// arrives meanwhile is never overwritten by a stale snapshot.
@MainActor @Observable
public final class SettingsWriter {
  @ObservationIgnored public let sink: any SettingsSink

  public init(sink: any SettingsSink) {
    self.sink = sink
  }

  /// Writes to every target in parallel. A target that cannot take the write (offline, or the
  /// session lacks `settings:write`) is reported, never redirected to another computer.
  public func write(_ patch: ServerSettingsPatch, to targets: [EnvironmentModel]) async -> [SettingsWriteFailure] {
    await withTaskGroup(of: SettingsWriteFailure?.self) { group in
      for target in targets {
        group.addTask { await self.write(patch, to: target) }
      }
      var failures: [SettingsWriteFailure] = []
      for await failure in group {
        if let failure { failures.append(failure) }
      }
      return failures.sorted { $0.label.localizedStandardCompare($1.label) == .orderedAscending }
    }
  }

  private func write(_ patch: ServerSettingsPatch, to target: EnvironmentModel) async -> SettingsWriteFailure? {
    guard target.canWriteSettings else {
      let error: EnvironmentRequestError = target.status.isConnected ? .rejected(message: nil) : .notConnected
      return SettingsWriteFailure(environmentId: target.id, label: target.label, error: error)
    }
    let pending = PendingSettingsWrite(id: UUID(), patch: patch)
    target.pendingSettings.append(pending)
    defer { target.pendingSettings.removeAll { $0.id == pending.id } }
    do {
      target.settings = try await sink.updateSettings(patch, in: target.id)
      return nil
    } catch {
      return SettingsWriteFailure(environmentId: target.id, label: target.label, error: error)
    }
  }
}
