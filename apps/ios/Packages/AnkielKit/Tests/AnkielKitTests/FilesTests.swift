import Foundation
import Testing

@testable import AnkielKit

/// File browser and viewer wire shapes, compared with `Fixtures/commands/files-*.json` (decoded
/// with the server's schemas by `check-schemas.mjs`), plus the pure path, tree and source logic.
@Suite("Files")
struct FilesTests {
  static let thread = "0b7e4f2a-9c1d-4e8b-a6f3-5d2c1b0a9e87"
  static let cwd = "/Users/dev/tide-chart"
  static let context = FileContext(environmentId: "env", cwd: cwd, threadId: thread, title: "tide-chart")
  static let draft = FileContext(environmentId: "env", cwd: cwd, threadId: nil, title: "tide-chart")

  static let samples: [(name: String, schema: String, value: any Encodable & Sendable)] = [
    ("files-list-root", "listEntries", ListEntriesRequest(cwd: cwd, directoryPath: "")),
    ("files-list-folder", "listEntries", ListEntriesRequest(cwd: cwd, directoryPath: "Sources/TideKit")),
    ("files-search", "searchEntries", SearchEntriesRequest(cwd: cwd, query: "tide", limit: SearchEntriesRequest.maxLimit)),
    ("files-read", "readFile", ReadFileRequest(cwd: cwd, relativePath: "Sources/TideKit/Tide.swift")),
    ("files-metadata", "metadata", FileMetadataRequest(paths: ["/Users/dev/tide-chart/data/tides.sqlite"])),
    ("asset-workspace-file", "assetUrl", AssetURLRequest(resource: context.asset("docs/chart.png"))),
    ("asset-media-video", "assetUrl", AssetURLRequest(resource: context.asset("docs/demo.mp4"))),
    ("asset-media-download", "assetUrl", AssetURLRequest(resource: context.asset("data/tides.sqlite", download: true))),
    ("asset-draft-file", "assetUrl", AssetURLRequest(resource: draft.asset("docs/chart.png"))),
    ("asset-draft-download", "assetUrl", AssetURLRequest(resource: draft.asset("Package.resolved", download: true))),
    (
      "asset-attachment-download", "assetUrl",
      AssetURLRequest(resource: .attachment(id: "att_9q1z", fileName: "notes.pdf", mimeType: "application/pdf", download: true))
    ),
    ("asset-tool-output-image", "assetUrl", AssetURLRequest(resource: .toolOutputImage(threadId: thread, itemId: "item-1", index: 0))),
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

  @Test("asset resources pick the tag RN picks")
  func assetTags() {
    #expect(Self.context.asset("a.png") == .workspaceFile(threadId: Self.thread, path: "/Users/dev/tide-chart/a.png"))
    #expect(Self.context.asset("/tmp/shot.png") == .mediaFile(threadId: Self.thread, path: "/tmp/shot.png", download: false))
    #expect(Self.context.asset("clip.mov") == .mediaFile(threadId: Self.thread, path: "/Users/dev/tide-chart/clip.mov", download: false))
    #expect(Self.draft.asset("a.png") == .draftWorkspaceFile(cwd: Self.cwd, path: "a.png", download: false))
  }

  @Test("listings decode tolerantly: unknown kinds stay, malformed rows drop")
  func listingDecoding() throws {
    let entries = try decode(
      WorkspaceEntries.self,
      json: #"{"entries":[{"path":"Sources","kind":"directory"},{"path":"x","kind":"symlink","extra":1},{"kind":"file"},{"path":"a.ts","kind":"file","ignored":true}],"truncated":true}"#)
    #expect(entries.entries.map(\.path) == ["Sources", "x", "a.ts"])
    #expect(entries.entries[1].kind == .unknown("symlink"))
    #expect(entries.entries[2].ignored == true)
    #expect(entries.dropped == 1)
    #expect(entries.truncated)
  }

  @Test("metadata entries decode, null and unreadable ones as nil")
  func metadata() throws {
    let result = try decode(
      FileMetadataResult.self, json: #"{"entries":[{"kind":"file","byteLength":3097724},null,{"kind":7}]}"#)
    #expect(result.entries.map(\.wrappedValue) == [FileMetadata(kind: "file", byteLength: 3_097_724, mimeType: nil), nil, nil])
  }

  @Test("asset results keep the file revision and image size")
  func assetResult() throws {
    let result = try decode(
      AssetURLResult.self,
      json: #"{"relativeUrl":"/api/assets/media-file/abc","expiresAt":1764230400000,"fileRevision":"12:34","imageDimensions":{"width":640,"height":480}}"#)
    #expect(result.fileRevision == "12:34")
    #expect(result.imageDimensions == AssetImageDimensions(width: 640, height: 480))
    let bare = try decode(AssetURLResult.self, json: #"{"relativeUrl":"/api/assets/a/b","expiresAt":1,"imageDimensions":"?"}"#)
    #expect(bare.fileRevision == nil && bare.imageDimensions == nil)
  }

  @Test("tree lists lazily, sorts folders first and flattens open folders")
  func tree() {
    var tree = FileTree()
    #expect(tree.pending == [""])
    tree.begin("")
    tree.finish(
      "",
      .success(WorkspaceEntries(entries: [
        WorkspaceEntry(path: "b.txt", kind: .file), WorkspaceEntry(path: "Src", kind: .directory),
        WorkspaceEntry(path: "a10.txt", kind: .file), WorkspaceEntry(path: "a9.txt", kind: .file),
      ])))
    #expect(tree.rows.map(\.entry.path) == ["Src", "a9.txt", "a10.txt", "b.txt"])
    let opened = tree.toggle("Src")
    #expect(opened)
    #expect(tree.rows.first?.listing == .loading)
    tree.begin("Src")
    tree.finish("Src", .success(WorkspaceEntries(entries: [WorkspaceEntry(path: "Src/main.swift", kind: .file)])))
    #expect(tree.rows.map(\.entry.path) == ["Src", "Src/main.swift", "a9.txt", "a10.txt", "b.txt"])
    #expect(tree.rows[1].depth == 1)
    let closed = tree.toggle("Src")
    #expect(!closed)
    #expect(tree.rows.count == 4)
    // Reopening a listed folder does not list it again; a failed one does.
    let reopened = tree.toggle("Src")
    #expect(!reopened)
    tree.finish("Src", .failure(.notConnected))
    #expect(tree.needsListing("Src"))
    tree.invalidate()
    #expect(tree.pending == ["", "Src"])
  }

  @Test("paths resolve and relativize like RN")
  func paths() {
    #expect(WorkspacePath.resolve("./src/a.ts", in: "/repo/") == "/repo/src/a.ts")
    #expect(WorkspacePath.resolve("/abs", in: "/repo") == "/abs")
    #expect(WorkspacePath.resolve("src/a.ts", in: #"C:\repo"#) == #"C:\repo\src\a.ts"#)
    #expect(WorkspacePath.workspaceRelative("/repo/lib/b.ts", root: "/repo/") == "lib/b.ts")
    #expect(WorkspacePath.workspaceRelative("/elsewhere/x", root: "/repo") == "/elsewhere/x")
    #expect(WorkspacePath.workspaceRelative("src/./a.ts", root: "/repo") == "src/a.ts")
    #expect(WorkspacePath.workspaceRelative("../up", root: "/repo") == nil)
    #expect(WorkspacePath.workspaceRelative("~/notes.md", root: "/Users/dev/repo") == "/Users/dev/notes.md")
    #expect(WorkspacePath.parent("a/b/c.ts") == "a/b")
    #expect(WorkspacePath.parent("c.ts") == "")
  }

  @Test("file links read positions and skip web links")
  func links() throws {
    #expect(FileLink.position(try #require(URL(string: "src/a.ts:12"))) == FilePosition(path: "src/a.ts", line: 12))
    #expect(FileLink.position(try #require(URL(string: "src/a.ts#L7-L9"))) == FilePosition(path: "src/a.ts", line: 7))
    #expect(FileLink.position(try #require(URL(string: "file:///repo/My%20File.md"))) == FilePosition(path: "/repo/My File.md"))
    #expect(FileLink.position(try #require(URL(string: "https://example.com/a.ts"))) == nil)
    #expect(FileLink.position(try #require(URL(string: "mailto:a@b.c"))) == nil)
    #expect(FileLink.position(try #require(URL(string: "#section"))) == nil)
  }

  @Test("file kinds and languages follow the name", arguments: [
    ("a/b/Tide.swift", FileKind.text, String?("swift")), ("x.PNG", .image, nil), ("clip.mov", .video, nil),
    ("README.md", .markdown, nil), ("doc.pdf", .pdf, nil), ("db.sqlite", .sqlite, nil),
    ("Makefile", .text, "sh"), ("Localizable.xcstrings", .text, "json"), ("font.woff2", .font, nil),
  ])
  func kinds(_ path: String, _ kind: FileKind, _ language: String?) {
    #expect(FileKind(path: path) == kind)
    #expect(SourceLanguage.named(path: path) == language)
  }

  @Test("source documents split lines and style tokens per line")
  func source() {
    var keyword = AttributeContainer()
    keyword.link = URL(string: "k:")
    let document = SourceDocument(text: "let a = 1\r\n// note\nlet b = \"x\"\n", language: "swift")
    #expect(document.lineCount == 3)
    #expect(document.isHighlighted)
    let first = document.attributedLine(0, style: [.keyword: keyword])
    #expect(first.runs.first { $0.link != nil }.map { String(first[$0.range].characters) } == "let")
    let third = document.attributedLine(2, style: [.keyword: keyword])
    #expect(third.runs.first { $0.link != nil }.map { String(third[$0.range].characters) } == "let")
    #expect(document.matches("LET") == [0, 2])
    #expect(SourceDocument(text: "", language: nil).lineCount == 1)
  }

  @Test("thread images collect attachments and nested markdown images in order")
  func threadImages() throws {
    let parser = MarkdownParser()
    let image = ChatAttachment(type: "image", id: "img", name: "shot.png", mimeType: "image/png", sizeBytes: 10)
    let text = ChatAttachment(type: "file", id: "f", name: "notes.txt", mimeType: "text/plain", sizeBytes: 10)
    let user = UserMessageRow(
      messageId: "m1", itemId: "i1", text: "", attachments: [image, text], isSteer: false, fromAgent: false,
      freshContext: false, createdAt: WireTimestamp(rawValue: "2026-11-27T00:00:00Z"), revision: 0)
    let markdown = "![one](docs/a.png)\n\n- item\n\n  ![two](b.png)\n\n> ![three](https://x.y/c.png)"
    let reply = AssistantMessageRow(
      messageId: "m2", itemId: "i2", text: markdown, document: parser.parse(markdown), streaming: false, attachments: [],
      footer: nil, revision: 0)
    let images = ThreadImage.collect([
      TimelineRow(id: "r1", content: .user(user)), TimelineRow(id: "r2", content: .assistant(reply)),
    ])
    #expect(images.map(\.title) == ["shot.png", "one", "two", "three"])
    #expect(Set(images.map(\.id)).count == 4)
  }
}

@Suite("Tool output images")
struct ToolOutputImageTests {
  @Test("counts image blocks the way the server indexes them")
  func counts() throws {
    let claude = try decode(
      JSONValue.self,
      json: #"{"content":[{"type":"text","text":"x"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"AA"}},{"type":"image","source":{"type":"url","url":"https://x"}}]}"#)
    #expect(ToolOutputImages.count(claude) == 1)
    let codex = try decode(JSONValue.self, json: #"[{"type":"image","data":"AA","mimeType":"image/jpeg"},{"type":"image","mimeType":"image/svg+xml"}]"#)
    #expect(ToolOutputImages.count(codex) == 1)
    #expect(ToolOutputImages.count(nil) == 0)
    let many = JSONValue.array(Array(repeating: ["type": "image", "mimeType": "image/png"], count: 12))
    #expect(ToolOutputImages.count(many) == 8)
  }
}
