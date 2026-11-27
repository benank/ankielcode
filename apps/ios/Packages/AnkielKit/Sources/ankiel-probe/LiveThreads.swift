import AnkielKit
import Foundation

/// `--live threads`: subscribes to every shell thread twice, once raw (`JSONValue`) and once
/// through the client's decoder, reducer and timeline builder, and compares what the server holds
/// with what the client would render: item counts per kind, dropped items, unknown kinds.
func liveThreads(_ session: EnvironmentSession) async throws {
  let threads = try await shellThreads(session)
  print("threads: \(threads.count)")
  var problems = 0
  var largest = (bytes: 0, title: "")
  for thread in threads {
    let raw = try await rawSnapshot(session, threadId: thread.id)
    let bytes = (try? JSONEncoder().encode(raw).count) ?? 0
    if bytes > largest.bytes { largest = (bytes, thread.title) }
    let rawItems = raw["projection"]?["visibleTurnItems"]?.arrayValue ?? []
    var rawKinds: [String: Int] = [:]
    for row in rawItems { rawKinds[row["item"]?["type"]?.stringValue ?? "?", default: 0] += 1 }

    let decoded = try await decodedSnapshot(session, threadId: thread.id)
    guard let projection = decoded else {
      print("  ✗ \(thread.title.prefix(50)): snapshot did not decode")
      problems += 1
      continue
    }
    var kinds: [String: Int] = [:]
    var unknown: [String] = []
    for row in projection.visibleTurnItems {
      kinds[row.item.body.wireType, default: 0] += 1
      if case .unknown(let type) = row.item.body { unknown.append(type) }
    }
    let timeline = ThreadTimelineBuilder.build(projection, markdown: MarkdownParser(style: MarkdownStyle()), cache: TimelineCache())
    var rowKinds: [String: Int] = [:]
    for row in timeline.rows { rowKinds[rowKind(row.content), default: 0] += 1 }
    let same = rawKinds == kinds
    if !same || !unknown.isEmpty { problems += 1 }
    let title = thread.title.isEmpty ? "(untitled)" : String(thread.title.prefix(44))
    print(
      "  \(same && unknown.isEmpty ? "✓" : "✗") \(title): \(rawItems.count) items, \(bytes / 1024) KB, runs \(projection.runs.count), requests \(projection.runtimeRequests.count) → \(timeline.rows.count) rows \(rowKinds.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: " "))"
    )
    if !same { print("      raw \(rawKinds.sorted { $0.key < $1.key })\n      got \(kinds.sorted { $0.key < $1.key })") }
    if !unknown.isEmpty { print("      unknown kinds: \(unknown)") }
  }
  print("largest snapshot: \(largest.bytes / 1024) KB (\(largest.title.prefix(50)))\(largest.bytes > 48 * 1024 ? " → split into frame parts" : "")")
  if problems > 0 { throw ProbeFailure(description: "\(problems) thread(s) differ.") }
}

func rowKind(_ content: TimelineRow.Content) -> String {
  switch content {
  case .user: "user"
  case .assistant: "assistant"
  case .fold: "fold"
  case .workGroup: "group"
  case .work: "work"
  case .subagent: "subagent"
  case .plan: "plan"
  case .notice: "notice"
  case .answered: "answered"
  case .working: "working"
  }
}

func shellThreads(_ session: EnvironmentSession) async throws -> [ThreadShell] {
  let stream = try await session.subscribeShell(session.initialConfig.shellSubscription)
  for try await item in stream {
    if case .snapshot(let snapshot, nil) = item { return snapshot.threads }
  }
  throw ProbeFailure(description: "The shell ended without a snapshot.")
}

/// The first snapshot of a thread as the server sent it.
func rawSnapshot(_ session: EnvironmentSession, threadId: String) async throws -> JSONValue {
  let stream = try await session.rpc.stream(
    ThreadSubscription.rpcTag, payload: ThreadSubscription(threadId: threadId), of: JSONValue.self)
  for try await item in stream {
    if item["kind"]?.stringValue == "snapshot" { return item }
  }
  throw ProbeFailure(description: "No snapshot for \(threadId).")
}

func decodedSnapshot(_ session: EnvironmentSession, threadId: String) async throws -> ThreadProjection? {
  let stream = try await session.rpc.stream(
    ThreadSubscription.rpcTag, payload: ThreadSubscription(threadId: threadId), of: ThreadStreamItem.self)
  for try await item in stream {
    switch item {
    case .snapshot(let snapshot): return snapshot.projection
    case .skipped(_, let reason) where reason.hasPrefix("snapshot"): return nil
    default: continue
    }
  }
  return nil
}

extension JSONValue {
  var arrayValue: [JSONValue]? {
    if case .array(let values) = self { values } else { nil }
  }
}
