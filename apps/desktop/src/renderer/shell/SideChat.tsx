import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { MAX_PROMPT_LENGTH, MAX_SIDE_CHATS } from '../../shared/ipc.js';
import { IconButton } from '../app/IconButton.js';
import { isImeComposing } from '../composer/ime-guard.js';
import { SCROLL_FOLLOW } from '../transcript/constants.js';
import { CloseIcon, PlusIcon, SendIcon, StopIcon } from './icons.js';
import { useT } from '../app/app-context.js';
import { CopyButton } from '../transcript/rows/common.js';
import { usageChanged } from '../usage/usage.js';
import { reason } from './errors.js';
import { ToolHeaderContent } from './ToolHeaderSlot.js';
import { PanelEmpty } from './PanelEmpty.js';
import { registerPanel } from './registry.js';

interface Exchange {
  question: string;
  answer?: string;
  stopped?: boolean;
  error?: string;
}

function SideChat({
  sessionId,
  panelId,
  selected,
  close,
}: {
  sessionId: string;
  panelId: string;
  selected: boolean;
  close: () => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState('');
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  const history = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useLayoutEffect(() => {
    const list = history.current;
    if (list && follow.current) list.scrollTop = list.scrollHeight;
  }, [exchanges, busy]);
  const waiting = useRef(false);
  const active = useRef(true);
  useEffect(() => {
    const field = input.current;
    if (selected && field && !field.ownerDocument.activeElement?.closest('[role="tablist"]'))
      field.focus({ preventScroll: true });
  }, [selected]);
  useEffect(() => {
    active.current = true;
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
    follow.current = true;
    input.current?.focus({ preventScroll: true });
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
  const stop = () => {
    window.piarc.controlSideChat(sessionId, panelId, false).catch((failure: unknown) => {
      if (active.current) setError(reason(failure));
    });
  };
  return (
    <section
      className="side-chat"
      hidden={!selected}
      id={'side-content-' + panelId}
      role="tabpanel"
      aria-labelledby={'side-tab-' + panelId}
      data-testid="side-chat"
      aria-label={t('sideChat.title')}
      onKeyDown={(event) => {
        if (event.defaultPrevented || isImeComposing(event.nativeEvent) || event.key !== 'Escape')
          return;
        event.preventDefault();
        event.stopPropagation();
        if (busy) stop();
        else close();
      }}
    >
      <div
        className="side-chat-history"
        ref={history}
        aria-live="polite"
        aria-relevant="additions text"
        onScroll={(event) => {
          const list = event.currentTarget;
          follow.current =
            list.scrollHeight - list.clientHeight - list.scrollTop <= SCROLL_FOLLOW.resumePx;
        }}
      >
        {exchanges.length === 0 && (
          <PanelEmpty title={t('sideChat.empty')} description={t('sideChat.scope')} />
        )}
        {exchanges.map((exchange, index) => (
          <div className="side-chat-exchange" key={index}>
            <p className="side-chat-prompt">{exchange.question}</p>
            {exchange.answer && (
              <div className="side-chat-reply">
                <p data-testid="side-chat-answer">{exchange.answer}</p>
                <CopyButton label={t('transcript.copyText')} text={() => exchange.answer ?? ''} />
              </div>
            )}
            {exchange.stopped && <small className="muted">{t('sideChat.stopped')}</small>}
            {exchange.error && (
              <p className="error-text" role="alert">
                {exchange.error}
              </p>
            )}
          </div>
        ))}
        {busy && <span className="side-chat-busy">{t('sideChat.busy')}</span>}
      </div>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <form
        className="side-chat-form"
        onSubmit={(event) => {
          event.preventDefault();
          void ask();
        }}
      >
        <div className="side-chat-composer">
          <textarea
            ref={input}
            rows={1}
            aria-label={t(exchanges.length ? 'sideChat.followUp' : 'sideChat.question')}
            placeholder={t(exchanges.length ? 'sideChat.followUp' : 'sideChat.question')}
            data-testid="side-chat-question"
            maxLength={MAX_PROMPT_LENGTH}
            value={draft}
            onChange={(event) => {
              setDraft(event.currentTarget.value);
            }}
            onKeyDown={(event) => {
              if (
                isImeComposing(event.nativeEvent) ||
                event.key !== 'Enter' ||
                event.shiftKey ||
                event.ctrlKey ||
                event.altKey ||
                event.metaKey
              )
                return;
              event.preventDefault();
              event.stopPropagation();
              void ask();
            }}
          />
          {busy ? (
            <IconButton label={t('composer.stop')} onClick={stop}>
              <StopIcon />
            </IconButton>
          ) : (
            <IconButton type="submit" label={t('composer.send')} disabled={!draft.trim()}>
              <SendIcon />
            </IconButton>
          )}
        </div>
      </form>
    </section>
  );
}

function SideChats({ sessionId, close }: { sessionId: string; close: () => void }) {
  const t = useT();
  const [first] = useState(() => ({ id: crypto.randomUUID(), number: 1 }));
  const [tabs, setTabs] = useState([first]);
  const [selected, select] = useState(first.id);
  const counter = useRef(1);
  const newTab = () => {
    if (tabs.length >= MAX_SIDE_CHATS) return;
    const tab = { id: crypto.randomUUID(), number: ++counter.current };
    setTabs([...tabs, tab]);
    select(tab.id);
  };
  const closeTab = (id: string) => {
    const next = tabs.filter((tab) => tab.id !== id);
    if (!next.length) {
      close();
      return;
    }
    setTabs(next);
    const neighbor = next[Math.max(0, tabs.findIndex((tab) => tab.id === id) - 1)];
    if (selected === id && neighbor) select(neighbor.id);
  };
  return (
    <>
      <ToolHeaderContent>
        <div className="side-chat-tabs" role="tablist" aria-label={t('sideChat.title')}>
          {tabs.map((tab, i) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={'side-tab-' + tab.id}
              aria-controls={'side-content-' + tab.id}
              aria-selected={selected === tab.id}
              tabIndex={selected === tab.id ? 0 : -1}
              data-testid="side-chat-tab"
              onClick={() => {
                select(tab.id);
              }}
              onKeyDown={(event) => {
                if (isImeComposing(event.nativeEvent)) return;
                if (event.key === 'Delete' || event.key === 'Backspace') {
                  event.preventDefault();
                  closeTab(tab.id);
                  return;
                }
                const direction =
                  event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
                if (direction) {
                  event.preventDefault();
                  const neighbor = tabs[(i + direction + tabs.length) % tabs.length];
                  if (neighbor) {
                    select(neighbor.id);
                    event.currentTarget.ownerDocument
                      .getElementById('side-tab-' + neighbor.id)
                      ?.focus();
                  }
                }
              }}
            >
              {tabs.length === 1 ? t('sideChat.title') : t('sideChat.tab', { number: tab.number })}
            </button>
          ))}
        </div>
        {tabs.length > 1 && (
          <IconButton
            label={t('sideChat.close')}
            data-testid="side-chat-close-tab"
            onClick={() => {
              closeTab(selected);
            }}
          >
            <CloseIcon />
          </IconButton>
        )}
        <IconButton
          label={t('sideChat.new')}
          data-testid="side-chat-new"
          disabled={tabs.length >= MAX_SIDE_CHATS}
          onClick={newTab}
        >
          <PlusIcon />
        </IconButton>
      </ToolHeaderContent>
      {tabs.map((tab) => (
        <SideChat
          key={tab.id}
          sessionId={sessionId}
          panelId={tab.id}
          selected={tab.id === selected}
          close={() => {
            closeTab(tab.id);
          }}
        />
      ))}
    </>
  );
}

registerPanel({
  id: 'side-chat',
  area: 'tool',
  order: 20,
  title: 'sideChat.title',
  when: ({ sessionId }) => sessionId !== undefined,
  render: ({ sessionId, sideChat }) =>
    sessionId && sideChat ? (
      <SideChats key={sessionId} sessionId={sessionId} close={sideChat.close} />
    ) : null,
});
