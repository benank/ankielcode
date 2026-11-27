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
}
