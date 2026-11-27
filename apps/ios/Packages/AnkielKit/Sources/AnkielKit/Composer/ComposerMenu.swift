import Foundation

/// One row of the composer's `@` / `/` / `$` suggestion list (RN `ComposerCommandItem`).
public struct ComposerMenuItem: Identifiable, Hashable, Sendable {
  public enum Action: Hashable, Sendable {
    /// A workspace file or folder (relative to the composer's workspace).
    case path(String, isDirectory: Bool)
    /// An Ankiel command (`/model`, `/clear`, `/side`, `/btw`).
    case command(String)
    /// A provider's own slash command, sent as text.
    case providerCommand(String)
    case skill(String)
    case model(instanceId: String, model: String)
  }

  public var id: String
  public var label: String
  public var detail: String
  public var action: Action

  public init(id: String, label: String, detail: String, action: Action) {
    self.id = id
    self.label = label
    self.detail = detail
    self.action = action
  }
}

public enum ComposerMenu {
  /// `@` results from `projects.searchEntries`: the name, and the folder it is in.
  public static func pathItems(_ entries: [WorkspaceEntry]) -> [ComposerMenuItem] {
    entries.map { entry in
      let parts = entry.path.precomposedStringWithCanonicalMapping.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
      return ComposerMenuItem(
        id: "path:\(entry.path)", label: parts.last ?? entry.path, detail: parts.count > 1 ? parts.dropLast().joined(separator: "/") : "",
        action: .path(entry.path, isDirectory: entry.isDirectory))
    }
  }

  /// The text a pick writes over the trigger (`resolveComposerCommandSelection`), or nil for
  /// commands that act instead of inserting (the caller clears the trigger and runs them).
  public static func replacement(for item: ComposerMenuItem) -> String? {
    switch item.action {
    case .path(let path, _): "\(ComposerFileLink.serialize(path)) "
    case .skill(let name): "$\(name) "
    case .command(let name): "/\(name) "
    case .providerCommand(let name): "/\(name) "
    case .model(let instanceId, let model): "\(modelMention(instanceId: instanceId, model: model)) "
    }
  }

  /// Prompt text naming a provider instance and model for the agent. No `@`, which the editor
  /// would turn into a file chip (`formatComposerModelMention`).
  public static func modelMention(instanceId: String, model: String) -> String { "model:\(instanceId)/\(model)" }

  /// Applies a pick to the draft: the new text and the caret after it.
  public static func apply(_ item: ComposerMenuItem, to text: String, trigger: ComposerTrigger) -> (text: String, cursor: Int) {
    ComposerTrigger.replace(text, start: trigger.rangeStart, end: trigger.rangeEnd, with: replacement(for: item) ?? "")
  }
}
