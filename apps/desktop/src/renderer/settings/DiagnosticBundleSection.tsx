// The diagnostic bundle (T45, architecture section 10.5) at the end of the diagnostics page:
// Core prepares the bundle in memory and the section lists its files, what was replaced and
// what is never included; only "Export…" writes it, where the user chooses in the main process's
// save dialog. Nothing is sent anywhere.
import { useState } from 'react';

import type { MessageId } from '../../shared/i18n/index.js';
import { useApp } from '../app/app-context.js';
import { reason } from '../shell/errors.js';
import { Button } from '../app/Button.js';
import { SettingsInfo, SettingsSection } from './layout.js';

/** The redaction kinds Core reports (`piarc_telemetry::redact::Kind::label`), in display order. */
const REDACTION_KINDS = {
  secret: 'diagnostics.bundle.redaction.secret',
  'api-key': 'diagnostics.bundle.redaction.apiKey',
  'access-key': 'diagnostics.bundle.redaction.accessKey',
  token: 'diagnostics.bundle.redaction.token',
  jwt: 'diagnostics.bundle.redaction.jwt',
  home: 'diagnostics.bundle.redaction.home',
} as const satisfies Record<string, MessageId>;

export interface BundleManifest {
  readonly id: string;
  readonly files: readonly { readonly name: string; readonly bytes: number }[];
  readonly redactions: Readonly<Partial<Record<keyof typeof REDACTION_KINDS, number>>>;
  readonly excluded: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Core's manifest, checked; undefined when it has another shape. */
export function parseManifest(text: string): BundleManifest | undefined {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || typeof value.id !== 'string') return undefined;
  const files = Array.isArray(value.files) ? value.files : [];
  const redactions: Partial<Record<keyof typeof REDACTION_KINDS, number>> = {};
  if (isRecord(value.redactions)) {
    for (const kind of Object.keys(REDACTION_KINDS) as (keyof typeof REDACTION_KINDS)[]) {
      const count = value.redactions[kind];
      if (typeof count === 'number' && count > 0) redactions[kind] = count;
    }
  }
  return {
    id: value.id,
    files: files.flatMap((f) =>
      isRecord(f) && typeof f.name === 'string' && typeof f.bytes === 'number'
        ? [{ name: f.name, bytes: f.bytes }]
        : [],
    ),
    redactions,
    excluded: Array.isArray(value.excluded)
      ? value.excluded.filter((e): e is string => typeof e === 'string')
      : [],
  };
}

type State =
  | { readonly kind: 'idle' }
  | { readonly kind: 'busy' }
  | { readonly kind: 'preview'; readonly manifest: BundleManifest }
  | { readonly kind: 'exported'; readonly path: string; readonly bytes: number }
  | { readonly kind: 'error'; readonly message: string };

export function DiagnosticBundleSection({ workspace }: { readonly workspace: string | null }) {
  const { t, format } = useApp();
  const [state, setState] = useState<State>({ kind: 'idle' });
  const size = (bytes: number) =>
    format.number(bytes / 1024, { style: 'unit', unit: 'kilobyte', maximumFractionDigits: 1 });

  const prepare = () => {
    setState({ kind: 'busy' });
    window.piarc
      .prepareDiagnostics(workspace)
      .then((text) => {
        const manifest = parseManifest(text);
        setState(
          manifest === undefined
            ? { kind: 'error', message: t('diagnostics.bundle.failed') }
            : { kind: 'preview', manifest },
        );
      })
      .catch((e: unknown) => {
        setState({ kind: 'error', message: reason(e) });
      });
  };

  const exportBundle = (manifest: BundleManifest) => {
    window.piarc
      .exportDiagnostics(manifest.id)
      .then((text) => {
        if (text === null) return;
        const result: unknown = JSON.parse(text);
        if (
          isRecord(result) &&
          typeof result.path === 'string' &&
          typeof result.bytes === 'number'
        ) {
          setState({ kind: 'exported', path: result.path, bytes: result.bytes });
        }
      })
      .catch((e: unknown) => {
        setState({ kind: 'error', message: reason(e) });
      });
  };

  const redactions =
    state.kind === 'preview'
      ? (Object.keys(REDACTION_KINDS) as (keyof typeof REDACTION_KINDS)[]).flatMap((kind) => {
          const count = state.manifest.redactions[kind];
          return count === undefined ? [] : [t(REDACTION_KINDS[kind], { count })];
        })
      : [];

  return (
    <SettingsSection
      title={t('diagnostics.bundle.title')}
      testId="diagnostic-bundle"
      aside={
        <>
          <SettingsInfo text={t('diagnostics.bundle.intro')} />
          {state.kind !== 'preview' && (
            <Button
              size="small"
              loading={state.kind === 'busy'}
              aria-label={state.kind === 'busy' ? t('diagnostics.bundle.preparing') : undefined}
              onClick={prepare}
              data-testid="diagnostic-bundle-prepare"
            >
              {t('diagnostics.bundle.prepare')}
            </Button>
          )}
        </>
      }
    >
      {state.kind === 'preview' && (
        <div className="diagnostic-bundle-preview" data-testid="diagnostic-bundle-preview">
          <h3 className="permission-source-title">{t('diagnostics.bundle.files')}</h3>
          <ul className="diagnostic-bundle-files" data-testid="diagnostic-bundle-files">
            {state.manifest.files.map((file) => (
              <li key={file.name}>
                <code>{file.name}</code> <span className="muted">{size(file.bytes)}</span>
              </li>
            ))}
          </ul>
          <h3 className="permission-source-title">{t('diagnostics.bundle.redactions')}</h3>
          <ul data-testid="diagnostic-bundle-redactions">
            {redactions.length === 0 ? (
              <li>{t('diagnostics.bundle.noRedactions')}</li>
            ) : (
              redactions.map((line) => <li key={line}>{line}</li>)
            )}
          </ul>
          <p className="muted" data-testid="diagnostic-bundle-excluded">
            {t('diagnostics.bundle.excluded', { list: state.manifest.excluded.join(', ') })}
          </p>
          <div className="diagnostic-bundle-actions">
            <Button
              variant="primary"
              onClick={() => {
                exportBundle(state.manifest);
              }}
              data-testid="diagnostic-bundle-export"
            >
              {t('diagnostics.bundle.export')}
            </Button>
            <Button
              variant="ghost"
              size="small"
              onClick={() => {
                setState({ kind: 'idle' });
              }}
              data-testid="diagnostic-bundle-cancel"
            >
              {t('diagnostics.bundle.cancel')}
            </Button>
          </div>
        </div>
      )}
      {state.kind === 'exported' && (
        <p role="status" data-testid="diagnostic-bundle-exported">
          {t('diagnostics.bundle.exported', { path: state.path, size: size(state.bytes) })}
        </p>
      )}
      {state.kind === 'error' && (
        <p className="error-text" role="alert">
          {state.message}
        </p>
      )}
    </SettingsSection>
  );
}
