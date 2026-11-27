import XCTest

/// Scheduled tasks against the dev server (skipped unless `ANKIEL_TEST_SCHEDULED=1`): creates an
/// hourly task with the free Replay model in the `ankiel-probe live` project, runs it now, pauses
/// it and deletes it. The run's thread is left for the caller to delete.
final class ScheduledTaskUITests: HomeUITestCase {
  override func setUp() async throws {
    guard ProcessInfo.processInfo.environment["ANKIEL_TEST_SCHEDULED"] == "1" else { throw XCTSkip("Live scheduled tasks are opt-in.") }
    let url = URL(string: "http://127.0.0.1:14527/.well-known/ankiel/environment")!
    guard (try? await URLSession.shared.data(from: url)) != nil else { throw XCTSkip("The dev server is not running.") }
  }

  func testCreateRunPauseDelete() {
    launch([
      "ANKIEL_DEBUG_ROUTE": "settings-scheduled",
      "ANKIEL_DEBUG_SCHEDULED_PRESET": "project=ankiel-probe live;model=devReplay/showcase;workspace=root",
    ])
    let new = app.buttons["scheduledTasks.new"]
    XCTAssertTrue(new.waitForExistence(timeout: 20))
    new.tap()
    let name = app.textFields["scheduledTask.name"]
    XCTAssertTrue(name.waitForExistence(timeout: 10))
    name.tap()
    name.typeText("iOS check task")
    let prompt = app.textViews["scheduledTask.prompt"].exists ? app.textViews["scheduledTask.prompt"] : app.textFields["scheduledTask.prompt"]
    prompt.tap()
    prompt.typeText("Say hello to the tide chart.")
    app.buttons["Interval"].tap()
    shot("scheduled-new")
    app.buttons["scheduledTask.save"].tap()

    let row = app.buttons.matching(NSPredicate(format: "label == 'Edit iOS check task'")).firstMatch
    XCTAssertTrue(row.waitForExistence(timeout: 20), "the new task is listed")
    XCTAssertTrue((row.value as? String ?? "").contains("Every 15 minutes"))
    shot("scheduled-list")

    row.press(forDuration: 1.0)
    app.buttons["Run now"].tap()
    row.press(forDuration: 1.0)
    app.buttons["Pause"].tap()
    let paused = NSPredicate(format: "value CONTAINS 'Paused'")
    expectation(for: paused, evaluatedWith: row)
    waitForExpectations(timeout: 15)

    row.press(forDuration: 1.0)
    app.buttons["Delete"].tap()
    let confirm = app.buttons.matching(NSPredicate(format: "label == 'Delete'")).element(boundBy: 0)
    XCTAssertTrue(confirm.waitForExistence(timeout: 5))
    confirm.tap()
    expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: row)
    waitForExpectations(timeout: 15)
  }
}
