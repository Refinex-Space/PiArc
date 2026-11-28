// "Fetch models" for a custom or local endpoint (ADR-0083): Core asks the endpoint for its model
// list with the key typed in the form, or with the stored key when the endpoint is the one the
// provider was saved for. Checking a model adds it to the model list; unchecking removes it.
import { useId, useState } from 'react';

import { useT } from '../app/app-context.js';
import { Button } from '../app/Button.js';
import { reason } from '../shell/errors.js';
import { entries, parseDiscovered, withModel, type Form } from './provider-form.js';

export function ModelDiscovery({
  form,
  savedId,
  disabled,
  onModels,
}: {
  readonly form: Form;
  /** The provider being edited, whose stored key Core may use. */
  readonly savedId: string | undefined;
  readonly disabled: boolean;
  readonly onModels: (models: string) => void;
}) {
  const t = useT();
  const listId = useId();
  const [loading, setLoading] = useState(false);
  const [found, setFound] = useState<string[]>();
  const [failure, setFailure] = useState('');
  const chosen = new Set(entries(form));
  const fetchModels = () => {
    setLoading(true);
    setFailure('');
    const request = JSON.stringify({
      api: form.api,
      baseUrl: form.baseUrl,
      ...(savedId === undefined ? {} : { provider: savedId }),
    });
    const secret =
      form.key !== '' && !form.removeKey ? JSON.stringify({ key: form.key }) : undefined;
    window.piarc
      .discoverModels(request, secret)
      .then(parseDiscovered)
      .then(setFound)
      .catch((e: unknown) => {
        setFound(undefined);
        setFailure(reason(e));
      })
      .finally(() => {
        setLoading(false);
      });
  };
  return (
    <div className="model-discovery">
      <Button
        size="small"
        data-testid="provider-discover"
        loading={loading}
        disabled={disabled || form.baseUrl.trim() === ''}
        aria-controls={found === undefined ? undefined : listId}
        onClick={fetchModels}
      >
        {t('providers.discover')}
      </Button>
      {failure === '' ? null : (
        <p className="error-text small" role="alert" data-testid="provider-discover-failed">
          {t('providers.discoverFailed', { reason: failure })}
        </p>
      )}
      {found === undefined ? null : found.length === 0 ? (
        <p className="muted small" role="status">
          {t('providers.discoverNone')}
        </p>
      ) : (
        <fieldset className="model-discovered" id={listId}>
          <legend className="muted small">{t('providers.discovered')}</legend>
          {found.map((id) => (
            <label key={id} className="model-discovered-item">
              <input
                type="checkbox"
                data-testid={`provider-discovered-${id}`}
                checked={chosen.has(id)}
                disabled={disabled}
                onChange={(e) => {
                  onModels(withModel(form.models, id, e.currentTarget.checked));
                }}
              />
              <span>{id}</span>
            </label>
          ))}
        </fieldset>
      )}
    </div>
  );
}
