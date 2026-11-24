package expo.modules.ankielreviewdiff

import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private val REVIEW_DIFF_EVENTS = arrayOf(
  "onDebug",
  "onVisibleFileChange",
  "onToggleFile",
  "onToggleViewedFile",
  "onPressLine",
  "onToggleComment",
  "onPressNotice",
)

class AnkielReviewDiffModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("AnkielReviewDiffSurface")

    View(AnkielReviewDiffView::class) {
      Prop("tokensResetKey") { view: AnkielReviewDiffView, tokensResetKey: String ->
        view.setTokensResetKey(tokensResetKey)
      }
      Prop("contentResetKey") { view: AnkielReviewDiffView, contentResetKey: String ->
        view.setContentResetKey(contentResetKey)
      }
      Prop("collapsedFileIdsJson") { view: AnkielReviewDiffView, collapsedFileIdsJson: String ->
        view.setCollapsedFileIdsJson(collapsedFileIdsJson)
      }
      Prop("viewedFileIdsJson") { view: AnkielReviewDiffView, viewedFileIdsJson: String ->
        view.setViewedFileIdsJson(viewedFileIdsJson)
      }
      Prop("selectedRowIdsJson") { view: AnkielReviewDiffView, selectedRowIdsJson: String ->
        view.setSelectedRowIdsJson(selectedRowIdsJson)
      }
      Prop("collapsedCommentIdsJson") { view: AnkielReviewDiffView, collapsedCommentIdsJson: String ->
        view.setCollapsedCommentIdsJson(collapsedCommentIdsJson)
      }
      Prop("appearanceScheme") { view: AnkielReviewDiffView, appearanceScheme: String ->
        view.setAppearanceScheme(appearanceScheme)
      }
      Prop("themeJson") { view: AnkielReviewDiffView, themeJson: String ->
        view.setThemeJson(themeJson)
      }
      Prop("styleJson") { view: AnkielReviewDiffView, styleJson: String ->
        view.setStyleJson(styleJson)
      }
      Prop("rowHeight") { view: AnkielReviewDiffView, rowHeight: Double ->
        view.setRowHeight(rowHeight.toFloat())
      }
      // Accept the shared prop while deriving Android's scroll range from the drawn text.
      Prop("contentWidth") { _: AnkielReviewDiffView, _: Double -> }
      Prop("contentInsetBottom") { view: AnkielReviewDiffView, value: Double ->
        view.setContentInsetBottom(value.toFloat())
      }
      Prop("scrollEnabled") { view: AnkielReviewDiffView, enabled: Boolean ->
        view.setScrollEnabled(enabled)
      }
      Prop("initialRowIndex") { view: AnkielReviewDiffView, initialRowIndex: Double ->
        view.setInitialRowIndex(initialRowIndex)
      }
      Prop("initialFileId") { view: AnkielReviewDiffView, fileId: String ->
        view.setInitialFileId(fileId)
      }

      Events(REVIEW_DIFF_EVENTS)

      AsyncFunction("scrollToFile") { view: AnkielReviewDiffView, fileId: String, animated: Boolean ->
        view.scrollToFile(fileId, animated)
      }
      AsyncFunction("scrollToTop") { view: AnkielReviewDiffView, animated: Boolean ->
        view.scrollToTop(animated)
      }
      AsyncFunction("setRowsJson") { view: AnkielReviewDiffView, rowsJson: String, resetKey: String ->
        view.setContentResetKey(resetKey)
        view.setRowsJson(rowsJson)
      }
      AsyncFunction("setTokensJson") { view: AnkielReviewDiffView, tokensJson: String ->
        view.setTokensJson(tokensJson)
      }
      AsyncFunction("setTokensPatchJson") {
          view: AnkielReviewDiffView,
          tokensPatchJson: String,
          promise: Promise
        ->
        view.setTokensPatchJson(tokensPatchJson) { accepted -> promise.resolve(accepted) }
      }

      OnViewDestroys { view: AnkielReviewDiffView ->
        view.cleanup()
      }
    }
  }
}
