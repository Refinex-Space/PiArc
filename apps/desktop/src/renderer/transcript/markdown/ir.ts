// The intermediate structure the Markdown worker produces and React renders (architecture
// section 8.4): blocks and spans made of plain data, with every string meant to be shown as
// text. Nothing here is HTML: raw HTML in model output arrives as `html` nodes whose `text` is
// displayed literally, and links carry an `href` only when it passed `safeHref`.

export type Span =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'strong' | 'emphasis' | 'delete'; readonly children: readonly Span[] }
  | { readonly kind: 'code'; readonly text: string }
  | {
      readonly kind: 'link';
      /** An `https:`, `http:` or `mailto:` URL, or `null` when the target was not allowed. */
      readonly href: string | null;
      readonly title: string | null;
      readonly children: readonly Span[];
    }
  | {
      /** Images are never loaded: they render as a link to their source. */
      readonly kind: 'image';
      readonly href: string | null;
      readonly alt: string;
      readonly title: string | null;
    }
  | { readonly kind: 'break' }
  /** Inline raw HTML, displayed as text. */
  | { readonly kind: 'html'; readonly text: string };

export type Align = 'left' | 'center' | 'right' | null;

export interface ListItem {
  /** `true` / `false` for task list items, `null` for ordinary items. */
  readonly checked: boolean | null;
  readonly blocks: readonly Block[];
}

export type Block =
  | { readonly kind: 'paragraph'; readonly spans: readonly Span[] }
  | { readonly kind: 'heading'; readonly level: number; readonly spans: readonly Span[] }
  | {
      readonly kind: 'code';
      /** The first word of the fence's info string, or `null`. */
      readonly lang: string | null;
      readonly text: string;
      /** `false` while the closing fence has not arrived; such blocks are not highlighted. */
      readonly complete: boolean;
    }
  | {
      readonly kind: 'list';
      readonly ordered: boolean;
      readonly start: number;
      /** Loose lists separate their items with blank lines. */
      readonly loose: boolean;
      readonly items: readonly ListItem[];
    }
  | { readonly kind: 'blockquote'; readonly blocks: readonly Block[] }
  | {
      readonly kind: 'table';
      readonly align: readonly Align[];
      readonly header: readonly (readonly Span[])[];
      readonly rows: readonly (readonly (readonly Span[])[])[];
    }
  | { readonly kind: 'rule' }
  /** A raw HTML block, displayed as text. */
  | { readonly kind: 'html'; readonly text: string };
