import { useRef, useState } from 'react';

// Small dependency-free SVG charts. Colors come from CSS custom properties (--series-1, --seq-*, …)
// so light/dark are handled in styles.css.

export interface Pt {
  x: number; // index or timestamp
  y: number;
  label: string; // tooltip label for x
}

interface LineProps {
  data: Pt[];
  height?: number;
  format?: (y: number) => string;
  yMin?: number;
  yMax?: number;
  reference?: { y: number; label: string };
  color?: string;
  unit?: string;
}

export function LineChart({ data, height = 180, format = (y) => y.toFixed(0), yMin, yMax, reference, color = 'var(--series-1)', unit = '' }: LineProps) {
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const W = 640;
  const H = height;
  const pad = { l: 40, r: 12, t: 12, b: 24 };
  if (data.length === 0) return <div className="chart-empty">No data yet</div>;
  const ys = data.map((d) => d.y).concat(reference ? [reference.y] : []);
  const lo = yMin ?? Math.min(0, ...ys);
  const hi = yMax ?? niceMax(Math.max(...ys, 1));
  const X = (i: number) => pad.l + (data.length === 1 ? (W - pad.l - pad.r) / 2 : (i / (data.length - 1)) * (W - pad.l - pad.r));
  const Y = (y: number) => pad.t + (1 - (y - lo) / (hi - lo || 1)) * (H - pad.t - pad.b);
  const path = data.map((d, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(d.y).toFixed(1)}`).join('');
  const ticks = [lo, lo + (hi - lo) / 2, hi];
  const onMove = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W;
    const i = Math.round(((x - pad.l) / (W - pad.l - pad.r)) * (data.length - 1));
    setHover(Math.max(0, Math.min(data.length - 1, i)));
  };
  const h = hover !== null ? data[hover] : null;
  return (
    <div className="chart">
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={Y(t)} y2={Y(t)} className="grid" />
            <text x={pad.l - 6} y={Y(t) + 4} className="axis" textAnchor="end">
              {format(t)}
            </text>
          </g>
        ))}
        {reference && (
          <g>
            <line x1={pad.l} x2={W - pad.r} y1={Y(reference.y)} y2={Y(reference.y)} className="refline" />
            <text x={W - pad.r} y={Y(reference.y) - 4} className="axis" textAnchor="end">
              {reference.label}
            </text>
          </g>
        )}
        <path d={path} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {data.length <= 40 && data.map((d, i) => <circle key={i} cx={X(i)} cy={Y(d.y)} r={3} fill={color} stroke="var(--surface)" strokeWidth={2} />)}
        {h && hover !== null && (
          <g>
            <line x1={X(hover)} x2={X(hover)} y1={pad.t} y2={H - pad.b} className="crosshair" />
            <circle cx={X(hover)} cy={Y(h.y)} r={5} fill={color} stroke="var(--surface)" strokeWidth={2} />
          </g>
        )}
        <text x={pad.l} y={H - 6} className="axis">
          {data[0].label}
        </text>
        {data.length > 1 && (
          <text x={W - pad.r} y={H - 6} className="axis" textAnchor="end">
            {data[data.length - 1].label}
          </text>
        )}
      </svg>
      {h && hover !== null && (
        <div className="tooltip" style={{ left: `${(X(hover) / W) * 100}%` }}>
          <b>
            {format(h.y)}
            {unit}
          </b>
          <span>{h.label}</span>
        </div>
      )}
    </div>
  );
}

export function BarChart({ data, height = 160, format = (y: number) => y.toFixed(0), colors, yMax }: { data: Pt[]; height?: number; format?: (y: number) => string; colors?: string[]; yMax?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 640;
  const H = height;
  const pad = { l: 40, r: 12, t: 16, b: 24 };
  if (!data.length) return <div className="chart-empty">No data yet</div>;
  const hi = yMax ?? niceMax(Math.max(...data.map((d) => d.y), 1));
  const bw = (W - pad.l - pad.r) / data.length;
  const Y = (y: number) => pad.t + (1 - y / hi) * (H - pad.t - pad.b);
  const barW = Math.max(2, Math.min(56, bw - 2));
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" onPointerLeave={() => setHover(null)}>
        {[0, hi / 2, hi].map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={Y(t)} y2={Y(t)} className="grid" />
            <text x={pad.l - 6} y={Y(t) + 4} className="axis" textAnchor="end">
              {format(t)}
            </text>
          </g>
        ))}
        {data.map((d, i) => {
          const x = pad.l + i * bw + (bw - barW) / 2;
          const y = Y(d.y);
          const h = Math.max(0, H - pad.b - y);
          const r = Math.min(4, barW / 2, h);
          return (
            <g key={i} onPointerEnter={() => setHover(i)}>
              <rect x={pad.l + i * bw} y={pad.t} width={bw} height={H - pad.t - pad.b} fill="transparent" />
              <path
                d={`M${x},${H - pad.b} V${y + r} Q${x},${y} ${x + r},${y} H${x + barW - r} Q${x + barW},${y} ${x + barW},${y + r} V${H - pad.b} Z`}
                fill={colors?.[i] ?? 'var(--series-1)'}
                opacity={hover === null || hover === i ? 1 : 0.55}
              />
              {data.length <= 6 && (
                <text x={x + barW / 2} y={H - 6} className="axis" textAnchor="middle">
                  {d.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {hover !== null && (
        <div className="tooltip" style={{ left: `${((pad.l + (hover + 0.5) * bw) / W) * 100}%` }}>
          <b>{format(data[hover].y)}</b>
          <span>{data[hover].label}</span>
        </div>
      )}
    </div>
  );
}

function niceMax(v: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/** GitHub-style calendar of words per day (sequential blue); `goal` is the value shown darkest. */
export function Calendar({ byDay, goal }: { byDay: Map<string, number>; goal: number }) {
  const [hover, setHover] = useState<{ k: string; v: number; x: number; y: number } | null>(null);
  const weeks = 26;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - (weeks * 7 - 1) - start.getDay());
  const cells: { k: string; v: number; w: number; d: number }[] = [];
  for (let i = 0; ; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    if (d > today) break;
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    cells.push({ k, v: byDay.get(k) ?? 0, w: Math.floor(i / 7), d: d.getDay() });
  }
  const level = (v: number) => (v <= 0 ? 0 : v < goal * 0.25 ? 1 : v < goal * 0.6 ? 2 : v < goal ? 3 : 4);
  const S = 13;
  return (
    <div className="chart calendar">
      <svg viewBox={`0 0 ${(weeks + 1) * S + 4} ${7 * S + 4}`} onPointerLeave={() => setHover(null)}>
        {cells.map((c) => (
          <rect
            key={c.k}
            x={c.w * S + 2}
            y={c.d * S + 2}
            width={S - 2}
            height={S - 2}
            rx={2}
            className={'cal l' + level(c.v)}
            onPointerEnter={() => setHover({ ...c, x: ((c.w * S + 2) / ((weeks + 1) * S + 4)) * 100, y: c.d })}
          />
        ))}
      </svg>
      {hover && (
        <div className="tooltip" style={{ left: `${hover.x}%` }}>
          <b>{hover.v} words</b>
          <span>{new Date(hover.k).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</span>
        </div>
      )}
      <div className="legend-row small muted">
        Less <span className="cal-key l0" />
        <span className="cal-key l1" />
        <span className="cal-key l2" />
        <span className="cal-key l3" />
        <span className="cal-key l4" /> More
      </div>
    </div>
  );
}

export interface XY {
  x: number;
  y: number;
  label: string;
}

/** Scatter plot with an optional least-squares trend line. */
export function Scatter({ data, xLabel, yLabel, formatX = (v) => v.toFixed(0), formatY = (v) => v.toFixed(0), yMax, height = 220 }: { data: XY[]; xLabel: string; yLabel: string; formatX?: (v: number) => string; formatY?: (v: number) => string; yMax?: number; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 640;
  const H = height;
  const pad = { l: 44, r: 14, t: 12, b: 34 };
  if (!data.length) return <div className="chart-empty">No data yet</div>;
  const xs = data.map((d) => d.x);
  const xLo = Math.max(0, Math.min(...xs) * 0.9);
  const xHi = niceMax(Math.max(...xs, 1) * 1.05);
  const yHi = yMax ?? niceMax(Math.max(...data.map((d) => d.y), 1));
  const X = (v: number) => pad.l + ((v - xLo) / (xHi - xLo || 1)) * (W - pad.l - pad.r);
  const Y = (v: number) => pad.t + (1 - v / yHi) * (H - pad.t - pad.b);
  let trend: [number, number] | null = null;
  if (data.length >= 3) {
    const mx = xs.reduce((a, b) => a + b, 0) / data.length;
    const my = data.reduce((a, d) => a + d.y, 0) / data.length;
    const sxx = data.reduce((a, d) => a + (d.x - mx) ** 2, 0);
    if (sxx > 0) {
      const slope = data.reduce((a, d) => a + (d.x - mx) * (d.y - my), 0) / sxx;
      trend = [my + slope * (xLo - mx), my + slope * (xHi - mx)];
    }
  }
  const h = hover !== null ? data[hover] : null;
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" onPointerLeave={() => setHover(null)}>
        {[0, yHi / 2, yHi].map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={Y(t)} y2={Y(t)} className="grid" />
            <text x={pad.l - 6} y={Y(t) + 4} className="axis" textAnchor="end">
              {formatY(t)}
            </text>
          </g>
        ))}
        <text x={pad.l} y={H - 18} className="axis">
          {formatX(xLo)}
        </text>
        <text x={W - pad.r} y={H - 18} className="axis" textAnchor="end">
          {formatX(xHi)}
        </text>
        <text x={(W + pad.l) / 2} y={H - 4} className="axis" textAnchor="middle">
          {xLabel} →
        </text>
        <text x={12} y={pad.t + 4} className="axis" transform={`rotate(-90 12 ${pad.t + 4})`} textAnchor="end">
          {yLabel} →
        </text>
        {trend && <line x1={X(xLo)} x2={X(xHi)} y1={Y(Math.max(0, Math.min(yHi, trend[0])))} y2={Y(Math.max(0, Math.min(yHi, trend[1])))} className="refline" />}
        {data.map((d, i) => (
          <circle
            key={i}
            cx={X(d.x)}
            cy={Y(d.y)}
            r={hover === i ? 7 : 5}
            fill="var(--series-1)"
            fillOpacity={0.75}
            stroke="var(--surface)"
            strokeWidth={1.5}
            onPointerEnter={() => setHover(i)}
          />
        ))}
      </svg>
      {h && hover !== null && (
        <div className="tooltip" style={{ left: `${(X(h.x) / W) * 100}%` }}>
          <b>
            {formatX(h.x)} · {formatY(h.y)}
          </b>
          <span>{h.label}</span>
        </div>
      )}
    </div>
  );
}
