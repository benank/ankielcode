import XCTest

/// The new-thread workspace choice with the fake composer, whose projects list made-up branches
/// (`NewThreadRefs`): the default checkout, a new worktree from a chosen base, the remote toggle.
final class NewThreadWorkspaceUITests: HomeUITestCase {
  func testChoosingAWorktreeAndItsBaseBranch() {
    launch(["ANKIEL_DEBUG_COMPOSER": "fake", "ANKIEL_DEBUG_COMPOSER_RESET": "1", "ANKIEL_DEBUG_ROUTE": "new-thread"])
    let workspace = app.buttons["newThread.workspace"]
    let branch = app.buttons["newThread.branch"]
    XCTAssertTrue(workspace.waitForExistence(timeout: 8))
    XCTAssertEqual(workspace.label, "Current checkout")
    XCTAssertEqual(branch.label, "Branch: tide-offsets")
    shot("workspace-checkout")
    workspace.tap()
    XCTAssertEqual(workspace.label, "New worktree")
    XCTAssertEqual(branch.label, "Base branch: From main (remote)", "a worktree starts from the default branch")
    branch.tap()
    let release = app.buttons["newThread.branch.release/2.4"]
    XCTAssertTrue(release.waitForExistence(timeout: 5))
    let remote = app.switches["newThread.startFromOrigin"]
    remote.switches.firstMatch.tap()
    shot("workspace-branches")
    release.tap()
    XCTAssertTrue(release.waitForNonExistence(timeout: 3))
    XCTAssertEqual(branch.label, "Base branch: From release/2.4")
    shot("workspace-worktree")
    // The choice survives closing and reopening the sheet.
    app.buttons["Close"].tap()
    app.terminate()
    launch(["ANKIEL_DEBUG_COMPOSER": "fake", "ANKIEL_DEBUG_ROUTE": "new-thread"])
    XCTAssertTrue(app.buttons["newThread.workspace"].waitForExistence(timeout: 8))
    XCTAssertEqual(app.buttons["newThread.workspace"].label, "New worktree")
    XCTAssertEqual(app.buttons["newThread.branch"].label, "Base branch: From release/2.4")
  }
}
