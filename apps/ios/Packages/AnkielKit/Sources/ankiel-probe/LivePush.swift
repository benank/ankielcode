import AnkielKit
import Foundation

/// `--live push`: the app's push RPCs against a server, raw and decoded. Reads the status,
/// registers a token (`--token <hex>`, else a made-up one), reads it back, then unregisters and
/// checks the session is left with no registration. A malformed token must be refused.
func livePush(_ session: EnvironmentSession, token: String?) async throws {
  struct Empty: Encodable, Sendable {}
  func status() async throws -> PushStatus { try await session.rpc.call(PushRegistration.statusTag, payload: Empty(), as: PushStatus.self) }
  func register(_ registration: PushRegistration) async throws -> PushStatus {
    try await session.rpc.call(PushRegistration.registerTag, payload: registration, as: PushStatus.self)
  }
  func show(_ label: String, _ status: PushStatus) {
    let kinds = status.registeredKinds.map { "[\($0.map(\.rawValue).joined(separator: ","))]" } ?? "none"
    print(
      "\(label.padding(toLength: 18, withPad: " ", startingAt: 0)) relayConfigured=\(status.relayConfigured) relayConnected=\(status.relayConnected) ios=\(status.availableOnIOS) registration=\(kinds) → \(PushComputerState.derive(connected: true, status: status, error: nil))"
    )
  }
  let raw = try await session.rpc.call(PushRegistration.statusTag, payload: Empty(), as: JSONValue.self)
  print("status (raw):      \(String(decoding: try JSONEncoder.sorted.encode(raw), as: UTF8.self).replacingOccurrences(of: "\n", with: " "))")
  show("status:", try await status())
  let registration = PushRegistration(
    token: token ?? String(repeating: "0f", count: 32), appId: "com.ankiel.code.native", apnsEnvironment: .sandbox,
    kinds: [.completed, .failed, .approval, .input], locale: Locale.preferredLanguages.first ?? "en")
  show("registered:", try await register(registration))
  show("status again:", try await status())
  var bad = registration
  bad.token = "not-hex"
  do {
    _ = try await register(bad)
    throw ProbeFailure(description: "A malformed token was accepted.")
  } catch let error as RpcError {
    print("malformed token:   refused (\(error))")
  }
  let after = try await session.rpc.call(PushRegistration.unregisterTag, payload: Empty(), as: PushStatus.self)
  show("unregistered:", after)
  guard after.registeredKinds == nil else { throw ProbeFailure(description: "Still registered after unregister.") }
  print("push: ok")
}

/// `--live push-stage`: a Replay thread left waiting on a request, and the `.apns` payload the
/// server's `AgentAlertPush` would send for it (written to `--out`), so a simulator can press the
/// alert's buttons with `simctl push`. Waits up to `--wait` seconds for the request to end, prints
/// how it ended, then deletes the thread.
@MainActor
func livePushStage(_ session: EnvironmentSession, scenario: String, out: String?, wait: Double) async throws {
  try await withReplayThread(session, scenario: scenario) { threadId, _, watcher in
    let state = try await watcher.until(60, "a pending request", waitingFor)
    let approval = state.pending.approvals.first
    let question = state.pending.userInputs.first
    guard let requestId = approval?.requestId ?? question?.requestId else { throw ProbeFailure(description: "No request.") }
    let isApproval = approval != nil
    let payload: JSONValue = [
      "Simulator Target Bundle": "com.ankiel.code.native",
      "aps": [
        "alert": ["title": .string(state.title ?? "Replay thread"), "loc-key": .string(isApproval ? "ANKIEL_PUSH_APPROVAL" : "ANKIEL_PUSH_INPUT")],
        "sound": "default", "thread-id": .string("\(session.environmentId)/\(threadId)"), "interruption-level": "active",
        "category": .string(isApproval ? "ANKIEL_APPROVAL" : "ANKIEL_INPUT_REPLY"),
      ],
      "body": [
        "environmentId": .string(session.environmentId), "threadId": .string(threadId), "kind": .string(isApproval ? "approval" : "input"),
        "requestId": .string(requestId), "requestThreadId": .string(threadId),
      ],
    ]
    let data = try JSONEncoder.sorted.encode(payload)
    if let out { try data.write(to: URL(filePath: out)) }
    print("staged:            \(isApproval ? "approval" : "question") \(requestId) on thread \(threadId)\(out.map { " → \($0)" } ?? "")")
    let ended = try await watcher.until(wait, "the request to end") { $0.pending.isEmpty }
    print("request ended:     \(ended.outcomes[requestId].map { "\($0)" } ?? "no outcome")")
  }
}
