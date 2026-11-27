// A screenshot the user took from the screenshot menu (B3.4): its thumbnail and size, then copy
// (the main process writes the PNG to the clipboard), save (the native save dialog) and add to
// the conversation.
import type { BrowserImage } from '../../shared/browser.js';
import type { MessageId } from '../../shared/i18n/index.js';
import { useApp } from '../app/app-context.js';
import { Button } from '../app/Button.js';
import { IconButton } from '../app/IconButton.js';
import { CloseIcon } from '../shell/icons.js';

export type ShotKind = 'visible' | 'full' | 'region' | 'element';

export const SHOT_LABELS: Readonly<Record<ShotKind, MessageId>> = {
  visible: 'browser.shot.visible',
  full: 'browser.shot.full',
  region: 'browser.shot.region',
  element: 'browser.shot.element',
};

export function ShotBar({
  image,
  kind,
  onCopy,
  onSave,
  onAdd,
  onClose,
}: {
  readonly image: BrowserImage;
  readonly kind: ShotKind;
  readonly onCopy: () => void;
  readonly onSave: () => void;
  readonly onAdd: () => void;
  readonly onClose: () => void;
}) {
  const { t, format } = useApp();
  return (
    <div
      id="browser-shot"
      className="browser-shot"
      data-testid="browser-shot"
      data-kind={kind}
      role="group"
      aria-label={t('browser.shot.title')}
    >
      <img
        className="browser-shot-thumb"
        src={image.data}
        alt=""
        width={image.width}
        height={image.height}
      />
      <span className="browser-shot-label">
        {t('browser.shot.size', {
          kind: t(SHOT_LABELS[kind]),
          size: `${format.number(image.width)} × ${format.number(image.height)}`,
        })}
      </span>
      <Button size="small" data-testid="browser-shot-copy" onClick={onCopy}>
        {t('browser.shot.copy')}
      </Button>
      <Button size="small" data-testid="browser-shot-save" onClick={onSave}>
        {t('browser.shot.save')}
      </Button>
      <Button variant="primary" size="small" data-testid="browser-shot-add" onClick={onAdd}>
        {t('browser.shot.add')}
      </Button>
      <IconButton
        size="xs"
        label={t('browser.shot.close')}
        data-testid="browser-shot-close"
        onClick={onClose}
      >
        <CloseIcon size={12} />
      </IconButton>
    </div>
  );
}
