import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Account, AccountsView, Connection, Policy, PolicyResult, Pool, UsageView } from "../../src/contract";
import { api, send, useApi, useLive, useLiveList } from "../api";
import { Steps } from "../chart";
import { Busy, Empty, Meter, STANDING, dayOf, fmt, toast, useAction, useNow, when } from "../ui";

const WEEK = 7 * 86_400_000;
const SOON = 3 * 86_400_000;

export default function Accounts() {
  const accounts = useLiveList("a:").map(([, a]) => a);
  const pool = useLive("pool");
  const view = useApi<AccountsView>("/accounts", "accounts");
  const week = useApi<UsageView>("/usage?range=7d&by=agent&measure=week&limit=200", "usage");
  const [signIn, setSignIn] = useState<string | null>(null);
  const order = pool?.order ?? [];
  const ranked = accounts.toSorted((a, b) => (order.indexOf(a.id) + 1 || 99) - (order.indexOf(b.id) + 1 || 99));

  return (
    <div className="page accounts">
      <header className="head">
        <div>
          <h1>Accounts</h1>
          <p className="lede">{pool?.decision ?? "Waiting for tokenhub's pool…"}</p>
        </div>
        <button className="primary" onClick={() => setSignIn("")}>
          Add account
        </button>
      </header>

      {!ranked.length && <Empty>No accounts in the pool yet.</Empty>}
      <div className="cards">
        {ranked.map((a) => (
          <AccountCard key={a.id} account={a} pool={pool} view={view.data} week={week.data} onSignIn={() => setSignIn(a.label)} />
        ))}
      </div>

      {pool && <PolicyEditor pool={pool} />}
      {signIn !== null && <SignIn email={signIn} onClose={() => setSignIn(null)} />}
    </div>
  );
}

function AccountCard({
  account: a,
  pool,
  view,
  week,
  onSignIn,
}: {
  account: Account;
  pool: Pool | undefined;
  view: AccountsView | null;
  week: UsageView | null;
  onSignIn: () => void;
}) {
  const now = useNow();
  const history = view?.history.filter((h) => h.account === a.id) ?? [];

  const top = (week?.rows ?? [])
    .map((r) => ({ row: r, points: r.byAccount.find((b) => b.account === a.id)?.week ?? 0 }))
    .filter((t) => t.points > 0)
    .toSorted((x, y) => y.points - x.points)
    .slice(0, 5);

  const expiring = a.signInUntil !== null && a.signInUntil - now < SOON;

  return (
    <section className="section account" aria-labelledby={`acct-${a.id}`}>
      <div className="section-head">
        {a.rank !== null && <span className="rank mono">#{a.rank}</span>}
        <div className="account-name">
          <h2 id={`acct-${a.id}`}>{a.label}</h2>
          <p className="muted small">
            {a.plan}
            {a.since && ` · in the pool since ${dayOf(a.since)}`}
          </p>
        </div>
        <span className="spacer" />
        <span className={`chip standing ${a.standing}`}>{STANDING[a.standing]}</span>
      </div>
      <div className="pad account-body">
        <div className="limit-meters">
          <Meter label="5 hours" window={a.fiveHour} />
          <Meter label="Week" window={a.week} />
        </div>

        <dl className="facts">
          <div>
            <dt>Seats</dt>
            <dd>
              {a.working} working · {a.idle} idle
            </dd>
          </div>
          <div>
            <dt>Sign-in</dt>
            <dd className={a.standing === "signed-out" || expiring ? "warn" : undefined}>
              {a.standing === "signed-out" ? "signed out" : a.signInUntil ? `good until ${when(a.signInUntil)}` : "no expiry known"}
              {(a.standing === "signed-out" || expiring) && (
                <button className="small" onClick={onSignIn}>
                  Sign in again
                </button>
              )}
            </dd>
          </div>
          {a.heldResets.map((h) => (
            <div key={h.kind}>
              <dt>Held reset</dt>
              <dd>
                {h.left} {h.kind} {h.left === 1 ? "reset" : "resets"}
                {h.expiresAt && `, use by ${when(h.expiresAt)}`}
              </dd>
            </div>
          ))}
          {a.atLimit?.available && (
            <div>
              <dt>Reset offer</dt>
              <dd className="warn">Claude offers a limit reset now</dd>
            </div>
          )}
        </dl>
        {a.reasons.length > 0 && (
          <ul className="reasons small">
            {a.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}

        {history.length > 0 && (
          <Steps
            caption={`${a.label}: limit use over the last 7 days`}
            from={now - WEEK}
            to={now}
            cutoffs={
              pool
                ? [
                    { label: "week", value: pool.policy.weeklyCutoff },
                    { label: "5h", value: pool.policy.sessionCutoff },
                  ]
                : []
            }
            lines={history.map((h) => ({
              key: h.kind,
              label: h.kind === "week" ? "Week" : "5 hours",
              color: h.kind === "week" ? "ink" : "muted",
              dashed: h.kind === "fiveHour",
              points: h.points,
            }))}
          />
        )}

        <div className="drill">
          <h3 className="small muted">Top agents this week</h3>
          {top.length ? (
            <ul className="sessions">
              {top.map(({ row, points }) => (
                <li key={row.key}>
                  <span className="who clip">
                    <i className="swatch" data-c={row.color} />
                    {row.label}
                    <span className="muted small">{row.detail}</span>
                  </span>
                  <span className="num">{fmt.pts(points)} pts</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">{week ? "No week points tied to agents yet." : "Reading usage…"}</p>
          )}
        </div>
      </div>
    </section>
  );
}

const FIELDS: { key: keyof Policy; label: string; unit: string; max: number; about: string }[] = [
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

/** The one policy editor: change, preview what tokenhub would do, then save against the revision you previewed. */
function PolicyEditor({ pool }: { pool: Pool }) {
  const [draft, setDraft] = useState<Policy | null>(null);
  const [preview, setPreview] = useState<PolicyResult | null>(null);
  const { busy, run } = useAction();
  const values = draft ?? pool.policy;
  const dirty = draft !== null && FIELDS.some((f) => draft[f.key] !== pool.policy[f.key]);
  const valid = FIELDS.every((f) => Number.isInteger(values[f.key]) && values[f.key] >= 1 && values[f.key] <= f.max);
  const previewed = preview !== null && FIELDS.every((f) => preview.pool.policy[f.key] === values[f.key]);

  const hint = !dirty
    ? "Change a value to preview it."
    : !valid
      ? "Cutoffs go from 1 to 100%, agents from 1 to 500."
      : previewed
        ? "Saving would do this right now:"
        : "Preview to see what changes, then save.";

  const submit = (save: boolean) =>
    run(save ? "save" : "preview", async () => {
      const revision = save && preview ? preview.pool.revision : pool.revision;
      const result = await send<PolicyResult>("/accounts/policy", "POST", { policy: values, revision, save });

      if (result.conflict) {
        setPreview(null);
        toast("The policy changed somewhere else since you previewed. Check the new values, then preview again.", "bad");

        return;
      }

      if (!save) return setPreview(result);
      setPreview(null);
      setDraft(null);
      toast("Policy saved. New sessions use it; running ones keep their account.");
    });

  return (
    <section className="section policy" aria-labelledby="policy-title">
      <div className="section-head">
        <h2 id="policy-title">Routing policy</h2>
        <span className={dirty ? "chip warn" : "sub"}>{dirty ? "not saved" : "in effect"}</span>
      </div>
      <div className="pad">
        <div className="policy-fields">
          {FIELDS.map((f) => (
            <label key={f.key} className="field">
              <span>{f.label}</span>
              <span className="policy-input">
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={f.max}
                  step={1}
                  value={Number.isNaN(values[f.key]) ? "" : values[f.key]}
                  onChange={(e) => {
                    setPreview(null);
                    setDraft({ ...values, [f.key]: e.currentTarget.valueAsNumber });
                  }}
                />
                <span className="muted">{f.unit}</span>
              </span>
              <span className="muted small">{f.about}</span>
            </label>
          ))}
        </div>
        <div className="policy-actions">
          <Busy on={busy === "preview"} disabled={!dirty || !valid || busy !== null} onClick={() => void submit(false)}>
            Preview
          </Busy>
          <Busy on={busy === "save"} className="primary" disabled={!dirty || !previewed || busy !== null} onClick={() => void submit(true)}>
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
        {previewed && <PolicyChange now={pool} then={preview.pool} />}
        {pool.notes.length > 0 && (
          <details className="notes">
            <summary>How the pool picks an account</summary>
            <ul>
              {pool.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </section>
  );
}

function PolicyChange({ now, then }: { now: Pool; then: Pool }) {
  const accounts = useLiveList("a:");
  const name = (id: string | null) => (id ? (accounts.find(([key]) => key === id)?.[1].label ?? id) : "no account");
  const sameOrder = now.order.join() === then.order.join();

  return (
    <ul className="changes">
      <li>
        {then.next === now.next ? (
          <>
            The next new session still goes to <b>{name(then.next)}</b>.
          </>
        ) : (
          <>
            The next new session would go to <b>{name(then.next)}</b> instead of {name(now.next)}.
          </>
        )}
      </li>
      {!sameOrder && <li>Order after it: {then.order.map(name).join(", ")}.</li>}
      {then.decision !== now.decision && <li className="muted">{then.decision}</li>}
    </ul>
  );
}

function SignIn({ email: initial, onClose }: { email: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [email, setEmail] = useState(initial);
  const [code, setCode] = useState("");
  const [connection, setConnection] = useState<Connection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failures, setFailures] = useState(0);
  const steps = useRef(0);
  const joined = connection?.status === "connected";

  useEffect(() => dialog.current?.showModal(), []);

  useEffect(() => {
    if (!connection || connection.status === "connected" || connection.status === "failed") return;

    const asked = steps.current;

    const timer = setTimeout(
      () =>
        api<Connection>(`/accounts/connect/${connection.id}`).then(
          (next) => {
            if (steps.current !== asked) return;
            setFailures(0);
            setConnection(next);
          },
          (e) => {
            setError(e instanceof Error ? e.message : String(e));
            setFailures((n) => n + 1);
          },
        ),
      2000 * Math.min(failures + 1, 5),
    );

    return () => clearTimeout(timer);
  }, [connection, failures]);

  const step = (action: () => Promise<Connection>) => async (e: FormEvent) => {
    e.preventDefault();
    steps.current++;
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
    <dialog ref={dialog} className="signin" onClose={onClose} aria-labelledby="signin-title">
      <div className="section-head flush">
        <h2 id="signin-title">{joined ? "Account added" : initial ? "Sign in again" : "Add a Claude account"}</h2>
        <span className="spacer" />
        <button className="quiet small" aria-label="Close" onClick={() => dialog.current?.close()}>
          ✕
        </button>
      </div>

      {error && <p className="alert">{error}</p>}

      {!connection ? (
        <form className="signin-step" onSubmit={step(() => send<Connection>("/accounts/connect", "POST", { email }))}>
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
        <div className="signin-step">
          <p>
            Claude confirmed <b>{connection.email}</b>. Its limits show up here once tokenhub reads them, usually within a minute.
          </p>
          <button className="primary" onClick={() => dialog.current?.close()}>
            Done
          </button>
        </div>
      ) : connection.status === "failed" ? (
        <div className="signin-step">
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
              <a className="button" href={connection.url} target="_blank" rel="noreferrer">
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
                aria-label="Code from Claude"
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
