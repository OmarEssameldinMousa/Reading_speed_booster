import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { PageModel } from '../pdf/types';
import type { Marks } from './marks';

interface Props {
  doc: PDFDocumentProxy;
  pages: PageModel[];
  marks: Marks;
  width: number;
  onWordClick: (w: number) => void;
}

/** The real book pages (canvas, untouched) with the reading highlight on top. */
export function Pages({ doc, pages, marks, width, onWordClick }: Props) {
  return (
    <div
      className="chapter"
      onClick={(e) => {
        const w = (e.target as HTMLElement).dataset?.w;
        if (w !== undefined) onWordClick(Number(w));
      }}
    >
      {pages.map((pm, i) => (
        <PageShell key={pm.page} doc={doc} pm={pm} idx={i} marks={marks} scale={width / pm.width} />
      ))}
    </div>
  );
}

function PageShell({ doc, pm, idx, marks, scale }: { doc: PDFDocumentProxy; pm: PageModel; idx: number; marks: Marks; scale: number }) {
  const shell = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const w = pm.width * scale;
  const h = pm.height * scale;

  useEffect(() => {
    const io = new IntersectionObserver(([e]) => setNear(e.isIntersecting), { rootMargin: '1400px 0px' });
    io.observe(shell.current!);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!near) return;
    let cancelled = false;
    let task: { cancel: () => void } | null = null;
    marks.mountPage(idx, layer.current!, scale);
    (async () => {
      const page = await doc.getPage(pm.page + 1);
      if (cancelled) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      const vp = page.getViewport({ scale: scale * dpr });
      const cv = canvas.current!;
      cv.width = Math.round(vp.width);
      cv.height = Math.round(vp.height);
      const rt = page.render({ canvas: cv, viewport: vp });
      task = rt;
      try {
        await rt.promise;
      } catch {
        /* cancelled */
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
      marks.unmountPage(idx);
      if (canvas.current) {
        canvas.current.width = 0;
        canvas.current.height = 0;
      }
    };
  }, [near, doc, pm, idx, scale, marks]);

  return (
    <div className="page" ref={shell} style={{ width: w, height: h }} data-page={idx}>
      <canvas ref={canvas} style={{ width: w, height: h }} />
      <div className="marks" ref={layer} />
    </div>
  );
}
