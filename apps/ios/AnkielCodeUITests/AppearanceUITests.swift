import XCTest

/// Settings → Appearance: a swatch sets one appearance's theme, a card sets both.
final class AppearanceUITests: HomeUITestCase {
  func testThemePicker() {
    launch(["ANKIEL_DEBUG_SETTINGS": "fixture", "ANKIEL_DEBUG_ROUTE": "settings-appearance"])
    let emberDark = app.buttons["appearance.theme.ember.dark"]
    let emberLight = app.buttons["appearance.theme.ember.light"]
    XCTAssertTrue(emberDark.waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["appearance.theme.ankiel-code.light"].isSelected, "the default theme starts selected")

    emberDark.tap()
    XCTAssertTrue(emberDark.isSelected, "the dark swatch sets the dark theme")
    XCTAssertFalse(emberLight.isSelected, "and leaves the light one")
    XCTAssertTrue(app.buttons["appearance.theme.ankiel-code.light"].isSelected)

    app.buttons["appearance.theme.grove"].tap()
    XCTAssertTrue(app.buttons["appearance.theme.grove.light"].isSelected, "the card sets both")
    XCTAssertTrue(app.buttons["appearance.theme.grove.dark"].isSelected)
    XCTAssertFalse(emberDark.isSelected)
    shot("appearance-grove")
  }
}
