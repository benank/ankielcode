import XCTest

/// The later Settings pages on the canned computers of `ANKIEL_DEBUG_SETTINGS=fixture`: nothing
/// here reaches a server.
final class SettingsMoreUITests: HomeUITestCase {
  func testProviderOpensWithItsModels() {
    launch(["ANKIEL_DEBUG_SETTINGS": "fixture", "ANKIEL_DEBUG_ROUTE": "settings-providers"])
    let claude = app.buttons["providers.env-fixture-studio.claudeAgent"]
    XCTAssertTrue(claude.waitForExistence(timeout: 5))
    XCTAssertFalse(claude.label.contains("harbor@example.com"), "emails stay masked in the list")
    claude.tap()
    XCTAssertTrue(app.staticTexts["Models"].waitForExistence(timeout: 3))
    XCTAssertTrue(app.staticTexts["claude-haiku-5-5"].exists)
    shot("provider-detail")
  }

  func testThreadsPageWritesStreamingAndKeepsDevicePreference() {
    launch(["ANKIEL_DEBUG_SETTINGS": "fixture", "ANKIEL_DEBUG_ROUTE": "settings-threads"])
    let toggle = app.switches["threads.useLastProject"]
    XCTAssertTrue(toggle.waitForExistence(timeout: 5))
    toggle.switches.firstMatch.tap()
    XCTAssertEqual(toggle.value as? String, "0")
    let afterTurn = app.buttons.containing(NSPredicate(format: "label BEGINSWITH %@", "After the turn")).firstMatch
    for _ in 0..<4 where !afterTurn.isHittable { app.swipeUp() }
    afterTurn.tap()
    let selected = NSPredicate(format: "isSelected == true")
    expectation(for: selected, evaluatedWith: afterTurn)
    waitForExpectations(timeout: 5)
    shot("threads-streaming")
  }

  func testUsageCostAndTokensTabs() {
    launch(["ANKIEL_DEBUG_SETTINGS": "fixture", "ANKIEL_DEBUG_ROUTE": "settings-usage"])
    let cost = app.segmentedControls["usage.tab"].buttons["Cost"]
    XCTAssertTrue(cost.waitForExistence(timeout: 5))
    cost.tap()
    XCTAssertTrue(app.staticTexts["Raw token cost"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["Claude"].exists)
    app.segmentedControls["usage.tab"].buttons["Tokens"].tap()
    XCTAssertTrue(app.staticTexts["Processed tokens"].firstMatch.waitForExistence(timeout: 5))
    app.segmentedControls["usage.window"].buttons.element(boundBy: 1).tap()
    XCTAssertTrue(app.staticTexts["Daily processed tokens"].waitForExistence(timeout: 5))
    shot("usage-tokens")
  }
}
