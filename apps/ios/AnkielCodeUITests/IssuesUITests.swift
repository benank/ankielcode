import XCTest

/// Issues on canned fixtures (`ANKIEL_DEBUG_ISSUES=fixture`, two issues to a page): no server.
final class IssuesUITests: HomeUITestCase {
  func open() {
    launch([
      "ANKIEL_DEBUG_HOME": "sample", "ANKIEL_DEBUG_ISSUES": "fixture", "ANKIEL_DEBUG_COMPOSER": "fake",
      "ANKIEL_DEBUG_COMPOSER_RESET": "1",
    ])
    let more = app.buttons["home.more"]
    XCTAssertTrue(more.waitForExistence(timeout: 15))
    more.tap()
    let issues = app.buttons["Issues"]
    XCTAssertTrue(issues.waitForExistence(timeout: 5))
    issues.tap()
  }

  /// Open issues page in as the list scrolls; search narrows them; the filter shows closed ones.
  func testPagingSearchAndFilter() {
    open()
    XCTAssertTrue(app.buttons["issues.row.#42"].waitForExistence(timeout: 10))
    // The third open issue is on the second page.
    XCTAssertTrue(app.buttons["issues.row.#7"].waitForExistence(timeout: 10), "the next page loads")
    shot("issues-list")

    app.buttons["issues.filter"].tap()
    app.buttons["Closed"].tap()
    XCTAssertTrue(app.buttons["issues.row.#31"].waitForExistence(timeout: 5), "closed issues show")
    XCTAssertFalse(app.buttons["issues.row.#42"].exists)
    shot("issues-closed")
    app.buttons["issues.filter"].tap()
    app.buttons["Open"].tap()
    XCTAssertTrue(app.buttons["issues.row.#42"].waitForExistence(timeout: 5))

    let search = app.searchFields.firstMatch
    XCTAssertTrue(search.waitForExistence(timeout: 5))
    search.tap()
    search.typeText("widget\n")
    XCTAssertTrue(app.buttons["issues.row.#38"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["issues.row.#42"].waitForNonExistence(timeout: 5), "search narrows the list")
    search.buttons.firstMatch.tap()  // clear
    XCTAssertTrue(app.buttons["issues.row.#42"].waitForExistence(timeout: 5), "clearing shows every issue again")
  }

  /// A row's context menu starts a thread: the new-thread sheet opens with the issue's link.
  func testStartAThreadFromTheContextMenu() {
    open()
    let row = app.buttons["issues.row.#42"]
    XCTAssertTrue(row.waitForExistence(timeout: 10))
    row.press(forDuration: 1.0)
    for title in ["Open", "Start a thread", "Copy link", "Open on the tracker"] {
      XCTAssertTrue(app.buttons[title].waitForExistence(timeout: 3), "\(title) is in the menu")
    }
    app.buttons["Start a thread"].tap()
    XCTAssertTrue(app.buttons["issues.done"].waitForNonExistence(timeout: 5), "Issues closes")
    let field = app.textViews["composer.field"].exists ? app.textViews["composer.field"] : app.textFields["composer.field"]
    XCTAssertTrue(field.waitForExistence(timeout: 10), "the new-thread sheet opens")
    XCTAssertTrue((field.value as? String ?? "").contains("Tide table skips"), "its draft carries the issue")
    shot("issues-start-thread")
  }

  /// A row opens the issue read-only with its comments.
  func testOpenDetail() {
    open()
    let row = app.buttons["issues.row.#42"]
    XCTAssertTrue(row.waitForExistence(timeout: 10))
    row.tap()
    XCTAssertTrue(app.staticTexts["Looks like the month table hard-codes 28 days."].waitForExistence(timeout: 10))
    shot("issues-detail")
  }

  /// An entry point (here the New thread intent, as Siri runs it at a cold launch) never lands
  /// under a cover: Issues closes and the new-thread sheet shows.
  func testAnEntryPointClosesIssuesFirst() {
    launch([
      "ANKIEL_DEBUG_HOME": "sample", "ANKIEL_DEBUG_ISSUES": "fixture", "ANKIEL_DEBUG_ISSUES_OPEN": "list",
      "ANKIEL_DEBUG_INTENT": "new:Check the leap day", "ANKIEL_DEBUG_COMPOSER": "fake", "ANKIEL_DEBUG_COMPOSER_RESET": "1",
    ])
    let field = app.textViews["composer.field"].exists ? app.textViews["composer.field"] : app.textFields["composer.field"]
    XCTAssertTrue(field.waitForExistence(timeout: 15), "the new-thread sheet shows")
    XCTAssertFalse(app.buttons["issues.done"].exists, "Issues closed first")
  }
}

/// The live gate (RN `issuesSupportedAtom`): home's menu has Issues exactly when the dev server
/// has GitHub integration on. Set it first (`ankiel-probe --set-github on|off`) and pass the
/// expectation as `TEST_RUNNER_ANKIEL_TEST_ISSUES=shown|hidden`; skips otherwise.
final class LiveIssuesGateUITests: HomeUITestCase {
  func testMenuFollowsGitHubIntegration() async throws {
    guard let expected = ProcessInfo.processInfo.environment["ANKIEL_TEST_ISSUES"] else {
      throw XCTSkip("Set TEST_RUNNER_ANKIEL_TEST_ISSUES to shown or hidden.")
    }
    let url = URL(string: "http://127.0.0.1:14527/.well-known/ankiel/environment")!
    guard (try? await URLSession.shared.data(from: url)) != nil else {
      throw XCTSkip("The dev server is not running.")
    }
    launch()
    // Wait for the live rows, so the computer's settings have arrived.
    XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'thread.'")).firstMatch.waitForExistence(timeout: 30))
    let more = app.buttons["home.more"]
    XCTAssertTrue(more.waitForExistence(timeout: 10))
    more.tap()
    let issues = app.buttons["home.issues"]
    if expected == "shown" {
      XCTAssertTrue(issues.waitForExistence(timeout: 5), "Issues shows with GitHub integration on")
      shot("issues-gate-shown")
      issues.tap()
      XCTAssertTrue(app.buttons["issues.done"].waitForExistence(timeout: 10))
      shot("issues-live-list")
    } else {
      XCTAssertTrue(app.buttons["home.workflows"].waitForExistence(timeout: 5), "the menu is open")
      XCTAssertFalse(issues.exists, "Issues hides with GitHub integration off")
      shot("issues-gate-hidden")
    }
  }
}
