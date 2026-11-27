import Foundation

/// Where files are read from: a thread's workspace (its worktree, else its project's root) or a
/// project with no thread. Every request carries `cwd`; asset URLs need the thread when there is one.
public struct FileContext: Sendable, Hashable {
  public var environmentId: String
  public var cwd: String
  public var threadId: String?
  /// The project's title, for headers.
  public var title: String

  public init(environmentId: String, cwd: String, threadId: String?, title: String) {
    self.environmentId = environmentId
    self.cwd = cwd
    self.threadId = threadId
    self.title = title
  }

  /// The resource that signs `path` (relative to `cwd`, or absolute). `download` serves any type.
  public func asset(_ path: String, download: Bool = false) -> AssetResource {
    let absolute = WorkspacePath.resolve(path, in: cwd)
    guard let threadId else { return .draftWorkspaceFile(cwd: cwd, path: path, download: download) }
    // RN: video, audio and absolute paths go through `media-file`; `download` needs it too.
    let kind = FileKind(path: path)
    if download || kind == .video || kind == .audio || WorkspacePath.isAbsolute(path) {
      return .mediaFile(threadId: threadId, path: absolute, download: download)
    }
    return .workspaceFile(threadId: threadId, path: absolute)
  }
}

/// One entry of a listing or a search (`ProjectEntry`).
public struct WorkspaceEntry: Sendable, Hashable, Decodable, Identifiable {
  public var path: String
  public var kind: WireEnum<Kind>
  public var ignored: Bool?

  public enum Kind: String, Sendable, Hashable { case file, directory }

  public var id: String { path }
  public var name: String { WorkspacePath.basename(path) }
  public var isDirectory: Bool { kind == .directory }

  public init(path: String, kind: Kind, ignored: Bool? = nil) {
    self.path = path
    self.kind = .known(kind)
    self.ignored = ignored
  }

  enum CodingKeys: String, CodingKey { case path, kind, ignored }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    path = try container.decode(String.self, forKey: .path)
    kind = try container.decode(WireEnum<Kind>.self, forKey: .kind)
    ignored = try? container.decodeIfPresent(Bool.self, forKey: .ignored)
  }
}

/// A listing or search result: entries the client could read, and whether the server cut it.
public struct WorkspaceEntries: Sendable, Hashable, Decodable {
  public var entries: [WorkspaceEntry]
  public var truncated: Bool
  /// Rows dropped as unreadable.
  public var dropped: Int

  public init(entries: [WorkspaceEntry], truncated: Bool = false) {
    self.entries = entries
    self.truncated = truncated
    dropped = 0
  }

  enum CodingKeys: String, CodingKey { case entries, truncated }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    let lossy = try container.decode(LossyArray<WorkspaceEntry>.self, forKey: .entries)
    entries = lossy.elements
    dropped = lossy.droppedCount
    truncated = (try? container.decodeIfPresent(Bool.self, forKey: .truncated)) ?? false
  }
}

/// `projects.listEntries`: one folder's children (`directoryPath` "" is the root).
struct ListEntriesRequest: Encodable, Sendable {
  static let rpcTag = "projects.listEntries"
  var cwd: String
  var directoryPath: String
}

/// `projects.searchEntries`: paths matching a query, ranked by the server.
struct SearchEntriesRequest: Encodable, Sendable {
  static let rpcTag = "projects.searchEntries"
  /// `PROJECT_SEARCH_ENTRIES_MAX_LIMIT`.
  static let maxLimit = 200
  var cwd: String
  var query: String
  var limit: Int
}

/// `projects.readFile`: up to 1 MiB of a UTF-8 file.
struct ReadFileRequest: Encodable, Sendable {
  static let rpcTag = "projects.readFile"
  var cwd: String
  var relativePath: String
}

struct ReadFileResult: Decodable, Sendable {
  var relativePath: String
  var contents: String
  var byteLength: Int
  var truncated: Bool
  @Tolerant var exists: Bool?
}

/// What reading a file gave.
public enum FileRead: Sendable, Hashable {
  /// The text; `truncated` means the server sent only the first 1 MiB of `byteLength`.
  case text(String, byteLength: Int, truncated: Bool)
  /// Not UTF-8 text (`binary_file`): show it through Quick Look instead.
  case binary
  /// A folder, or something that is not a regular file (`path_not_file`).
  case notFile
}

/// Anything that makes unary RPC calls: a live session, or the bare client (`ankiel-probe`).
public protocol UnaryCaller: Sendable {
  func call<Response: Decodable & Sendable>(
    _ tag: String, payload: some Encodable & Sendable, as: Response.Type
  ) async throws -> Response
}

extension RpcClient: UnaryCaller {}

struct SessionCaller: UnaryCaller {
  let session: any LiveSession
  func call<Response: Decodable & Sendable>(
    _ tag: String, payload: some Encodable & Sendable, as type: Response.Type
  ) async throws -> Response {
    try await session.call(tag, payload: payload, as: type)
  }
}

/// The file reads, over any caller.
public enum WorkspaceFileCalls {
  public static func list(_ directory: String, cwd: String, via caller: some UnaryCaller) async throws -> WorkspaceEntries {
    try await caller.call(ListEntriesRequest.rpcTag, payload: ListEntriesRequest(cwd: cwd, directoryPath: directory), as: WorkspaceEntries.self)
  }

  public static func search(_ query: String, cwd: String, via caller: some UnaryCaller) async throws -> WorkspaceEntries {
    let trimmed = String(query.trimmingCharacters(in: .whitespacesAndNewlines).prefix(256))
    guard !trimmed.isEmpty else { return WorkspaceEntries(entries: []) }
    return try await caller.call(
      SearchEntriesRequest.rpcTag, payload: SearchEntriesRequest(cwd: cwd, query: trimmed, limit: SearchEntriesRequest.maxLimit),
      as: WorkspaceEntries.self)
  }

  /// A binary or non-file target answers as a value, not an error (`ProjectReadFileError.failure`).
  public static func read(_ path: String, cwd: String, via caller: some UnaryCaller) async throws -> FileRead {
    do {
      let result = try await caller.call(ReadFileRequest.rpcTag, payload: ReadFileRequest(cwd: cwd, relativePath: path), as: ReadFileResult.self)
      return .text(result.contents, byteLength: result.byteLength, truncated: result.truncated)
    } catch RpcError.failed(let failure) where failure.tag == "ProjectReadFileError" {
      switch failure.error["failure"]?.stringValue {
      case "binary_file": return .binary
      case "path_not_file": return .notFile
      default: throw RpcError.failed(failure)
      }
    }
  }

  /// `assets.createUrl`; `relativeUrl` resolves against the environment's endpoint.
  public static func signRelative(_ resource: AssetResource, via caller: some UnaryCaller) async throws -> (relativeUrl: String, fileRevision: String?) {
    let result = try await caller.call(AssetURLRequest.rpcTag, payload: AssetURLRequest(resource: resource), as: AssetURLResult.self)
    return (result.relativeUrl, result.fileRevision)
  }
}

extension EnvironmentRegistry {
  public func listEntries(_ directory: String, in context: FileContext) async throws(EnvironmentRequestError) -> WorkspaceEntries {
    try await request(context.environmentId) { try await WorkspaceFileCalls.list(directory, cwd: context.cwd, via: SessionCaller(session: $0)) }
  }

  public func searchEntries(_ query: String, in context: FileContext) async throws(EnvironmentRequestError) -> WorkspaceEntries {
    try await request(context.environmentId) { try await WorkspaceFileCalls.search(query, cwd: context.cwd, via: SessionCaller(session: $0)) }
  }

  public func readFile(_ path: String, in context: FileContext) async throws(EnvironmentRequestError) -> FileRead {
    try await request(context.environmentId) { try await WorkspaceFileCalls.read(path, cwd: context.cwd, via: SessionCaller(session: $0)) }
  }
}
