// Adding an MCP server (ADR-0101): a name, a local command (with its environment) or an HTTP
// address, and where it applies (every project, or only this one without touching the
// repository). The main process shows the definition in a native confirmation before Core writes
// it; a cancelled confirmation keeps the dialog open with what was typed.
import { useId, useState } from 'react';

import type { MessageId } from '../../shared/i18n/index.js';
import type { McpServerInput } from '../../shared/ipc.js';
import { Button } from '../app/Button.js';
import { SegmentedControl } from '../app/SegmentedControl.js';
import { useApp } from '../app/app-context.js';
import { Dialog } from '../shell/Dialog.js';
import { reason } from '../shell/errors.js';
import { isCancelled } from './PluginsSection.js';
import { IconButton } from '../app/IconButton.js';
import { CloseIcon, PlusIcon } from '../shell/icons.js';
import {
  envFromRows,
  splitCommand,
  validServerName,
  validServerUrl,
  type EnvRow,
} from './mcp-input.js';

type Transport = 'stdio' | 'http';
type Scope = 'user' | 'projectLocal';
type Field = 'name' | 'command' | 'env' | 'url';

/** The form's input, or the first problem of each field. */
export function readForm(
  form: {
    readonly name: string;
    readonly transport: Transport;
    readonly command: string;
    readonly env: readonly EnvRow[];
    readonly url: string;
    readonly scope: Scope;
  },
  taken: readonly string[],
): { input: McpServerInput } | { errors: Partial<Record<Field, MessageId>> } {
  const errors: Partial<Record<Field, MessageId>> = {};
  const name = form.name.trim();
  if (!validServerName(name)) errors.name = 'mcp.add.error.name';
  else if (taken.includes(name)) errors.name = 'mcp.add.error.taken';
  if (form.transport === 'http') {
    const url = form.url.trim();
    if (!validServerUrl(url)) errors.url = 'mcp.add.error.url';
    if (Object.keys(errors).length > 0) return { errors };
    return { input: { scope: form.scope, name, transport: 'http', url } };
  }
  const words = splitCommand(form.command);
  const env = envFromRows(form.env);
  const [command, ...args] = words ?? [];
  if (command === undefined || command === '') errors.command = 'mcp.add.error.command';
  if (env === undefined) errors.env = 'mcp.add.error.env';
  if (Object.keys(errors).length > 0 || command === undefined || env === undefined) {
    return { errors };
  }
  return { input: { scope: form.scope, name, transport: 'stdio', command, args, env } };
}

export function McpAddDialog({
  workspace,
  taken,
  onClose,
  onAdded,
}: {
  readonly workspace: string;
  /** Names any source already uses. */
  readonly taken: readonly string[];
  readonly onClose: () => void;
  readonly onAdded: (status: string) => void;
}) {
  const { t } = useApp();
  const id = useId();
  const [form, setForm] = useState({
    name: '',
    transport: 'stdio' as Transport,
    command: '',
    env: [{ name: '', value: '' }] as readonly EnvRow[],
    url: '',
    scope: 'user' as Scope,
  });
  const [errors, setErrors] = useState<Partial<Record<Field, MessageId>>>({});
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => {
    setForm((old) => ({ ...old, [key]: value }));
    setErrors((old) => ({ ...old, [key]: undefined }));
  };
  const field = (key: Field, label: MessageId, control: React.ReactNode, hint?: MessageId) => (
    <div className="mcp-add-field">
      <label htmlFor={`${id}-${key}`} className="mcp-add-label">
        {t(label)}
      </label>
      {control}
      {errors[key] === undefined ? (
        hint === undefined ? null : (
          <span className="mcp-add-hint">{t(hint)}</span>
        )
      ) : (
        <span className="error-text small" id={`${id}-${key}-error`} role="alert">
          {t(errors[key])}
        </span>
      )}
    </div>
  );
  const props = (key: Exclude<Field, 'env'>) => ({
    id: `${id}-${key}`,
    className: 'input',
    spellCheck: false,
    autoComplete: 'off',
    'aria-invalid': errors[key] !== undefined,
    'aria-describedby': errors[key] === undefined ? undefined : `${id}-${key}-error`,
    'data-testid': `mcp-add-${key}`,
    value: form[key],
  });
  return (
    <Dialog
      labelledBy={`${id}-title`}
      onCancel={onClose}
      testId="mcp-add-dialog"
      className="mcp-add"
      wide
    >
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (busy) return;
          const read = readForm(form, taken);
          if ('errors' in read) {
            setErrors(read.errors);
            return;
          }
          setBusy(true);
          setFailure('');
          window.piarc
            .mcpAddServer(workspace, read.input)
            .then(
              (raw) => {
                if (!isCancelled(raw)) onAdded(raw);
              },
              (e: unknown) => {
                setFailure(t('mcp.add.failed', { reason: reason(e) }));
              },
            )
            .finally(() => {
              setBusy(false);
            });
        }}
      >
        <h2 id={`${id}-title`} className="dialog-title">
          {t('mcp.add.title')}
        </h2>
        <fieldset className="mcp-add-fields" disabled={busy}>
          {field(
            'name',
            'mcp.add.name',
            <input
              {...props('name')}
              data-autofocus
              placeholder={t('mcp.add.namePlaceholder')}
              onChange={(e) => {
                set('name', e.currentTarget.value);
              }}
            />,
          )}
          <div className="mcp-add-field">
            <span className="mcp-add-label" id={`${id}-transport`}>
              {t('mcp.add.transport')}
            </span>
            <SegmentedControl<Transport>
              name={`${id}-transport-choice`}
              aria-labelledby={`${id}-transport`}
              options={['stdio', 'http']}
              value={form.transport}
              labelOf={(v) => t(v === 'stdio' ? 'mcp.add.stdio' : 'mcp.add.http')}
              onChange={(v) => {
                set('transport', v);
              }}
              testIdPrefix="mcp-add-transport"
            />
          </div>
          {form.transport === 'stdio' ? (
            <>
              {field(
                'command',
                'mcp.add.command',
                <input
                  {...props('command')}
                  className="input mono-text"
                  placeholder={t('mcp.add.commandPlaceholder')}
                  onChange={(e) => {
                    set('command', e.currentTarget.value);
                  }}
                />,
              )}
              <div className="mcp-add-field">
                <span className="mcp-add-label" id={`${id}-env`}>
                  {t('mcp.add.env')}
                </span>
                <div className="mcp-env" role="group" aria-labelledby={`${id}-env`}>
                  {form.env.map((row, index) => (
                    <div className="mcp-env-row" key={index}>
                      <input
                        className="input mono-text"
                        aria-label={t('mcp.add.envName')}
                        placeholder={t('mcp.add.envNamePlaceholder')}
                        spellCheck={false}
                        autoComplete="off"
                        value={row.name}
                        aria-invalid={errors.env !== undefined}
                        data-testid={`mcp-add-env-name-${String(index)}`}
                        onChange={(e) => {
                          const name = e.currentTarget.value;
                          set(
                            'env',
                            form.env.map((r, i) => (i === index ? { ...r, name } : r)),
                          );
                        }}
                      />
                      <input
                        className="input mono-text"
                        aria-label={t('mcp.add.envValue')}
                        placeholder={t('mcp.add.envValuePlaceholder')}
                        spellCheck={false}
                        autoComplete="off"
                        value={row.value}
                        data-testid={`mcp-add-env-value-${String(index)}`}
                        onChange={(e) => {
                          const value = e.currentTarget.value;
                          set(
                            'env',
                            form.env.map((r, i) => (i === index ? { ...r, value } : r)),
                          );
                        }}
                      />
                      <IconButton
                        size="sm"
                        className="settings-remove"
                        label={t('mcp.add.envRemove')}
                        disabled={form.env.length === 1 && row.name === '' && row.value === ''}
                        onClick={() => {
                          const rest = form.env.filter((_, i) => i !== index);
                          set('env', rest.length === 0 ? [{ name: '', value: '' }] : rest);
                        }}
                      >
                        <CloseIcon />
                      </IconButton>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="settings-add-link mcp-env-add"
                    data-testid="mcp-add-env-add"
                    disabled={form.env.length >= 64}
                    onClick={() => {
                      set('env', [...form.env, { name: '', value: '' }]);
                    }}
                  >
                    <PlusIcon />
                    {t('mcp.add.envAdd')}
                  </button>
                </div>
                {errors.env === undefined ? (
                  <span className="mcp-add-hint">{t('mcp.add.envHint')}</span>
                ) : (
                  <span className="error-text small" role="alert">
                    {t(errors.env)}
                  </span>
                )}
              </div>
            </>
          ) : (
            field(
              'url',
              'mcp.add.url',
              <input
                {...props('url')}
                className="input mono-text"
                inputMode="url"
                placeholder={t('mcp.add.urlPlaceholder')}
                onChange={(e) => {
                  set('url', e.currentTarget.value);
                }}
              />,
              'mcp.add.urlHint',
            )
          )}
          <div className="mcp-add-field">
            <span className="mcp-add-label" id={`${id}-scope`}>
              {t('mcp.add.scopeLabel')}
            </span>
            <SegmentedControl<Scope>
              name={`${id}-scope-choice`}
              aria-labelledby={`${id}-scope`}
              options={['user', 'projectLocal']}
              value={form.scope}
              labelOf={(v) =>
                t(v === 'user' ? 'mcp.add.scope.userShort' : 'mcp.add.scope.projectShort')
              }
              onChange={(v) => {
                set('scope', v);
              }}
              testIdPrefix="mcp-add-scope"
            />
            <span className="mcp-add-hint">
              {t(form.scope === 'user' ? 'mcp.add.scope.user' : 'mcp.add.scope.projectLocal')}
            </span>
          </div>
        </fieldset>
        {failure === '' ? null : (
          <p className="error-text small" role="alert" data-testid="mcp-add-failure">
            {failure}
          </p>
        )}
        <div className="dialog-actions">
          <Button variant="ghost" onClick={onClose}>
            {t('dialog.cancel')}
          </Button>
          <Button type="submit" variant="primary" loading={busy} data-testid="mcp-add-submit">
            {t('mcp.add.submit')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
