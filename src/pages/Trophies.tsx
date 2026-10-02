import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { BADGES, loadStats, nextTargets, progressOf, TIERS, type Progress } from '../gamify/badges';

const fmt = (n: number) => n.toLocaleString();

export function Trophies() {
  const data = useLiveQuery(async () => {
    const [stats, have] = await Promise.all([loadStats(), db.achievements.toArray()]);
    return { stats, have };
  }, []);
  if (!data) return <div className="center-msg">Loading…</div>;
  const { stats, have } = data;
  const all = BADGES.map((d) => progressOf(d, stats));
  const earned = have.length;
  const total = BADGES.length * TIERS.length;
  const targets = nextTargets(stats);

  return (
    <div className="page-wrap">
      <div className="section-head">
        <div>
          <div className="eyebrow">Keep collecting</div>
          <h1>Trophies</h1>
        </div>
        <div className="trophy-count">
          <b>{earned}</b> / {total} earned{stats.streak > 0 && <span> · 🔥 {stats.streak}-day streak</span>}
        </div>
      </div>

      {targets.length > 0 && (
        <section className="panel">
          <div className="panel-head">
            <h3>Next up</h3>
            <span className="muted small">The trophies you're closest to.</span>
          </div>
          <div className="targets">
            {targets.map((p) => (
              <Target key={p.def.id} p={p} />
            ))}
          </div>
        </section>
      )}

      <div className="badge-grid">
        {all.map((p) => {
          const at = have.filter((a) => a.badge === p.def.id).sort((a, b) => b.tier - a.tier)[0];
          return (
            <div key={p.def.id} className={'badge-card' + (p.tier >= 0 ? ` tier-${p.tier}` : ' locked')}>
              <div className="badge-icon">{p.def.icon}</div>
              <div className="badge-title">{p.def.title}</div>
              <div className="medals" aria-label={p.tier >= 0 ? TIERS[p.tier] : 'Not earned yet'}>
                {TIERS.map((t, i) => (
                  <span key={t} className={'medal m' + i + (p.tier >= i ? ' got' : '')} title={`${t}: ${fmt(p.def.tiers[i])}${p.def.unit ?? ''} ${p.def.what}`} />
                ))}
              </div>
              <div className="small muted">
                {p.def.what}: {fmt(p.value)}
                {p.def.unit ?? ''}
              </div>
              {p.next !== null ? (
                <>
                  <div className="progress-line thin">
                    <div style={{ width: `${p.ratio * 100}%` }} />
                  </div>
                  <div className="small">
                    {TIERS[p.tier + 1]} at {fmt(p.next)}
                    {p.def.unit ?? ''}
                  </div>
                </>
              ) : (
                <div className="small maxed">All tiers earned ✨</div>
              )}
              {at && <div className="small muted">since {new Date(at.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function Target({ p }: { p: Progress }) {
  return (
    <div className="target">
      <span className="badge-icon small-icon">{p.def.icon}</span>
      <div className="target-main">
        <div className="small">
          <b>{p.def.title}</b> → {TIERS[p.tier + 1]}
        </div>
        <div className="progress-line thin">
          <div style={{ width: `${p.ratio * 100}%` }} />
        </div>
        <div className="small muted">
          {fmt(Math.max(0, p.next! - p.value))}
          {p.def.unit ?? ''} more {p.def.what}
        </div>
      </div>
    </div>
  );
}
