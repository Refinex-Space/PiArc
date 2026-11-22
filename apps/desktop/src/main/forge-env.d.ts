// Constants defined by @electron-forge/plugin-vite when it bundles the main process.
// `MAIN_WINDOW_VITE_DEV_SERVER_URL` is the dev-server URL under `electron-forge start` and
// `undefined` in packaged builds.
declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

// Vite replaces `import.meta.env.DEV` at build time: true under `electron-forge start`,
// false when packaging.
interface ImportMetaEnv {
  readonly DEV: boolean;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Vite replaces it at build time (vite.main.config.ts): true in the release flavor only.
declare const __PIARC_RELEASE_BUILD__: boolean;
