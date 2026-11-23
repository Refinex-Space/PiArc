import { useId, useRef, useState, type Ref } from 'react';
import { useApp } from '../app/app-context.js';
import { Dialog } from './Dialog.js';
import { MenuPopup, useMenu } from './Menu.js';
import {
  keyOf,
  isEffort,
  parsePreview,
  type Catalog,
  type ModelChoice,
  type Effort,
  type SwitchPreview,
} from './model-catalog.js';

export function ModelMenus({
  id,
  catalog,
  modelButton,
  effortButton,
  onChange,
  onError,
  running,
}: {
  id: string;
  catalog: Catalog | undefined;
  modelButton: Ref<HTMLButtonElement>;
  effortButton: Ref<HTMLButtonElement>;
  onChange: () => void;
  onError: (e: unknown) => void;
  running: boolean;
}) {
  const { t, locale } = useApp();
  const title = useId();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [chosen, setChosen] = useState<{ model: ModelChoice; preview: SwitchPreview }>();
  const [level, setLevel] = useState<Effort | ''>('');
  const [busy, setBusy] = useState(false);
  const nextRequest = useRef(0);
  const menu = useMenu();
  const current = catalog?.models.find((m) => catalog.model && keyOf(m) === keyOf(catalog.model));
  const close = () => {
    nextRequest.current++;
    setChosen(undefined);
    setOpen(false);
    setBusy(false);
  };
  const edit = async (model: ModelChoice) => {
    const seq = ++nextRequest.current;
    setBusy(true);
    try {
      const preview = parsePreview(
        await window.piarc.previewModelSwitch(id, model.provider, model.id),
      );
      if (seq !== nextRequest.current) return;
      setChosen({ model, preview });
      setLevel(
        catalog?.effort && model.efforts.includes(catalog.effort)
          ? catalog.effort
          : model.efforts.length === 1
            ? (model.efforts[0] ?? '')
            : '',
      );
    } catch (e) {
      if (seq === nextRequest.current) {
        close();
        onError(e);
      }
    } finally {
      if (seq === nextRequest.current) setBusy(false);
    }
  };
  const confirm = async () => {
    if (!chosen || !level || busy) return;
    setBusy(true);
    try {
      // A PreModelSwitch hook may ask a question in the session's approval ledger. Release
      // this modal's focus trap before waiting for the confirmed operation.
      setOpen(false);
      setChosen(undefined);
      await window.piarc.setSessionModel(id, chosen.model.provider, chosen.model.id, level);
      onChange();
      close();
    } catch (e) {
      close();
      onError(e);
    }
  };
  const models =
    catalog?.models.filter((m) =>
      (m.name + ' ' + keyOf(m)).toLowerCase().includes(search.toLowerCase()),
    ) ?? [];
  return (
    <>
      <button
        type="button"
        className="row-action"
        ref={modelButton}
        disabled={running || busy}
        data-testid="session-model"
        aria-haspopup="dialog"
        onClick={() => {
          setSearch('');
          setOpen(true);
        }}
      >
        {catalog?.model ? keyOf(catalog.model) : t('models.label')} ▾
      </button>
      <button
        type="button"
        className="row-action"
        ref={effortButton}
        disabled={running || busy || !current?.efforts.length}
        data-testid="session-effort"
        aria-haspopup="menu"
        aria-expanded={Boolean(menu.open)}
        onClick={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          menu.openAt(box.left, box.top);
        }}
      >
        {t('models.effort')}
        {catalog?.effort && ` · ${t(`models.effort.${catalog.effort}`)}`} ▾
      </button>
      {menu.open && current && (
        <MenuPopup
          label={t('models.effort')}
          at={menu.open}
          onClose={menu.close}
          items={current.efforts.map((e) => ({
            id: `effort-${e}`,
            label: t(`models.effort.${e}`),
            run: () => {
              if (e !== catalog?.effort)
                window.piarc.setSessionEffort(id, e).then(onChange, onError);
            },
          }))}
        />
      )}
      {open && (
        <Dialog
          labelledBy={title}
          onCancel={() => {
            if (!chosen || !busy) close();
          }}
          testId={chosen ? 'model-switch-dialog' : 'model-menu'}
          focusKey={chosen ? 'preview' : 'menu'}
        >
          {chosen ? (
            <>
              <h2 id={title}>{t('models.switchTo', { model: keyOf(chosen.model) })}</h2>
              <dl className="model-preview">
                <dt>{t('models.context')}</dt>
                <dd data-testid="model-context">
                  {chosen.preview.contextTokens === null
                    ? t('models.unknown')
                    : t('models.tokens', { count: chosen.preview.contextTokens })}
                </dd>
                <dt>{t('models.cache')}</dt>
                <dd>{t(chosen.preview.cacheInvalidated ? 'models.invalidated' : 'models.kept')}</dd>
                <dt>{t('models.cost')}</dt>
                <dd data-testid="model-cache-cost">
                  {chosen.preview.cacheWriteUsd === null
                    ? t('models.unknown')
                    : new Intl.NumberFormat(locale, {
                        style: 'currency',
                        currency: 'USD',
                        maximumSignificantDigits: 6,
                      }).format(chosen.preview.cacheWriteUsd)}
                </dd>
                <dt>{t('models.thinking')}</dt>
                <dd>{t(chosen.preview.dropsThinking ? 'models.dropped' : 'models.retained')}</dd>
              </dl>
              <label className="setting">
                {t('models.effort')}
                <select
                  className="input"
                  value={level}
                  data-testid="model-switch-effort"
                  onChange={(e) => {
                    const v = e.currentTarget.value;
                    if (isEffort(v)) setLevel(v);
                  }}
                >
                  {!level && <option value="">{t('models.priority')}</option>}
                  {chosen.model.efforts.map((e) => (
                    <option key={e} value={e}>
                      {t(`models.effort.${e}`)}
                    </option>
                  ))}
                </select>
              </label>
              <div className="dialog-actions">
                <button type="button" className="button" disabled={busy} onClick={close}>
                  {t('dialog.cancel')}
                </button>
                <button
                  type="button"
                  className="button button-primary"
                  disabled={!level || busy || running}
                  data-testid="model-switch-confirm"
                  onClick={() => {
                    void confirm();
                  }}
                >
                  {t('models.switch')}
                </button>
              </div>
            </>
          ) : (
            <>
              <h2 id={title}>{t('models.label')}</h2>
              <input
                className="input"
                data-autofocus
                aria-label={t('models.search')}
                placeholder={t('models.search')}
                value={search}
                onChange={(e) => {
                  setSearch(e.currentTarget.value);
                }}
              />
              <ul className="model-list">
                {models.map((m) => (
                  <li key={keyOf(m)}>
                    <button
                      type="button"
                      className="model-option"
                      disabled={busy || running || (current && keyOf(m) === keyOf(current))}
                      data-testid={`model-option-${keyOf(m)}`}
                      onClick={() => {
                        void edit(m);
                      }}
                    >
                      <strong>{m.name}</strong>
                      <span className="small muted">{keyOf(m)}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {!models.length && <p className="muted">{t('models.empty')}</p>}
              <div className="dialog-actions">
                <button
                  type="button"
                  className="button"
                  onClick={() => {
                    void window.piarc.openSettings('providers');
                    close();
                  }}
                >
                  {t('models.manage')}
                </button>
                <button type="button" className="button" onClick={close}>
                  {t('shortcuts.close')}
                </button>
              </div>
            </>
          )}
        </Dialog>
      )}
    </>
  );
}
