// Converts a scrollable element's scrollTop to/from a 0..1 ratio (so windows
// of different sizes stay aligned), coalesces native scroll events to at
// most one outgoing send per animation frame, and suppresses the echo that
// would otherwise happen when applyRemote's own scrollTo fires a native
// "scroll" event straight back into the same listener.

export interface ScrollSync {
  applyRemote(ratio: number): void;
}

export interface ScrollSyncOptions {
  el: HTMLElement | Window;
  send: (ratio: number, seq: number) => void;
}

function maxScroll(el: ScrollSyncOptions["el"]): number {
  if (el instanceof Window) {
    return document.documentElement.scrollHeight - el.innerHeight;
  }
  return el.scrollHeight - el.clientHeight;
}

function currentTop(el: ScrollSyncOptions["el"]): number {
  if (el instanceof Window) {
    return el.scrollY;
  }
  return el.scrollTop;
}

function scrollTo(el: ScrollSyncOptions["el"], top: number) {
  if (el instanceof Window) {
    el.scrollTo({ top, behavior: "instant" });
    return;
  }
  el.scrollTo({ top, behavior: "instant" });
}

export function makeScrollSync(opts: ScrollSyncOptions): ScrollSync {
  const { el, send } = opts;
  let applyingRemote = false;
  let pending: number | null = null;
  let seq = 0;
  let scheduled = false;

  function currentRatio(): number {
    const max = maxScroll(el);
    if (max <= 0) return 0;
    return currentTop(el) / max;
  }

  function flush() {
    scheduled = false;
    if (pending === null) return;
    seq++;
    send(pending, seq);
    pending = null;
  }

  el.addEventListener(
    "scroll",
    () => {
      // Don't re-broadcast a position we just applied ourselves.
      if (applyingRemote) return;
      pending = currentRatio();
      if (!scheduled) {
        scheduled = true;
        requestAnimationFrame(flush);
      }
    },
    { passive: true },
  );

  return {
    applyRemote(ratio: number) {
      applyingRemote = true;
      scrollTo(el, ratio * maxScroll(el));
      // Release after the resulting scroll event has had a chance to fire.
      requestAnimationFrame(() => {
        applyingRemote = false;
      });
    },
  };
}
