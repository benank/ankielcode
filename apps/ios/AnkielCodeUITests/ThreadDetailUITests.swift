import XCTest

/// The thread screen over bundled fixtures (`ANKIEL_DEBUG_THREAD`, no server).
final class FixtureThreadUITests: HomeUITestCase {
  func testFoldOpensTheTurnsWork() {
    launch(["ANKIEL_DEBUG_THREAD": "short"])
    let fold = app.buttons["Worked for 10s"]
    XCTAssertTrue(fold.waitForExistence(timeout: 5))
    let latest = app.buttons["thread.scrollToLatest"]
    _ = latest.waitForNonExistence(timeout: 2)
    shot("thread-short-opened")
    XCTAssertFalse(latest.exists && latest.isHittable, "the thread opens at the bottom")
    fold.tap()
    let work = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'command'")).firstMatch
    XCTAssertTrue(work.waitForExistence(timeout: 2), "the fold shows the turn's work group")
    shot("thread-fold-open")
  }

  /// Opening the last work group while at the bottom keeps the feed on screen.
  func testOpeningTheTailGroupKeepsTheFeed() {
    launch(["ANKIEL_DEBUG_THREAD": "kinds"])
    let group = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Searched code'")).firstMatch
    XCTAssertTrue(group.waitForExistence(timeout: 5))
    group.tap()
    sleep(1)
    shot("thread-kinds-tail-open")
    XCTAssertTrue(app.staticTexts["Show every item kind."].exists || group.isHittable)
  }

  /// A large fold opened at the bottom expands in place; the feed stays on screen.
  func testOpeningALargeFoldAtTheBottom() {
    launch(["ANKIEL_DEBUG_THREAD": "markdown"])
    let fold = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Worked for'")).element(boundBy: 0)
    XCTAssertTrue(fold.waitForExistence(timeout: 5))
    let folds = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Worked for'"))
    let last = folds.element(boundBy: folds.count - 1)
    last.tap()
    sleep(1)
    shot("thread-markdown-fold-open")
    XCTAssertTrue(last.isHittable, "the opened fold stays on screen")
  }

  /// Scrolling up while a reply streams keeps the reader's place and shows the new-content dot.
  func testScrollingUpWhileStreaming() {
    launch(["ANKIEL_DEBUG_THREAD": "replay"])
    XCTAssertTrue(app.buttons["thread.menu"].waitForExistence(timeout: 5))
    sleep(2)
    app.swipeDown(velocity: .slow)
    let latest = app.buttons["thread.scrollToLatest"]
    XCTAssertTrue(latest.waitForExistence(timeout: 3))
    sleep(2)
    shot("thread-replay-scrolled-up")
    XCTAssertEqual(latest.value as? String, "New messages")
    latest.tap()
    XCTAssertTrue(latest.waitForNonExistence(timeout: 3))
  }

  /// A subagent row opens its child thread (a fixture child has no data, so it says so).
  func testSubagentRowOpensTheChildThread() {
    launch([
      "ANKIEL_DEBUG_THREAD": "subagents", "ANKIEL_DEBUG_THREAD_EXPAND": "folds", "ANKIEL_DEBUG_THREAD_SCROLL": "top",
    ])
    XCTAssertTrue(app.buttons["thread.menu"].waitForExistence(timeout: 5))
    let row = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'Reef forecast' OR label CONTAINS[c] 'Fathom vessel'")).firstMatch
    for _ in 0..<20 where !(row.exists && row.isHittable) { app.swipeUp(velocity: .slow) }
    XCTAssertTrue(row.isHittable)
    shot("thread-subagent-row")
    row.tap()
    XCTAssertTrue(app.staticTexts["Could not open this thread"].waitForExistence(timeout: 5))
    // The child pushed onto the stack, so Back returns to the parent thread.
    app.navigationBars.buttons.firstMatch.tap()
    XCTAssertTrue(row.waitForExistence(timeout: 5))
    XCTAssertFalse(app.staticTexts["Could not open this thread"].exists)
  }

  func testScrollToLatestReturnsToTheBottom() {
    launch(["ANKIEL_DEBUG_THREAD": "long", "ANKIEL_DEBUG_THREAD_SCROLL": "top"])
    let button = app.buttons["thread.scrollToLatest"]
    XCTAssertTrue(button.waitForExistence(timeout: 5))
    button.tap()
    XCTAssertTrue(button.waitForNonExistence(timeout: 3))
  }

  func testStreamingReplaySettles() {
    launch(["ANKIEL_DEBUG_THREAD": "replay"])
    XCTAssertTrue(app.buttons["Copy message"].waitForExistence(timeout: 15), "the replayed turn ends with a footer")
  }

  /// Scroll hitches on the 500-row fixture (`XCTOSSignpostMetric.scrollingAndDecelerationMetric`).
  func testLongThreadScrollPerformance() {
    launch(["ANKIEL_DEBUG_THREAD": "long"])
    XCTAssertTrue(app.buttons["thread.menu"].waitForExistence(timeout: 5))
    sleep(1)
    let options = XCTMeasureOptions()
    options.iterationCount = 3
    measure(metrics: [XCTOSSignpostMetric.scrollingAndDecelerationMetric], options: options) {
      app.swipeDown(velocity: .fast)
      app.swipeDown(velocity: .fast)
      app.swipeUp(velocity: .fast)
    }
  }
}

/// The thread screen against the dev server; skipped while it is down.
final class LiveThreadUITests: HomeUITestCase {
  override func setUp() async throws {
    let url = URL(string: "http://127.0.0.1:14527/.well-known/ankiel/environment")!
    guard (try? await URLSession.shared.data(from: url)) != nil else {
      throw XCTSkip("The dev server is not running.")
    }
    launch(["ANKIEL_DEBUG_ROUTE": "thread"])
  }

  func testFirstThreadLoadsItsConversation() {
    XCTAssertTrue(app.buttons["thread.menu"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.otherElements["Loading thread"].waitForNonExistence(timeout: 10))
    shot("live-thread")
  }
}
