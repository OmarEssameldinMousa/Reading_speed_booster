import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { navigate, useRoute } from './router';
import { db, getSettings } from './db/db';
import { Review } from './pages/Review';
import { Library } from './pages/Library';
import { BookPage } from './pages/BookPage';
import { Read } from './reader/Read';
import { Stats } from './pages/Stats';
import { SettingsPage } from './pages/SettingsPage';
import { Trophies } from './pages/Trophies';
import { checkBadges, onUnlock, TIERS, type Unlock } from './gamify/badges';
import { celebrate, onCelebrate, type CelebrateOpts, type Level } from './fx/celebrate';

interface Toast extends Unlock {
  key: number;
}

export function App() {
  const route = useRoute();
  const due = useLiveQuery(() => db.cards.where('due').belowOrEqual(Date.now()).count(), [route.join('/')]) ?? 0;
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [banner, setBanner] = useState<(CelebrateOpts & { key: number }) | null>(null);

  useEffect(() => {
    void checkBadges();
    const offUnlock = onUnlock(async (list) => {
      const items = list.map((u, i) => ({ ...u, key: Date.now() + i }));
      setToasts((t) => [...t, ...items]);
      setTimeout(() => setToasts((t) => t.filter((x) => !items.includes(x))), 6000);
      const s = await getSettings();
      if (!s.celebrations) return;
      // bronze → warm confetti, silver → bigger, gold and platinum → fireworks
      const top = Math.max(...list.map((u) => u.tier));
      const best = list.find((u) => u.tier === top)!;
      const level = Math.min(4, top + 2) as Level;
      setTimeout(
        () => celebrate({ level, title: `${best.def.icon} ${TIERS[best.tier]} ${best.def.title}`, subtitle: `${best.def.what}: ${best.def.tiers[best.tier].toLocaleString()}${best.def.unit ?? ''}`, sound: s.celebrationSound }),
        700, // after the milestone's own celebration
      );
    });
    let timer = 0;
    const offCelebrate = onCelebrate((o) => {
      if (o.level < 3) return;
      clearTimeout(timer);
      setBanner({ ...o, key: Date.now() });
      timer = window.setTimeout(() => setBanner(null), o.level === 4 ? 5200 : 3400);
    });
    return () => {
      offUnlock();
      offCelebrate();
    };
  }, []);

  const [page, a, b, c] = route;
  const reading = page === 'read';
  let content: React.ReactNode;
  if (page === 'book' && a) content = <BookPage bookId={Number(a)} />;
  else if (reading && a && b !== undefined) content = <Read key={route.join('/')} bookId={Number(a)} chapter={Number(b)} at={c === undefined ? undefined : Number(c)} />;
  else if (page === 'stats') content = <Stats />;
  else if (page === 'review') content = <Review />;
  else if (page === 'trophies') content = <Trophies />;
  else if (page === 'settings') content = <SettingsPage />;
  else content = <Library />;

  return (
    <div className={'app' + (reading ? ' is-reading' : '')}>
      {!reading && (
        <nav className="topnav">
          <a className="brand" href="#/">
            <span className="brand-read">Reading</span>
            <span className="brand-x">⚡</span>
            <span className="brand-write">Booster</span>
          </a>
          <div className="nav-links">
            <a href="#/" className={!page ? 'active' : ''}>Library</a>
            <a href="#/review" className={page === 'review' ? 'active' : ''}>
              Review {due > 0 && <span className="badge">{due}</span>}
            </a>
            <a href="#/trophies" className={page === 'trophies' ? 'active' : ''}>Trophies</a>
            <a href="#/stats" className={page === 'stats' ? 'active' : ''}>Progress</a>
            <a href="#/settings" className={page === 'settings' ? 'active' : ''}>Settings</a>
          </div>
        </nav>
      )}
      {content}

      {banner && (
        <div key={banner.key} className={`celebration-banner level-${banner.level}`} role="status" onClick={() => setBanner(null)}>
          <div className="cb-title">{banner.title}</div>
          {banner.subtitle && <div className="cb-sub">{banner.subtitle}</div>}
        </div>
      )}
      <div className="trophy-toasts">
        {toasts.map((t) => (
          <div key={t.key} className={`trophy-toast tier-${t.tier}`} onClick={() => navigate('#/trophies')}>
            <span className="tt-icon">{t.def.icon}</span>
            <div>
              <div className="eyebrow">{TIERS[t.tier]} trophy</div>
              <b>{t.def.title}</b>
              <div className="small muted">
                {t.def.what}: {t.def.tiers[t.tier].toLocaleString()}
                {t.def.unit ?? ''}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
