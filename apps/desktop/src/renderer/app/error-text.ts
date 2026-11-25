// The text of a failed call in the window's language (I236). A Core error arrives with its kind
// (`shared/ipc-error.ts`), which picks the message from the catalog; Core's own (English) text
// is kept only where it names what failed (a path, a setting) as the message's `{detail}`. Any
// other error (the main process's argument checks, the page's own) keeps its text.
import { isMessageId, Translator, type Locale } from '../../shared/i18n/index.js';
import { decodeIpcError } from '../../shared/ipc-error.js';

let translator = new Translator('en');

/** Follows the window's language: the app context calls it when the language changes. */
export function setErrorLocale(locale: Locale): void {
  if (translator.locale !== locale) translator = new Translator(locale);
}

/** What the text of a failed call (without Electron's prefix) tells the user. */
export function describeError(text: string): string {
  const core = decodeIpcError(text);
  if (core === undefined) return text;
  const id = `error.kind.${core.kind}`;
  return isMessageId(id) ? translator.t(id, { detail: core.message }) : core.message;
}

/** The Core error kind of a failed call's text, if it was a Core error. */
export function errorKindOf(text: string): string | undefined {
  return decodeIpcError(text)?.kind;
}
