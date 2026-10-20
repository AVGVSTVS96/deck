import { useEffect, useState, type ReactNode } from "react";
import type { LimitWindow } from "../src/contract";
import { navigate } from "./api";

type Toast = { id: number; text: string; tone: "ok" | "bad" };

const toastListeners = new Set<(toasts: Toast[]) => void>();
let toasts: Toast[] = [];
let nextId = 0;

const TOAST_MS = 5200;

function publish() {
  for (const listener of toastListeners) listener(toasts);
}

export function toast(text: string, tone: Toast["tone"] = "ok") {
  const id = ++nextId;
  toasts = [...toasts, { id, text, tone }];
  publish();
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    publish();
  }, TOAST_MS);
}

export const fail = (message: string) => toast(message, "bad");

export function Toasts() {
  const [list, setList] = useState(toasts);
  useEffect(() => {
    toastListeners.add(setList);

    return () => {
      toastListeners.delete(setList);
    };
  }, []);

  return (
    <div className="toasts" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function Link({ to, children, className, current }: { to: string; children: ReactNode; className?: string; current?: boolean }) {
  return (
    <a
      href={to}
      className={className}
      aria-current={current ? "page" : undefined}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey) return;
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

export function Busy({ on, children, ...props }: { on: boolean; children: ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...props} disabled={props.disabled || on} data-busy={on || undefined}>
      {children}
    </button>
  );
}

export function useAction() {
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (name: string, action: () => Promise<void>) => {
    setBusy(name);

    try {
      await action();
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  return { busy, run };
}

/** The clock for render: refreshed every `ms` so relative times and "last 24 hours" stay current. */
export function useNow(ms = 60_000) {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);

    return () => clearInterval(timer);
  }, [ms]);

  return now;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

/** A row of toggle buttons for one choice; the chosen one is pressed. */
export function Seg<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} type="button" aria-pressed={v === value} onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  );
}

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 2 });
const compact1 = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const dollars = new Intl.NumberFormat("en", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const cents = new Intl.NumberFormat("en", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const fmt = {
  tokens: (n: number) => (n < 1000 ? String(Math.round(n)) : compact.format(n)),
  axis: (n: number) => compact1.format(n),
  usd: (n: number) => (n >= 1000 ? dollars.format(n) : cents.format(n)),
  pts: (n: number | null) => (n === null ? "–" : n === 0 ? "0" : n < 0.05 ? "<0.1" : n.toFixed(1)),
  pct: (n: number) => `${Math.round(n * 100)}%`,
  int: (n: number) => n.toLocaleString("en"),
};

const timeOfDay = new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" });
const weekday = new Intl.DateTimeFormat("en", { weekday: "short", hour: "numeric", minute: "2-digit" });
const day = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });

/** "4:10 PM" within a day, "Thu 9:00 AM" within a week, else "Oct 24". */
export const when = (at: number) => {
  const away = Math.abs(at - Date.now());

  return away < 20 * 3_600_000 ? timeOfDay.format(at) : away < 6 * 86_400_000 ? weekday.format(at) : day.format(at);
};

export const dayOf = (at: number) => day.format(at);

export const STANDING = {
  next: "Takes the next session",
  open: "Open",
  tight: "Near a cutoff",
  limited: "At a cutoff",
  "signed-out": "Signed out",
} as const;

/** `elapsed` is the share gone when the reading was taken; carry it forward to now. */
function elapsedNow({ elapsed, sampledAt, resetsAt }: LimitWindow) {
  if (elapsed === null || sampledAt === null || resetsAt === null) return elapsed;
  const length = (resetsAt - sampledAt) / Math.max(1 - elapsed, 0.001);

  return Math.min(1, elapsed + (Date.now() - sampledAt) / length);
}

/** The one limit meter: used fill, the policy cutoff tick, and a caret for how much of the window has passed. */
export function Meter({ label, window, detail }: { label: ReactNode; window: LimitWindow; detail?: ReactNode }) {
  const { used, cutoff, resetsAt } = window;

  useNow();
  const elapsed = elapsedNow(window);
  const tone = used === null ? "" : used >= cutoff ? "over" : used >= cutoff - 15 ? "near" : "";
  const text = used === null ? "no reading" : `${Math.round(used)}% used, cutoff ${cutoff}%`;

  return (
    <div
      className="meter"
      role="meter"
      aria-valuenow={used ?? undefined}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={`${label}`}
      aria-valuetext={text}
    >
      <div className="meter-label">
        <span>{label}</span>
        <b>{used === null ? "–" : `${Math.round(used)}%`}</b>
      </div>
      <div className="meter-track">
        {used !== null && <div className={`meter-fill ${tone}`} style={{ width: `${Math.min(used, 100)}%` }} />}
        <div className="meter-cut" style={{ left: `${cutoff}%` }} />
        {elapsed !== null && <div className="meter-time" style={{ left: `${elapsed * 100}%` }} />}
      </div>
      <div className="meter-foot">
        {resetsAt ? `Resets ${when(resetsAt)}` : "No reset time"}
        {elapsed !== null && ` · ${fmt.pct(elapsed)} gone`}
        {detail}
      </div>
    </div>
  );
}
