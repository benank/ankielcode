package expo.modules.ankielpreviewtunnel

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class AnkielPreviewTunnelModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("AnkielPreviewTunnel")

    Function("resolveAccess") { requestId: String, url: String? ->
      TunnelAccess.resolve(requestId, url)
    }

    View(AnkielTunnelWebView::class) {
      Events("onAccessRequest", "onNavigationChange", "onLoadError", "onPageScroll")

      OnViewDestroys { view: AnkielTunnelWebView -> view.destroyWebView() }

      Prop("environmentId") { view: AnkielTunnelWebView, environmentId: String ->
        view.setEnvironment(environmentId)
      }
      Prop("url") { view: AnkielTunnelWebView, url: String -> view.loadUrl(url) }

      AsyncFunction("loadUrl") { view: AnkielTunnelWebView, url: String ->
        view.post { view.loadUrl(url) }
      }

      AsyncFunction("goBack") { view: AnkielTunnelWebView -> view.goBack() }
      AsyncFunction("goForward") { view: AnkielTunnelWebView -> view.goForward() }
      AsyncFunction("reload") { view: AnkielTunnelWebView -> view.reload() }
    }
  }
}

/**
 * Pending asks for a tunnel URL. JavaScript owns the environment's credentials and the route in
 * use, so every connection asks it for a freshly ticketed URL.
 */
internal object TunnelAccess {
  private val pending = ConcurrentHashMap<String, CompletableFuture<String?>>()
  private val nextId = AtomicInteger()

  /** Blocks the calling connection thread until JavaScript answers or 15 seconds pass. */
  fun request(ask: (String) -> Unit): String? {
    val requestId = "preview-tunnel-${nextId.incrementAndGet()}"
    val answer = CompletableFuture<String?>()
    pending[requestId] = answer
    return try {
      ask(requestId)
      answer.get(15, TimeUnit.SECONDS)
    } catch (_: Exception) {
      null
    } finally {
      pending.remove(requestId)
    }
  }

  fun resolve(requestId: String, url: String?) {
    pending[requestId]?.complete(url)
  }
}
