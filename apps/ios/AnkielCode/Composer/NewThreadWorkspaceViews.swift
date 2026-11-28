import AnkielKit
import SwiftUI

/// The project's branches for the new-thread workspace choice, loaded once per project.
@MainActor
@Observable
final class NewThreadRefs {
  private(set) var refs: [WorkspaceRef] = []
  /// nil until the first answer.
  private(set) var isGitRepo: Bool?
  private(set) var loading = false
  private(set) var failed = false
  private var loadedKey: String?

  func load(environmentId: String, cwd: String, registry: EnvironmentRegistry, fake: Bool) async {
    let key = "\(environmentId)|\(cwd)"
    guard key != loadedKey else { return }
    loadedKey = key
    refs = []
    isGitRepo = nil
    failed = false
    #if DEBUG
      if fake {
        refs = [
          WorkspaceRef(name: "tide-offsets", current: true), WorkspaceRef(name: "main", isDefault: true),
          WorkspaceRef(name: "release/2.4"), WorkspaceRef(name: "origin/main", isRemote: true),
        ]
        isGitRepo = true
        return
      }
    #endif
    loading = true
    defer { loading = false }
    do {
      let list = try await registry.workspaceRefs(cwd: cwd, in: environmentId)
      guard loadedKey == key else { return }
      refs = list.refs
      isGitRepo = list.isRepo ?? !list.refs.isEmpty
    } catch {
      guard loadedKey == key else { return }
      failed = true
      isGitRepo = false
    }
  }

  func reload(environmentId: String, cwd: String, registry: EnvironmentRegistry, fake: Bool) async {
    loadedKey = nil
    await load(environmentId: environmentId, cwd: cwd, registry: registry, fake: fake)
  }
}

/// RN's workspace and branch controls under the project: the current checkout or a new worktree,
/// and the branch a worktree starts from.
struct NewThreadWorkspaceChips: View {
  let resolved: NewThreadWorkspace.Resolved
  let refs: NewThreadRefs
  let setMode: (NewThreadWorkspace.Mode) -> Void
  let openBranches: () -> Void

  var body: some View {
    HStack(spacing: Spacing.sm) {
      Button {
        Haptics.selection()
        setMode(resolved.mode == .local ? .worktree : .local)
      } label: {
        WorkspaceChipLabel(
          systemImage: resolved.mode == .worktree ? "plus.square.on.square" : "folder",
          text: resolved.mode == .worktree ? String(localized: "New worktree") : String(localized: "Current checkout"),
          chevron: "arrow.left.arrow.right")
      }
      .buttonStyle(.plain)
      .accessibilityLabel(resolved.mode == .worktree ? Text("New worktree") : Text("Current checkout"))
      .accessibilityHint(resolved.mode == .worktree ? Text("Switches to the current checkout") : Text("Switches to a new worktree"))
      .accessibilityIdentifier("newThread.workspace")
      Button(action: openBranches) {
        WorkspaceChipLabel(systemImage: "arrow.triangle.branch", text: branchLabel, chevron: resolved.mode == .worktree ? "chevron.right" : nil)
      }
      .buttonStyle(.plain)
      // In place the thread uses whatever is checked out; switching branches here is not built.
      .disabled(resolved.mode == .local || refs.loading)
      .accessibilityLabel(resolved.mode == .worktree ? Text("Base branch: \(branchLabel)") : Text("Branch: \(branchLabel)"))
      .accessibilityIdentifier("newThread.branch")
    }
  }

  /// RN `resolveNewTaskBranchLabel`.
  private var branchLabel: String {
    if refs.loading, refs.refs.isEmpty { return String(localized: "Loading branches…") }
    guard let branch = resolved.branch else { return String(localized: "Choose branch") }
    if resolved.mode == .local { return branch }
    return resolved.startFromOrigin ? String(localized: "From \(branch) (remote)") : String(localized: "From \(branch)")
  }
}

private struct WorkspaceChipLabel: View {
  let systemImage: String
  let text: String
  let chevron: String?

  var body: some View {
    HStack(spacing: Spacing.xs + 2) {
      Image(systemName: systemImage)
        .foregroundStyle(Palette.textSecondary)
      Text(text)
        .foregroundStyle(Palette.textPrimary)
        .lineLimit(1)
      if let chevron {
        Image(systemName: chevron)
          .font(Typography.caption2.weight(.semibold))
          .foregroundStyle(Palette.textTertiary)
      }
    }
    .font(Typography.footnote.weight(.medium))
    .padding(.horizontal, Spacing.md)
    .frame(minHeight: 36)
    .background(Palette.fill, in: .capsule)
    .contentShape(.capsule)
    .frame(minHeight: 44)
  }
}

/// RN `NewTaskBranchPickerRouteScreen` for a worktree: find a base branch, and start from the remote.
struct NewThreadBranchSheet: View {
  let refs: NewThreadRefs
  let selected: String?
  let startFromOrigin: Bool
  let pick: (String) -> Void
  let setStartFromOrigin: (Bool) -> Void
  let retry: () -> Void
  @Environment(\.dismiss) private var dismiss
  @State private var query = ""

  var body: some View {
    NavigationStack {
      List {
        Section {
          Toggle("Start from remote", isOn: Binding(get: { startFromOrigin }, set: { setStartFromOrigin($0) }))
            .accessibilityIdentifier("newThread.startFromOrigin")
        }
        Section {
          let shown = NewThreadWorkspace.filter(refs.refs, query: query)
          if shown.isEmpty {
            if refs.loading {
              Text("Loading branches…").foregroundStyle(Palette.textSecondary)
            } else {
              Text(query.isEmpty ? "No branches available" : "No matching branches").foregroundStyle(Palette.textSecondary)
              if refs.failed { Button("Try again", action: retry) }
            }
          }
          ForEach(shown) { ref in
            Button {
              pick(ref.name)
              dismiss()
            } label: {
              HStack {
                Text(ref.name)
                  .foregroundStyle(Palette.textPrimary)
                if ref.isDefault {
                  Text("default")
                    .font(Typography.caption)
                    .foregroundStyle(Palette.textSecondary)
                }
                Spacer(minLength: 0)
                if ref.name == selected {
                  Image(systemName: "checkmark").foregroundStyle(Palette.accent)
                }
              }
              .contentShape(.rect)
            }
            .accessibilityIdentifier("newThread.branch.\(ref.name)")
            .accessibilityAddTraits(ref.name == selected ? .isSelected : [])
          }
        }
      }
      .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: Text("Find a branch"))
      .navigationTitle("Base branch")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done", systemImage: "checkmark") { dismiss() }
            .accessibilityIdentifier("newThread.branch.done")
        }
      }
    }
    .presentationDetents([.medium, .large])
  }
}
