import Foundation
import Testing

@testable import AnkielKit

@Suite("Archive")
struct ArchiveTests {
  /// Fixtures `check-schemas.mjs` decodes with the server's schemas (same format as
  /// `CommandEncodingTests`; `ANKIEL_WRITE_COMMAND_FIXTURES=1` rewrites them).
  static let samples: [(name: String, schema: String, value: any Encodable & Sendable)] = [
    ("archived-snapshot", "archivedSnapshot", ArchivedShellRequest()),
    ("thread-archive", "command", CommandEncodingTests.thread(.archive)),
    ("thread-unarchive", "command", CommandEncodingTests.thread(.unarchive)),
    ("thread-delete", "command", CommandEncodingTests.thread(.delete)),
  ]

  @Test("archive requests encode exactly as their fixtures", arguments: samples.map(\.name))
  func matchesFixture(_ name: String) throws {
    let sample = try #require(Self.samples.first { $0.name == name })
    let encoded = try JSONEncoder.wire.encode(sample.value)
    let url = CommandEncodingTests.directory.appending(path: "\(name).json")
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

  static func row(_ id: String, title: String, project: String, archivedAt: String?, branch: String? = nil) throws -> ThreadShell {
    var row = try Fixture.thread(id, title: title)
    row.projectId = project
    row.archivedAt = archivedAt.map(WireTimestamp.init(rawValue:))
    row.branch = branch
    return row
  }

  static func project(_ id: String, title: String) throws -> ProjectShell {
    var project = try Fixture.project
    project.id = id
    project.title = title
    project.workspaceRoot = "/work/\(title)"
    return project
  }

  static func sources() throws -> [ArchivedThreadList.Source] {
    let a = ArchivedShellSnapshot(
      projects: [try project("p1", title: "harbor"), try project("p2", title: "tides")],
      threads: [
        try row("t1", title: "Fix the buoy parser", project: "p1", archivedAt: "2026-11-20T10:00:00.000Z", branch: "fix/buoy"),
        try row("t2", title: "Chart colors", project: "p2", archivedAt: "2026-11-25T10:00:00.000Z"),
        try row("t3", title: "Still active", project: "p1", archivedAt: nil),
        try row("t4", title: "Orphan", project: "gone", archivedAt: "2026-11-26T10:00:00.000Z"),
      ])
    let b = ArchivedShellSnapshot(
      projects: [try project("p9", title: "lighthouse")],
      threads: [try row("t9", title: "Lamp timer", project: "p9", archivedAt: "2026-11-22T10:00:00.000Z")])
    return [
      .init(environmentId: "mac", label: "Studio Mac", snapshot: a), .init(environmentId: "box", label: "Build box", snapshot: b),
    ]
  }

  @Test("groups per computer and project, newest archive first, skipping live rows and unknown projects")
  func grouping() throws {
    let groups = ArchivedThreadList.groups(try Self.sources())
    #expect(groups.map(\.id) == ["mac:p2", "box:p9", "mac:p1"])
    #expect(groups.flatMap(\.rows).map(\.ref.threadId) == ["t2", "t9", "t1"])
    #expect(groups[2].rows[0].branch == "fix/buoy")
    let oldest = ArchivedThreadList.groups(try Self.sources(), order: .oldest)
    #expect(oldest.map(\.id) == ["mac:p1", "box:p9", "mac:p2"])
  }

  @Test("search matches thread titles and branches, or a whole project or computer; the filter keeps one computer")
  func search() throws {
    let sources = try Self.sources()
    #expect(ArchivedThreadList.groups(sources, query: "BUOY").flatMap(\.rows).map(\.ref.threadId) == ["t1"])
    #expect(ArchivedThreadList.groups(sources, query: "fix/").flatMap(\.rows).map(\.ref.threadId) == ["t1"])
    #expect(ArchivedThreadList.groups(sources, query: "build box").flatMap(\.rows).map(\.ref.threadId) == ["t9"])
    #expect(ArchivedThreadList.groups(sources, query: "tides").flatMap(\.rows).map(\.ref.threadId) == ["t2"])
    #expect(ArchivedThreadList.groups(sources, query: "nothing here").isEmpty)
    #expect(ArchivedThreadList.groups(sources, environmentId: "box").map(\.id) == ["box:p9"])
    #expect(ArchivedThreadList.groups(sources, hidden: ["mac:t2"]).map(\.id) == ["box:p9", "mac:p1"])
  }

  @Test("the snapshot decodes leniently: a bad row is dropped, not the answer")
  func decoding() throws {
    guard case .object(var good) = try Fixture.json("thread-shell") else { throw CocoaError(.coderReadCorrupt) }
    good["archivedAt"] = "2026-11-20T10:00:00.000Z"
    let json: JSONValue = [
      "schemaVersion": 1, "snapshotSequence": 12, "projects": [try Fixture.json("project-shell")],
      "threads": [.object(good), ["id": 3]],
    ]
    let snapshot = try JSONDecoder().decode(ArchivedShellSnapshot.self, from: JSONEncoder().encode(json))
    #expect(snapshot.snapshotSequence == 12)
    #expect(snapshot.threads.count == 1)
    #expect(snapshot.projects.count == 1)
  }
}
