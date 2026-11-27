import Foundation
import Testing

@testable import AnkielKit

/// Every pull request request, encoded and compared with `Fixtures/commands/pr-*.json`, which
/// `check-schemas.mjs` decodes strictly with the contracts' schemas. Writes are encoded through
/// `PullRequestWrite.payload()`, the exact bytes the sinks send.
/// `ANKIEL_WRITE_COMMAND_FIXTURES=1 swift test --filter PullRequestEncoding` rewrites the files.
@Suite("Pull request encoding")
struct PullRequestEncodingTests {
  static let ref = PullRequestRef(projectId: "proj-tide-chart", host: "github.com", repository: "tidewater/tide-chart", number: 42)

  static func write(_ write: PullRequestWrite) -> RawJSONPayload {
    RawJSONPayload(data: try! write.payload())
  }

  static let samples: [(name: String, schema: String, value: any Encodable & Sendable)] = [
    ("pr-list", "prList", PullRequestListRequest(state: .open, involvement: .all, filters: PullRequestListFilters(), limit: 30)),
    (
      "pr-list-filtered", "prList",
      PullRequestListRequest(
        state: .all, involvement: .reviewing,
        filters: PullRequestListFilters(draft: .hide, review: .changesRequested, checks: .failing, labels: [["bug", "regression"]], excludedLabels: ["wontfix"], author: "mira-dev"),
        projectId: "proj-tide-chart", limit: 60, cursors: ["github.com tidewater/tide-chart": "Y3Vyc29yOjMw"], query: "tide table")
    ),
    ("pr-list-stats", "prListStats", PullRequestListStatsRequest(refs: [ref])),
    ("pr-ref", "prRef", ref),
    ("pr-invalidate", "prInvalidate", PullRequestInvalidateRequest(reference: ref)),
    ("pr-invalidate-all", "prInvalidate", PullRequestInvalidateRequest()),
    ("pr-diff", "prDiff", PullRequestDiffRequest(ref: ref, cursor: "page-2")),
    ("pr-reviewer-candidates", "prReviewerCandidates", PullRequestRefPayload(ref, ReviewerQuery(query: "mira"))),
    ("pr-routing-identity", "prRoutingIdentity", PullRequestRoutingIdentityRequest(host: "github.com")),
    ("pr-comment", "prComment", write(.comment(ref, body: "Looks good once the tide table loads offline."))),
    ("pr-reply", "prReply", write(.reply(ref, threadId: "PRRT_synthetic_1", body: "Fixed in the next commit."))),
    ("pr-react", "prReaction", write(.react(ref, subjectId: "IC_synthetic_7", content: .rocket, reacted: true))),
    ("pr-react-body", "prReaction", write(.react(ref, subjectId: nil, content: .thumbsUp, reacted: false))),
    (
      "pr-review", "prReview",
      write(
        .review(
          ref,
          PullRequestReviewSubmission(
            expectedHeadSha: "3f2a9c1d7e5b4a6c8d0e2f4a6b8c0d2e4f6a8b0c", verdict: .requestChanges, body: "Two small things.",
            comments: [
              PullRequestReviewCommentDraft(path: "Sources/TideChart/Table.swift", position: .added(newLine: 18), body: "Cache this?"),
              PullRequestReviewCommentDraft(
                path: "Sources/TideChart/Station.swift", oldPath: "Sources/TideChart/Port.swift",
                position: .context(oldLine: 40, newLine: 42, side: .right), startPosition: .deleted(oldLine: 38), body: "Range note."),
            ])))
    ),
    ("pr-review-approve", "prReview", write(.review(ref, PullRequestReviewSubmission(expectedHeadSha: nil, verdict: .approve, body: "", comments: [])))),
    (
      "pr-merge", "prAction",
      write(.action(ref, PullRequestActionRequest(action: .merge, mergeMethod: .squash, expectedHeadSha: "3f2a9c1d7e5b4a6c8d0e2f4a6b8c0d2e4f6a8b0c")))
    ),
    ("pr-close", "prAction", write(.action(ref, PullRequestActionRequest(action: .close)))),
    ("pr-ready", "prAction", write(.action(ref, PullRequestActionRequest(action: .ready)))),
    ("pr-update-branch", "prAction", write(.action(ref, PullRequestActionRequest(action: .updateBranch, updateMethod: .rebase)))),
    ("pr-request-reviewers", "prReviewers", write(.requestReviewers(ref, reviewers: [.init(id: "U_synthetic_mira", kind: .user), .init(id: "T_synthetic_docs", kind: .team)], requested: true))),
    ("pr-update", "prUpdate", write(.update(ref, title: "Load tide tables offline", body: "Caches the last table.\n\n- [x] tests"))),
    ("pr-resolve", "prResolve", write(.resolveThread(ref, threadId: "PRRT_synthetic_1", resolved: true))),
    (
      "pr-asset-github-media", "assetUrl",
      AssetURLRequest(resource: .sourceControlMedia(cwd: "/Users/dev/tide-chart", url: "https://github.com/user-attachments/assets/1a2b-3c4d", repository: "tidewater/tide-chart"))
    ),
    ("pr-files-viewed", "prFilesViewed", write(.setFilesViewed(ref, files: [.init(path: "Sources/TideChart/Table.swift", viewed: true, revision: "a1b2c3")]))),
  ]

  @Test("each pull request request encodes exactly as its checked-in fixture", arguments: samples.map(\.name))
  func matchesFixture(_ name: String) throws {
    let sample = try #require(Self.samples.first { $0.name == name })
    let encoded = try JSONEncoder.wire.encode(sample.value)
    let url = CommandEncodingTests.directory.appending(path: "\(name).json")
    if ProcessInfo.processInfo.environment["ANKIEL_WRITE_COMMAND_FIXTURES"] == "1" {
      let pretty = JSONEncoder()
      pretty.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
      let value = try JSONDecoder().decode(JSONValue.self, from: encoded)
      try pretty.encode(["schema": .string(sample.schema), "value": value] as JSONValue).write(to: url)
    }
    let fixture = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url))
    #expect(fixture["schema"] == .string(sample.schema))
    #expect(try JSONDecoder().decode(JSONValue.self, from: encoded) == fixture["value"])
  }

  @Test("a void write answer decodes, whatever the server sends")
  func voidAnswers() throws {
    #expect(throws: Never.self) { try JSONDecoder().decode(RpcVoid.self, from: Data("null".utf8)) }
    #expect(throws: Never.self) { try JSONDecoder().decode(RpcVoid.self, from: Data("{}".utf8)) }
    // Actions answer a summary, or nothing from servers that predate `replyWithSummary`.
    #expect(try JSONDecoder().decode(PullRequestCalls.OptionalSummary.self, from: Data("null".utf8)).summary == nil)
    let summary = """
      {"provider":"github","projectId":"p","repository":"tidewater/tide-chart","number":42,"title":"T","url":"https://github.com/tidewater/tide-chart/pull/42","state":"merged","headBranch":"h","baseBranch":"main","updatedAt":"2026-11-20T10:00:00.000Z"}
      """
    #expect(try JSONDecoder().decode(PullRequestCalls.OptionalSummary.self, from: Data(summary.utf8)).summary?.state == .merged)
  }

  @Test("typed refusals keep their reasons")
  func errors() {
    let unavailable: JSONValue = ["_tag": "PullRequestUnavailableError", "reason": "cli-unauthenticated", "requirement": "Sign in with gh auth login."]
    #expect(
      PullRequestError(RpcError.failed(RpcFailure(error: unavailable)))
        == .unavailable(.init(reason: .known(.cliUnauthenticated), requirement: "Sign in with gh auth login.")))
    let missing: JSONValue = ["_tag": "PullRequestOperationError", "operation": "detail", "detail": "Not found.", "reason": "not-found"]
    #expect(PullRequestError(RpcError.failed(RpcFailure(error: missing))) == .operation(detail: "Not found.", notFound: true))
    #expect(PullRequestError(EnvironmentRequestError.notConnected).rejectedBeforeDispatch)
    #expect(!PullRequestError.operation(detail: "x", notFound: false).rejectedBeforeDispatch)
  }

  @Test("detail and list decode tolerantly: unknown enums keep their raw value, bad rows are skipped")
  func tolerantDecoding() throws {
    let list = """
      {"viewers":{"github.com":"mira-dev"},"providers":[],"errors":[],"truncated":false,"nextCursors":{},
       "entries":[{"provider":"github","host":"github.com","projectId":"p","projectTitle":"Tide chart","repository":"tidewater/tide-chart","number":7,
         "title":"Add tides","url":"https://github.com/tidewater/tide-chart/pull/7","author":null,"headBranch":"tides","baseBranch":"main",
         "state":"queued","isDraft":false,"mergeability":"mergeable","additions":0,"deletions":0,"createdAt":"2026-11-20T10:00:00.000Z",
         "updatedAt":"2026-11-21T10:00:00.000Z","viewerReviewRequested":false,"labels":[{"name":"ok","color":"0e8a16"},{"color":1}],"checksState":"weird"},
         {"number":"not a row"}]}
      """
    let decoded = try JSONDecoder().decode(PullRequestListResult.self, from: Data(list.utf8))
    #expect(decoded.entries.count == 1)
    #expect(decoded.entries[0].state == .unknown("queued"))
    #expect(decoded.entries[0].labels.count == 1)
    #expect(decoded.entries[0].checksState == .unknown("weird"))
  }
}
