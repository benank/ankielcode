import Foundation
import Testing

@testable import AnkielKit

/// Issue reads: requests compared with `Fixtures/commands/issue-*.json` (decoded by
/// `check-schemas.mjs` with the server's schemas) and tolerant decoding of synthetic answers.
@Suite("Issues")
struct IssueTests {
  static let ref = IssueRef(projectId: "proj-tide", tracker: "github", host: "github.com", scope: "tide-co/tide-chart", key: "42")

  static let samples: [(name: String, schema: String, value: any Encodable & Sendable)] = [
    ("issue-list", "issuesList", IssueListRequest(state: .open, limit: 50)),
    ("issue-list-project", "issuesList", IssueListRequest(state: .closed, projectId: "proj-tide", limit: 50, refresh: true, query: "  tides  ")),
    ("issue-detail", "issueRef", ref),
    ("issue-comments", "issueComments", IssueCommentsRequest(ref, cursor: "Y3Vyc29yOjQy")),
  ]

  static var directory: URL {
    URL(filePath: #filePath).deletingLastPathComponent().appending(path: "Fixtures/commands", directoryHint: .isDirectory)
  }

  @Test("each request encodes exactly as its checked-in fixture", arguments: samples.map(\.name))
  func matchesFixture(_ name: String) throws {
    let sample = try #require(Self.samples.first { $0.name == name })
    let encoded = try JSONEncoder.wire.encode(sample.value)
    let url = Self.directory.appending(path: "\(name).json")
    if ProcessInfo.processInfo.environment["ANKIEL_WRITE_COMMAND_FIXTURES"] == "1" {
      let pretty = JSONEncoder()
      pretty.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
      let value = try JSONDecoder().decode(JSONValue.self, from: encoded)
      let document: JSONValue = ["schema": .string(sample.schema), "value": value]
      try pretty.encode(document).write(to: url)
    }
    let fixture = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url))
    #expect(fixture["schema"] == .string(sample.schema))
    #expect(try JSONDecoder().decode(JSONValue.self, from: encoded) == fixture["value"])
  }

  static let entry = """
    {"tracker":"github","host":"github.com","scope":"tide-co/tide-chart","key":"42","displayKey":"#42",
    "title":"Tide table skips leap days","url":"https://github.com/tide-co/tide-chart/issues/42",
    "author":{"login":"marina","name":null,"avatarUrl":null},"state":{"category":"open","name":"Open"},
    "createdAt":"2026-11-20T10:00:00.000Z","updatedAt":"2026-11-26T10:00:00.000Z","closedAt":null,
    "assignees":[],"labels":[{"name":"bug","color":"d73a4a"}],"commentCount":3,
    "projectId":"proj-tide","projectTitle":"tide-chart"
    """

  @Test("a listing keeps readable rows and skips broken ones")
  func list() throws {
    let json = """
      {"viewers":{},"trackers":[{"tracker":"github","host":"github.com","projectCount":1,"capabilities":null,"configured":true,"detail":null}],
      "entries":[\(Self.entry)},{"title":"no keys"}],"errors":[],"nextCursors":{"github.com tide-co/tide-chart":"c2"}}
      """
    let result = try decode(IssueListResult.self, json: json)
    #expect(result.entries.count == 1)
    let row = try #require(result.entries.first)
    #expect(row.displayKey == "#42")
    #expect(row.state.isOpen)
    #expect(row.labels.first?.color == "d73a4a")
    #expect(row.ref == Self.ref)
    #expect(result.nextCursors.count == 1)
    #expect(IssueCalls.threadPrompt(row) == "Tide table skips leap days\n\nhttps://github.com/tide-co/tide-chart/issues/42")
  }

  @Test("a detail reads its body, comments and whether it takes comments")
  func detail() throws {
    let json = """
      \(Self.entry),"writable":true,"capabilities":{"create":true,"edit":true,"comment":true,"labels":true,"assignees":true,
      "reactions":true,"templates":false,"linkedPullRequests":true,"events":true,"search":true},
      "viewerPermissions":{"setState":true,"comment":true,"edit":true,"labels":true,"assignees":true},"states":[],
      "viewer":"marina","body":"Feb 29 is missing.","comments":[{"id":"c1","author":null,"body":"Same here","createdAt":"2026-11-21T10:00:00.000Z","url":null}],
      "commentsCursor":"c-older","events":[],"linkedPullRequests":[],"unknownField":1}
      """
    let detail = try decode(IssueDetail.self, json: json)
    #expect(detail.body == "Feb 29 is missing.")
    #expect(detail.comments.map(\.body) == ["Same here"])
    #expect(detail.commentsCursor == "c-older")
    #expect(detail.canComment)
    #expect(detail.entry.title == "Tide table skips leap days")
  }

  @Test("an unknown state category still decodes, as open")
  func unknownState() throws {
    let state = try decode(IssueState.self, json: #"{"category":"triage","name":"Triage"}"#)
    #expect(state.isOpen)
    #expect(try !decode(IssueState.self, json: #"{"category":"closed","name":"Closed","closeReason":"completed"}"#).isOpen)
  }
}

@Suite struct ThreadIssueBadgeTests {
  func link(_ key: String, at time: String) throws -> ThreadShell.IssueLink {
    let json = """
      {"tracker":"github","host":"github.com","scope":"tide-co/tide-chart","key":"\(key)","projectId":"proj-tide",
      "url":"https://github.com/tide-co/tide-chart/issues/\(key)","source":"agent","linkedAt":"\(time)",
      "displayKey":"#\(key)","title":"Issue \(key)"}
      """
    return try JSONDecoder().decode(ThreadShell.IssueLink.self, from: Data(json.utf8))
  }

  @Test func showsTheNewestLinkAndHowManyMore() throws {
    #expect(ThreadIssueBadge(nil) == nil)
    #expect(ThreadIssueBadge([]) == nil)
    let one = try #require(ThreadIssueBadge([link("7", at: "2026-11-01T10:00:00.000Z")]))
    #expect(one.label == "#7")
    let three = try #require(
      ThreadIssueBadge([
        link("7", at: "2026-11-01T10:00:00.000Z"), link("42", at: "2026-11-03T10:00:00.000Z"),
        link("9", at: "2026-11-02T10:00:00.000Z"),
      ]))
    #expect(three.label == "#42 +2")
    #expect(three.url.hasSuffix("/issues/42"))
  }
}

/// RN `issuesSupportedAtom`: Issues shows only where GitHub integration is on and the computer
/// says `capabilities.issues`; the list still takes any capable computer.
@MainActor @Suite("Issue computers")
struct IssueComputerTests {
  func computer(_ id: String, issues: Bool?, github: Bool, connected: Bool = true, enabled: Bool = true) -> EnvironmentModel {
    let endpoint = EnvironmentEndpoint(httpBaseURL: URL(string: "http://127.0.0.1:9/")!)!
    var record = EnvironmentRecord(SavedEnvironment(environmentId: id, label: id, endpoint: endpoint, serverVersion: "1"))
    record.enabled = enabled
    let model = EnvironmentModel(record: record)
    model.status = connected ? .connected : .offline
    if let issues { model.capabilities = ["issues": .bool(issues)] }
    model.settings.githubIntegrationEnabled = github
    return model
  }

  @Test func `the setting decodes, defaulting to off`() throws {
    #expect(try JSONDecoder().decode(ServerSettings.self, from: Data(#"{"githubIntegrationEnabled":true}"#.utf8)).githubIntegrationEnabled)
    #expect(try JSONDecoder().decode(ServerSettings.self, from: Data("{}".utf8)).githubIntegrationEnabled == false)
    #expect(try JSONDecoder().decode(ServerSettings.self, from: Data(#"{"githubIntegrationEnabled":"yes"}"#.utf8)).githubIntegrationEnabled == false)
  }

  @Test func `issues show only with the capability and GitHub integration`() {
    #expect(IssueComputers.available([computer("a", issues: true, github: true)]))
    #expect(!IssueComputers.available([computer("a", issues: true, github: false)]))
    #expect(!IssueComputers.available([computer("a", issues: nil, github: true)]))
    #expect(!IssueComputers.available([computer("a", issues: false, github: true)]))
    #expect(!IssueComputers.available([computer("a", issues: true, github: true, enabled: false)]))
    #expect(!IssueComputers.available([]))
  }

  @Test func `a pending integration write shows Issues at once`() {
    let target = computer("a", issues: true, github: false)
    target.pendingSettings = [PendingSettingsWrite(id: UUID(), patch: .githubIntegration(true))]
    #expect(IssueComputers.available([target]))
  }

  @Test func `the list takes capable computers, integration on and connected first`() {
    let off = computer("off", issues: true, github: false)
    let offline = computer("offline", issues: true, github: true, connected: false)
    let on = computer("on", issues: true, github: true)
    let none = computer("none", issues: nil, github: true)
    #expect(IssueComputers.choices([off, offline, none, on]).map(\.id) == ["on", "offline", "off"])
  }
}
