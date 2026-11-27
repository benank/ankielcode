import XCTest

/// Where the feed scrolls, asserted with element frames against the bars (fixtures, no server).
final class FeedScrollUITests: HomeUITestCase {
  var field: XCUIElement { app.textFields["composer.field"].exists ? app.textFields["composer.field"] : app.textViews["composer.field"] }
  var latest: XCUIElement { app.buttons["thread.scrollToLatest"] }
  var navBottom: CGFloat { app.navigationBars.firstMatch.frame.maxY }

  /// The visible band between the nav bar and the composer.
  func assertBetweenBars(_ element: XCUIElement, _ message: String, file: StaticString = #filePath, line: UInt = #line) {
    let frame = element.frame
    XCTAssertGreaterThanOrEqual(frame.minY, navBottom - 1, "\(message): \(frame) under the nav bar", file: file, line: line)
    XCTAssertLessThanOrEqual(frame.maxY, field.frame.minY, "\(message): \(frame) under the composer at \(field.frame.minY)", file: file, line: line)
  }

  func send(_ text: String) {
    field.tap()
    field.typeText(text)
    app.buttons["composer.send"].tap()
  }

  /// 1. Sending with the keyboard up brings the new message into view above the composer.
  func testSendingWithTheKeyboardUpShowsTheMessage() {
    launch(["ANKIEL_DEBUG_THREAD": "short", "ANKIEL_DEBUG_COMPOSER": "fail", "ANKIEL_DEBUG_COMPOSER_RESET": "1"])
    XCTAssertTrue(field.waitForExistence(timeout: 5))
    send("This will be refused")
    let edit = app.buttons["pending.edit"]
    XCTAssertTrue(edit.waitForExistence(timeout: 5))
    sleep(1)
    shot("feed-send-keyboard")
    assertBetweenBars(edit, "the failed message's actions")
    XCTAssertFalse(latest.exists, "the feed is at its end")
  }

  /// 1. Sending while scrolled up returns to the end and shows the new message.
  func testSendingWhileScrolledUpShowsTheMessage() {
    launch([
      "ANKIEL_DEBUG_THREAD": "long", "ANKIEL_DEBUG_THREAD_SCROLL": "top", "ANKIEL_DEBUG_COMPOSER": "offline",
      "ANKIEL_DEBUG_COMPOSER_RESET": "1",
    ])
    XCTAssertTrue(latest.waitForExistence(timeout: 5))
    send("Send when back")
    let delete = app.buttons["pending.delete"]
    XCTAssertTrue(delete.waitForExistence(timeout: 5))
    sleep(1)
    shot("feed-send-scrolled-up")
    assertBetweenBars(delete, "the waiting message's actions")
  }

  /// 4. A thread opens at its end: the last row's footer sits just above the composer.
  func testOpensAtTheEnd() {
    launch(["ANKIEL_DEBUG_THREAD": "markdown"])
    let copy = app.buttons.matching(identifier: "Copy message")
    XCTAssertTrue(copy.firstMatch.waitForExistence(timeout: 10))
    sleep(1)
    XCTAssertFalse(latest.exists)
    let last = copy.element(boundBy: copy.count - 1)
    let before = last.frame
    assertBetweenBars(last, "the last footer")
    sleep(1)
    XCTAssertEqual(last.frame.minY, before.minY, accuracy: 0.5, "nothing settles after opening")
  }

  /// 2, 8. The last turn's fold (scrolled to from the end) opens in place.
  func testOpeningTheLastFoldKeepsItInPlace() {
    launch(["ANKIEL_DEBUG_THREAD": "markdown"])
    let fold = lastFoldOnScreen()
    let before = fold.frame.minY
    fold.tap()
    sleep(1)
    shot("feed-last-fold-open")
    XCTAssertEqual(fold.frame.minY, before, accuracy: 2, "the fold stays under the finger")
    fold.tap()
    sleep(1)
    XCTAssertEqual(fold.frame.minY, before, accuracy: 2, "closing keeps it too")
  }

  /// 3, 8. A fold in the middle of a long feed opens in place and the rows under it render.
  func testOpeningAFoldMidFeedKeepsItInPlace() {
    launch(["ANKIEL_DEBUG_THREAD": "long", "ANKIEL_DEBUG_THREAD_SCROLL": "top"])
    XCTAssertTrue(latest.waitForExistence(timeout: 5))
    for _ in 0..<3 { app.swipeUp(velocity: .fast) }
    sleep(1)
    let folds = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Worked for'"))
    guard let fold = (0..<folds.count).lazy.map({ folds.element(boundBy: $0) }).first(where: \.isHittable) else {
      return XCTFail("no fold on screen")
    }
    let before = fold.frame.minY
    fold.tap()
    sleep(1)
    shot("feed-mid-fold-open")
    XCTAssertEqual(fold.frame.minY, before, accuracy: 2, "the fold stays under the finger")
    // Something renders right under it (no blank feed).
    let edge = fold.frame.maxY
    let below = app.buttons.allElementsBoundByIndex.contains { $0.frame.minY > edge - 1 && $0.frame.minY < edge + 120 }
    XCTAssertTrue(below, "rows show under the opened fold")
  }

  /// 5. Scrolled up while a reply streams: the reader's row stays put and the dot shows.
  func testStreamingDoesNotMoveAReaderWhoScrolledUp() {
    launch(["ANKIEL_DEBUG_THREAD": "replay"])
    XCTAssertTrue(app.buttons["thread.menu"].waitForExistence(timeout: 5))
    sleep(2)
    app.swipeDown(velocity: .slow)
    XCTAssertTrue(latest.waitForExistence(timeout: 3))
    sleep(1)
    let anchor = app.staticTexts.allElementsBoundByIndex.first { $0.isHittable && $0.frame.minY > navBottom + 20 }
    let before = anchor?.frame.minY
    sleep(2)
    XCTAssertEqual(anchor?.frame.minY ?? 0, before ?? 0, accuracy: 1, "the reader's row did not move")
    XCTAssertEqual(latest.value as? String, "New messages")
  }

  /// 7. Opening a child thread and coming back restores the reader's position.
  func testReturningRestoresThePosition() {
    launch([
      "ANKIEL_DEBUG_THREAD": "subagents", "ANKIEL_DEBUG_THREAD_EXPAND": "folds", "ANKIEL_DEBUG_THREAD_SCROLL": "top",
    ])
    XCTAssertTrue(app.buttons["thread.menu"].waitForExistence(timeout: 5))
    let row = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'Check inlet stations' OR label CONTAINS[c] 'Check north coast stations'")).firstMatch
    for _ in 0..<20 where !(row.exists && row.isHittable) { app.swipeUp(velocity: .slow) }
    sleep(1)
    let before = row.frame.minY
    row.tap()
    XCTAssertTrue(app.staticTexts["Could not open this thread"].waitForExistence(timeout: 5))
    app.navigationBars.buttons.firstMatch.tap()
    XCTAssertTrue(row.waitForExistence(timeout: 5))
    sleep(1)
    XCTAssertEqual(row.frame.minY, before, accuracy: 2, "the row is back where it was")
  }

  /// 6. The keyboard rising and the composer growing keep the newest row just above the composer.
  func testKeyboardAndComposerGrowthKeepTheEnd() {
    launch(["ANKIEL_DEBUG_THREAD": "markdown", "ANKIEL_DEBUG_COMPOSER": "slow", "ANKIEL_DEBUG_COMPOSER_RESET": "1"])
    let copy = app.buttons.matching(identifier: "Copy message")
    XCTAssertTrue(copy.firstMatch.waitForExistence(timeout: 8))
    sleep(1)
    let footer = copy.element(boundBy: copy.count - 1)
    let gap = field.frame.minY - footer.frame.maxY
    field.tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    sleep(1)
    XCTAssertEqual(field.frame.minY - footer.frame.maxY, gap, accuracy: 2, "the end stays above the raised composer")
    field.typeText("one\ntwo\nthree\nfour\nfive\nsix\nseven\neight")
    sleep(1)
    shot("feed-composer-grown")
    XCTAssertEqual(field.frame.minY - footer.frame.maxY, gap, accuracy: 2, "the end stays above the grown composer")
    XCTAssertFalse(latest.exists, "still at the end")
  }

  /// 6. Rotating while scrolled up keeps the reader's row on screen and puts it back on return.
  func testRotationKeepsTheReadersRow() {
    launch(["ANKIEL_DEBUG_THREAD": "long", "ANKIEL_DEBUG_THREAD_SCROLL": "top"])
    XCTAssertTrue(latest.waitForExistence(timeout: 8))
    for _ in 0..<4 { app.swipeUp(velocity: .slow) }
    sleep(1)
    let fold = lastFoldOnScreen()
    let label = fold.label
    let before = fold.frame.minY - navBottom
    XCUIDevice.shared.orientation = .landscapeLeft
    sleep(2)
    shot("feed-rotated")
    XCTAssertTrue(app.buttons[label].firstMatch.exists, "the reader's row is still in view")
    XCUIDevice.shared.orientation = .portrait
    sleep(2)
    XCTAssertEqual(app.buttons[label].firstMatch.frame.minY - navBottom, before, accuracy: 2, "the row is back in place")
  }
}

extension HomeUITestCase {
  /// Scrolls up from the end until a run fold is on screen, and returns the lowest one. The feed
  /// only has rows on screen (and just around it) in the accessibility tree.
  func lastFoldOnScreen(file: StaticString = #filePath, line: UInt = #line) -> XCUIElement {
    XCTAssertTrue(app.buttons["thread.menu"].waitForExistence(timeout: 8), file: file, line: line)
    let folds = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Worked for'"))
    for _ in 0..<12 where !folds.allElementsBoundByIndex.contains(where: \.isHittable) {
      app.swipeDown(velocity: .slow)
    }
    sleep(1)
    let label = folds.allElementsBoundByIndex.last(where: \.isHittable)?.label ?? "no fold"
    return app.buttons[label].firstMatch
  }
}
