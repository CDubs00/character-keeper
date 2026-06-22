// ExportStage.jsx
import React, { useEffect, useRef } from 'react';
import { toCanvas } from 'html-to-image';
import SheetRenderer from './SheetRenderer';

const EXPORT_WIDTH = 1150;
const PIXEL_RATIO  = 2;

export default function ExportStage({ char, mode = 'single', onDone, onError }) {
  const hostRef = useRef(null);

  useEffect(() => {
    if (!char) return;
    let cancelled = false;

    (async () => {
      const host = hostRef.current;
      if (!host) return;

      // Wait for SheetRenderer to render (.sheet-root appears).
      const deadline = Date.now() + 15000;
      let root = null;
      while (!cancelled && Date.now() < deadline) {
        root = host.querySelector('.sheet-root');
        if (root) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      if (cancelled) return;
      if (!root) throw new Error('Sheet did not finish loading');

      if (document.fonts?.ready) await document.fonts.ready;

      // Expand every inner scroll region so the snapshot shows ALL rows, not a
      // clipped, scrollbar'd window. Generic — keys off computed overflow, so it
      // works whatever classes the bundle used (gear list, weapon/armor tables…).
      root.querySelectorAll('*').forEach((el) => {
        const cs = getComputedStyle(el);
        if (/(auto|scroll)/.test(cs.overflow + cs.overflowX + cs.overflowY)) {
          el.style.overflow  = 'visible';
          el.style.maxHeight = 'none';
          el.style.maxWidth  = 'none';
        }
      });

      await new Promise((r) => requestAnimationFrame(() => r()));
      if (cancelled) return;

      const bg      = getComputedStyle(root).backgroundColor;
      const bgColor = bg && bg !== 'rgba(0, 0, 0, 0)' ? bg : '#ffffff';

      // One capture of the whole sheet — the render we KNOW comes out wide.
      const full = await toCanvas(root, { pixelRatio: PIXEL_RATIO, backgroundColor: bgColor, cacheBust: true });
      if (cancelled) return;

      const toBlob = (canvas) => new Promise((res) => canvas.toBlob(res, 'image/png'));

      if (mode === 'single') {
        const blob = await toBlob(full);
        if (!blob) throw new Error('Capture produced no image');
        if (!cancelled) onDone({ kind: 'single', blob });
        return;
      }

      // mode === 'tabs': slice the one good capture by each tab's box. No
      // re-render, so each tab inherits the exact wide layout of the single image.
      const panels = Array.from(root.querySelectorAll('.cf-tab-export'));
      if (panels.length === 0) {
        const blob = await toBlob(full);
        if (!cancelled) onDone({ kind: 'tabs', tabs: [{ label: '', blob }] });
        return;
      }

      const rootTop = root.getBoundingClientRect().top;

      // ── Step 1: measure each panel's natural slice geometry up front ─────────
      // top    = where this tab begins inside the full capture (device pixels)
      // height = how tall this tab's actual content is (device pixels)
      const geom = panels.map((panel) => {
        const r      = panel.getBoundingClientRect();
        const top    = Math.max(0, Math.round((r.top - rootTop) * PIXEL_RATIO));
        const height = Math.min(full.height - top, Math.round(r.height * PIXEL_RATIO));
        return { top, height };
      });

      // ── Step 2: the FIRST tab is the reference height ────────────────────────
      const refHeight = geom[0]?.height ?? 0;

      // ── Step 3: build each tab image ─────────────────────────────────────────
      const tabs = [];
      for (let i = 0; i < panels.length; i++) {
        if (cancelled) return;
        const { top, height } = geom[i];

        // Canvas height rule:
        //   tab 0            → its own height (it IS the reference)
        //   tab 1, 2, 3, …   → max(own height, reference)
        // So a SHORTER later tab is padded up to the reference; a TALLER one
        // keeps its full height and is never cropped.
        const canvasHeight = (i === 0) ? height : Math.max(height, refHeight);

        const slice = document.createElement('canvas');
        slice.width  = full.width;
        slice.height = canvasHeight;
        const ctx = slice.getContext('2d');

        // Fill the WHOLE canvas with background first — anything we don't draw
        // over (the padding below a short tab) stays this colour.
        ctx.fillStyle = bgColor;
        ctx.fillRect(0, 0, full.width, canvasHeight);

        // Draw only the tab's real content (its own `height`) at the top. We do
        // NOT scale to canvasHeight — that would stretch the image. The gap
        // between `height` and `canvasHeight` is the padding.
        ctx.drawImage(full, 0, top, full.width, height, 0, 0, full.width, height);

        const label = panels[i].querySelector('.cf-export-tab-title')?.textContent?.trim() || `tab-${i + 1}`;
        tabs.push({ label, blob: await toBlob(slice) });
      }
      if (!cancelled) onDone({ kind: 'tabs', tabs });
    })().catch((err) => { if (!cancelled) onError(err); });

    return () => { cancelled = true; };
  }, [char, mode, onDone, onError]);

  if (!char) return null;

  return (
    <div ref={hostRef} aria-hidden="true" style={{ position: 'fixed', left: '-10000px', top: 0, width: EXPORT_WIDTH, pointerEvents: 'none' }}>
      <SheetRenderer char={char} update={() => {}} charId={char.id} readOnly exportMode />
    </div>
  );
}
