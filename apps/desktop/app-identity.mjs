// The application identifier (requirements D2) on the JavaScript side: the macOS bundle id
// (forge.config.ts) and the Windows AppUserModelID (main process). The single definition is
// `piarc_core::identity::APP_IDENTIFIER` in Rust; app-identity.test.mjs fails when the two
// differ. Changing it after the first release orphans every installed copy's keychain entry
// and notification settings.

export const APP_IDENTIFIER = 'cn.piarc.desktop';
