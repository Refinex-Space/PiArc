import { useCallback, useMemo } from 'react';
import { useUi } from '../../shell/ui.js';
import { useT } from '../../app/app-context.js';
import {
  IMAGE_BATCH_LIMIT,
  IMAGE_LIMIT,
  IMAGE_COUNT_LIMIT,
  imageRef,
  type ImagePlacement,
} from '../../../shared/markdown-images.js';
import { projectRecord } from '../../../shared/project-files.js';

function inserted(raw: unknown): string {
  if (!projectRecord(raw) || typeof raw.alt !== 'string' || typeof raw.href !== 'string')
    throw new TypeError('Invalid image import response');
  return imageRef(raw.alt, raw.href);
}
export async function loadMarkdownImage(
  sessionId: string,
  documentPath: string,
  reference: string,
) {
  const url = await window.piarc.markdownImage(sessionId, documentPath, {
    op: 'preview',
    reference,
  });
  if (!url.startsWith('piarc-document://markdown-images/'))
    throw new Error('Invalid image resource');
  return {
    url,
    release: () => {
      void window.piarc
        .markdownImage(sessionId, documentPath, { op: 'release', url })
        .catch((error: unknown) => {
          console.warn('[files] image release failed', error);
        });
    },
  };
}
export function useMarkdownImages(sessionId: string, path: string) {
  const t = useT();
  const { addToast } = useUi();
  const format = useCallback(
    (result: unknown) => {
      if (!Array.isArray(result)) throw new TypeError('Invalid image import result');
      const refs: string[] = [],
        failures: string[] = [];
      for (const raw of result as unknown[]) {
        if (projectRecord(raw) && typeof raw.error === 'string' && typeof raw.name === 'string')
          failures.push(raw.name + ' — ' + raw.error);
        else refs.push(inserted(raw));
      }
      if (failures.length) {
        const message = t('files.images.importFailed', { files: failures.join(' · ') });
        if (!refs.length) throw new Error(message);
        addToast({ sessionId, text: message });
      }
      return refs;
    },
    [addToast, sessionId, t],
  );
  const choose = useCallback(
    async (placement: ImagePlacement) => {
      const raw: unknown = JSON.parse(
        await window.piarc.markdownImage(sessionId, path, { op: 'pick', placement }),
      );
      const refs = format(raw);
      return refs.length ? refs.join('\n') : null;
    },
    [sessionId, path, format],
  );
  const importFiles = useCallback(
    async (files: readonly File[]) => {
      if (
        files.length > IMAGE_COUNT_LIMIT ||
        files.some((f) => !f.size || f.size > IMAGE_LIMIT) ||
        files.reduce((n, f) => n + f.size, 0) > IMAGE_BATCH_LIMIT
      )
        throw new Error(t('files.images.limit'));
      const inputs = await Promise.all(
        files.map(async (file) => {
          const source = window.piarc.pathForFile(file);
          return {
            name: file.name,
            bytes: new Uint8Array(await file.arrayBuffer()),
            ...(source ? { source } : {}),
          };
        }),
      );
      const result: unknown = JSON.parse(
        await window.piarc.markdownImage(sessionId, path, { op: 'import', files: inputs }),
      );
      return format(result);
    },
    [sessionId, path, t, format],
  );
  const openSettings = useCallback(() => {
    void window.piarc.openSettings('markdown').catch((e: unknown) => {
      console.error('[files] opening Markdown settings failed', e);
    });
  }, []);
  return useMemo(
    () => ({ choose, importFiles, openSettings, dialogs: null }),
    [choose, importFiles, openSettings],
  );
}
