import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

// Wait for the overlay fonts so text widths are measured correctly.
const fonts = ["16px 'Crimson Pro'", "italic 16px 'Crimson Pro'", "600 16px 'Source Sans 3'", "16px 'Source Code Pro'"];
Promise.race([Promise.all(fonts.map((f) => document.fonts.load(f))), new Promise((r) => setTimeout(r, 2500))]).finally(() =>
  createRoot(document.getElementById('root')!).render(<App />),
);
