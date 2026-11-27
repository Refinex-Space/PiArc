import { useId, useRef, useState, type Ref } from 'react';
import { useApp } from '../app/app-context.js';
import { Dialog } from './Dialog.js';
import { choiceName, MenuPopup, useMenu } from './Menu.js';
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
  const picker = useMenu();
  const [chosen, setChosen] = useState<{ model: ModelChoice; preview: SwitchPreview }>();
  const [level, setLevel] = useState<Effort | ''>('');
  const [busy, setBusy] = useState(false);
  const nextRequest = useRef(0);
  const menu = useMenu();
  const current = catalog?.models.find((m) => catalog.model && keyOf(m) === keyOf(catalog.model));
  const modelLabel = current?.name ?? catalog?.model?.id ?? t('models.label');
  const effortLabel = catalog?.effort ? t(`models.effort.${catalog.effort}`) : t('models.effort');
  // The model's highest level stands out, like the reference's top tier (the rest stay grey).
  const topEffort =
    catalog?.effort !== undefined &&
    current !== undefined &&
    current.efforts.length > 1 &&
    current.efforts.at(-1) === catalog.effort;
  const close = () => {
    nextRequest.current++;
    setChosen(undefined);
    picker.close();
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
      picker.close();
      setChosen(undefined);
      await window.piarc.setSessionModel(id, chosen.model.provider, chosen.model.id, level);
      onChange();
      close();
    } catch (e) {
      close();
      onError(e);
    }
  };
  const effortItems =
    current?.efforts.map((e) => ({
      id: `effort-${e}`,
      selected: e === catalog?.effort,
      label: t(`models.effort.${e}`),
      run: () => {
        if (e !== catalog?.effort) window.piarc.setSessionEffort(id, e).then(onChange, onError);
      },
    })) ?? [];
  return (
    <>
      <button
        type="button"
        className="choice-button composer-model"
        ref={modelButton}
        disabled={running || busy}
        data-testid="session-model"
        aria-label={choiceName(modelLabel, t('models.label'))}
        aria-haspopup="dialog"
        title={catalog?.model ? keyOf(catalog.model) : t('models.label')}
        aria-expanded={picker.open !== null}
        onClick={(event) => {
          picker.openAbove(event.currentTarget);
        }}
      >
        {modelLabel}
      </button>
      <button
        type="button"
        className="choice-button composer-effort"
        ref={effortButton}
        disabled={running || busy || !current?.efforts.length}
        data-testid="session-effort"
        data-top-tier={topEffort ? '' : undefined}
        aria-label={choiceName(effortLabel, t('models.effort'))}
        aria-haspopup="menu"
        aria-expanded={Boolean(menu.open)}
        onClick={(e) => {
          menu.openAbove(e.currentTarget);
        }}
      >
        {effortLabel}
      </button>
      {menu.open && current && (
        <MenuPopup
          label={t('models.effort')}
          heading={t('models.effort')}
          at={menu.open}
          onClose={menu.close}
          items={effortItems}
        />
      )}
      {picker.open !== null && (
        <MenuPopup
          label={t('models.label')}
          testId="model-menu"
          filterLabel={t('models.search')}
          at={picker.open}
          onClose={picker.close}
          items={[
            ...(catalog?.models ?? []).map((m) => ({
              id: keyOf(m),
              testId: `model-option-${keyOf(m)}`,
              label: m.name,
              hint: keyOf(m),
              selected: current !== undefined && keyOf(m) === keyOf(current),
              run: () => {
                if (current === undefined || keyOf(m) !== keyOf(current)) void edit(m);
              },
            })),
            ...(effortItems.length
              ? [{ id: 'effort', label: t('models.effort'), submenu: effortItems }]
              : []),
            {
              id: 'manage-models',
              label: t('models.manage'),
              run: () => {
                void window.piarc.openSettings('providers');
              },
            },
          ]}
        />
      )}
      {chosen && (
        <Dialog
          labelledBy={title}
          onCancel={() => {
            if (!busy) close();
          }}
          testId="model-switch-dialog"
        >
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
        </Dialog>
      )}
    </>
  );
}
