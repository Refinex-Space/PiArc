import { useEffect, useRef, useState } from 'react';

import { MAX_PROMPT_LENGTH } from '../../shared/ipc.js';
import { useT } from '../app/app-context.js';
import { CopyButton } from '../transcript/rows/common.js';
import { usageChanged } from '../usage/usage.js';
import { reason } from './errors.js';
import { registerPanel } from './registry.js';

interface Exchange {
  question: string;
  answer?: string;
  stopped?: boolean;
  error?: string;
}

function SideChat({ sessionId, close }: { sessionId: string; close: () => void }) {
  const t = useT();
  const [panelId] = useState(() => crypto.randomUUID());
  const [draft, setDraft] = useState('');
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  const waiting = useRef(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    input.current?.focus();
    return () => {
      active.current = false;
      window.piarc.controlSideChat(sessionId, panelId, true).catch((failure: unknown) => {
        console.error('[side chat] cannot close the conversation', failure);
      });
    };
  }, [sessionId, panelId]);
  async function ask(): Promise<void> {
    if (!draft.trim() || waiting.current) return;
    const question = draft;
    waiting.current = true;
    setExchanges((past) => [...past, { question }]);
    setBusy(true);
    setDraft('');
    setError('');
    let result: Exchange;
    try {
      const reply: unknown = JSON.parse(
        await window.piarc.askSideChat(sessionId, panelId, question),
      );
      if (
        !reply ||
        typeof reply !== 'object' ||
        !('text' in reply) ||
        typeof reply.text !== 'string' ||
        !('stopped' in reply) ||
        typeof reply.stopped !== 'boolean'
      )
        throw new Error('Invalid side chat reply');
      result = { question, answer: reply.text, stopped: reply.stopped };
    } catch (failure) {
      result = { question, error: reason(failure) };
    } finally {
      waiting.current = false;
      usageChanged.dispatchEvent(new Event(sessionId));
    }
    if (active.current) {
      setExchanges((past) => [...past.slice(0, -1), result]);
      setBusy(false);
    }
  }
  return (
    <section className="side-chat" data-testid="side-chat" aria-label={t('sideChat.title')}>
      <div className="side-chat-history" aria-live="polite" aria-relevant="additions text">
        {exchanges.map((exchange, index) => (
          <div className="side-chat-exchange" key={index}>
            <strong>{exchange.question}</strong>
            {exchange.answer && <p data-testid="side-chat-answer">{exchange.answer}</p>}
            {exchange.stopped && <span>{t('sideChat.stopped')}</span>}
            {exchange.error && (
              <p className="error-text" role="alert">
                {exchange.error}
              </p>
            )}
            {exchange.answer && (
              <CopyButton label={t('transcript.copyText')} text={() => exchange.answer ?? ''} />
            )}
          </div>
        ))}
        {busy && <span>{t('sideChat.busy')}</span>}
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void ask();
        }}
      >
        <textarea
          ref={input}
          aria-label={t('sideChat.question')}
          placeholder={t('sideChat.question')}
          data-testid="side-chat-question"
          maxLength={MAX_PROMPT_LENGTH}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
        />
        <div className="side-chat-actions">
          <button type="submit" disabled={busy || !draft.trim()}>
            {t('composer.send')}
          </button>
          {busy && (
            <button
              type="button"
              onClick={() => {
                window.piarc
                  .controlSideChat(sessionId, panelId, false)
                  .catch((failure: unknown) => {
                    setError(reason(failure));
                  });
              }}
            >
              {t('composer.stop')}
            </button>
          )}
          <button type="button" onClick={close}>
            {t('sideChat.close')}
          </button>
        </div>
      </form>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

registerPanel({
  id: 'side-chat',
  area: 'dock',
  order: 20,
  title: 'sideChat.title',
  keepMounted: true,
  when: ({ sideChat }) => sideChat !== undefined,
  render: ({ sessionId, sideChat }) =>
    sessionId && sideChat ? (
      <SideChat key={sessionId} sessionId={sessionId} close={sideChat.close} />
    ) : null,
});
