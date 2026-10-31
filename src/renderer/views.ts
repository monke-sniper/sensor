// Reports where web views should be placed. The main process positions the
// real WebContentsViews over these placeholder rectangles.
import { sensor } from './api';

let pending = false;
let last = '';

export function requestRects(): void {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    const rects: { tabId: string; x: number; y: number; width: number; height: number }[] = [];
    document.querySelectorAll<HTMLElement>('[data-view-tab]').forEach((el) => {
      const id = el.dataset.viewTab!;
      if (!id) return;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return;
      rects.push({ tabId: id, x: r.left, y: r.top, width: r.width, height: r.height });
    });
    const key = JSON.stringify(rects);
    if (key === last) return;
    last = key;
    sensor.setRects(rects);
  });
}

export function forceRects(): void {
  last = '';
  requestRects();
}

export function watchLayout(root: HTMLElement): void {
  const ro = new ResizeObserver(() => requestRects());
  ro.observe(root);
  const mo = new MutationObserver(() => {
    root.querySelectorAll<HTMLElement>('[data-view-tab]').forEach((el) => {
      if (!(el as any).__observed) {
        (el as any).__observed = true;
        ro.observe(el);
      }
    });
    requestRects();
  });
  mo.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-view-tab', 'style', 'class'] });
  window.addEventListener('resize', requestRects);
}
