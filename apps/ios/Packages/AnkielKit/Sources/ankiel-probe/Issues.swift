import AnkielKit
import Foundation

/// `--issues [--project <id>] [--query <text>] [--closed]`: read-only. Lists issues, opens the
/// newest one's detail and pages its older comments once. Nothing is written to the tracker.
func probeIssues(_ session: EnvironmentSession) async throws {
  let request = IssueListRequest(
    state: CommandLine.arguments.contains("--closed") ? .closed : .open, projectId: argument("--project"), limit: 10,
    query: argument("--query"))
  let list = try await IssueCalls.list(request, via: session.rpc)
  print("trackers:          \(list.trackers.map { "\($0.tracker)@\($0.host) configured=\($0.configured)\($0.detail.map { " (\($0))" } ?? "")" })")
  print("errors:            \(list.errors.map { "\($0.projectTitle): \($0.message)" })")
  print("entries:           \(list.entries.count), more scopes=\(list.nextCursors.count)")
  for entry in list.entries.prefix(5) {
    print("  \(entry.displayKey) [\(entry.state.name)] \(entry.title.prefix(60)) · \(entry.projectTitle) · \(entry.labels.map(\.name))")
  }
  guard let first = list.entries.first else { return }
  let detail = try await IssueCalls.detail(first.ref, via: session.rpc)
  print("detail:            \(detail.entry.displayKey) body=\(detail.body.count) chars comments=\(detail.comments.count) older=\(detail.commentsCursor != nil)")
  if let cursor = detail.commentsCursor {
    let page = try await IssueCalls.olderComments(first.ref, cursor: cursor, via: session.rpc)
    print("older comments:    \(page.comments.count), more=\(page.nextCursor != nil)")
  }
}
