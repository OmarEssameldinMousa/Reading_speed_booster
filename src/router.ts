import { useEffect, useState } from 'react';

export function navigate(hash: string) {
  if (location.hash === hash) return;
  location.hash = hash;
}

export function useRoute(): string[] {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const h = () => {
      setHash(location.hash);
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', h);
    return () => window.removeEventListener('hashchange', h);
  }, []);
  return hash.replace(/^#\/?/, '').split('/').filter(Boolean);
}
