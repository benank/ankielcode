import Foundation

/// One pickable model (RN `ModelOption`).
public struct ModelOption: Sendable, Hashable, Identifiable {
  public var instanceId: String
  public var providerLabel: String
  public var model: ServerProviderModel
  /// Shown (it is the current pick) but cannot be chosen.
  public var isUnavailable: Bool

  public var id: String { "\(instanceId):\(model.slug)" }
  public var label: String { model.name }
  public var shortLabel: String { model.shortName ?? model.name }
}

public struct ProviderGroup: Sendable, Hashable, Identifiable {
  public var instanceId: String
  public var label: String
  public var models: [ModelOption]
  public var id: String { instanceId }
}

/// The composer's model and option rules, ported from RN `buildModelOptions`, `groupByProvider`,
/// `composer-model-menu.ts`, `use-model-option-memory.ts` and `resolveNewTaskModelSelection`.
public enum ModelCatalog {
  /// Provider groups the picker shows. `locked` (a started thread's instance) limits the list to
  /// instances that can continue its conversation; `current` stays listed even when hidden.
  public static func groups(
    providers: [ServerProvider], settings: ServerSettings, locked: String? = nil, current: ModelSelection? = nil
  ) -> [ProviderGroup] {
    let lockedProvider = locked.flatMap { id in providers.first { $0.instanceId == id } }
    func matchesLock(_ provider: ServerProvider) -> Bool {
      guard let locked, provider.instanceId != locked else { return true }
      guard let lockedProvider, provider.driver == lockedProvider.driver else { return false }
      if let key = lockedProvider.continuationGroupKey { return provider.continuationGroupKey == key }
      return provider.driver != "antigravity"
    }
    var groups: [ProviderGroup] = []
    for provider in providers where provider.isSelectable && matchesLock(provider) {
      let hidden = settings.hiddenModels[provider.instanceId] ?? []
      var models = provider.models.filter { model in
        let isCurrent = current?.instanceId == provider.instanceId && current?.model == model.slug
        if isCurrent { return true }
        return (model.isCustom || !hidden.contains(model.slug)) && !model.isLegacy
      }
      if let order = settings.modelOrder[provider.instanceId], !order.isEmpty {
        let rank = Dictionary(order.enumerated().map { ($1, $0) }, uniquingKeysWith: { first, _ in first })
        models = models.enumerated().sorted { lhs, rhs in
          let l = rank[lhs.element.slug] ?? Int.max
          let r = rank[rhs.element.slug] ?? Int.max
          return l != r ? l < r : lhs.offset < rhs.offset
        }.map(\.element)
      }
      let options = models.map { model in
        ModelOption(
          instanceId: provider.instanceId, providerLabel: provider.label, model: model,
          isUnavailable: provider.updateRequiredModelSlugs.contains(model.slug))
      }
      if !options.isEmpty { groups.append(ProviderGroup(instanceId: provider.instanceId, label: provider.label, models: options)) }
    }
    return groups
  }

  public static func model(for selection: ModelSelection?, in providers: [ServerProvider]) -> ServerProviderModel? {
    guard let selection else { return nil }
    return providers.first { $0.instanceId == selection.instanceId }?.models.first { $0.slug == selection.model }
  }

  public static func provider(for selection: ModelSelection?, in providers: [ServerProvider]) -> ServerProvider? {
    guard let selection else { return nil }
    return providers.first { $0.instanceId == selection.instanceId }
  }

  /// The effort/thinking control (RN `findReasoningDescriptor`).
  public static func reasoning(_ descriptors: [OptionDescriptor]) -> OptionDescriptor? {
    descriptors.first { $0.isReasoning && ($0.kind == .boolean || !$0.selectableChoices.isEmpty) }
  }

  /// The value a descriptor shows for a selection: the explicit pick, else the catalog's current
  /// value, else the default choice (RN `getProviderOptionCurrentValue`).
  public static func currentValue(_ descriptor: OptionDescriptor, in selection: ModelSelection?) -> JSONValue? {
    if let explicit = selection?.options?.first(where: { $0.id == descriptor.id }) { return explicit.value }
    if descriptor.kind == .boolean { return descriptor.currentValue }
    if let current = descriptor.currentValue, current != .null { return current }
    return descriptor.choices.first(where: \.isDefault).map { .string($0.id) }
  }

  /// `selection` with one option set (RN `applyProviderOptionSelection`).
  public static func setting(_ id: String, to value: JSONValue, in selection: ModelSelection) -> ModelSelection {
    var next = selection
    var options = next.options ?? []
    if let index = options.firstIndex(where: { $0.id == id }) {
      options[index].value = value
    } else {
      options.append(ModelSelection.Option(id: id, value: value))
    }
    next.options = options
    return next
  }

  /// The composer's compact label: the model's short name and the effort choice.
  public static func label(for selection: ModelSelection?, providers: [ServerProvider]) -> (model: String, effort: String?) {
    guard let selection else { return ("", nil) }
    let model = Self.model(for: selection, in: providers)
    let name = model?.shortName ?? model?.name ?? selection.model
    guard let reasoning = reasoning(model?.optionDescriptors ?? []), reasoning.kind == .select,
      let value = currentValue(reasoning, in: selection)?.stringValue
    else { return (name, nil) }
    return (name, reasoning.choices.first { $0.id == value }?.label)
  }

  /// The pick for a new thread (RN `resolveNewTaskModelSelection`): the draft's, the project's
  /// default, the last one used, the server's default, then the first model listed. Picks that are
  /// no longer selectable are skipped.
  public static func newThreadSelection(
    draft: ModelSelection?, projectDefault: ModelSelection?, sticky: ModelSelection?,
    providers: [ServerProvider], settings: ServerSettings
  ) -> ModelSelection? {
    let groups = groups(providers: providers, settings: settings)
    let options = groups.flatMap(\.models)
    func usable(_ selection: ModelSelection?) -> ModelSelection? {
      guard let selection else { return nil }
      return options.contains { $0.instanceId == selection.instanceId && $0.model.slug == selection.model && !$0.isUnavailable }
        ? selection : nil
    }
    if let pick = usable(draft) ?? usable(projectDefault) ?? usable(sticky) ?? usable(settings.defaultModelSelection) {
      return pick
    }
    let fallback = options.first { $0.model.isDefault && !$0.isUnavailable } ?? options.first { !$0.isUnavailable }
    return fallback.map { ModelSelection(instanceId: $0.instanceId, model: $0.model.slug) }
  }

  /// Runtime modes the provider offers (absent: all four).
  public static func runtimeModes(for provider: ServerProvider?) -> [RuntimeMode] {
    guard let modes = provider?.supportedRuntimeModes, !modes.isEmpty else { return RuntimeMode.allCases }
    return RuntimeMode.allCases.filter(modes.contains)
  }
}

/// Remembered options per model (RN `use-model-option-memory`): picking a model again brings back
/// the effort chosen for it last time.
public struct ModelOptionMemory: Sendable, Hashable, Codable {
  public var options: [String: [String: [ModelSelection.Option]]] = [:]

  public init() {}

  public mutating func remember(_ selection: ModelSelection) {
    guard let picked = selection.options, !picked.isEmpty else { return }
    options[selection.instanceId, default: [:]][selection.model] = picked
  }

  public func applying(to selection: ModelSelection) -> ModelSelection {
    guard let remembered = options[selection.instanceId]?[selection.model] else { return selection }
    var next = selection
    next.options = remembered
    return next
  }
}
