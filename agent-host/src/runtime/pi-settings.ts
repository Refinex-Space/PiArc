// Pi's own package lists stay out of the Agent Host (THR-03, T45, ADR-0058 rule 4).
//
// Pi 1.5.2's resource loader calls its package manager on every reload, and the package manager
// installs each source of the `packages` lists in Pi's settings it cannot find: npm without
// `--ignore-scripts`, a git clone followed by `npm install` (`npmCommand` from the same
// settings), only skipped when `PI_OFFLINE` is set, which would also stop the model catalog
// refresh. A trusted project's `.pi/settings.json` or the user-level `pi/settings.json` could
// so run install scripts inside the Agent Host. Extension packages reach Pi only through
// PiArc's own packages (Core installs them with the bundled npm and `--ignore-scripts`, the
// Agent Host loads their confirmed entry files), so the package manager sees no lists at all.
import type { SettingsManager } from '@earendil-works/pi-coding-agent';

type Settings = ReturnType<SettingsManager['getGlobalSettings']>;

function stripPackages(settings: Settings): Settings {
  const rest = { ...settings };
  delete rest.packages;
  return rest;
}

/**
 * `settings` with the `packages` of both scopes hidden from the two readers Pi's package manager
 * uses (`getGlobalSettings`, `getProjectSettings`); every other setting reads as before.
 */
export function withoutPiPackages(settings: SettingsManager): SettingsManager {
  const global = settings.getGlobalSettings.bind(settings);
  const project = settings.getProjectSettings.bind(settings);
  settings.getGlobalSettings = () => stripPackages(global());
  settings.getProjectSettings = () => stripPackages(project());
  return settings;
}
