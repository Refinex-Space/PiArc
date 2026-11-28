// Render the parsed chord, so named keys and punctuation stay intact on both platforms.
import { Fragment } from 'react';

import { displayKeyParts, type KeyPlatform } from '../../shared/keybindings.js';

export function Keycaps({
  binding,
  platform,
}: {
  readonly binding: string;
  readonly platform: KeyPlatform;
}) {
  const parts = displayKeyParts(binding, platform);
  return (
    <span className="keycaps">
      <span className="visually-hidden">
        {binding.replace(/\bMod\b/gu, platform === 'mac' ? 'Command' : 'Ctrl')}
      </span>
      <span className="keycaps-visual" aria-hidden="true">
        {parts.map((part, index) => (
          <Fragment key={String(index)}>
            {index > 0 && platform !== 'mac' && <span className="keycap-joiner">+</span>}
            <kbd>{part}</kbd>
          </Fragment>
        ))}
      </span>
    </span>
  );
}
