import XCTest

/// Workflows against the dev server, on runs the test owner started (README, "The full UI suite"): a run
/// asking "Ship tide chart v1.4?" and a paused "Tide chart v1.5". Skipped unless
/// `ANKIEL_TEST_WORKFLOWS=1`. Answers the question with Ship, then cancels the paused run.
final class WorkflowUITests: HomeUITestCase {
  override func setUp() async throws {
    guard ProcessInfo.processInfo.environment["ANKIEL_TEST_WORKFLOWS"] == "1" else { throw XCTSkip("No workflow runs set up.") }
    let url = URL(string: "http://127.0.0.1:14527/.well-known/ankiel/environment")!
    guard (try? await URLSession.shared.data(from: url)) != nil else { throw XCTSkip("The dev server is not running.") }
  }

  func testAnswerAndCancel() {
    launch()
    let more = app.buttons["home.more"]
    XCTAssertTrue(more.waitForExistence(timeout: 20))
    more.tap()
    let open = app.buttons["home.workflows"]
    XCTAssertTrue(open.waitForExistence(timeout: 5))
    open.tap()
    let asking = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Tide chart v1.4'")).firstMatch
    XCTAssertTrue(asking.waitForExistence(timeout: 20), "the asking run is under Needs you")
    shot("workflows-list")
    asking.tap()
    let ship = app.buttons["Ship"]
    XCTAssertTrue(ship.waitForExistence(timeout: 15))
    shot("workflow-question")
    ship.tap()
    XCTAssertTrue(app.staticTexts["Done"].waitForExistence(timeout: 20), "the answered run finishes")
    shot("workflow-done")
    app.navigationBars.buttons.firstMatch.tap()

    let paused = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Tide chart v1.5'")).firstMatch
    XCTAssertTrue(paused.waitForExistence(timeout: 15))
    paused.tap()
    XCTAssertTrue(app.buttons["workflow.resume"].waitForExistence(timeout: 15))
    let cancel = app.buttons["workflow.cancel"]
    cancel.tap()
    let confirm = app.alerts.buttons["Cancel run"]
    XCTAssertTrue(confirm.waitForExistence(timeout: 5))
    confirm.tap()
    XCTAssertTrue(app.staticTexts["Cancelled"].waitForExistence(timeout: 20), "the paused run is cancelled")
    shot("workflow-cancelled")
  }
}
