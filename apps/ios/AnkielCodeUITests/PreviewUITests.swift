import XCTest

/// A device preview through the dev server's tunnel. Needs a thread link
/// (`ANKIEL_TEST_PREVIEW_THREAD_LINK`) and a page served on the Mac's loopback
/// (`ANKIEL_TEST_PREVIEW_PORT`, its index links `/second.html`); skipped without them or the server.
/// Opens Browser from the thread menu, types the address, follows a link, goes back, then shows a
/// closed port's error.
final class PreviewUITests: HomeUITestCase {
  private var threadLink: String?
  private var port: String?

  override func setUp() async throws {
    let environment = ProcessInfo.processInfo.environment
    threadLink = environment["ANKIEL_TEST_PREVIEW_THREAD_LINK"]
    port = environment["ANKIEL_TEST_PREVIEW_PORT"]
    guard threadLink != nil, port != nil else { throw XCTSkip("No preview thread or page port given.") }
    let url = URL(string: "http://127.0.0.1:14527/.well-known/ankiel/environment")!
    guard (try? await URLSession.shared.data(from: url)) != nil else {
      throw XCTSkip("The dev server is not running.")
    }
  }

  func testOpenNavigateAndFail() throws {
    let threadLink = try XCTUnwrap(threadLink)
    let port = try XCTUnwrap(port)
    launch(["ANKIEL_OPEN_URL": threadLink])
    let menu = app.buttons["thread.menu"]
    XCTAssertTrue(menu.waitForExistence(timeout: 20))
    menu.tap()
    let browser = app.buttons.matching(NSPredicate(format: "identifier == 'thread.preview' OR label == 'Browser'")).firstMatch
    XCTAssertTrue(browser.waitForExistence(timeout: 5), "Browser is in the thread's menu")
    browser.tap()
    let new = app.buttons["thread.preview.new"]
    if new.waitForExistence(timeout: 2) { new.tap() }

    XCTAssertTrue(app.otherElements["preview.start"].waitForExistence(timeout: 10) || app.scrollViews["preview.start"].exists)
    shot("preview-start")
    let address = app.textFields["preview.address"]
    XCTAssertTrue(address.waitForExistence(timeout: 5))
    address.tap()
    address.typeText("localhost:\(port)\n")

    let heading = app.webViews.staticTexts["Tide chart preview"]
    XCTAssertTrue(heading.waitForExistence(timeout: 20), "the page loads through the tunnel")
    XCTAssertTrue(app.webViews.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Script: loaded'")).firstMatch.waitForExistence(timeout: 10))
    shot("preview-page")

    app.webViews.links["Second page"].tap()
    XCTAssertTrue(app.webViews.staticTexts["Second page"].waitForExistence(timeout: 15))
    let back = app.buttons["preview.back"]
    XCTAssertTrue(back.isEnabled)
    back.tap()
    XCTAssertTrue(heading.waitForExistence(timeout: 15), "Back returns to the first page")

    address.tap()
    app.buttons["Clear"].tap()
    address.typeText("localhost:47899\n")
    let refused = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'reach localhost:47899'")).firstMatch
    let found = refused.waitForExistence(timeout: 20)
    shot("preview-closed-port")
    XCTAssertTrue(found, "a closed port says so")

    app.buttons["preview.close"].tap()
    XCTAssertTrue(menu.waitForExistence(timeout: 5))
  }
}
