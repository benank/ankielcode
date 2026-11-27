import XCTest

/// Entry points that live inside feed rows. Rows are hosted in collection view cells outside
/// SwiftUI's tree, so each one proves the thread's presenters reach the cells.
final class FeedEntryUITests: HomeUITestCase {
  /// Scrolls the feed up until `element` is on screen and hittable.
  func reveal(_ element: XCUIElement, swipes limit: Int = 30) -> Bool {
    var swipes = 0
    while !(element.exists && element.isHittable), swipes < limit {
      app.swipeDown(velocity: .slow)
      swipes += 1
    }
    return element.exists && element.isHittable
  }

  /// A tap while the feed still decelerates only stops it: tap again if nothing opened.
  func tapSettled(_ element: XCUIElement) {
    element.tap()
    if !app.buttons["review.sections"].waitForExistence(timeout: 2), element.exists, element.isHittable { element.tap() }
  }

  /// An expanded row that read or changed one file opens it in the viewer.
  func testFileOpensFromAWorkRow() {
    launch([
      "ANKIEL_DEBUG_THREAD": "markdown", "ANKIEL_DEBUG_THREAD_EXPAND": "all",
      "ANKIEL_DEBUG_COMPOSER": "fake", "ANKIEL_DEBUG_COMPOSER_RESET": "1",
    ])
    XCTAssertTrue(app.buttons["thread.menu"].waitForExistence(timeout: 15))
    let open = app.buttons["work.openFile"].firstMatch
    XCTAssertTrue(reveal(open), "an expanded file row offers to open its file")
    open.tap()
    if !app.buttons["files.done"].waitForExistence(timeout: 3), open.exists, open.isHittable { open.tap() }
    XCTAssertTrue(app.buttons["files.done"].waitForExistence(timeout: 10), "the file viewer opens")
    shot("feed-open-file")
  }

  /// A tool's image thumbnail in an expanded row opens the gallery: the live
  /// `MediaFilesUITests.testToolImageOpensFromItsThumbnail` (fixtures carry no images).

  /// An expanded file-change row offers "Review changes", which opens review on its turn.
  func testReviewOpensFromAFileChangeRow() {
    launch([
      "ANKIEL_DEBUG_THREAD": "markdown", "ANKIEL_DEBUG_REVIEW": "fixture", "ANKIEL_DEBUG_THREAD_EXPAND": "all",
      "ANKIEL_DEBUG_COMPOSER": "fake", "ANKIEL_DEBUG_COMPOSER_RESET": "1",
    ])
    XCTAssertTrue(app.buttons["thread.menu"].waitForExistence(timeout: 15))
    let link = app.buttons["work.review"].firstMatch
    XCTAssertTrue(reveal(link), "an expanded file change offers Review changes")
    shot("feed-review-link")
    tapSettled(link)
    let opened = app.buttons["review.sections"].waitForExistence(timeout: 10)
    shot("feed-review-opened")
    XCTAssertTrue(opened, "review opens")
  }

  /// The thread menu has one item per name: git's sheet is "Git actions", the thread's is "More".
  func testThreadMenuHasNoDuplicateLabels() {
    launch(["ANKIEL_DEBUG_THREAD": "short", "ANKIEL_DEBUG_REVIEW": "fixture", "ANKIEL_DEBUG_HOME": "sample"])
    let menu = app.buttons["thread.menu"]
    XCTAssertTrue(menu.waitForExistence(timeout: 15))
    menu.tap()
    // Menu items keep their labels, not their identifiers.
    XCTAssertTrue(app.buttons["Review changes"].waitForExistence(timeout: 5))
    shot("thread-menu")
    XCTAssertTrue(app.buttons["Git actions"].exists, "git's sheet has its own name")
    XCTAssertLessThanOrEqual(app.buttons.matching(NSPredicate(format: "label == 'More'")).count, 1)
  }
}
