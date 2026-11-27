import AnkielKit
import Foundation

/// `--live archive`: the Archived screen's wire paths on a Replay thread the probe launches:
/// archive → listed by `getArchivedShellSnapshot` and gone from the shell → a thread snapshot of
/// the archived id (read-only open) → unarchive → back in the shell → archive → delete → gone.
///
/// `--seed <n>` instead launches and archives n threads titled "probe archive <i>" (for the
/// Archived screen); `--seed-clean` deletes every archived thread with that title prefix.
func liveArchive(_ session: EnvironmentSession) async throws {
  if let count = argument("--seed").flatMap(Int.init) {
    for index in 1...count {
      let (result, _) = try await launchReplayThread(session, scenario: "showcase", runtimeMode: .fullAccess)
      _ = try? await dispatch(session, .stop, result.threadId)
      try await dispatch(session, .rename("probe archive \(index)"), result.threadId)
      try await dispatch(session, .archive, result.threadId)
      print("archived \(result.threadId)")
    }
    return
  }
  if CommandLine.arguments.contains("--seed-clean") {
    let listing = try await session.rpc.call(ArchivedShellRequest.rpcTag, payload: ArchivedShellRequest(), as: ArchivedShellSnapshot.self)
    for thread in listing.threads where thread.title.hasPrefix("probe archive") { await deleteThread(session, thread.id) }
    for thread in try await shellThreads(session) where thread.title.hasPrefix("probe archive") { await deleteThread(session, thread.id) }
    return
  }
  let (result, _) = try await launchReplayThread(session, scenario: "showcase", runtimeMode: .fullAccess)
  let id = result.threadId
  print("launched thread \(id)")
  var failures: [String] = []
  func check(_ name: String, _ ok: Bool, _ detail: String = "") {
    if !ok { failures.append(name) }
    print("  \(ok ? "✓" : "✗") \(name)\(detail.isEmpty ? "" : ": \(detail)")")
  }
  func archived() async throws -> ArchivedShellSnapshot {
    try await session.rpc.call(ArchivedShellRequest.rpcTag, payload: ArchivedShellRequest(), as: ArchivedShellSnapshot.self)
  }
  do {
    _ = try? await dispatch(session, .stop, id)
    try await Task.sleep(for: .seconds(1))
    try await dispatch(session, .archive, id)
    let listing = try await archived()
    let row = listing.threads.first { $0.id == id }
    check("archived row listed", row != nil, "archivedAt=\(row?.archivedAt?.rawValue ?? "nil"), \(listing.threads.count) archived")
    check("its project is in the answer", row.map { r in listing.projects.contains { $0.id == r.projectId } } ?? false)
    check("gone from the shell", try await !shellThreads(session).contains { $0.id == id })
    let projection = try await decodedSnapshot(session, threadId: id)
    check("an archived thread still subscribes", projection != nil, "\(projection?.messages.count ?? 0) messages")
    try await dispatch(session, .unarchive, id)
    check("unarchive puts it back in the shell", try await shellThreads(session).contains { $0.id == id })
    check("and out of the archive", try await !archived().threads.contains { $0.id == id })
    try await dispatch(session, .archive, id)
    try await dispatch(session, .delete, id)
    check("delete removes it from the archive", try await !archived().threads.contains { $0.id == id })
    check("and the shell", try await !shellThreads(session).contains { $0.id == id })
  } catch {
    await deleteThread(session, id)
    throw error
  }
  if !failures.isEmpty { throw ProbeFailure(description: "archive: \(failures.joined(separator: ", "))") }
  print("archive: all checks passed")
}
