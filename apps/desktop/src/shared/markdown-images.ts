// Image locations and link spelling follow Markdown Studio and Marklyra's editor preferences.
export const IMAGE_LIMIT = 8 * 1024 * 1024;
export const IMAGE_BATCH_LIMIT = 32 * 1024 * 1024;
export const IMAGE_COUNT_LIMIT = 16;
export const locations = [
  'assets',
  'document',
  'named',
  'relative',
  'selected',
  'reference',
] as const;
export type ImageLocation = (typeof locations)[number];
export type ImageLink = 'relativeDot' | 'relative' | 'absolute';
export interface ImageChoices {
  mode: ImageLocation;
  folder: string;
  link: ImageLink;
}
export interface ImageSettings extends ImageChoices {
  directory: string | null;
}
export type ImageSettingsRequest =
  { op: 'read' | 'choose' | 'forget' } | ({ op: 'set' } & ImageChoices);
export interface ImagePlacement {
  /** Raw source and range at the user gesture, including its original line endings. */
  text: string;
  from: number;
  to: number;
  eol: '\n' | '\r\n' | '\r';
}
export type ImageInput =
  | { op: 'pick'; placement: ImagePlacement }
  | { op: 'import'; files: { name: string; bytes: Uint8Array; source?: string }[] }
  | { op: 'preview'; reference: string }
  | { op: 'release'; url: string };
export function validImageFolder(template: string) {
  const parts = template.replace(/^\.\//u, '').replaceAll('${filename}', 'document');
  return (
    parts.length > 0 &&
    parts.length <= 240 &&
    parts
      .split('/')
      .every(
        (p) =>
          p.length > 0 &&
          p.trim() === p &&
          !p.endsWith('.') &&
          !p.includes('\\') &&
          !/[<>:"|?*$]/u.test(p) &&
          !Array.from(p).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) &&
          !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(p),
      )
  );
}
export function imageRef(alt: string, href: string): string {
  return (
    '![' +
    alt
      .replaceAll('\\', '\\\\')
      .replaceAll('[', '\\[')
      .replaceAll(']', '\\]')
      .replace(/[\r\n]/gu, ' ') +
    '](' +
    href +
    ')'
  );
}
