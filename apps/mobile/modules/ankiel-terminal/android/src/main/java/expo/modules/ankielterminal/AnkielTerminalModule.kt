package expo.modules.ankielterminal

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class AnkielTerminalModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("AnkielTerminalSurface")

    // Bumped when native hardware-keyboard handling changes; surfaced in the JS debug
    // logs so a stale native binary is distinguishable from a broken key pipeline.
    Constants(
      "hardwareKeyRevision" to 2,
      "outputRevision" to 1,
    )

    View(AnkielTerminalView::class) {
      AsyncFunction("writeOutput") { view: AnkielTerminalView, data: String, reset: Boolean ->
        view.writeOutput(data, reset)
      }

      // The Android input field already clears after every change.
      AsyncFunction("resetInput") { _: AnkielTerminalView -> }

      Prop("terminalKey") { view: AnkielTerminalView, terminalKey: String ->
        view.terminalKey = terminalKey
      }

      Prop("initialBuffer") { view: AnkielTerminalView, initialBuffer: String ->
        view.initialBuffer = initialBuffer
      }

      Prop("fontSize") { view: AnkielTerminalView, fontSize: Double ->
        view.fontSize = fontSize.toFloat()
      }

      Prop("focusRequest") { view: AnkielTerminalView, focusRequest: Double ->
        view.focusRequest = focusRequest
      }

      Prop("readOnly") { view: AnkielTerminalView, readOnly: Boolean ->
        view.readOnly = readOnly
      }

      Prop("autoFocus") { view: AnkielTerminalView, autoFocus: Boolean ->
        view.autoFocus = autoFocus
      }

      Prop("appearanceScheme") { view: AnkielTerminalView, appearanceScheme: String ->
        view.appearanceScheme = appearanceScheme
      }

      Prop("themeConfig") { view: AnkielTerminalView, themeConfig: String ->
        view.themeConfig = themeConfig
      }

      Prop("backgroundColor") { view: AnkielTerminalView, backgroundColor: String ->
        view.backgroundColorHex = backgroundColor
      }

      Prop("foregroundColor") { view: AnkielTerminalView, foregroundColor: String ->
        view.foregroundColorHex = foregroundColor
      }

      Prop("mutedForegroundColor") { view: AnkielTerminalView, mutedForegroundColor: String ->
        view.mutedForegroundColorHex = mutedForegroundColor
      }

      Prop("captureRequest") { view: AnkielTerminalView, request: Double ->
        view.captureRequest = request
      }

      Prop("sharedGrid") { view: AnkielTerminalView, sharedGrid: List<Int> ->
        view.sharedGrid = sharedGrid
      }
      Events("onInput", "onResize", "onCapture")

      OnViewDidUpdateProps { view: AnkielTerminalView ->
        view.applyPendingBuffer()
      }

      OnViewDestroys { view: AnkielTerminalView ->
        view.cleanup()
      }
    }
  }
}
