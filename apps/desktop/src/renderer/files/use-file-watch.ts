import { useEffect, useState } from 'react';
import { documentWindow } from '../app/surface-document.js';
export function useFileWatch(
  id: string,
  dirs: readonly string[],
  active: string | null,
  doc: Document,
) {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    // Watch the parent too: atomic replacement changes file identity and rename events on
    // the previous inode alone would miss subsequent writes.
    const parent = active?.split('/').slice(0, -1).join('/');
    const paths = [...new Set([...dirs, ...(parent === undefined ? [] : [parent])])];
    const notify = () => {
      if (!doc.hidden) setRevision((value) => value + 1);
    };
    const update = (selected: readonly string[]) => {
      void window.piarc.watchProjectFiles(id, selected).catch((error: unknown) => {
        console.warn('[files] watch failed', error);
      });
    };
    update(paths);
    const unsub = window.piarc.onAppEvent((event) => {
      if (event.type === 'projectFilesChanged' && event.sessionId === id) notify();
    });
    const win = documentWindow(doc);
    win.addEventListener('focus', notify);
    doc.addEventListener('visibilitychange', notify);
    return () => {
      unsub();
      win.removeEventListener('focus', notify);
      doc.removeEventListener('visibilitychange', notify);
      update([]);
    };
  }, [id, dirs, active, doc]);
  return revision;
}
