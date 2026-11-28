import XCTest

/// Git actions against a live server, on a throwaway checkout (README, "The full UI suite"). Skipped
/// unless `TEST_RUNNER_LIVE_GIT_THREAD` names the thread's deep link; each test is one step, and
/// the checkout is set up between runs.
final class ReviewLiveGitUITests: HomeUITestCase {
  var environment: [String: String] { ProcessInfo.processInfo.environment }

  func openThread() throws {
    let link = try XCTUnwrap(environment["LIVE_GIT_THREAD"], "set TEST_RUNNER_LIVE_GIT_THREAD")
    launch(["ANKIEL_OPEN_URL": link])
    let menu = app.buttons["thread.menu"]
    XCTAssertTrue(menu.waitForExistence(timeout: 20))
    menu.tap()
  }

  /// Menu items do not carry their identifiers, so the Git sheet opens by its label.
  func openGitSheet() {
    let item = app.buttons["Git actions"]
    XCTAssertTrue(item.waitForExistence(timeout: 10))
    item.tap()
  }

  func waitForResult(_ text: String) {
    let progress = app.descendants(matching: .any)["git.progress"]
    let done = NSPredicate(format: "label CONTAINS[c] %@", text)
    let result = XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: done, object: progress)], timeout: 30)
    shot("live-result-\(text)")
    XCTAssertEqual(result, .completed, "result: \(progress.exists ? progress.label : "none")")
  }

  /// The menu's one-tap action reads `LIVE_GIT_EXPECT`, runs, and ends with `LIVE_GIT_DONE`.
  /// `LIVE_GIT_CONFIRM=feature` answers the default-branch question with a feature branch.
  func testQuickAction() throws {
    try XCTSkipIf(environment["LIVE_GIT_THREAD"] == nil, "live only")
    try openThread()
    let expected = try XCTUnwrap(environment["LIVE_GIT_EXPECT"])
    // The status loads after the menu opens; the item's label is its action.
    let quick = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", expected)).firstMatch
    let found = quick.waitForExistence(timeout: 15)
    shot("live-menu-\(expected)")
    XCTAssertTrue(found, app.debugDescription)
    quick.tap()
    if environment["LIVE_GIT_CONFIRM"] == "feature" {
      let feature = app.alerts.buttons["Feature branch & continue"]
      XCTAssertTrue(feature.waitForExistence(timeout: 5))
      shot("live-confirm")
      feature.tap()
    }
    waitForResult(try XCTUnwrap(environment["LIVE_GIT_DONE"]))
  }

  /// Commit from the Git sheet with a message.
  func testCommitFromSheet() throws {
    try XCTSkipIf(environment["LIVE_GIT_THREAD"] == nil, "live only")
    try openThread()
    openGitSheet()
    let commit = app.buttons["git.action.commit"]
    XCTAssertTrue(commit.waitForExistence(timeout: 10))
    XCTAssertTrue(commit.isEnabled)
    shot("live-sheet")
    commit.tap()
    let message = app.descendants(matching: .any)["git.commit.message"]
    XCTAssertTrue(message.waitForExistence(timeout: 5))
    message.tap()
    message.typeText("Neap tide")
    app.buttons["git.commit.submit"].tap()
    waitForResult("Committed")
  }

  /// The Git sheet as it is, for screenshots.
  func testSheet() throws {
    try XCTSkipIf(environment["LIVE_GIT_THREAD"] == nil, "live only")
    try openThread()
    shot("live-menu")
    openGitSheet()
    XCTAssertTrue(app.buttons["git.action.push"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.buttons["git.action.pr"].exists)
    sleep(1)
    shot("live-sheet")
  }
}
