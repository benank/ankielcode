import AnkielKit
import Foundation

/// Debug launch hooks for issues (README, "Debug hooks"). `ANKIEL_DEBUG_ISSUES=fixture` reads canned,
/// synthetic issues about a made-up project instead of a computer (`fail` refuses, `empty` has
/// none); `ANKIEL_DEBUG_ISSUES_OPEN=list` opens Issues over home, `detail` its first issue.
/// Issues are read-only, so there is no write sink to fake.
@MainActor
enum IssuesDebug {
  static let environmentId = "debug-issues"

  static var source: (any IssueSource)? {
    #if DEBUG
      guard let mode = ProcessInfo.processInfo.environment["ANKIEL_DEBUG_ISSUES"] else { return nil }
      return FixtureIssueSource(mode: mode)
    #else
      nil
    #endif
  }

  /// Whether a launch asked for Issues to open over home.
  static var opensAtLaunch: Bool {
    #if DEBUG
      ProcessInfo.processInfo.environment["ANKIEL_DEBUG_ISSUES_OPEN"] != nil
    #else
      false
    #endif
  }

  static func openedEntry(_ issues: IssuesModel) -> IssueEntry? {
    #if DEBUG
      guard ProcessInfo.processInfo.environment["ANKIEL_DEBUG_ISSUES_OPEN"] == "detail", issues.source is FixtureIssueSource else {
        return nil
      }
      return FixtureIssueSource.entries.first
    #else
      nil
    #endif
  }
}

#if DEBUG
  @MainActor
  private struct FixtureIssueSource: IssueSource {
    let mode: String

    static let entries: [IssueEntry] = [
      IssueEntry(
        scope: "tide-co/tide-chart", key: "42", title: "Tide table skips Feb 29 in leap years",
        state: IssueState(category: .open, name: "Open"), projectId: "proj-tide", projectTitle: "tide-chart",
        updatedAt: stamp(-3_600), labels: [IssueLabel(name: "bug", color: "d73a4a"), IssueLabel(name: "calendar", color: "0e8a16")],
        author: IssueActor(login: "marina"), commentCount: 3),
      IssueEntry(
        scope: "tide-co/tide-chart", key: "38", title: "Add a widget with the next high tide",
        state: IssueState(category: .open, name: "Open"), projectId: "proj-tide", projectTitle: "tide-chart",
        updatedAt: stamp(-86_400), labels: [IssueLabel(name: "enhancement", color: "a2eeef")],
        author: IssueActor(login: "pier"), commentCount: 1),
      IssueEntry(
        scope: "tide-co/tide-api", key: "7", title: "Station list returns duplicates after a sync that was interrupted halfway",
        state: IssueState(category: .open, name: "Open"), projectId: "proj-api", projectTitle: "tide-api",
        updatedAt: stamp(-3 * 86_400), author: IssueActor(login: "harbor")),
      IssueEntry(
        scope: "tide-co/tide-chart", key: "31", title: "Chart axis labels overlap on small phones",
        state: IssueState(category: .closed, name: "Closed", closeReason: "completed"), projectId: "proj-tide",
        projectTitle: "tide-chart", updatedAt: stamp(-9 * 86_400), labels: [IssueLabel(name: "bug", color: "d73a4a")],
        author: IssueActor(login: "marina"), commentCount: 5),
    ]

    private static func stamp(_ offset: TimeInterval) -> String {
      Date.now.addingTimeInterval(offset).formatted(.iso8601)
    }

    func list(_ request: IssueListRequest, environmentId: String) async throws(EnvironmentRequestError) -> IssueListResult {
      if mode == "fail" { throw .rejected(message: "gh is not signed in on this computer.") }
      if mode == "empty" { return IssueListResult(entries: []) }
      let query = request.query?.lowercased()
      let rows = Self.entries.filter { entry in
        (request.state == .all || (request.state == .open) == entry.state.isOpen)
          && (request.projectId == nil || entry.projectId == request.projectId)
          && (query == nil || entry.title.lowercased().contains(query!))
      }
      // Two to a page, so paging runs on fixtures too.
      let start = request.cursors?["tide-co"].flatMap(Int.init) ?? 0
      let page = Array(rows.dropFirst(start).prefix(2))
      let next = start + page.count < rows.count ? ["tide-co": String(start + page.count)] : [:]
      return IssueListResult(entries: page, nextCursors: next)
    }

    func detail(_ ref: IssueRef, environmentId: String) async throws(EnvironmentRequestError) -> IssueDetail {
      guard let entry = Self.entries.first(where: { $0.ref == ref }) else { throw .rejected(message: nil) }
      let body = """
        On leap years the table jumps from **Feb 28** to **Mar 1**.

        Steps:
        1. Pick a station
        2. Open February 2028

        Expected the 29th to show its four tides.
        """
      let comments = [
        IssueComment(id: "c1", author: IssueActor(login: "pier"), body: "Same on the API side: `GET /tides?date=2028-02-29` is empty.", createdAt: Self.stamp(-7_200)),
        IssueComment(id: "c2", author: IssueActor(login: "marina"), body: "Looks like the month table hard-codes 28 days.", createdAt: Self.stamp(-3_600)),
      ]
      return IssueDetail(entry: entry, body: body, comments: comments, commentsCursor: "older")
    }

    func olderComments(_ ref: IssueRef, cursor: String, environmentId: String) async throws(EnvironmentRequestError) -> IssueCommentsPage {
      IssueCommentsPage(
        comments: [IssueComment(id: "c0", author: IssueActor(login: "harbor"), body: "First noticed this in 2024.", createdAt: Self.stamp(-30 * 86_400))],
        nextCursor: nil)
    }
  }
#endif
