import UIKit
import XCTest

/// Settings over the canned computers of `ANKIEL_DEBUG_SETTINGS=fixture` (own folder, defaults and
/// credential store, fake settings sink): nothing here touches the real saved computers.
final class SettingsUITests: HomeUITestCase {
  func open(_ route: String = "settings", mode: String = "fixture") {
    launch(["ANKIEL_DEBUG_SETTINGS": mode, "ANKIEL_DEBUG_ROUTE": route])
  }

  var done: XCUIElement { app.buttons["settings.done"] }

  func back() {
    app.navigationBars.buttons.element(boundBy: 0).tap()
  }

  func testEveryPageOpensAndReturns() {
    open()
    XCTAssertTrue(done.waitForExistence(timeout: 5))
    shot("settings-root")
    let pages: [(String, String)] = [
      ("settings.general", "Project grouping"), ("settings.appearance", "Code & Diffs"), ("settings.chat", "Steer"),
      ("settings.notifications", "Push notifications"), ("settings.providers", "Claude"),
      ("settings.threads", "Default permissions"), ("settings.about", "Remove all computers"),
    ]
    for (id, marker) in pages {
      let link = app.buttons[id]
      if !link.isHittable { app.swipeUp() }
      XCTAssertTrue(link.waitForExistence(timeout: 3), id)
      link.tap()
      XCTAssertTrue(app.staticTexts[marker].firstMatch.waitForExistence(timeout: 3), "\(id) shows \(marker)")
      back()
      XCTAssertTrue(done.waitForExistence(timeout: 3))
    }
    app.swipeUp()
    app.buttons["settings.about"].tap()
    app.buttons["settings.storage"].tap()
    XCTAssertTrue(app.staticTexts["Environment caches"].waitForExistence(timeout: 3))
    back()
    app.buttons["settings.diagnostics"].tap()
    XCTAssertTrue(app.buttons["diagnostics.copy"].waitForExistence(timeout: 3))
    back()
    back()
    app.swipeDown()
    app.buttons["settings.computer.env-fixture-studio"].tap()
    XCTAssertTrue(app.switches["computer.enabled"].waitForExistence(timeout: 3))
    back()
    app.buttons["settings.computer.env-fixture-buildbox"].tap()
    XCTAssertTrue(app.buttons["computer.pairAgain"].waitForExistence(timeout: 3))
    shot("computer-needs-pairing")
  }

  func testSearchFindsASettingOnItsPage() {
    open()
    XCTAssertTrue(done.waitForExistence(timeout: 5))
    let field = app.searchFields.firstMatch
    field.tap()
    field.typeText("auto-settle")
    let hit = app.buttons.containing(NSPredicate(format: "label CONTAINS[c] %@", "Auto-settle")).firstMatch
    XCTAssertTrue(hit.waitForExistence(timeout: 3))
    shot("settings-search")
    hit.tap()
    let merged = app.switches["Auto-settle merged threads"]
    XCTAssertTrue(app.staticTexts["Default permissions"].waitForExistence(timeout: 3))
    for _ in 0..<3 where !merged.exists { app.swipeUp() }
    XCTAssertTrue(merged.exists)
  }

  func testThemeSwitchAppliesToTheOpenSheetAndBack() throws {
    open("settings-appearance")
    let theme = app.segmentedControls["appearance.theme"]
    XCTAssertTrue(theme.waitForExistence(timeout: 5))
    theme.buttons["Dark"].tap()
    XCTAssertTrue(waitFor { self.brightness() < 0.3 }, "dark applies to the open sheet")
    shot("appearance-dark-applied")
    theme.buttons["Light"].tap()
    XCTAssertTrue(waitFor { self.brightness() > 0.7 }, "light applies to the open sheet")
    theme.buttons["System"].tap()
    let system = XCUIDevice.shared.appearance == .dark
    XCTAssertTrue(waitFor { system ? self.brightness() < 0.3 : self.brightness() > 0.7 }, "system returns to the device appearance")
  }

  func testRemovingAComputerAsksFirst() {
    open("settings-computer")
    let remove = app.buttons["computer.remove"]
    for _ in 0..<4 where !remove.isHittable { app.swipeUp() }
    remove.tap()
    let confirm = app.buttons["Remove"].firstMatch
    XCTAssertTrue(confirm.waitForExistence(timeout: 3))
    shot("remove-confirm")
    // Dismissing keeps it (iOS 26 dialogs close by tapping outside).
    app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.12)).tap()
    XCTAssertTrue(confirm.waitForNonExistence(timeout: 3))
    XCTAssertTrue(remove.waitForExistence(timeout: 2))
    remove.tap()
    app.buttons["Remove"].firstMatch.tap()
    XCTAssertTrue(done.waitForExistence(timeout: 3))
    XCTAssertTrue(app.buttons["settings.computer.env-fixture-studio"].waitForNonExistence(timeout: 3))
    XCTAssertTrue(app.buttons["settings.computer.env-fixture-buildbox"].exists)
  }

  func testAServerSettingWritesAndARefusalRollsBack() {
    open("settings-threads")
    let merged = app.switches["Auto-settle merged threads"]
    for _ in 0..<3 where !merged.isHittable { app.swipeUp() }
    XCTAssertEqual(merged.value as? String, "1")
    merged.switches.firstMatch.tap()
    XCTAssertTrue(waitFor { merged.value as? String == "0" })

    open("settings-threads", mode: "fail")
    for _ in 0..<3 where !merged.isHittable { app.swipeUp() }
    merged.switches.firstMatch.tap()
    XCTAssertTrue(app.alerts["Could not save settings"].waitForExistence(timeout: 3))
    shot("settings-write-failed")
    app.alerts.buttons["OK"].tap()
    XCTAssertEqual(merged.value as? String, "1", "the refused change rolls back")
  }

  func testPairingFromSettingsStaysInSettings() {
    open()
    XCTAssertTrue(done.waitForExistence(timeout: 5))
    app.buttons["settings.addComputer"].tap()
    let address = app.textFields["Address"]
    XCTAssertTrue(address.waitForExistence(timeout: 3))
    address.tap()
    address.typeText("127.0.0.1:9")
    let code = app.textFields["Code"]
    code.tap()
    code.typeText("ABCDEFGHJKMN")
    app.buttons["Connect"].tap()
    let close = app.buttons["Close"]
    XCTAssertTrue(close.waitForExistence(timeout: 15), "the failure card shows over Settings")
    shot("settings-pairing-failed")
    close.tap()
    XCTAssertTrue(done.waitForExistence(timeout: 3), "Settings stays open")

    app.buttons["settings.computer.env-fixture-buildbox"].tap()
    app.buttons["computer.pairAgain"].tap()
    let closeScanner = app.buttons["Close"].firstMatch
    XCTAssertTrue(closeScanner.waitForExistence(timeout: 5))
    closeScanner.tap()
    XCTAssertTrue(app.buttons["computer.pairAgain"].waitForExistence(timeout: 3), "the computer page is still there")
  }

  func testUpdateCheckOffersTheUpdateAndAsksFirst() {
    open("settings-computer")
    let check = app.buttons["computer.checkUpdates"]
    for _ in 0..<5 where !check.isHittable { app.swipeUp() }
    check.tap()
    let update = app.buttons["computer.update"]
    XCTAssertTrue(waitFor { self.app.swipeUp(); return update.exists && update.isHittable }, "Update appears after the check")
    XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "0.1.12 is available")).firstMatch.exists)
    shot("computer-update-available")
    update.tap()
    XCTAssertTrue(app.buttons["Update"].firstMatch.waitForExistence(timeout: 3), "the update asks before restarting the computer")
    shot("computer-update-confirm")
  }

  func testThemeSurvivesAColdLaunch() {
    open("settings-appearance")
    let theme = app.segmentedControls["appearance.theme"]
    XCTAssertTrue(theme.waitForExistence(timeout: 5))
    theme.buttons["Dark"].tap()
    app.terminate()
    launch(["ANKIEL_DEBUG_SETTINGS": "fixture", "ANKIEL_DEBUG_SETTINGS_KEEP": "1", "ANKIEL_DEBUG_ROUTE": "settings-appearance"])
    XCTAssertTrue(app.segmentedControls["appearance.theme"].waitForExistence(timeout: 5))
    XCTAssertTrue(waitFor { self.brightness() < 0.3 }, "the saved theme applies at launch")
    app.segmentedControls["appearance.theme"].buttons["System"].tap()
  }

  // MARK: Helpers

  /// Mean brightness of a strip under the navigation bar (the sheet's background).
  func brightness() -> Double {
    guard let image = XCUIScreen.main.screenshot().image.cgImage else { return 0.5 }
    let width = image.width, height = image.height
    let crop = CGRect(x: width / 2 - 20, y: height * 82 / 100, width: 40, height: 20)
    guard let region = image.cropping(to: crop) else { return 0.5 }
    var pixels = [UInt8](repeating: 0, count: 40 * 20 * 4)
    let context = CGContext(
      data: &pixels, width: 40, height: 20, bitsPerComponent: 8, bytesPerRow: 160, space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    context?.draw(region, in: CGRect(x: 0, y: 0, width: 40, height: 20))
    var total = 0.0
    for index in stride(from: 0, to: pixels.count, by: 4) {
      total += (Double(pixels[index]) + Double(pixels[index + 1]) + Double(pixels[index + 2])) / 765
    }
    return total / Double(pixels.count / 4)
  }

  func waitFor(_ condition: @escaping () -> Bool, timeout: TimeInterval = 4) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if condition() { return true }
      RunLoop.current.run(until: Date().addingTimeInterval(0.2))
    }
    return condition()
  }
}
