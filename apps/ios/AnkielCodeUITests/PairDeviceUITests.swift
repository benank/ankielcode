import XCTest

/// "Pair a device" on the fixture computer (`ANKIEL_DEBUG_SETTINGS=fixture`, fake invites): the
/// entry points, each state, approve, deny and cancel. `LivePairDeviceUITests` runs one invite
/// against the dev server.
final class PairDeviceUITests: HomeUITestCase {
  func open(_ mode: String, route: String = "settings-computer-pair") {
    var environment = ["ANKIEL_DEBUG_SETTINGS": "fixture", "ANKIEL_DEBUG_ROUTE": route, "ANKIEL_DEBUG_PAIR_DEVICE": mode]
    // `TEST_RUNNER_PAIR_THEME=<id>` shoots the states in another palette.
    if let theme = ProcessInfo.processInfo.environment["PAIR_THEME"] { environment["ANKIEL_DEBUG_THEME"] = theme }
    launch(environment)
  }

  func element(_ id: String) -> XCUIElement { app.descendants(matching: .any)[id].firstMatch }

  func testEntryPointsOpenThePage() {
    open("ready", route: "settings-computer")
    let entry = app.buttons["computer.pairDevice"]
    for _ in 0..<5 where !entry.isHittable { app.swipeUp() }
    XCTAssertTrue(entry.waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["Connect your Mac or another device with Handoff, AirDrop, or a link, without typing codes."].exists)
    shot("pair-entry-computer")
    entry.tap()
    XCTAssertTrue(element("pairDevice.ready").waitForExistence(timeout: 5))
    app.navigationBars.buttons.firstMatch.tap()

    let access = app.buttons["computer.access"]
    for _ in 0..<3 where !access.isHittable { app.swipeUp() }
    access.tap()
    let fromAccess = app.buttons["access.pairDevice"]
    XCTAssertTrue(fromAccess.waitForExistence(timeout: 5))
    fromAccess.tap()
    XCTAssertTrue(element("pairDevice.ready").waitForExistence(timeout: 5))
  }

  func testOldServerShowsTheUpdateHint() {
    open("unsupported", route: "settings-computer")
    let hint = app.staticTexts["Update this server to pair other devices with Handoff, AirDrop, or a link."]
    for _ in 0..<5 where !hint.exists { app.swipeUp() }
    XCTAssertTrue(hint.waitForExistence(timeout: 5))
    XCTAssertFalse(app.buttons["computer.pairDevice"].exists)
  }

  func testReadyCountsDownAndCancelLeaves() {
    open("ready")
    XCTAssertTrue(element("pairDevice.ready").waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["pairDevice.shareFile"].exists)
    XCTAssertTrue(app.buttons["pairDevice.shareLink"].exists)
    let countdown = element("pairDevice.countdown")
    XCTAssertTrue(countdown.label.contains("Expires in"), countdown.label)
    shot("pair-ready")
    app.buttons["pairDevice.cancel"].tap()
    XCTAssertTrue(element("pairDevice.ready").waitForNonExistence(timeout: 5))
  }

  func testClaimShowsTheCodeAndApproves() {
    open("claimed")
    XCTAssertTrue(app.buttons["pairDevice.approve"].waitForExistence(timeout: 8))
    XCTAssertTrue(app.staticTexts["4 8 2 - 9 1 3"].exists)
    XCTAssertTrue(app.descendants(matching: .any).containing(NSPredicate(format: "label CONTAINS 'Harbor MacBook Pro'")).firstMatch.exists)
    XCTAssertTrue(app.staticTexts["Grants full client access to Studio Mac."].exists)
    shot("pair-claimed")
    app.buttons["pairDevice.approve"].tap()
    XCTAssertTrue(element("pairDevice.approved").waitForExistence(timeout: 5))
    shot("pair-approved")
    app.buttons["pairDevice.secondary"].tap()
    XCTAssertTrue(element("pairDevice.ready").waitForExistence(timeout: 5))
  }

  func testDenyEndsAndTryAgainStartsOver() {
    open("claimed")
    XCTAssertTrue(app.buttons["pairDevice.deny"].waitForExistence(timeout: 8))
    app.buttons["pairDevice.deny"].tap()
    XCTAssertTrue(element("pairDevice.denied").waitForExistence(timeout: 5))
    shot("pair-denied")
    app.buttons["pairDevice.primary"].tap()
    XCTAssertTrue(element("pairDevice.ready").waitForExistence(timeout: 5))
  }

  func testInviteExpires() {
    open("expired")
    XCTAssertTrue(element("pairDevice.ready").waitForExistence(timeout: 5))
    XCTAssertTrue(element("pairDevice.expired").waitForExistence(timeout: 12))
    shot("pair-expired")
  }

  func testRefusalsSayWhy() {
    open("limit")
    XCTAssertTrue(element("pairDevice.failed").waitForExistence(timeout: 5))
    XCTAssertTrue(
      app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'Too many pairing invites'")).firstMatch.exists)
    shot("pair-limit")
  }

  func testNoAccessWrite() {
    open("noaccess")
    XCTAssertTrue(app.staticTexts["Permission required"].waitForExistence(timeout: 5))
    shot("pair-noaccess")
  }
}

/// One real invite on the dev server (opt in with `TEST_RUNNER_ANKIEL_TEST_PAIR_INVITE=<file>`
/// and `TEST_RUNNER_ANKIEL_TEST_PAIR_BASE=<url>`): the app writes the invite to `<file>`, where
/// `ankiel-probe --claim-invite <file>` claims it; this test approves it on screen.
final class LivePairDeviceUITests: HomeUITestCase {
  func testApproveARealClaim() throws {
    let environment = ProcessInfo.processInfo.environment
    guard let file = environment["ANKIEL_TEST_PAIR_INVITE"], let base = environment["ANKIEL_TEST_PAIR_BASE"] else {
      throw XCTSkip("No live invite run set up.")
    }
    launch(["ANKIEL_DEBUG_ROUTE": "settings-computer-pair", "ANKIEL_DEBUG_PAIR_BASE_URL": base, "ANKIEL_DEBUG_PAIR_INVITE_OUT": file])
    // The probe claims within a second or two, so the ready state may already be gone.
    XCTAssertTrue(app.buttons["pairDevice.approve"].waitForExistence(timeout: 60), "the probe did not claim the invite")
    shot("pair-live-claimed")
    app.buttons["pairDevice.approve"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["pairDevice.approved"].firstMatch.waitForExistence(timeout: 10))
    shot("pair-live-approved")
  }
}
