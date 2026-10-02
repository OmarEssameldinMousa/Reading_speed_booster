import { useLiveQuery } from 'dexie-react-hooks';
import { useRoute } from './router';
import { db } from './db/db';
import { Review } from './pages/Review';
import { Library } from './pages/Library';
import { BookPage } from './pages/BookPage';
import { Read } from './reader/Read';
import { Stats } from './pages/Stats';
import { SettingsPage } from './pages/SettingsPage';

export function App() {
  const route = useRoute();
  const due = useLiveQuery(() => db.cards.where('due').belowOrEqual(Date.now()).count(), [route.join('/')]) ?? 0;
  const [page, a, b, c] = route;
  const reading = page === 'read';
  let content: React.ReactNode;
  if (page === 'book' && a) content = <BookPage bookId={Number(a)} />;
  else if (reading && a && b !== undefined) content = <Read key={route.join('/')} bookId={Number(a)} chapter={Number(b)} at={c === undefined ? undefined : Number(c)} />;
  else if (page === 'stats') content = <Stats />;
  else if (page === 'review') content = <Review />;
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
            <a href="#/stats" className={page === 'stats' ? 'active' : ''}>Progress</a>
            <a href="#/settings" className={page === 'settings' ? 'active' : ''}>Settings</a>
          </div>
        </nav>
      )}
      {content}
    </div>
  );
}
