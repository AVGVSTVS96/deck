import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { dayOf } from "./ui";

export function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const element = ref.current;

    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));

    observer.observe(element);

    return () => observer.disconnect();
  }, []);

  return [ref, width] as const;
}

/** Round axis steps (1, 2, 2.5, 5 × 10^n) covering 0..max with about `count` ticks. */
export function ticks(max: number, count = 4) {
  if (max <= 0) return [0];
  const raw = max / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? raw;

  return Array.from({ length: Math.ceil(max / step - 1e-9) + 1 }, (_, i) => i * step);
}

export type Series = { key: string; label: string; color: number; values: number[] };

const PAD = { top: 8, right: 8, bottom: 22, left: 48 };

function Tip({ x, width, children }: { x: number; width: number; children: ReactNode }) {
  const left = x > width / 2 ? undefined : x + 12;
  const right = x > width / 2 ? width - x + 12 : undefined;

  return (
    <div className="tip" style={{ left, right, top: 0 }}>
      {children}
    </div>
  );
}

/** Stacked columns, one per bucket, with value axis, legend and a per-column readout on hover or focus. */
export function Columns({
  labels,
  titles,
  series,
  format,
  axis = format,
  height = 220,
  caption,
}: {
  /** Axis text per bucket; an empty string leaves that bucket unlabelled. */
  labels: string[];
  titles: string[];
  series: Series[];
  format: (n: number) => string;
  axis?: (n: number) => string;
  height?: number;
  caption: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const totals = labels.map((_, i) => series.reduce((n, s) => n + (s.values[i] ?? 0), 0));
  const scale = ticks(Math.max(...totals, 0));
  const top = scale.at(-1) || 1;
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = height - PAD.top - PAD.bottom;
  const band = labels.length ? plotW / labels.length : 0;
  const bar = Math.max(2, Math.min(24, band - 2));
  const y = (v: number) => PAD.top + plotH - (v / top) * plotH;
  const labelled = labels.flatMap((l, i) => (l ? [i] : []));
  const gap = labelled.length > 1 ? labelled[1] - labelled[0] : 1;
  const every = gap * Math.max(1, Math.ceil(56 / Math.max(band * gap, 1)));

  return (
    <div className="chart" ref={ref}>
      {width > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={`${caption}. Arrow keys step through the ${labels.length} columns.`}
          tabIndex={0}
          onFocus={() => setActive((a) => a ?? labels.length - 1)}
          onBlur={() => setActive(null)}
          onKeyDown={(e) => {
            const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;

            if (!step) return;
            e.preventDefault();
            setActive((a) => Math.min(labels.length - 1, Math.max(0, (a ?? 0) + step)));
          }}
        >
          {scale.map((t) => (
            <g key={t}>
              <line className={t === 0 ? "baseline" : "gridline"} x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} />
              <text className="tick" x={PAD.left - 8} y={y(t) + 4} textAnchor="end">
                {axis(t)}
              </text>
            </g>
          ))}
          {labels.map((label, i) => {
            const x = PAD.left + i * band + (band - bar) / 2;
            let base = 0;

            return (
              <g
                key={titles[i]}
                className={i === active ? "col on" : "col"}
                onPointerEnter={() => setActive(i)}
                onPointerLeave={() => setActive(null)}
              >
                <rect className="hit" x={PAD.left + i * band} y={PAD.top} width={band} height={plotH} fill="transparent" />
                {series.map((s) => {
                  const v = s.values[i] ?? 0;

                  if (v <= 0) return null;
                  const y0 = y(base);
                  const y1 = y(base + v);

                  base += v;

                  return (
                    <rect
                      key={s.key}
                      x={x}
                      y={y1}
                      width={bar}
                      height={Math.max(0, y0 - y1)}
                      style={{ fill: `var(--c${s.color})` }}
                      stroke="var(--surface)"
                      strokeWidth={series.length > 1 ? 1 : 0}
                    />
                  );
                })}
                {label && (i - (labelled[0] ?? 0)) % every === 0 && (
                  <text className="tick" x={PAD.left + i * band + band / 2} y={height - 6} textAnchor="middle">
                    {label}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      )}
      {active !== null && (
        <Tip x={PAD.left + active * band + band / 2} width={width}>
          <div className="tip-row">
            <span />
            <span>{titles[active]}</span>
            <b>{format(totals[active])}</b>
          </div>
          {series
            .filter((s) => (s.values[active] ?? 0) > 0)
            .toReversed()
            .map((s) => (
              <div key={s.key} className="tip-row" data-c={s.color}>
                <i />
                <span className="muted">{s.label}</span>
                <b>{format(s.values[active])}</b>
              </div>
            ))}
        </Tip>
      )}
      {series.length > 1 && (
        <div className="legend">
          {series.map((s) => (
            <span key={s.key} data-c={s.color}>
              <i className="swatch" data-c={s.color} />
              {s.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** A row's activity over the range, as small columns in its own color. */
export function Spark({ values, color, width = 96, height = 20 }: { values: number[]; color: number; width?: number; height?: number }) {
  const max = Math.max(...values, 0) || 1;
  const band = width / Math.max(values.length, 1);

  return (
    <svg className="spark" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" data-c={color} aria-hidden>
      <path
        d={values
          .map((v, i) => (v > 0 ? `M${i * band},${height}v${-Math.max(1, (v / max) * height)}h${Math.max(1, band - 1)}V${height}z` : ""))
          .join("")}
      />
    </svg>
  );
}

/** `color` is a palette slot ("0" to "7") or "ink" / "muted", for lines that aren't an agent. */
export type Line = { key: string; label: string; color: string; dashed?: boolean; points: [at: number, value: number][] };

/** Step lines of limit use (0 to 100%) over time, with the policy cutoff and a crosshair readout. */
export function Steps({
  lines,
  from,
  to,
  cutoffs,
  height = 180,
  caption,
}: {
  lines: Line[];
  from: number;
  to: number;
  cutoffs: number[];
  height?: number;
  caption: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { ...PAD, left: 40 };
  const plotW = Math.max(0, width - pad.left - pad.right);
  const plotH = height - pad.top - pad.bottom;
  const x = (t: number) => pad.left + ((t - from) / (to - from || 1)) * plotW;
  const y = (v: number) => pad.top + plotH - (Math.min(v, 100) / 100) * plotH;

  const days = Array.from(
    { length: Math.ceil((to - from) / 86_400_000) },
    (_, i) => new Date(from).setHours(24, 0, 0, 0) + i * 86_400_000,
  ).filter((t) => t < to);

  const step = Math.max(1, Math.ceil(days.length / Math.max(1, Math.floor(plotW / 64))));
  const at = hover === null ? null : from + ((hover - pad.left) / (plotW || 1)) * (to - from);
  const valueAt = (line: Line, t: number) => line.points.findLast(([p]) => p <= t)?.[1] ?? null;

  const path = (line: Line) =>
    line.points
      .filter(([t]) => t >= from && t <= to)
      .map(([t, v], i, all) => (i === 0 ? `M${x(t)},${y(v)}` : `H${x(t)}V${y(v)}`) + (i === all.length - 1 ? `H${x(to)}` : ""))
      .join("");

  return (
    <div className="chart" ref={ref}>
      {width > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={caption}
          onPointerMove={(e) => {
            const left = e.currentTarget.getBoundingClientRect().left;
            const px = e.clientX - left;

            setHover(px >= pad.left && px <= width - pad.right ? px : null);
          }}
          onPointerLeave={() => setHover(null)}
        >
          {[0, 25, 50, 75, 100].map((t) => (
            <g key={t}>
              <line className={t === 0 ? "baseline" : "gridline"} x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} />
              <text className="tick" x={pad.left - 8} y={y(t) + 4} textAnchor="end">
                {t}%
              </text>
            </g>
          ))}
          {[...new Set(cutoffs)].map((c) => (
            <line key={c} className="cutoff" x1={pad.left} x2={width - pad.right} y1={y(c)} y2={y(c)} />
          ))}
          {days.map((t, i) =>
            i % step === 0 ? (
              <text key={t} className="tick" x={x(t)} y={height - 6} textAnchor="middle">
                {dayOf(t)}
              </text>
            ) : null,
          )}
          {lines.map((line) => (
            <path
              key={line.key}
              d={path(line)}
              fill="none"
              data-c={line.color}
              style={{ stroke: "var(--c)" }}
              strokeWidth={2}
              strokeDasharray={line.dashed ? "5 3" : undefined}
              strokeLinejoin="round"
            />
          ))}
          {hover !== null && <line className="baseline" x1={hover} x2={hover} y1={pad.top} y2={pad.top + plotH} />}
        </svg>
      )}
      {at !== null && hover !== null && (
        <Tip x={hover} width={width}>
          <div className="tip-row">
            <span />
            <span>{new Date(at).toLocaleString("en", { weekday: "short", hour: "numeric", minute: "2-digit" })}</span>
            <span />
          </div>
          {lines.map((line) => {
            const v = valueAt(line, at);

            return (
              <div key={line.key} className="tip-row" data-c={line.color}>
                <i />
                <span className="muted">{line.label}</span>
                <b>{v === null ? "–" : `${Math.round(v)}%`}</b>
              </div>
            );
          })}
        </Tip>
      )}
      <div className="legend">
        {lines.map((line) => (
          <span key={line.key} data-c={line.color}>
            <i className={line.dashed ? "line-key dash" : "line-key"} />
            {line.label}
          </span>
        ))}
        {cutoffs.length > 0 && <span>┄ cutoff {[...new Set(cutoffs)].map((c) => `${c}%`).join(" / ")}</span>}
      </div>
    </div>
  );
}
