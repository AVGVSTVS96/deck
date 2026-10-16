import { useEffect, useState, type ReactNode } from "react";
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

export function Link({ to, children, className, hue }: { to: string; children: ReactNode; className?: string; hue?: number }) {
  return (
    <a
      href={to}
      className={className}
      data-hue={hue}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey) return;
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

export function Meter({ used, threshold, label }: { used: number; threshold?: number; label: string }) {
  const tone = threshold !== undefined && used >= threshold ? "hot" : used >= 75 ? "warm" : "cool";

  return (
    <div className="meter" title={`${label}: ${used}% used${threshold ? `, pool moves on at ${threshold}%` : ""}`}>
      <div className="meter-label">
        <span>{label}</span>
        <span className="num">{used}%</span>
      </div>
      <div className="meter-track">
        <div className={`meter-fill ${tone}`} style={{ width: `${Math.min(used, 100)}%` }} />
        {threshold !== undefined && <div className="meter-tick" style={{ left: `${threshold}%` }} />}
      </div>
    </div>
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

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
