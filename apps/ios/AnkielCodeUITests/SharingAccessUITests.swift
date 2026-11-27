import XCTest

/// Sharing & access on the fixture computer (`ANKIEL_DEBUG_SETTINGS=fixture`, fake access
/// service): nothing reaches a server.
final class SharingAccessUITests: HomeUITestCase {
  func open(_ extra: [String: String] = [:]) {
    launch(["ANKIEL_DEBUG_SETTINGS": "fixture", "ANKIEL_DEBUG_ROUTE": "settings-computer"].merging(extra) { $1 })
  }

  func testComputerOpensAccessAndRevokesAnotherDevice() {
    open()
    let entry = app.buttons["computer.access"]
    for _ in 0..<4 where !entry.isHittable { app.swipeUp() }
    XCTAssertTrue(entry.waitForExistence(timeout: 5))
    entry.tap()
    let tablet = app.buttons["access.session.session-fixture-tablet"]
    XCTAssertTrue(tablet.waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["This device"].exists)
    shot("access-list")

    tablet.tap()
    let revoke = app.buttons["access.session.revoke"]
    XCTAssertTrue(app.staticTexts["Galley tablet"].waitForExistence(timeout: 3))
    for _ in 0..<3 where !revoke.exists { app.swipeUp() }
    XCTAssertTrue(revoke.waitForExistence(timeout: 3))
    revoke.tap()
    let confirm = app.buttons["access.confirmRevoke"].firstMatch
    XCTAssertTrue(confirm.waitForExistence(timeout: 3))
    confirm.tap()
    XCTAssertTrue(waitForAbsence(tablet, timeout: 5))
    // This device offers no revoke.
    app.buttons["access.session.session-fixture-phone"].tap()
    XCTAssertTrue(app.staticTexts["Permissions"].waitForExistence(timeout: 3))
    XCTAssertFalse(app.buttons["access.session.revoke"].exists)
  }

  func testCreateLinkShowsQRAndRevokes() {
    open(["ANKIEL_DEBUG_ROUTE": "settings-computer-access"])
    let create = app.buttons["access.createLink"]
    XCTAssertTrue(create.waitForExistence(timeout: 5))
    create.tap()
    let name = app.textFields["access.create.name"]
    XCTAssertTrue(name.waitForExistence(timeout: 3))
    name.tap()
    name.typeText("Deck tablet")
    app.buttons["access.create.submit"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["access.share.qr"].firstMatch.waitForExistence(timeout: 5))
    let copyCode = app.buttons["access.share.copyCode"]
    for _ in 0..<3 where !copyCode.exists { app.swipeUp() }
    XCTAssertTrue(copyCode.exists)
    shot("access-share")
    let revoke = app.buttons["access.share.revoke"]
    for _ in 0..<3 where !revoke.isHittable { app.swipeUp() }
    revoke.tap()
    let confirm = app.buttons["Revoke"].firstMatch
    XCTAssertTrue(confirm.waitForExistence(timeout: 3))
    confirm.tap()
    XCTAssertTrue(create.waitForExistence(timeout: 5))
    XCTAssertFalse(app.staticTexts["Deck tablet"].exists)
  }

  func testDeniedSessionSaysWhy() {
    open(["ANKIEL_DEBUG_ROUTE": "settings-computer-access", "ANKIEL_DEBUG_ACCESS": "denied"])
    let notice = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "does not have permission")).firstMatch
    XCTAssertTrue(notice.waitForExistence(timeout: 5))
    XCTAssertFalse(app.buttons["access.createLink"].exists)
  }

  private func waitForAbsence(_ element: XCUIElement, timeout: TimeInterval) -> Bool {
    let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: element)
    return XCTWaiter.wait(for: [gone], timeout: timeout) == .completed
  }
}
