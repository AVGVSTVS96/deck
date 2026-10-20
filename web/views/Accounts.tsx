import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Account, Accounts as Pool, Connection, HeldReset, Quota, Settings } from "../../src/accounts";
import { api, relativeTime, send, useLoad } from "../api";
import { Busy, Empty, toast, useAction } from "../ui";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const FIVE_HOURS = 5 * HOUR;
const WEEK = 7 * DAY;

const RESET_NAMES: Record<HeldReset["kind"], string> = { session: "five-hour", weekly: "weekly", fable: "Fable", full: "full" };

const FIELDS: { key: keyof Settings; label: string; unit: string; max: number; about: string }[] = [
  {
    key: "sessionCutoff",
    label: "Five-hour cutoff",
    unit: "%",
    max: 100,
    about: "New sessions skip an account once its five-hour use reaches this.",
  },
  { key: "weeklyCutoff", label: "Weekly cutoff", unit: "%", max: 100, about: "The same, for the week." },
  {
    key: "agentsPerAccount",
    label: "Agents per account",
    unit: "agents",
    max: 500,
    about: "How many working agents a fresh account takes before new ones go elsewhere; fewer as it fills.",
  },
];

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

function when(at: number, now: number) {
  if (sameDay(at, now)) return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  if (Math.abs(at - now) < 6 * DAY) return new Date(at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });

  return day(at);
}

const day = (at: number) => new Date(at).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });

const tierName = (tier: string) => tier.replace(/^\w/, (c) => c.toUpperCase());

const heldName = (reset: HeldReset) => `${reset.left} ${RESET_NAMES[reset.kind]} reset${reset.left === 1 ? "" : "s"}`;

export function Accounts() {
  const pool = useLoad<Pool>("/accounts");
  const [draft, setDraft] = useState<Settings | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const { reload } = pool;

  useEffect(() => {
    const timer = setInterval(() => void reload(), 30_000);

    return () => clearInterval(timer);
  }, [reload]);

  if (!pool.data) return <Empty>{pool.error ?? "Reading the account pool…"}</Empty>;
  const { accounts, settings } = pool.data;
  const cutoffs = draft ?? settings;
  const now = Date.parse(pool.data.at);
  const signedOut = accounts.filter((a) => a.needsReauth).length;
  const held = accounts.flatMap((a) => a.held);
  const heldCount = held.reduce((sum, r) => sum + r.left, 0);
  const soonest = held.flatMap((r) => (r.useBy === null ? [] : [r.useBy])).toSorted((a, b) => a - b)[0];

  return (
    <div className="page accounts-page">
      <header className="page-head acct-head">
        <div>
          <h1>Accounts</h1>
          <p className="lede">
            <b>{accounts.length}</b> Claude accounts share every session on the server and the Mac
            {signedOut ? (
              <>
                ; <b className="bad-text">{signedOut}</b> need signing in again
              </>
            ) : (
              ", all signed in"
            )}
            .
            {heldCount > 0 && (
              <>
                {" "}
                <b>{heldCount}</b> limit reset{heldCount === 1 ? "" : "s"} held
                {soonest ? `, the first to expire on ${day(soonest)}` : ""}.
              </>
            )}
          </p>
        </div>
        <button className="primary" onClick={() => setAdding("")}>
          Add account
        </button>
      </header>

      {pool.error && <p className="acct-alert">{pool.error} Showing the last reading.</p>}

      <p className="acct-key acct-legend muted small">
        <span>
          <i className="key-fill" /> used
        </span>
        <span>
          <i className="key-tick" /> cutoff, where new sessions move on
        </span>
        <span>
          <i className="key-time" /> time gone in the window
        </span>
      </p>
      <div className="acct-grid">
        {accounts.map((a, i) => (
          <AccountCard key={a.id} account={a} hue={i} now={now} cutoffs={cutoffs} onSignIn={() => setAdding(a.email)} />
        ))}
      </div>

      <Week accounts={accounts} now={now} />

      <PoolSettings pool={pool.data} draft={draft} setDraft={setDraft} reload={reload} />

      <p className="muted small acct-note">
        Held resets are read from Claude's usage report and only shown here. The pool never spends one; you do, with{" "}
        <code>/limit-reset</code>. Logins stay with tokenhub on the server; deck never sees them.
      </p>

      {adding !== null && (
        <SignIn
          email={adding}
          onClose={(joined) => {
            setAdding(null);

            if (joined) void reload();
          }}
        />
      )}
    </div>
  );
}

function AccountCard({
  account: a,
  hue,
  now,
  cutoffs,
  onSignIn,
}: {
  account: Account;
  hue: number;
  now: number;
  cutoffs: Settings;
  onSignIn: () => void;
}) {
  const lastsDays = a.signInUntil === null ? null : (a.signInUntil - now) / DAY;

  return (
    <article className={a.needsReauth ? "acct-card out" : "acct-card"} data-hue={hue}>
      <div className="pool-title">
        <span className="swatch" />
        <span className="who" title={a.email}>
          {a.email}
        </span>
        {a.needsReauth ? (
          <span className="chip bad">signed out</span>
        ) : !a.eligible ? (
          <span className="chip warn" title={a.reasons.join(" ")}>
            held back
          </span>
        ) : (
          a.next && <span className="chip live">next session</span>
        )}
      </div>
      <div className="acct-plan">
        {a.tier ? tierName(a.tier) : "Plan unknown"}
        {a.since !== null && (
          <span className="muted"> · since {new Date(a.since).toLocaleDateString([], { month: "short", year: "numeric" })}</span>
        )}
      </div>

      {a.needsReauth ? (
        <p className="acct-out">Its sign-in ended, so the pool skips it. Sign in again to put it back.</p>
      ) : (
        <>
          <Window label="5 hours" quota={a.fiveHour} cutoff={cutoffs.sessionCutoff} length={FIVE_HOURS} now={now} />
          <Window label="Week" quota={a.week} cutoff={cutoffs.weeklyCutoff} length={WEEK} now={now} />
        </>
      )}

      <dl className="facts acct-facts">
        <dt>Agents</dt>
        <dd>
          <b className="num">{a.working}</b> working · <span className="num">{a.idle}</span> idle
        </dd>
        <dt>Signed in</dt>
        <dd className={lastsDays !== null && lastsDays < 7 ? "warn" : undefined}>
          {a.signInUntil === null ? "until unknown" : `until ${day(a.signInUntil)}`}
          {a.signInUntil !== null && <span className="muted"> · {relativeTime(a.signInUntil)}</span>}
        </dd>
        <dt>Resets held</dt>
        <dd>
          {a.held.length === 0 && !a.limitReset && <span className="muted">none</span>}
          {a.held.map((r) => (
            <div key={`${r.kind}-${r.useBy}`} className="held">
              <span className="held-mark" />
              {heldName(r)}
              {r.useBy !== null && <span className={r.useBy - now < 2 * DAY ? "warn" : "muted"}> · use by {when(r.useBy, now)}</span>}
              {r.paused && <span className="muted"> · paused</span>}
            </div>
          ))}
          {a.limitReset && (
            <div className="held">
              {a.limitReset.available
                ? "Session-limit reset ready (1 a week)"
                : `Session-limit reset used${a.limitReset.nextAt ? `, next ${day(a.limitReset.nextAt)}` : ""}`}
            </div>
          )}
        </dd>
      </dl>

      <div className="acct-foot">
        <span className={a.stale ? "warn small" : "muted small"}>
          {a.readAt === null ? "Limits not read yet" : `Limits read ${relativeTime(a.readAt)}`}
        </span>
        <button className={a.needsReauth ? "primary small" : "quiet small"} onClick={onSignIn}>
          Sign in again
        </button>
      </div>
    </article>
  );
}

function Window({
  label,
  quota,
  cutoff,
  length,
  now,
}: {
  label: string;
  quota: Quota | null;
  cutoff: number;
  length: number;
  now: number;
}) {
  if (!quota) {
    return (
      <div className="win">
        <div className="meter-label">
          <span>{label}</span>
          <span className="muted">not reported</span>
        </div>
        <div className="meter-track" />
      </div>
    );
  }

  const lapsed = quota.resetsAt !== null && quota.resetsAt <= now;
  const gone = quota.resetsAt === null || lapsed ? null : Math.min(100, Math.max(0, (1 - (quota.resetsAt - now) / length) * 100));
  const tone = quota.used >= cutoff ? "hot" : "";

  return (
    <div
      className={lapsed ? "win lapsed" : "win"}
      title={`${label}: ${quota.used}% used, new sessions move on at ${cutoff}%${gone === null ? "" : `, ${Math.round(gone)}% of the window gone`}`}
    >
      <div className="meter-label">
        <span>{label}</span>
        <span className="num">{quota.used}%</span>
      </div>
      <div className="meter-track">
        <div className={`meter-fill ${tone}`} style={{ width: `${Math.min(quota.used, 100)}%` }} />
        <div className="meter-tick" style={{ left: `${cutoff}%` }} />
        {gone !== null && <i className="win-time" style={{ left: `${gone}%` }} />}
      </div>
      <div className="win-foot">
        {quota.resetsAt === null ? (
          <span className="muted">starts with the next use</span>
        ) : lapsed ? (
          <span className="muted">reset at {when(quota.resetsAt, now)}, waiting for a new reading</span>
        ) : (
          <>
            <span>resets {when(quota.resetsAt, now)}</span>
            <span className="muted">{relativeTime(quota.resetsAt)}</span>
          </>
        )}
      </div>
    </div>
  );
}

function Week({ accounts, now }: { accounts: Account[]; now: number }) {
  const end = now + WEEK;
  const x = (at: number) => `${((at - now) / WEEK) * 100}%`;
  const inside = (at: number | null): at is number => at !== null && at > now && at <= end;
  const midnights = Array.from({ length: 8 }, (_, i) => new Date(now).setHours(24 * (i + 1), 0, 0, 0)).filter((at) => at < end);
  const days = [now, ...midnights].map((from, i, all) => ({ from, to: all[i + 1] ?? end }));

  return (
    <section className="acct-week">
      <div className="section-head">
        <h2>The week ahead</h2>
        <span className="acct-legend muted small">
          <span>
            <i className="lg-week" /> week window, ends when its limit resets
          </span>
          <span>
            <i className="lg-held" /> held reset expires
          </span>
          <span>
            <i className="lg-out" /> sign-in ends
          </span>
        </span>
      </div>
      <div className="week">
        <span />
        <div className="week-axis">
          {days.map((d) =>
            d.to - d.from > DAY * 0.45 ? (
              <span key={d.from} style={{ left: x(d.from), width: x(now + d.to - d.from) }}>
                {sameDay(d.from, now)
                  ? "today"
                  : `${new Date(d.from).toLocaleDateString([], { weekday: "short" })} ${new Date(d.from).getDate()}`}
              </span>
            ) : null,
          )}
        </div>
        <span />
        {accounts.map((a, i) => {
          const reset = a.week?.resetsAt ?? null;

          return (
            <div key={a.id} className="week-row" data-hue={i}>
              <span className="week-who" title={a.email}>
                <span className="swatch" />
                <span>{a.email}</span>
              </span>
              <div className="week-track">
                {midnights.map((at) => (
                  <i key={at} className="week-day" style={{ left: x(at) }} />
                ))}
                {!a.needsReauth && inside(reset) && (
                  <>
                    <i className="week-band" style={{ width: x(reset) }} />
                    <i
                      className="week-reset"
                      style={{ left: x(reset) }}
                      title={`Weekly limit resets ${when(reset, now)} (${a.week?.used}% used now)`}
                    />
                    <span className={reset - now > WEEK * 0.85 ? "week-label flip" : "week-label"} style={{ left: x(reset) }}>
                      {a.week?.used}% → 0
                    </span>
                  </>
                )}
                {a.held.flatMap((r) =>
                  inside(r.useBy) ? (
                    <i
                      key={`${r.kind}-${r.useBy}`}
                      className="week-held"
                      style={{ left: x(r.useBy) }}
                      title={`${heldName(r)}, use by ${when(r.useBy, now)}`}
                    />
                  ) : (
                    []
                  ),
                )}
                {inside(a.signInUntil) && (
                  <i className="week-out" style={{ left: x(a.signInUntil) }} title={`Sign-in ends ${when(a.signInUntil, now)}`} />
                )}
              </div>
              <span className="week-after muted small">
                {a.needsReauth
                  ? "signed out"
                  : a.signInUntil && !inside(a.signInUntil)
                    ? `signed in to ${day(a.signInUntil).replace(/^\w+, /, "")}`
                    : ""}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function PoolSettings({
  pool,
  draft,
  setDraft,
  reload,
}: {
  pool: Pool;
  draft: Settings | null;
  setDraft: (settings: Settings | null) => void;
  reload: () => Promise<void>;
}) {
  const [preview, setPreview] = useState<Pool | null>(null);
  const { busy, run } = useAction();
  const values = draft ?? pool.settings;
  const dirty = draft !== null && FIELDS.some((f) => draft[f.key] !== pool.settings[f.key]);
  const valid = FIELDS.every((f) => Number.isInteger(values[f.key]) && values[f.key] >= 1 && values[f.key] <= f.max);
  const previewed = preview !== null && FIELDS.every((f) => preview.settings[f.key] === values[f.key]);

  const hint = !dirty
    ? "Change a value to preview it."
    : !valid
      ? "Cutoffs go from 1 to 100%, agents from 1 to 500."
      : previewed
        ? "This is what saving would change right now:"
        : "Preview to see what changes, then save.";

  const change = (key: keyof Settings, value: number) => {
    setPreview(null);
    setDraft({ ...values, [key]: value });
  };

  const submit = (operation: "preview" | "save") =>
    run(operation, async () => {
      const revision = operation === "save" && preview ? preview.revision : pool.revision;

      const result = await api<Pool>("/accounts/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation, settings: values, revision }),
      });

      if (operation === "preview") return setPreview(result);
      setPreview(null);
      setDraft(null);
      toast("Pool settings saved. New sessions use them; running ones keep their account.");
      await reload();
    });

  return (
    <section className="acct-settings">
      <div className="section-head">
        <h2>Pool settings</h2>
        <span className={dirty ? "chip warn" : "muted small"}>{dirty ? "not saved" : "in effect"}</span>
      </div>
      <div className="settings-grid">
        {FIELDS.map((f) => (
          <div key={f.key} className="setting">
            <label className="setting-name" htmlFor={`setting-${f.key}`}>
              {f.label}
            </label>
            <span className="setting-input">
              <input
                id={`setting-${f.key}`}
                aria-describedby={`setting-${f.key}-about`}
                type="number"
                inputMode="numeric"
                min={1}
                max={f.max}
                step={1}
                value={Number.isNaN(values[f.key]) ? "" : values[f.key]}
                onChange={(e) => change(f.key, e.currentTarget.valueAsNumber)}
              />
              <span className="muted">{f.unit}</span>
            </span>
            <span id={`setting-${f.key}-about`} className="muted small">
              {f.about}
            </span>
          </div>
        ))}
      </div>
      <div className="settings-actions">
        <Busy on={busy === "preview"} disabled={!dirty || !valid || busy !== null} onClick={() => void submit("preview")}>
          Preview
        </Busy>
        <Busy on={busy === "save"} className="primary" disabled={!dirty || !previewed || busy !== null} onClick={() => void submit("save")}>
          Save
        </Busy>
        <button
          className="quiet"
          disabled={!dirty || busy !== null}
          onClick={() => {
            setPreview(null);
            setDraft(null);
          }}
        >
          Discard
        </button>
        <span className="muted small">{hint}</span>
      </div>
      {previewed && <Changes now={pool.accounts} then={preview.accounts} />}
    </section>
  );
}

function Changes({ now, then }: { now: Account[]; then: Account[] }) {
  const before = new Map(now.map((a) => [a.id, a]));
  const flips = then.filter((a) => before.get(a.id)?.eligible !== a.eligible);
  const next = then.find((a) => a.next);
  const nextBefore = now.find((a) => a.next);

  return (
    <ul className="changes">
      {flips.map((a) => (
        <li key={a.id}>
          <b>{a.email}</b> {a.eligible ? "would take new sessions again." : `would be held back: ${a.reasons.join(" ").toLowerCase()}`}
        </li>
      ))}
      <li>
        {next?.id === nextBefore?.id ? (
          <>
            The next new session still goes to <b>{next?.email ?? "no account"}</b>.
          </>
        ) : (
          <>
            The next new session would go to <b>{next?.email ?? "no account"}</b> instead of {nextBefore?.email ?? "none"}.
          </>
        )}
      </li>
    </ul>
  );
}

function SignIn({ email: initial, onClose }: { email: string; onClose: (joined: boolean) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [email, setEmail] = useState(initial);
  const [code, setCode] = useState("");
  const [connection, setConnection] = useState<Connection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const joined = connection?.status === "connected";

  useEffect(() => dialog.current?.showModal(), []);

  useEffect(() => {
    if (!connection || connection.status === "connected" || connection.status === "failed") return;

    const timer = setTimeout(
      () =>
        api<Connection>(`/accounts/connect/${connection.id}`).then(setConnection, (e) =>
          setError(e instanceof Error ? e.message : String(e)),
        ),
      2000,
    );

    return () => clearTimeout(timer);
  }, [connection]);

  const step = (action: () => Promise<Connection>) => async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);

    try {
      setConnection(await action());
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog ref={dialog} className="signin" onClose={() => onClose(joined)} aria-labelledby="signin-title">
      <div className="signin-head">
        <h2 id="signin-title">{joined ? "Account added" : initial ? "Sign in again" : "Add a Claude account"}</h2>
        <button className="quiet small" aria-label="Close" onClick={() => dialog.current?.close()}>
          ✕
        </button>
      </div>

      {error && <p className="acct-alert">{error}</p>}

      {!connection ? (
        <form onSubmit={step(() => send<Connection>("/accounts/connect", "POST", { email }))}>
          <p className="muted">You sign in once on Claude's own page. The login stays with tokenhub on the server and joins the pool.</p>
          <label className="field">
            <span>Account email</span>
            <input type="email" required autoComplete="email" autoFocus value={email} onChange={(e) => setEmail(e.currentTarget.value)} />
          </label>
          <Busy on={busy} className="primary">
            Continue to Claude
          </Busy>
        </form>
      ) : joined ? (
        <div className="signin-done">
          <span className="dot live" />
          <p>
            Claude confirmed <b>{connection.email}</b>. Its limits show up here once tokenhub reads them, usually within a minute.
          </p>
          <button className="primary" onClick={() => dialog.current?.close()}>
            Done
          </button>
        </div>
      ) : connection.status === "failed" ? (
        <div>
          <p>
            Claude didn't finish this sign-in. Start again, and choose <b>{connection.email}</b> on Claude's page.
          </p>
          <button
            onClick={() => {
              setConnection(null);
              setCode("");
              setError(null);
            }}
          >
            Start again
          </button>
        </div>
      ) : (
        <ol className="signin-steps">
          <li>
            <b>Approve on Claude</b>
            <p className="muted">
              Pick <b>{connection.email}</b> on Claude's page and approve the Claude Code login.
            </p>
            {connection.url ? (
              <a className="button-link" href={connection.url} target="_blank" rel="noreferrer">
                Open Claude sign-in ↗
              </a>
            ) : (
              <p className="muted small">Getting the sign-in link…</p>
            )}
          </li>
          <li>
            <b>Paste the code</b>
            <p className="muted">Claude shows a code after you approve. Paste it here.</p>
            <form onSubmit={step(() => send<Connection>(`/accounts/connect/${connection.id}`, "POST", { code }))} className="code-row">
              <input
                required
                autoComplete="off"
                placeholder="Code from Claude"
                value={code}
                disabled={connection.status !== "authorize"}
                onChange={(e) => setCode(e.currentTarget.value)}
              />
              <Busy on={busy || connection.status === "finishing"} className="primary" disabled={connection.status !== "authorize"}>
                {connection.status === "finishing" ? "Connecting…" : "Finish"}
              </Busy>
            </form>
          </li>
        </ol>
      )}
    </dialog>
  );
}
