import UIKit
import UniformTypeIdentifiers

struct AnkielDragFile: Equatable {
  let url: URL
  let name: String
  let mimeType: String
}

/// Lets a presentation source's media be dragged into Files, Mail or another app.
@MainActor
final class AnkielPresentationDrag: NSObject, UIDragInteractionDelegate {
  private weak var owner: UIView?
  private var interaction: UIDragInteraction?
  var file: AnkielDragFile? {
    didSet { attach() }
  }

  init(owner: UIView) {
    self.owner = owner
  }

  /// UIKit hands a lifted context menu off to a drag only when both interactions share a
  /// view, so the drag joins the child that hosts the long-press menu when there is one.
  func attach(excluding removed: UIView? = nil) {
    var host: UIView?
    if file != nil, let owner {
      let child = owner.subviews.first(where: { $0 !== removed })
      let hostsMenu = child?.interactions.contains { $0 is UIContextMenuInteraction } ?? false
      host = hostsMenu ? child : owner
    }
    guard interaction?.view !== host else { return }
    if let interaction { interaction.view?.removeInteraction(interaction) }
    guard let host else { return }
    let drag = interaction ?? UIDragInteraction(delegate: self)
    // iPhone leaves drag interactions off by default.
    drag.isEnabled = true
    host.addInteraction(drag)
    interaction = drag
  }

  func dragInteraction(
    _ interaction: UIDragInteraction,
    itemsForBeginning session: UIDragSession
  ) -> [UIDragItem] {
    guard let owner, let file,
      interaction.view === owner || interaction.view === owner.subviews.first
    else { return [] }
    let provider = NSItemProvider()
    provider.suggestedName = file.name
    // An unknown tag yields a dynamic type, which no receiver asks for by name.
    let type = [UTType(mimeType: file.mimeType), UTType(filenameExtension: (file.name as NSString).pathExtension)]
      .compactMap { $0 }
      .first { !$0.isDynamic } ?? .data
    provider.registerFileRepresentation(for: type, visibility: .all, openInPlace: false) { completion in
      Self.load(file, completion: completion)
    }
    return [UIDragItem(itemProvider: provider)]
  }

  func dragInteraction(
    _ interaction: UIDragInteraction,
    previewForLifting item: UIDragItem,
    session: UIDragSession
  ) -> UITargetedDragPreview? {
    // The wrapper can be stretched past its media; lift the child, as the viewer zooms from it.
    guard let view = owner?.subviews.first ?? interaction.view, view.window != nil else { return nil }
    let parameters = UIDragPreviewParameters()
    parameters.backgroundColor = .clear
    let radius = Self.cornerRadius(in: view, depth: 3)
    if radius > 0 {
      parameters.visiblePath = UIBezierPath(roundedRect: view.bounds, cornerRadius: radius)
    }
    return UITargetedDragPreview(view: view, parameters: parameters)
  }

  func dragInteraction(_ interaction: UIDragInteraction, sessionAllowsMoveOperation session: UIDragSession) -> Bool {
    false
  }

  private static func cornerRadius(in view: UIView, depth: Int) -> CGFloat {
    if view.layer.cornerRadius > 0 { return view.layer.cornerRadius }
    guard depth > 0, let child = view.subviews.first else { return 0 }
    return cornerRadius(in: child, depth: depth - 1)
  }

  private nonisolated static func load(
    _ file: AnkielDragFile,
    completion: @escaping (URL?, Bool, (any Error)?) -> Void
  ) -> Progress? {
    // NSItemProvider calls it once, from any thread; Foundation just does not mark it Sendable.
    nonisolated(unsafe) let completion = completion
    let name = (file.name as NSString).lastPathComponent
    if file.url.isFileURL {
      guard file.url.lastPathComponent != name else {
        completion(file.url, false, nil)
        return nil
      }
      // Receivers such as Files name the copy after the URL, not the suggested name.
      do {
        completion(try named(name, moving: file.url, copy: true), false, nil)
      } catch {
        completion(nil, false, error)
      }
      return nil
    }
    let task = URLSession.shared.downloadTask(with: file.url) { location, response, error in
      guard let location, error == nil else {
        completion(nil, false, error ?? URLError(.cannotLoadFromNetwork))
        return
      }
      if let response = response as? HTTPURLResponse, !(200..<300).contains(response.statusCode) {
        completion(nil, false, URLError(.badServerResponse))
        return
      }
      do {
        completion(try named(name, moving: location, copy: false), false, nil)
      } catch {
        completion(nil, false, error)
      }
    }
    task.resume()
    return task.progress
  }

  private nonisolated static func named(_ name: String, moving source: URL, copy: Bool) throws -> URL {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("ankiel-drag", isDirectory: true)
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let destination = directory.appendingPathComponent(name.isEmpty ? "file" : name)
    if copy {
      try FileManager.default.copyItem(at: source, to: destination)
    } else {
      try FileManager.default.moveItem(at: source, to: destination)
    }
    return destination
  }
}
