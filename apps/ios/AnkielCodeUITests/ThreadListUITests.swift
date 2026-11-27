import XCTest

/// Home interactions on the simulator. `SampleListUITests` use the canned rows of
/// `ANKIEL_DEBUG_HOME=sample` (no server); `LiveListUITests` change real threads on the dev server
/// and put each one back.
@MainActor
class HomeUITestCase: XCTestCase {
  var app: XCUIApplication!

  func launch(_ environment: [String: String] = [:]) {
    continueAfterFailure = false
    app = XCUIApplication()
    app.launchEnvironment = environment
    app.launch()
  }

  func row(_ id: String) -> XCUIElement { app.buttons["thread.\(id)"] }

  /// Saves a screenshot to `TEST_RUNNER_SHOTS_DIR` when set, and attaches it to the result.
  func shot(_ name: String) {
    let screenshot = XCUIScreen.main.screenshot()
    let attachment = XCTAttachment(screenshot: screenshot)
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
    if let dir = ProcessInfo.processInfo.environment["SHOTS_DIR"] {
      try? screenshot.pngRepresentation.write(to: URL(filePath: dir).appending(path: "\(name).png"))
    }
  }
}

final class SampleListUITests: HomeUITestCase {
  override func setUp() async throws {
    launch(["ANKIEL_DEBUG_HOME": "sample"])
  }

  func testRowsFoldersAndShelves() {
    XCTAssertTrue(row("approval").waitForExistence(timeout: 5))
    XCTAssertTrue(row("subagent").exists, "a live subagent nests under its parent")
    XCTAssertFalse(row("settled-1").exists, "the settled shelf starts closed")
    app.swipeUp()
    app.buttons["shelf.settled"].firstMatch.tap()
    XCTAssertTrue(row("settled-1").waitForExistence(timeout: 2))
    shot("settled-open")
    app.buttons["shelf.settled"].firstMatch.tap()
    XCTAssertTrue(row("settled-1").waitForNonExistence(timeout: 2))
    app.swipeDown()

    app.buttons["folder.debug-studio:p2"].tap()
    XCTAssertTrue(row("input").waitForNonExistence(timeout: 2), "a closed folder hides its rows")
    app.buttons["folder.debug-studio:p2"].tap()
    XCTAssertTrue(row("input").waitForExistence(timeout: 2))
  }

  func testSwipeShowsSettleAndSnoozeAndRestoresOnFailure() {
    let target = row("done")
    XCTAssertTrue(target.waitForExistence(timeout: 5))
    target.swipeLeft()
    XCTAssertTrue(app.buttons["Settle"].waitForExistence(timeout: 2))
    XCTAssertTrue(app.buttons["Snooze"].exists)
    shot("swipe-trailing")
    app.buttons["Settle"].tap()
    // Canned rows are not on a server: the command fails, the row comes back and the alert explains.
    XCTAssertTrue(app.alerts["Could not settle thread"].waitForExistence(timeout: 5))
    app.alerts.buttons.firstMatch.tap()
    XCTAssertTrue(row("done").waitForExistence(timeout: 3))

    row("done").swipeRight()
    XCTAssertTrue(app.buttons["Read"].waitForExistence(timeout: 2), "an unread row swipes to mark read")
    row("done").tap()  // closes the swipe
  }

  func testContextMenu() {
    let target = row("done")
    XCTAssertTrue(target.waitForExistence(timeout: 5))
    target.press(forDuration: 1.0)
    XCTAssertTrue(app.buttons["Copy thread link"].waitForExistence(timeout: 3))
    for title in ["Copy thread ID", "Settle", "Snooze", "Pin", "More"] {
      XCTAssertTrue(app.buttons[title].exists, "menu has \(title)")
    }
    shot("context-menu")
    app.buttons["More"].tap()
    XCTAssertTrue(app.buttons["Rename"].waitForExistence(timeout: 2))
    XCTAssertTrue(app.buttons["Mark read"].exists)
    XCTAssertTrue(app.buttons["Delete"].exists)
    shot("context-menu-more")
    app.buttons["Delete"].tap()
    XCTAssertTrue(app.staticTexts["Delete thread?"].waitForExistence(timeout: 2), "delete asks first")
    shot("delete-confirm")
    app.alerts.buttons["Cancel"].tap()
    XCTAssertTrue(app.staticTexts["Delete thread?"].waitForNonExistence(timeout: 2))
    XCTAssertTrue(row("done").exists, "cancel keeps the thread")
  }

  func testSearchFiltersRows() {
    XCTAssertTrue(row("done").waitForExistence(timeout: 5))
    let field = app.searchFields.firstMatch
    field.tap()
    field.typeText("ipad")
    XCTAssertTrue(row("done").waitForExistence(timeout: 2))
    XCTAssertTrue(row("approval").waitForNonExistence(timeout: 2))
    shot("search")
    field.typeText("zzz")
    let noResults = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH[c] 'No Results'")).firstMatch
    XCTAssertTrue(noResults.waitForExistence(timeout: 3))
    shot("search-empty")
  }

  func testFilterMenuScopesTheList() {
    XCTAssertTrue(row("gpu").waitForExistence(timeout: 5))
    app.buttons["home.filter"].tap()
    XCTAssertTrue(app.buttons["All computers"].waitForExistence(timeout: 2))
    shot("filter-menu")
    app.buttons["Linux box"].tap()
    XCTAssertTrue(row("done").waitForNonExistence(timeout: 2))
    XCTAssertTrue(row("gpu").exists)
    app.buttons["home.filter"].tap()
    app.buttons["All computers"].tap()
    XCTAssertTrue(row("done").waitForExistence(timeout: 2))
  }

  func testRowOpensThreadAndBack() {
    let target = row("done")
    XCTAssertTrue(target.waitForExistence(timeout: 5))
    target.tap()
    XCTAssertTrue(app.buttons["thread.menu"].waitForExistence(timeout: 3))
    app.navigationBars.buttons.firstMatch.tap()
    XCTAssertTrue(row("done").waitForExistence(timeout: 3))
  }
}

final class DeepLinkUITests: HomeUITestCase {
  func testThreadLinkOpensAtLaunch() {
    launch(["ANKIEL_DEBUG_HOME": "sample", "ANKIEL_OPEN_URL": "ankielcode-native://thread/debug-studio/done"])
    XCTAssertTrue(app.buttons["thread.menu"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.navigationBars["Add the iPad split layout"].exists)
  }

  func testEmptyState() {
    launch(["ANKIEL_DEBUG_HOME": "empty"])
    XCTAssertTrue(app.staticTexts["No threads yet"].waitForExistence(timeout: 5))
    shot("empty-no-threads")
  }
}

/// Real commands against the dev server. Each test puts the thread back as it found it.
final class LiveListUITests: HomeUITestCase {
  override func setUp() async throws {
    let url = URL(string: "http://127.0.0.1:14527/.well-known/ankiel/environment")!
    guard (try? await URLSession.shared.data(from: url)) != nil else {
      throw XCTSkip("The dev server is not running.")
    }
    launch()
  }

  /// The first thread row on screen, by identifier.
  func firstRow() -> XCUIElement {
    app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'thread.'")).firstMatch
  }

  func testSettleThenUndo() {
    let target = firstRow()
    XCTAssertTrue(target.waitForExistence(timeout: 10))
    let id = target.identifier
    target.swipeLeft()
    app.buttons["Settle"].tap()
    XCTAssertTrue(app.buttons["undo.button"].waitForExistence(timeout: 5))
    shot("undo-notice")
    app.buttons["undo.button"].tap()
    XCTAssertTrue(app.buttons[id].waitForExistence(timeout: 8), "undo brings the row back")
  }

  func testRenameAndRestore() {
    let target = firstRow()
    XCTAssertTrue(target.waitForExistence(timeout: 10))
    let id = target.identifier
    let original = target.label.components(separatedBy: ", ").first ?? ""
    func rename(to title: String) {
      app.buttons[id].press(forDuration: 1.0)
      app.buttons["More"].tap()
      app.buttons["Rename"].tap()
      let field = app.textFields["rename.field"]
      XCTAssertTrue(field.waitForExistence(timeout: 3))
      field.clearAndType(title)
      app.buttons["rename.save"].tap()
    }
    rename(to: "UI test rename")
    XCTAssertTrue(
      app.buttons[id].staticTexts["UI test rename"].waitForExistence(timeout: 8))
    rename(to: original)
    XCTAssertTrue(app.buttons[id].staticTexts[original].waitForExistence(timeout: 8))
  }
}

extension XCUIElement {
  func clearAndType(_ text: String) {
    tap()
    if let value = value as? String, !value.isEmpty {
      typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: value.count))
    }
    typeText(text)
  }
}
