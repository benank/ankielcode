import Foundation
import Testing

@testable import AnkielKit

/// Ported from `packages/client-runtime/src/state/shellReducer.test.ts`.
@Suite struct ShellReducerTests {
  let identity = try! decode(
    RepositoryIdentity.self,
    json: #"{"canonicalKey":"github.com/example/repo","locator":{"source":"git-remote","remoteName":"origin","remoteUrl":"https://github.com/example/repo.git"}}"#)
  let otherIdentity = try! decode(
    RepositoryIdentity.self,
    json: #"{"canonicalKey":"github.com/example/other","locator":{"source":"git-remote","remoteName":"origin","remoteUrl":"https://github.com/example/other.git"}}"#)

  func project(
    _ id: String = "project-1", root: String = "/workspace/example", identity: RepositoryIdentity? = nil,
    title: String = "Example"
  ) throws -> ProjectShell {
    var project = try Fixture.project
    project.id = id
    project.workspaceRoot = root
    project.repositoryIdentity = identity
    project.title = title
    return project
  }

  func snapshot(sequence: Int = 0, projects: [ProjectShell] = [], threads: [ThreadShell] = [], archived: [ThreadShell] = []) -> ShellSnapshot {
    ShellSnapshot(snapshotSequence: sequence, threads: threads, archivedThreads: archived, projects: projects)
  }

  func update(_ sequence: Int, _ thread: ThreadShell, _ location: ShellLocation = .active) -> ShellDelta {
    .threadUpdated(sequence: sequence, location: .known(location), thread: thread)
  }

  func remove(_ sequence: Int, _ id: String) -> ShellDelta {
    .threadRemoved(sequence: sequence, location: .known(.active), threadId: id)
  }

  @Test func `ignores stale project updates`() throws {
    let seed = snapshot(sequence: 4, projects: [try project()])
    for sequence in [3, 4] {
      let next = ShellReducer.apply([.projectUpdated(sequence: sequence, project: try project(title: "Stale"))], to: seed)
      #expect(next == seed)
    }
  }

  @Test func `keeps the prior identity when a delta arrives with null identity`() throws {
    let withIdentity = ShellReducer.apply([.projectUpdated(sequence: 1, project: try project(identity: identity))], to: snapshot())
    let next = ShellReducer.apply([.projectUpdated(sequence: 2, project: try project(title: "Still same root"))], to: withIdentity)
    #expect(next.projects[0].title == "Still same root")
    #expect(next.projects[0].repositoryIdentity == identity)
  }

  @Test func `does not keep the prior identity after a workspace root move`() throws {
    let withIdentity = ShellReducer.apply([.projectUpdated(sequence: 1, project: try project(identity: identity))], to: snapshot())
    let moved = ShellReducer.apply([.projectUpdated(sequence: 2, project: try project(root: "/tmp/other-root"))], to: withIdentity)
    #expect(moved.projects[0].workspaceRoot == "/tmp/other-root")
    #expect(moved.projects[0].repositoryIdentity == nil)
  }

  @Test func `an authoritative lower-sequence snapshot replaces client-ahead state`() throws {
    let unchanged = try project("project-unchanged", identity: identity)
    let previous = snapshot(
      sequence: 9, projects: [try project(identity: identity, title: "Client ahead"), unchanged],
      threads: [try Fixture.thread("thread-1", title: "Local-only thread")])
    let next = ShellReducer.merge(
      previous,
      with: snapshot(
        sequence: 3, projects: [try project(title: "Server reset"), unchanged],
        threads: [try Fixture.thread("thread-1", title: "Server thread")]),
      resolvedRepositoryIdentityRoots: nil)
    #expect(next.snapshotSequence == 3)
    #expect(next.projects[0].title == "Server reset")
    #expect(next.projects[0].repositoryIdentity == identity)
    #expect(next.projects[1] == unchanged)
    #expect(next.threads[0].title == "Server thread")
  }

  @Test func `client-ahead survives a marked enrichment, then resets on an authoritative snapshot`() throws {
    let previous = snapshot(
      sequence: 20, projects: [try project(identity: identity, title: "Client ahead")],
      threads: [try Fixture.thread("thread-1", title: "Local-only thread")])
    let server = snapshot(
      sequence: 3, projects: [try project(title: "Server reset")], threads: [try Fixture.thread("thread-1", title: "Server thread")])

    let enriched = ShellReducer.merge(previous, with: server, resolvedRepositoryIdentityRoots: ["/workspace/example"])
    #expect(enriched.snapshotSequence == 20)
    #expect(enriched.projects[0].title == "Client ahead")
    #expect(enriched.projects[0].repositoryIdentity == nil)
    #expect(enriched.threads[0].title == "Local-only thread")

    let reset = ShellReducer.merge(enriched, with: server, resolvedRepositoryIdentityRoots: nil)
    #expect(reset.snapshotSequence == 3)
    #expect(reset.projects[0].title == "Server reset")
    #expect(reset.projects[0].repositoryIdentity == nil)
    #expect(reset.threads[0].title == "Server thread")
  }

  @Test func `a lower-sequence enrichment adds identity without reverting threads`() throws {
    let previous = snapshot(sequence: 5, projects: [try project()], threads: [try Fixture.thread("thread-1", title: "Newest title")])
    let next = ShellReducer.merge(
      previous,
      with: snapshot(sequence: 4, projects: [try project(identity: identity)], threads: [try Fixture.thread("thread-1", title: "Stale title")]),
      resolvedRepositoryIdentityRoots: ["/workspace/example"])
    #expect(next.snapshotSequence == 5)
    #expect(next.threads[0].title == "Newest title")
    #expect(next.projects[0].repositoryIdentity == identity)
  }

  @Test func `an enrichment cannot resurrect empty structural state`() throws {
    let next = ShellReducer.merge(
      snapshot(sequence: 7),
      with: snapshot(sequence: 4, projects: [try project(identity: identity)], threads: [try Fixture.thread]),
      resolvedRepositoryIdentityRoots: ["/workspace/example"])
    #expect(next.snapshotSequence == 7)
    #expect(next.projects.isEmpty)
    #expect(next.threads.isEmpty)
  }

  @Test func `a resolved null clears identity only for the marked root`() throws {
    let other = try project("project-other", root: "/workspace/other", identity: otherIdentity)
    let next = ShellReducer.merge(
      snapshot(sequence: 5, projects: [try project(identity: identity), other]),
      with: snapshot(sequence: 4, projects: [try project(), try project("project-other", root: "/workspace/other")]),
      resolvedRepositoryIdentityRoots: ["/workspace/example"])
    #expect(next.snapshotSequence == 5)
    #expect(next.projects.count == 2)
    #expect(next.projects[0].repositoryIdentity == nil)
    #expect(next.projects[1].repositoryIdentity == otherIdentity)
  }

  @Test func `an unmarked enrichment does not replace a live identity`() throws {
    let next = ShellReducer.merge(
      snapshot(sequence: 5, projects: [try project(identity: identity)]),
      with: snapshot(sequence: 4, projects: [try project(identity: otherIdentity)]),
      resolvedRepositoryIdentityRoots: [])
    #expect(next.projects[0].repositoryIdentity == identity)
  }

  @Test func `archive deltas stay out of the normal shell`() throws {
    var archivedRow = try Fixture.thread
    archivedRow.archivedAt = archivedRow.updatedAt
    let archived = ShellReducer.apply([update(3, archivedRow, .archive)], to: snapshot())
    #expect(archived.threads.isEmpty)
    #expect(archived.archivedThreads.isEmpty)
    let active = ShellReducer.apply([update(4, try Fixture.thread)], to: archived)
    #expect(active.threads.count == 1)
    #expect(active.archivedThreads.isEmpty)
  }

  @Test func `mixed deltas apply in order, including remove-reinsert and stale events`() throws {
    let a = try Fixture.thread("a"), b = try Fixture.thread("b"), unchanged = try Fixture.thread("unchanged")
    let archived = try Fixture.thread("archived"), oldArchive = try Fixture.thread("old-archive")
    let added = try Fixture.thread("new")
    var renamed = b
    renamed.title = "Renamed"
    let other = try project("other-project")
    let seed = snapshot(
      sequence: 4, projects: [try project(identity: identity), other], threads: [a, b, unchanged],
      archived: [archived, oldArchive])
    let events: [ShellDelta] = [
      update(5, renamed), remove(5, "a"), remove(6, "a"), update(7, a), update(8, b, .archive),
      update(9, archived), update(10, oldArchive, .archive), update(11, added), remove(12, "missing"),
      remove(11, "new"), remove(13, "new"), update(14, added), update(15, archived),
      .projectUpdated(sequence: 16, project: try project(title: "Updated")),
      .projectUpdated(sequence: 17, project: try project(root: "/moved")),
      .projectRemoved(sequence: 18, projectId: "project-1"),
      .projectUpdated(sequence: 19, project: try project()),
    ]
    let next = ShellReducer.apply(events, to: seed)
    #expect(next.threads.map(\.id) == ["unchanged", "a", "archived", "new"])
    #expect(next.archivedThreads.isEmpty)
    #expect(next.projects.map(\.id) == ["other-project", "project-1"])
    #expect(next.snapshotSequence == 19)
    #expect(ShellReducer.apply(events.prefix(14), to: seed).projects[0].repositoryIdentity == identity)
    #expect(ShellReducer.apply(events.prefix(15), to: seed).projects[0].repositoryIdentity == nil)
  }

  @Test func `equal rows and stale deltas leave the snapshot unchanged except the cursor`() throws {
    let a = try Fixture.thread("a"), b = try Fixture.thread("b")
    let seed = snapshot(sequence: 4, threads: [a, b])
    let next = ShellReducer.apply([update(5, a), update(6, b)], to: seed)
    #expect(next.threads == seed.threads)
    #expect(next.snapshotSequence == 6)
    #expect(ShellReducer.apply([remove(3, "a"), update(4, b)], to: seed) == seed)
  }

}

@Suite struct ShellStateTests {
  @Test func `the live cold sequence ends live with the authoritative rows`() throws {
    var project = try Fixture.project
    let authoritative = ShellSnapshot(snapshotSequence: 42, threads: [try Fixture.thread], projects: [project])
    project.repositoryIdentity = try decode(RepositoryIdentity.self, json: #"{"canonicalKey":"k"}"#)
    let enrichment = ShellSnapshot(snapshotSequence: 42, projects: [project])

    var state = ShellState()
    #expect(state.status == .empty)
    state.apply(.snapshot(authoritative, resolvedRepositoryIdentityRoots: nil))
    #expect(state.status == .synchronizing)
    state.apply(.snapshot(enrichment, resolvedRepositoryIdentityRoots: ["/workspace/example"]))
    #expect(state.threads.count == 1)
    #expect(state.projects[0].repositoryIdentity?.canonicalKey == "k")
    state.apply(.synchronized)
    #expect(state.status == .live)
    #expect(state.sequence == 42)
  }

  @Test func `deltas before a snapshot are dropped and unknown items never move the cursor`() throws {
    var state = ShellState()
    state.apply(.delta(.threadUpdated(sequence: 1, location: .known(.active), thread: try Fixture.thread)))
    #expect(state.snapshot == nil)
    state.apply([.snapshot(ShellSnapshot(snapshotSequence: 1), resolvedRepositoryIdentityRoots: nil), .unknown(kind: "future.event")])
    #expect(state.sequence == 1)
    state.apply([.undecodable(kind: "thread.updated", reason: "x"), .snapshotRequired])
    #expect(state.undecodableItems == 1)
    #expect(state.needsSnapshotReload)
  }

  @Test func `deltas after synchronized keep the state live`() throws {
    var state = ShellState(awaitingCompletion: false)
    state.apply([
      .snapshot(ShellSnapshot(snapshotSequence: 1), resolvedRepositoryIdentityRoots: nil),
      .delta(.threadUpdated(sequence: 2, location: .known(.active), thread: try Fixture.thread)),
    ])
    #expect(state.status == .live)
    #expect(state.threads.count == 1)
  }
}

@Suite struct ShellDeltaLocationTests {
  @Test func `a delta with an unknown location is ignored`() throws {
    let seed = ShellSnapshot(snapshotSequence: 1, threads: [try Fixture.thread])
    let next = ShellReducer.apply(
      [.threadUpdated(sequence: 2, location: .unknown("elsewhere"), thread: try Fixture.thread)], to: seed)
    #expect(next == seed)
  }
}
