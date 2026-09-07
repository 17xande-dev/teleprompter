// pdfview.ts — render a PDF as a plain column of pages inside a container.
//
// Deliberately not pdf.js's own viewer: this needs to be a stack of blocks in
// normal document flow, so the existing scroll sync keeps working untouched.
// scrollsync.ts measures scrollTop/scrollHeight of whatever it was given and
// converts to a ratio; a column of pages is no different to it than a column
// of paragraphs.
//
// pdf.js arrives through a dynamic import so the bundler splits it into its
// own chunk — a viewer that only ever shows text never downloads it.

import type {
  PDFDocumentProxy,
  PDFPageProxy,
  RenderTask,
} from "pdfjs-dist/types/src/pdf.d.ts";

export interface PdfView {
  /** Re-lay-out the pages at a new column width, keeping the scroll position. */
  setWidth(cssWidth: number): Promise<void>;
  destroy(): void;
}

// How far outside the viewport to keep pages rasterized, as a multiple of the
// scroll container's height. Generous, because the prompter scrolls
// continuously and a page that starts rendering only as its top edge appears
// arrives visibly late.
const RENDER_MARGIN = "200%";

// Cap the backing store so a large display doesn't try to allocate a canvas
// per page at 3x device pixels. Text stays sharp well below the point where
// this bites.
const MAX_PIXEL_RATIO = 2;

// Gap between pages, as a fraction of page height — see layout().
const PAGE_GAP = 0.02;

// The specifier is a variable so the bundler leaves it alone and the library
// stays a separate, lazily fetched file — a viewer that only ever shows text
// never downloads it. Cached so a second PDF doesn't re-evaluate the module.
let pdfjsPromise: Promise<typeof import("./pdfjs.ts")> | null = null;

function loadPdfjs(): Promise<typeof import("./pdfjs.ts")> {
  const url = "/pdfjs.js";
  pdfjsPromise ??= import(url) as Promise<typeof import("./pdfjs.ts")>;
  return pdfjsPromise;
}

interface Page {
  proxy: PDFPageProxy;
  /** Page box in PDF units at scale 1 — the aspect ratio never changes. */
  baseWidth: number;
  baseHeight: number;
  el: HTMLDivElement;
  canvas: HTMLCanvasElement | null;
  task: RenderTask | null;
}

export async function renderPdf(
  container: HTMLElement,
  data: ArrayBuffer,
  cssWidth: number,
): Promise<PdfView> {
  const pdfjs = await loadPdfjs();

  // Same-origin worker and side-files: see the CSP note in main.go. A
  // cross-origin workerSrc would send pdf.js down its blob: wrapper path,
  // which default-src 'self' refuses.
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdfworker.js";

  const loadingTask = pdfjs.getDocument({
    // getDocument transfers the buffer it is given, which would leave the
    // caller's copy detached — and the control page keeps its copy to re-send
    // to viewers that join later.
    data: data.slice(0),
    standardFontDataUrl: "/pdfjs/standard_fonts/",
    wasmUrl: "/pdfjs/wasm/",
  });
  const doc: PDFDocumentProxy = await loadingTask.promise;

  // Fetch every page's geometry before creating any element. Sizing the
  // placeholders in one pass means the container reaches its final
  // scrollHeight immediately: if pages grew as they rasterized, a ratio
  // measured on one viewer and applied on another would refer to two
  // different documents, and the two would visibly disagree during load.
  const proxies = await Promise.all(
    Array.from({ length: doc.numPages }, (_, i) => doc.getPage(i + 1)),
  );

  const pages: Page[] = proxies.map((proxy) => {
    const { width, height } = proxy.getViewport({ scale: 1 });
    const el = document.createElement("div");
    el.className = "pdf-page";
    return { proxy, baseWidth: width, baseHeight: height, el, canvas: null, task: null };
  });

  container.replaceChildren(...pages.map((p) => p.el));

  let width = cssWidth;
  let destroyed = false;

  function layout() {
    for (const page of pages) {
      const scale = width / page.baseWidth;
      const height = page.baseHeight * scale;
      page.el.style.width = `${width}px`;
      page.el.style.height = `${height}px`;
      // The gap is proportional too, not a fixed rem in CSS. Every viewer's
      // column is then the same shape at a different size, which is the whole
      // premise of syncing on a 0..1 ratio.
      page.el.style.marginBottom = `${height * PAGE_GAP}px`;
    }
  }

  function release(page: Page) {
    page.task?.cancel();
    page.task = null;
    page.canvas?.remove();
    page.canvas = null;
  }

  async function rasterize(page: Page) {
    if (destroyed || page.task) return;
    const scale = width / page.baseWidth;
    const ratio = Math.min(globalThis.devicePixelRatio || 1, MAX_PIXEL_RATIO);
    const viewport = page.proxy.getViewport({ scale: scale * ratio });

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    // The element already owns the layout height; the canvas just fills it.
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const task = page.proxy.render({ canvas, canvasContext: ctx, viewport });
    page.task = task;
    try {
      await task.promise;
    } catch {
      // A cancel() from release() or a width change lands here; it isn't a
      // failure, and the page will be re-rendered if it's still wanted.
      return;
    }
    if (destroyed || page.task !== task) return;
    release(page);
    page.canvas = canvas;
    page.task = null;
    page.el.replaceChildren(canvas);
  }

  // The observer's root has to be the element that actually scrolls. It
  // defaults to the viewport, which is right for a viewer (the document
  // scrolls) but wrong for the control page's pane, where only the page in
  // front of the operator would ever rasterize.
  const root = scrollParent(container);
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const page = pages.find((p) => p.el === entry.target);
      if (!page) continue;
      if (entry.isIntersecting) rasterize(page);
      else release(page);
    }
  }, {
    root: root === document.scrollingElement ? null : root,
    rootMargin: RENDER_MARGIN,
  });

  layout();
  for (const page of pages) observer.observe(page.el);

  return {
    async setWidth(next: number) {
      if (destroyed || next === width) return;

      // Re-laying out changes scrollHeight, and the browser keeps scrollTop in
      // pixels — so the position would land somewhere else in the document.
      // While the pacer is scrolling its ~60Hz samples would paper over that;
      // paused, nothing would ever correct it and the viewers would silently
      // sit on different lines.
      const scroller = scrollParent(container);
      const before = ratioOf(scroller);

      width = next;
      // Everything on screen is now the wrong size. Drop it and let the
      // observer re-request what's still visible.
      for (const page of pages) release(page);
      layout();
      setRatio(scroller, before);

      // The observer only reports *changes* in intersection, and a page that
      // was visible before and after the relayout produces no entry — so it
      // would sit blank until the reader scrolled. Kick the visible ones.
      await Promise.all(pages.filter((p) => isNear(p.el, scroller)).map(rasterize));
    },
    destroy() {
      destroyed = true;
      observer.disconnect();
      for (const page of pages) release(page);
      container.replaceChildren();
      // Tearing down the loading task is what actually shuts the worker down;
      // the document proxy has no destroy of its own. Without this every PDF
      // opened in a session leaves a worker behind.
      loadingTask.destroy();
    },
  };
}

// The element whose scrollbar actually moves this container: the viewer
// scrolls the document, the control page scrolls its own pane.
function scrollParent(el: HTMLElement): Element {
  let node: HTMLElement | null = el;
  while (node) {
    const overflow = getComputedStyle(node).overflowY;
    // Deliberately not also requiring scrollHeight > clientHeight: this is
    // called before the pages have been laid out, when nothing overflows yet,
    // and the answer would come back as the document every time.
    if (overflow === "auto" || overflow === "scroll") return node;
    node = node.parentElement;
  }
  return document.scrollingElement ?? document.documentElement;
}

function ratioOf(el: Element): number {
  const max = Math.max(0, el.scrollHeight - el.clientHeight);
  return max ? el.scrollTop / max : 0;
}

function setRatio(el: Element, ratio: number) {
  const max = Math.max(0, el.scrollHeight - el.clientHeight);
  el.scrollTo({ top: ratio * max, behavior: "instant" });
}

function isNear(el: HTMLElement, scroller: Element): boolean {
  const box = el.getBoundingClientRect();
  const view = scroller === document.scrollingElement
    ? { top: 0, bottom: globalThis.innerHeight }
    : scroller.getBoundingClientRect();
  const margin = (view.bottom - view.top) * 2;
  return box.bottom > view.top - margin && box.top < view.bottom + margin;
}
