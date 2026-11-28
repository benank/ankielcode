import AnkielKit
import SwiftUI

/// The model control's sheet (RN `composer-model-menu` and `ThreadSettingsSheet`): the effort and
/// other options of the current model, the models by provider, and permissions. Picks apply at
/// once; a started thread lists only providers that can continue its conversation.
struct ModelPickerSheet: View {
  let target: ComposerTarget
  let actions: ComposerActions
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss

  private var store: ComposerStore { model.composer }
  private var draft: ComposerDraft { store.draft(target.draftKey) }
  private var selection: ModelSelection? { target.selection(draft, sticky: store.memory.lastModelSelection) }
  private var current: ServerProviderModel? { ModelCatalog.model(for: selection, in: target.providers) }
  private var groups: [ProviderGroup] {
    ModelCatalog.groups(providers: target.providers, settings: target.settings, locked: target.lockedInstance, current: selection)
  }
  private var runtimeMode: RuntimeMode { target.runtimeMode(draft, sticky: store.memory.lastRuntimeMode) }

  var body: some View {
    NavigationStack {
      ThemedList(background: Palette.sheet) {
        if let current, let selection {
          let descriptors = current.optionDescriptors
          if let reasoning = ModelCatalog.reasoning(descriptors) {
            optionSection(reasoning, selection: selection)
          }
          let others = descriptors.filter { $0.id != ModelCatalog.reasoning(descriptors)?.id }
          if !others.isEmpty {
            Section {
              ForEach(others) { descriptor in optionRow(descriptor, selection: selection) }
            }
          }
        }
        ForEach(groups) { group in
          Section(group.label) {
            ForEach(group.models) { option in modelRow(option) }
          }
        }
        if groups.isEmpty {
          Section {
            Text(target.connected ? "No models are set up on this computer." : "Connect to this computer to change the model.")
              .font(Typography.subheadline)
              .foregroundStyle(Palette.textSecondary)
          }
        }
        Section {
          ForEach(ModelCatalog.runtimeModes(for: ModelCatalog.provider(for: selection, in: target.providers)), id: \.self) { mode in
            runtimeRow(mode)
          }
        } header: {
          Text("Permissions")
        }
      }
      .navigationTitle("Model")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done", systemImage: "checkmark") { dismiss() }
            .keyboardShortcut(.cancelAction)
            .accessibilityIdentifier("modelPicker.done")
        }
      }
    }
    .presentationDetents([.medium, .large])
    .presentationDragIndicator(.visible)
    .sensoryFeedback(.selection, trigger: selection)
    .sensoryFeedback(.selection, trigger: runtimeMode)
  }

  // MARK: Rows

  private func modelRow(_ option: ModelOption) -> some View {
    let isCurrent = selection?.instanceId == option.instanceId && selection?.model == option.model.slug
    return Button {
      actions.select(ModelSelection(instanceId: option.instanceId, model: option.model.slug))
    } label: {
      HStack(spacing: Spacing.md) {
        VStack(alignment: .leading, spacing: 2) {
          Text(option.label)
            .font(Typography.body)
            .foregroundStyle(option.isUnavailable ? Palette.textTertiary : Palette.textPrimary)
          if let sub = option.model.subProvider, !sub.isEmpty {
            Text(sub).font(Typography.caption).foregroundStyle(Palette.textTertiary)
          } else if option.isUnavailable {
            Text("Update the provider to use this model").font(Typography.caption).foregroundStyle(Palette.textTertiary)
          }
        }
        Spacer()
        if isCurrent {
          Image(systemName: "checkmark").font(Typography.body.weight(.semibold)).foregroundStyle(Palette.accent)
        }
      }
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .disabled(option.isUnavailable)
    .accessibilityAddTraits(isCurrent ? .isSelected : [])
    .accessibilityIdentifier("modelPicker.model.\(option.model.slug)")
  }

  @ViewBuilder
  private func optionSection(_ descriptor: OptionDescriptor, selection: ModelSelection) -> some View {
    if descriptor.kind == .select {
      Section(descriptor.label) {
        let value = ModelCatalog.currentValue(descriptor, in: selection)?.stringValue
        ForEach(descriptor.selectableChoices) { choice in
          Button {
            actions.setOption(descriptor.id, .string(choice.id), on: selection)
          } label: {
            HStack {
              VStack(alignment: .leading, spacing: 2) {
                Text(choice.label).font(Typography.body).foregroundStyle(Palette.textPrimary)
                if let description = choice.description {
                  Text(description).font(Typography.caption).foregroundStyle(Palette.textTertiary)
                }
              }
              Spacer()
              if value == choice.id {
                Image(systemName: "checkmark").font(Typography.body.weight(.semibold)).foregroundStyle(Palette.accent)
              }
            }
            .contentShape(.rect)
          }
          .buttonStyle(.plain)
          .accessibilityAddTraits(value == choice.id ? .isSelected : [])
          .accessibilityIdentifier("modelPicker.option.\(descriptor.id).\(choice.id)")
        }
      }
    } else {
      Section { optionRow(descriptor, selection: selection) }
    }
  }

  @ViewBuilder
  private func optionRow(_ descriptor: OptionDescriptor, selection: ModelSelection) -> some View {
    switch descriptor.kind {
    case .boolean:
      Toggle(isOn: Binding(
        get: { ModelCatalog.currentValue(descriptor, in: selection)?.boolValue ?? false },
        set: { actions.setOption(descriptor.id, .bool($0), on: selection) }
      )) {
        Text(descriptor.label)
      }
    case .select:
      Picker(descriptor.label, selection: Binding(
        get: { ModelCatalog.currentValue(descriptor, in: selection)?.stringValue ?? "" },
        set: { actions.setOption(descriptor.id, .string($0), on: selection) }
      )) {
        ForEach(descriptor.selectableChoices) { Text($0.label).tag($0.id) }
      }
    }
  }

  private func runtimeRow(_ mode: RuntimeMode) -> some View {
    Button {
      actions.setRuntimeMode(mode)
    } label: {
      HStack(spacing: Spacing.md) {
        Image(systemName: mode.symbol)
          .font(Typography.body)
          .foregroundStyle(Palette.textSecondary)
          .frame(width: 24)
        VStack(alignment: .leading, spacing: 2) {
          Text(mode.title).font(Typography.body).foregroundStyle(Palette.textPrimary)
          Text(mode.detail).font(Typography.caption).foregroundStyle(Palette.textTertiary)
        }
        Spacer()
        if runtimeMode == mode {
          Image(systemName: "checkmark").font(Typography.body.weight(.semibold)).foregroundStyle(Palette.accent)
        }
      }
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .accessibilityAddTraits(runtimeMode == mode ? .isSelected : [])
    .accessibilityIdentifier("modelPicker.runtime.\(mode.rawValue)")
  }
}

extension RuntimeMode {
  /// RN `RUNTIME_MODE_CHOICES`.
  var title: String {
    switch self {
    case .approvalRequired: String(localized: "Supervised")
    case .autoAcceptEdits: String(localized: "Auto-accept edits")
    case .auto: String(localized: "Auto")
    case .fullAccess: String(localized: "Full access")
    }
  }

  var detail: String {
    switch self {
    case .approvalRequired: String(localized: "Ask before commands and file changes.")
    case .autoAcceptEdits: String(localized: "Auto-approve edits, ask before other actions.")
    case .auto: String(localized: "Supported providers approve routine actions; others still ask.")
    case .fullAccess: String(localized: "Allow commands and edits without prompts.")
    }
  }

  var symbol: String {
    switch self {
    case .approvalRequired: "hand.raised"
    case .autoAcceptEdits: "pencil.and.outline"
    case .auto: "sparkles"
    case .fullAccess: "lock.open"
    }
  }
}
