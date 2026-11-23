// A server's request stays in the originating session's approval ledger. The form is local
// to its modal until submitted. The main process confirms and opens URL mode interactions.
import type { ApprovalRequest, ElicitationReply } from '@piarc/protocol';
import { useId, useRef, useState, type SubmitEvent } from 'react';
import { useT } from '../app/app-context.js';
import { Dialog } from '../shell/Dialog.js';
import { reason } from '../shell/errors.js';
import { revealBidi } from '../transcript/reveal.js';
import { useApprovalFocus } from './use-approval-focus.js';
import { approvalLabel } from './approval-label.js';
import { answerRequest } from './answer.js';
import { ApprovalOrigin } from './ApprovalOrigin.js';

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function choices(field: Record<string, unknown>): { value: string; label: string }[] {
  const source = field.type === 'array' ? object(field.items) : field;
  if (Array.isArray(source.enum)) {
    const titles = Array.isArray(source.enumNames) ? source.enumNames : [];
    return source.enum.flatMap((value: unknown, i: number) =>
      typeof value === 'string'
        ? [{ value, label: typeof titles[i] === 'string' ? titles[i] : value }]
        : [],
    );
  }
  const options: unknown = source.oneOf ?? source.anyOf;
  return Array.isArray(options)
    ? options.flatMap((item: unknown) => {
        const entry = object(item);
        return typeof entry.const === 'string'
          ? [
              {
                value: entry.const,
                label: typeof entry.title === 'string' ? entry.title : entry.const,
              },
            ]
          : [];
      })
    : [];
}

function Field({
  name,
  field,
  required,
}: {
  readonly name: string;
  readonly field: Record<string, unknown>;
  readonly required: boolean;
}) {
  const t = useT();
  const items = choices(field);
  const label = typeof field.title === 'string' ? field.title : name;
  const initial = field.default;
  const number = field.type === 'number' || field.type === 'integer';
  let control;
  if (field.type === 'boolean') {
    control = (
      <select
        name={name}
        required={required}
        defaultValue={typeof initial === 'boolean' ? String(initial) : ''}
      >
        <option value="" />
        <option value="true">{t('mcp.elicit.yes')}</option>
        <option value="false">{t('mcp.elicit.no')}</option>
      </select>
    );
  } else if (items.length > 0) {
    const multiple = field.type === 'array';
    const selected =
      multiple && Array.isArray(initial)
        ? initial.filter((v: unknown): v is string => typeof v === 'string')
        : typeof initial === 'string'
          ? initial
          : '';
    control = (
      <select name={name} multiple={multiple} required={required} defaultValue={selected}>
        {!multiple && <option value="" />}
        {items.map((item) => (
          <option key={item.value} value={item.value}>
            {revealBidi(item.label)}
          </option>
        ))}
      </select>
    );
  } else {
    control = (
      <input
        name={name}
        type={
          number
            ? 'number'
            : field.format === 'email'
              ? 'email'
              : field.format === 'date'
                ? 'date'
                : 'text'
        }
        required={required}
        defaultValue={
          typeof initial === 'string' || typeof initial === 'number' ? initial : undefined
        }
        min={number && typeof field.minimum === 'number' ? field.minimum : undefined}
        max={number && typeof field.maximum === 'number' ? field.maximum : undefined}
        step={number ? (field.type === 'integer' ? 1 : 'any') : undefined}
        minLength={typeof field.minLength === 'number' ? field.minLength : undefined}
        maxLength={typeof field.maxLength === 'number' ? field.maxLength : undefined}
      />
    );
  }
  return (
    <label>
      {revealBidi(label)}
      {control}
      {typeof field.description === 'string' && <small>{revealBidi(field.description)}</small>}
    </label>
  );
}

export function ElicitationCard({ request }: { readonly request: ApprovalRequest }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const busy = useRef(false);
  const [error, setError] = useState('');
  const title = useId();
  const card = useRef<HTMLElement>(null);
  useApprovalFocus(card);
  const elicitation = request.elicitation;
  if (!elicitation) return null;
  const schema = elicitation.mode === 'form' ? elicitation.requestedSchema : {};
  const fields = Object.entries(object(schema.properties));
  function respond(reply: ElicitationReply) {
    if (busy.current) return;
    busy.current = true;
    setError('');
    setWaiting(true);
    void answerRequest(request, {
      decision: reply.action === 'accept' ? 'allowOnce' : 'deny',
      elicitation: reply,
      ...(reply.action === 'accept' && elicitation?.mode === 'url'
        ? { confirmedUrl: elicitation.url }
        : {}),
    })
      .then((outcome) => {
        if (outcome === 'handled') setError(t('approval.handled'));
        if (outcome === 'cancelled') setOpen(false);
      })
      .catch((e: unknown) => {
        setError(reason(e));
      })
      .finally(() => {
        busy.current = false;
        setWaiting(false);
      });
  }
  function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (elicitation?.mode === 'url') {
      respond({ action: 'accept' });
      return;
    }
    const data = new FormData(event.currentTarget);
    const content = Object.fromEntries(
      fields.flatMap(([name, raw]): [string, unknown][] => {
        const values = data.getAll(name).filter((v): v is string => typeof v === 'string');
        const value = values[0];
        if (value === undefined || value === '') return [];
        const type = object(raw).type;
        return [
          [
            name,
            type === 'array'
              ? values
              : type === 'boolean'
                ? value === 'true'
                : type === 'integer' || type === 'number'
                  ? Number(value)
                  : value,
          ],
        ];
      }),
    );
    respond({ action: 'accept', content });
  }
  return (
    <section
      ref={card}
      className="row approval-card question-card"
      tabIndex={-1}
      aria-label={approvalLabel(request, t)}
      data-testid="approval-card"
      data-approval-card="elicitation"
      data-request-id={request.requestId}
    >
      <header>
        <strong>{t('approval.kind.elicitation')}</strong> {request.tool}
      </header>
      <ApprovalOrigin request={request} />
      <p>{revealBidi(elicitation.message)}</p>
      <button
        type="button"
        className="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        {t('mcp.elicit.review')}
      </button>
      {open && (
        <Dialog
          labelledBy={title}
          onCancel={() => {
            respond({ action: 'cancel' });
          }}
          testId="mcp-elicitation"
        >
          <h2 id={title}>
            {t('approval.kind.elicitation')} · {request.tool}
          </h2>
          <p>{revealBidi(elicitation.message)}</p>
          <form onSubmit={submit}>
            {elicitation.mode === 'url' ? (
              <p>{revealBidi(elicitation.url)}</p>
            ) : (
              fields.map(([name, raw]) => (
                <Field
                  key={name}
                  name={name}
                  field={object(raw)}
                  required={Array.isArray(schema.required) && schema.required.includes(name)}
                />
              ))
            )}
            <div className="dialog-actions">
              <button
                type="button"
                className="button"
                disabled={waiting}
                onClick={() => {
                  respond({ action: 'cancel' });
                }}
              >
                {t('dialog.cancel')}
              </button>
              <button
                type="button"
                className="button"
                disabled={waiting}
                onClick={() => {
                  respond({ action: 'decline' });
                }}
              >
                {t('mcp.elicit.decline')}
              </button>
              <button type="submit" className="button button-primary" disabled={waiting}>
                {elicitation.mode === 'url' ? t('link.open') : t('mcp.elicit.accept')}
              </button>
            </div>
            {error && <p role="alert">{error}</p>}
          </form>
        </Dialog>
      )}
    </section>
  );
}
