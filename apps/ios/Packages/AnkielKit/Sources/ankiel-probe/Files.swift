import AnkielKit
import Foundation

/// `--files <cwd> [--thread <id>] [--read <path>]…`: the file browser's reads against a live
/// server. Lists the root, searches, reads each `--read` path (text, binary, large), and signs and
/// downloads each asset kind the viewers use.
func probeFiles(_ session: EnvironmentSession, base: URL, cwd: String) async throws {
  let rpc = session.rpc
  let root = try await WorkspaceFileCalls.list("", cwd: cwd, via: rpc)
  print("list root:         \(root.entries.count) entries, truncated=\(root.truncated), dropped=\(root.dropped)")
  for entry in root.entries.prefix(6) { print("  \(entry.isDirectory ? "d" : "f") \(entry.path)") }
  if let folder = root.entries.first(where: \.isDirectory) {
    let listed = try await WorkspaceFileCalls.list(folder.path, cwd: cwd, via: rpc)
    print("list \(folder.path): \(listed.entries.count) entries, first \(listed.entries.first?.path ?? "-")")
  }
  let query = argument("--search") ?? "readme"
  let found = try await WorkspaceFileCalls.search(query, cwd: cwd, via: rpc)
  print("search \"\(query)\":   \(found.entries.count) matches, truncated=\(found.truncated): \(found.entries.prefix(3).map(\.path))")
  // The composer's `@` list: a bare `@` (empty query) and the query, 20 at most, each written
  // as the link the composer inserts and read back as a mention.
  for mention in ["", query] {
    let entries = try await WorkspaceFileCalls.mentionSearch(mention, cwd: cwd, via: rpc).entries
    let roundTrips = entries.allSatisfy { entry in
      let link = ComposerFileLink.serialize(entry.path)
      return ComposerInlineTokens.collect(link + " ").first?.value == entry.path
    }
    print("mention \"@\(mention)\":  \(entries.count) entries, links read back=\(roundTrips): \(entries.prefix(3).map { ComposerFileLink.serialize($0.path) })")
  }

  for (index, argument) in CommandLine.arguments.enumerated() where argument == "--read" {
    guard CommandLine.arguments.indices.contains(index + 1) else { continue }
    let path = CommandLine.arguments[index + 1]
    do {
      switch try await WorkspaceFileCalls.read(path, cwd: cwd, via: rpc) {
      case .text(let text, let bytes, let truncated):
        print("read \(path): text \(text.utf8.count) of \(bytes) bytes, truncated=\(truncated), lines=\(SourceDocument(text: text, language: SourceLanguage.named(path: path)).lineCount)")
      case .binary: print("read \(path): binary")
      case .notFile: print("read \(path): not a file")
      }
    } catch RpcError.failed(let failure) {
      print("read \(path): \(failure.tag ?? "?") failure=\(failure.error["failure"]?.stringValue ?? "none")")
    } catch {
      print("read \(path): failed \(error)")
    }
  }

  guard let threadId = argument("--thread") else { return }
  if let item = argument("--tool-item") {
    let full = try await rpc.call(
      "orchestration.getTurnItem", payload: JSONValue.object(["threadId": .string(threadId), "itemId": .string(item)]),
      as: JSONValue.self)
    print("tool item output:  \(ToolOutputImages.count(full["item"]?["output"])) image(s) (stream copy: outputOmitted)")
  }
  if let path = argument("--stat") {
    let stat = try await WorkspaceFileCalls.metadata(WorkspacePath.resolve(path, in: cwd), via: rpc)
    print("stat \(path): \(stat.map { "\($0.kind) \($0.byteLength ?? -1) bytes" } ?? "null")")
  }
  let context = FileContext(environmentId: "", cwd: cwd, threadId: threadId, title: "")
  let draft = FileContext(environmentId: "", cwd: cwd, threadId: nil, title: "")
  var assets: [(String, AssetResource)] = []
  if let image = argument("--image") {
    assets.append(("workspace image", context.asset(image)))
    assets.append(("draft image", draft.asset(image)))
  }
  for (index, argument) in CommandLine.arguments.enumerated() where argument == "--download" {
    guard CommandLine.arguments.indices.contains(index + 1) else { continue }
    let path = CommandLine.arguments[index + 1]
    assets.append(("download \(path)", context.asset(path, download: true)))
  }
  if let item = argument("--tool-item") {
    assets.append(("tool output image 0", .toolOutputImage(threadId: threadId, itemId: item, index: 0)))
  }
  if let image = argument("--image") {
    assets.append(("text as inline (refused)", context.asset(image.replacingOccurrences(of: ".png", with: ".swift"))))
  }
  for (label, resource) in assets {
    do {
      let signed = try await WorkspaceFileCalls.signRelative(resource, via: rpc)
      guard let url = URL(string: signed.relativeUrl, relativeTo: base) else { continue }
      let (data, response) = try await URLSession.shared.data(from: url)
      let http = response as? HTTPURLResponse
      print(
        "asset \(label): \(signed.relativeUrl.split(separator: "/").prefix(3).joined(separator: "/"))… revision=\(signed.fileRevision ?? "-") GET \(http?.statusCode ?? 0) \(http?.mimeType ?? "?") \(data.count) bytes"
      )
    } catch {
      print("asset \(label): failed \(error)")
    }
  }
}
