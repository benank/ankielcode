import AnkielKit
import Foundation

/// `--streaming-setting`: flips `responseStreamingMode` and puts it back, printing the value
/// before, after the write and after the restore. A reversible server settings write.
func probeStreamingSetting(_ session: EnvironmentSession) async throws {
  let before = session.initialConfig.settings.responseStreaming
  print("streaming before:  \(before.rawValue)")
  let flipped: ResponseStreamingMode = before == .turn ? .paragraph : .turn
  let written = try await session.rpc.call(
    UpdateSettingsRequest.rpcTag, payload: UpdateSettingsRequest(patch: .responseStreaming(flipped)), as: ServerSettings.self)
  print("streaming written: \(written.responseStreaming.rawValue)")
  let restored = try await session.rpc.call(
    UpdateSettingsRequest.rpcTag, payload: UpdateSettingsRequest(patch: .responseStreaming(before)), as: ServerSettings.self)
  print("streaming restored: \(restored.responseStreaming.rawValue)")
}
