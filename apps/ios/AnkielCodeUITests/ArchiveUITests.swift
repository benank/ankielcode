import XCTest

/// Settings → Archive against the dev server. Needs archived threads the probe made
/// (`ankiel-probe --live archive --seed 3`); deletes one of them and puts the others back.
final class ArchiveUITests: HomeUITestCase {
  override func setUp() async throws {
    let url = URL(string: "http://127.0.0.1:14527/.well-known/ankiel/environment")!
    guard (try? await URLSession.shared.data(from: url)) != nil else {
      throw XCTSkip("The dev server is not running.")
    }
    launch(["ANKIEL_DEBUG_ROUTE": "settings-archive"])
  }

  private var rows: XCUIElementQuery {
    app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'archive.thread.'"))
  }

  private func seededRow() throws -> XCUIElement {
    let row = rows.containing(NSPredicate(format: "label CONTAINS 'probe archive'")).firstMatch
    guard row.waitForExistence(timeout: 15) else { throw XCTSkip("No seeded archived thread (run the probe's --seed).") }
    return row
  }

  func testOpenReadOnlyThenUnarchiveUndoAndDelete() throws {
    var row = try seededRow()
    let id = row.identifier
    shot("archive-list")

    row.tap()
    XCTAssertTrue(app.buttons["thread.unarchive"].waitForExistence(timeout: 10), "an archived thread opens read-only")
    XCTAssertFalse(app.textViews["composer.field"].exists)
    shot("archive-thread")
    app.navigationBars.buttons.element(boundBy: 0).tap()

    row = app.buttons[id]
    XCTAssertTrue(row.waitForExistence(timeout: 5))
    row.swipeLeft()
    app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Unarchive'")).firstMatch.tap()
    XCTAssertTrue(app.buttons["archive.undo"].waitForExistence(timeout: 8))
    XCTAssertTrue(app.buttons[id].waitForNonExistence(timeout: 5), "an unarchived row leaves the list")
    shot("archive-undo")
    app.buttons["archive.undo"].tap()
    XCTAssertTrue(app.buttons[id].waitForExistence(timeout: 10), "undo archives it again")

    app.buttons[id].swipeLeft()
    app.buttons["Delete"].tap()
    XCTAssertTrue(app.buttons["archive.confirmDelete"].waitForExistence(timeout: 3))
    shot("archive-delete-confirm")
    app.buttons["archive.confirmDelete"].firstMatch.tap()
    XCTAssertTrue(app.buttons[id].waitForNonExistence(timeout: 10), "a deleted row is gone")
  }
}
