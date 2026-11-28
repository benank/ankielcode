import Foundation
import Testing

@testable import AnkielKit

/// RN `resolveNewTaskDraftWorkspace` / `fillNewTaskWorkspaceBranch`, without `ankiel.json`.
struct NewThreadWorkspaceTests {
  let refs = [
    WorkspaceRef(name: "feature/tides", current: true), WorkspaceRef(name: "main", isDefault: true),
    WorkspaceRef(name: "origin/main", isRemote: true),
  ]

  func resolve(_ draft: NewThreadWorkspace?, remembered: NewThreadWorkspace? = nil, default mode: NewThreadWorkspace.Mode = .local, git: Bool = true, origin: Bool = true)
    -> NewThreadWorkspace.Resolved
  {
    NewThreadWorkspace.resolve(draft: draft, remembered: remembered, defaultMode: mode, isGitRepo: git, refs: refs, settingsStartFromOrigin: origin)
  }

  @Test func theDefaultIsTheProjectsThenTheComputersThenTheCheckout() {
    #expect(NewThreadWorkspace.defaultMode(project: .worktree, settings: .local) == .worktree)
    #expect(NewThreadWorkspace.defaultMode(project: nil, settings: .worktree) == .worktree)
    #expect(NewThreadWorkspace.defaultMode(project: nil, settings: nil) == .local)
  }

  @Test func aWorktreeStartsFromTheDefaultBranchUnlessOneWasChosen() {
    let derived = resolve(NewThreadWorkspace(mode: .worktree))
    #expect(derived == .init(mode: .worktree, branch: "main", startFromOrigin: true))
    #expect(derived.launch == .worktree(baseRef: "main", startFromOrigin: true))
    let chosen = resolve(NewThreadWorkspace(mode: .worktree, baseBranch: "feature/tides", startFromOrigin: false))
    #expect(chosen.launch == .worktree(baseRef: "feature/tides", startFromOrigin: false))
    #expect(resolve(NewThreadWorkspace(mode: .worktree), origin: false).startFromOrigin == false)
  }

  @Test func inPlaceUsesTheCurrentCheckout() {
    let local = resolve(nil)
    #expect(local == .init(mode: .local, branch: "feature/tides", startFromOrigin: false))
    #expect(local.launch == .root)
  }

  @Test func theDraftWinsOverTheRememberedChoiceWhichWinsOverTheDefault() {
    #expect(resolve(nil, remembered: NewThreadWorkspace(mode: .worktree), default: .local).mode == .worktree)
    #expect(resolve(NewThreadWorkspace(mode: .local), remembered: NewThreadWorkspace(mode: .worktree)).mode == .local)
    #expect(resolve(nil, default: .worktree).mode == .worktree)
  }

  @Test func aFolderThatIsNotAGitCheckoutWorksInPlace() {
    #expect(resolve(NewThreadWorkspace(mode: .worktree), git: false).launch == .root)
  }

  @Test func aWorktreeWithoutRefsWaitsForABase() {
    let resolved = NewThreadWorkspace.resolve(
      draft: NewThreadWorkspace(mode: .worktree), remembered: nil, defaultMode: .local, isGitRepo: true, refs: [], settingsStartFromOrigin: true)
    #expect(resolved.launch == nil)
  }

  @Test func branchesFilterByName() {
    #expect(NewThreadWorkspace.filter(refs, query: " MAIN ").map(\.name) == ["main", "origin/main"])
  }

  @Test func settingsDecodeTheWorkspaceDefaults() throws {
    let settings = try JSONDecoder().decode(ServerSettings.self, from: Data(#"{"defaultThreadEnvMode":"worktree","newWorktreesStartFromOrigin":false}"#.utf8))
    #expect(settings.defaultThreadEnvMode == .worktree)
    #expect(!settings.newWorktreesStartFromOrigin)
    #expect(try JSONDecoder().decode(ServerSettings.self, from: Data("{}".utf8)).newWorktreesStartFromOrigin)
  }
}
