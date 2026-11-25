// FilesSearch: thin quad-mode View router delegating to isolated mode controllers.
import { View } from "gpui-kit";
import { theme, props } from "herdr";
import { createModLogger, renderErrorFallbackCard } from "./diagnostics.js";
import { PanelController } from "./panel-controller.js";
import { OverlayController } from "./overlay-controller.js";
import { IndexerController } from "./indexer-controller.js";
import { ViewerController } from "./viewer-controller.js";

export default class FilesSearch extends View {
  init(_props, cx) {
    const roleProps = props() || {};
    this.isOverlay = Boolean(roleProps.overlay);
    this.isIndexer = !this.isOverlay && roleProps.role === "indexer";
    this.isViewer = !this.isOverlay && !this.isIndexer && roleProps.role === "viewer";
    this.mode = this.isOverlay ? "overlay" : this.isIndexer ? "indexer" : this.isViewer ? "viewer" : "panel";
    this.logger = createModLogger("files-search");
    this.logger.lifecycle("mod.init", { mode: this.mode }, cx);

    if (this.isOverlay) {
      this.controller = new OverlayController(cx);
    } else if (this.isIndexer) {
      this.controller = new IndexerController(cx);
    } else if (this.isViewer) {
      this.controller = new ViewerController(cx);
    } else {
      this.controller = new PanelController(cx);
    }
  }

  close(cx) {
    try { this.logger?.dispose?.(); } catch {}
    try { this.controller?.close?.(cx); } catch {}
    this.controller = null;
  }

  render(cx) {
    try {
      return this.controller?.render(cx);
    } catch (err) {
      const mode = this.mode || "panel";
      const ser = this.logger?.recordRenderError(err, { mode }, cx);
      const summary = ser ? `${ser.name}: ${ser.message}` : String(err || "Render error");
      return renderErrorFallbackCard({
        modName: "files-search",
        errorSummary: summary,
        t: theme(),
        onRetry: (retryCx) => {
          this.controller?.clearError?.();
          retryCx.notify();
        },
        onExport: (exportCx) => {
          exportCx.spawn(async () => {
            await this.logger?.exportReport({ trigger: "error-card", extraState: { mode } });
          });
        },
      });
    }
  }
}
