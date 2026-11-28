import XCTest

/// Diff review on the fixture checkout (`ANKIEL_DEBUG_REVIEW=fixture`): no server, and git
/// actions go to a fake.
final class ReviewUITests: HomeUITestCase {
  func fixture(_ extra: [String: String] = [:]) {
    launch(
      [
        "ANKIEL_DEBUG_THREAD": "short", "ANKIEL_DEBUG_REVIEW": "fixture", "ANKIEL_DEBUG_COMPOSER": "fake",
        "ANKIEL_DEBUG_COMPOSER_RESET": "1",
      ].merging(extra) { _, new in new })
  }

  /// Open review from the thread menu → pick the uncommitted section → open a file → next and
  /// previous file → show unchanged lines.
  func testOpenSwitchFileExpandContext() {
    fixture()
    let menu = app.buttons["thread.menu"]
    XCTAssertTrue(menu.waitForExistence(timeout: 15))
    menu.tap()
    let review = app.buttons["Review changes"]
    XCTAssertTrue(review.waitForExistence(timeout: 5), "Review changes is in the thread's menu")
    review.tap()

    let sections = app.buttons["review.sections"]
    XCTAssertTrue(sections.waitForExistence(timeout: 10))
    sections.tap()
    let uncommitted = app.buttons["Uncommitted"]
    XCTAssertTrue(uncommitted.waitForExistence(timeout: 5))
    uncommitted.tap()

    // A button on iPhone, a selectable list cell in the iPad split.
    let file = app.descendants(matching: .any).matching(identifier: "review.file").firstMatch
    XCTAssertTrue(file.waitForExistence(timeout: 10))
    shot("review-uncommitted")
    file.tap()
    XCTAssertTrue(app.descendants(matching: .any)["review.diff"].waitForExistence(timeout: 10))
    let position = app.buttons["review.jump"]
    XCTAssertEqual(position.value as? String, "1 of 2")
    app.buttons["review.next"].tap()
    XCTAssertTrue(value(position, "2 of 2"), "next moves to the second file")
    app.buttons["review.previous"].tap()
    // Files keep the server's order: the chart (with gaps) is first.
    XCTAssertTrue(value(position, "1 of 2"))

    let lines = app.descendants(matching: .any).matching(identifier: "review.line")
    XCTAssertTrue(lines.firstMatch.waitForExistence(timeout: 5))
    let before = lines.count
    let expand = app.buttons["review.expand"].firstMatch
    XCTAssertTrue(expand.waitForExistence(timeout: 5))
    expand.tap()
    let more = NSPredicate { _, _ in lines.count > before }
    expectation(for: more, evaluatedWith: nil)
    waitForExpectations(timeout: 10)
    shot("review-expanded")
  }

  func value(_ element: XCUIElement, _ expected: String) -> Bool {
    let predicate = NSPredicate(format: "value == %@", expected)
    return XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: predicate, object: element)], timeout: 5) == .completed
  }

  /// Tap a line → comment → the review comment lands in the thread's composer draft.
  func testLineCommentGoesToComposer() {
    fixture(["ANKIEL_DEBUG_REVIEW_OPEN": "file:Sources/TideKit/TideChart.swift"])
    let line = app.descendants(matching: .any).matching(identifier: "review.line").element(boundBy: 4)
    XCTAssertTrue(line.waitForExistence(timeout: 15))
    line.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.5)).tap()

    let field = app.textFields["review.comment.text"]
    XCTAssertTrue(field.waitForExistence(timeout: 5))
    field.typeText("Keep feet for US stations")
    shot("review-comment")
    app.buttons["review.comment.submit"].tap()
    XCTAssertTrue(field.waitForNonExistence(timeout: 5))

    // A long press starts a range and a tap ends it.
    let rows = app.descendants(matching: .any).matching(identifier: "review.line")
    rows.element(boundBy: 6).coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.5)).press(forDuration: 0.6)
    rows.element(boundBy: 9).coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.5)).tap()
    let range = app.buttons["review.commentRange"]
    shot("review-range")
    XCTAssertTrue(range.waitForExistence(timeout: 5))
    XCTAssertTrue(range.label.contains("to"), "the bar names the range: \(range.label)")

    app.navigationBars.buttons.element(boundBy: 0).tap()
    app.buttons["review.done"].tap()
    let composer = app.textViews["composer.field"].exists ? app.textViews["composer.field"] : app.textFields["composer.field"]
    XCTAssertTrue(composer.waitForExistence(timeout: 10))
    let value = composer.value as? String ?? ""
    XCTAssertTrue(value.contains("<review_comment"), "the composer holds the comment block: \(value.prefix(120))")
    XCTAssertTrue(value.contains("Keep feet for US stations"))
    XCTAssertTrue(value.contains("filePath=\"Sources/TideKit/TideChart.swift\""))
  }

  /// A 5,000-line file: placeholder, load anyway, then scroll it.
  func testLargeDiffLoadsAndScrolls() {
    fixture(["ANKIEL_DEBUG_REVIEW_OPEN": "file:Data/stations.csv"])
    let load = app.buttons["review.loadAnyway"]
    XCTAssertTrue(load.waitForExistence(timeout: 15))
    load.tap()
    let tapped = Date.now
    let diff = app.descendants(matching: .any)["review.diff"]
    XCTAssertTrue(diff.waitForExistence(timeout: 10))
    let lines = app.descendants(matching: .any).matching(identifier: "review.line")
    XCTAssertTrue(lines.firstMatch.waitForExistence(timeout: 10))
    let firstRow = Date.now.timeIntervalSince(tapped)
    // Lazy: only the rows near the screen exist, not all 5,000.
    let realized = lines.count
    print("large diff: first row after \(firstRow)s, \(realized) line rows realized")
    XCTAssertLessThan(realized, 400, "the stack is lazy")
    let options = XCTMeasureOptions()
    options.iterationCount = 3
    measure(metrics: [XCTOSSignpostMetric.scrollDecelerationMetric], options: options) {
      diff.swipeUp(velocity: .fast)
      diff.swipeUp(velocity: .fast)
    }
    shot("review-large")
  }

  /// The git sheet's commit on the default branch asks first, from the thread menu's quick action.
  func testDefaultBranchConfirmation() {
    fixture()
    let menu = app.buttons["thread.menu"]
    XCTAssertTrue(menu.waitForExistence(timeout: 15))
    menu.tap()
    let quick = app.buttons["Commit & push"]
    XCTAssertTrue(quick.waitForExistence(timeout: 5))
    quick.tap()
    XCTAssertTrue(app.alerts.buttons["Feature branch & continue"].waitForExistence(timeout: 5))
    shot("git-confirm")
    app.alerts.buttons["Commit & push to main"].tap()

    // The fake streams two phases, then the server's toast.
    let progress = app.descendants(matching: .any)["git.progress"]
    XCTAssertTrue(progress.waitForExistence(timeout: 5))
    shot("git-progress")
    let done = NSPredicate(format: "label CONTAINS 'Committed'")
    XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: done, object: progress)], timeout: 8), .completed)
    shot("git-result")
  }
}
