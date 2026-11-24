import { useEffect, useId, useState } from 'react';
import { useT } from '../app/app-context.js';
import { Button } from '../app/Button.js';
import { reason } from '../shell/errors.js';
import {
  locations,
  validImageFolder,
  type ImageLink,
  type ImageLocation,
  type ImageSettings,
  type ImageSettingsRequest,
} from '../../shared/markdown-images.js';
import { projectRecord } from '../../shared/project-files.js';

function parse(data: string): ImageSettings {
  const raw: unknown = JSON.parse(data);
  if (
    !projectRecord(raw) ||
    !locations.some((m) => m === raw.mode) ||
    typeof raw.folder !== 'string' ||
    !['relativeDot', 'absolute', 'relative'].some((m) => m === raw.link) ||
    (raw.directory !== null && typeof raw.directory !== 'string')
  )
    throw new Error('Invalid image preferences');
  return {
    mode: raw.mode as ImageLocation,
    folder: raw.folder,
    link: raw.link as ImageLink,
    directory: raw.directory,
  };
}
function preview(p: ImageSettings, folder: string) {
  const dir =
    p.mode === 'assets'
      ? 'assets'
      : p.mode === 'named'
        ? 'guide.assets'
        : p.mode === 'relative'
          ? folder.replaceAll('${filename}', 'guide')
          : p.mode === 'selected'
            ? p.directory?.replaceAll('\\', '/')
            : '';
  // The settings page has no active file. Show the storage layout without guessing
  // a drive letter or the relative distance from a workspace to an external folder.
  if (p.mode === 'reference') return 'diagram.png';
  if (p.mode === 'selected') return (dir ?? '').replace(/\/$/u, '') + '/diagram.png';
  return 'docs/' + (dir ? dir.replace(/\/$/u, '') + '/' : '') + 'diagram.png';
}
export function MarkdownPage() {
  const t = useT(),
    uid = useId();
  const [prefs, setPrefs] = useState<ImageSettings>(),
    [folder, setFolder] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void window.piarc
      .markdownImageSettings({ op: 'read' })
      .then((data) => {
        if (live) {
          const state = parse(data);
          setPrefs(state);
          setFolder(state.folder);
        }
      })
      .catch((e: unknown) => {
        if (live) setError(reason(e));
      });
    return () => {
      live = false;
    };
  }, []);
  const update = async (req: ImageSettingsRequest) => {
    setBusy(true);
    setError('');
    try {
      const next = parse(await window.piarc.markdownImageSettings(req));
      setPrefs(next);
      setFolder(next.folder);
    } catch (e) {
      setError(reason(e));
    } finally {
      setBusy(false);
    }
  };
  const set = (mode: ImageLocation, folder: string, link: ImageLink) => {
    void update({ op: 'set', mode, folder, link });
  };
  const valid = validImageFolder(folder);
  return (
    <section
      className="settings-section settings-detail-page preference-rows markdown-image-settings"
      aria-labelledby={uid}
    >
      <h2 id={uid} className="settings-heading" data-testid="markdown-image-storage">
        {t('files.images.storage')}
      </h2>
      {error && (
        <p role="alert" className="error-text">
          {t('files.failed', { reason: error })}
        </p>
      )}
      {prefs && (
        <>
          <label className="preference-row">
            <span>{t('files.images.location')}</span>
            <select
              className="input preference-language"
              aria-label={t('files.images.location')}
              data-testid="markdown-image-location"
              value={prefs.mode}
              disabled={busy}
              onChange={(e) => {
                const choice = e.target.value as ImageLocation;
                if (choice === 'selected' && !prefs.directory) void update({ op: 'choose' });
                else
                  set(
                    choice,
                    prefs.folder || (choice === 'relative' ? 'images/${filename}' : ''),
                    prefs.link,
                  );
              }}
            >
              {locations.map((choice) => (
                <option key={choice} value={choice}>
                  {t(`files.images.mode.${choice}`)}
                </option>
              ))}
            </select>
          </label>
          {prefs.mode === 'relative' && (
            <div className="preference-row">
              <div>
                <label htmlFor={uid + '-folder'}>{t('files.images.relativeFolder')}</label>
                <p className="muted">{t('files.images.template')}</p>
              </div>
              <div>
                <input
                  id={uid + '-folder'}
                  value={folder}
                  spellCheck={false}
                  disabled={busy}
                  aria-invalid={!valid}
                  onChange={(e) => {
                    setFolder(e.target.value);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && valid) set(prefs.mode, folder, prefs.link);
                  }}
                />
                <Button
                  size="small"
                  disabled={busy || !valid || folder === prefs.folder}
                  onClick={() => {
                    set(prefs.mode, folder, prefs.link);
                  }}
                >
                  {t('files.images.apply')}
                </Button>
                {!valid && (
                  <p className="error-text" role="alert">
                    {t('files.images.invalidFolder')}
                  </p>
                )}
              </div>
            </div>
          )}
          {(prefs.mode === 'selected' || prefs.directory) && (
            <div className="preference-row">
              <div>
                <span>{t('files.images.directory')}</span>
                <p className="image-location-example">{prefs.directory}</p>
                <p className="preference-description">{t('files.images.folderGrant')}</p>
              </div>
              <div>
                <Button size="small" disabled={busy} onClick={() => void update({ op: 'choose' })}>
                  {t('files.images.chooseFolder')}
                </Button>
                {prefs.directory && (
                  <Button
                    size="small"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void update({ op: 'forget' })}
                  >
                    {t('files.images.forget')}
                  </Button>
                )}
              </div>
            </div>
          )}
          <label className="preference-row">
            <span>{t('files.images.links')}</span>
            <select
              className="input preference-language"
              disabled={busy}
              aria-label={t('files.images.links')}
              data-testid="markdown-image-link"
              value={prefs.link}
              onChange={(e) => {
                set(prefs.mode, prefs.folder, e.target.value as ImageLink);
              }}
            >
              {(['relativeDot', 'relative', 'absolute'] as const).map((kind) => (
                <option key={kind} value={kind}>
                  {t(`files.images.link.${kind}`)}
                </option>
              ))}
            </select>
          </label>
          <div className="preference-row">
            <span>{t('files.images.example')}</span>
            <output className="image-location-example" dir="ltr">
              {preview(prefs, folder)}
            </output>
          </div>
          {prefs.mode === 'reference' && <p className="muted">{t('files.images.referenceHint')}</p>}
        </>
      )}
    </section>
  );
}
