// verify step "i18n" (T43, architecture section 8.7): the English and Chinese catalogs
// (`apps/desktop/src/shared/i18n/`) have the same keys; every message is valid ICU MessageFormat
// with the same placeholders in both languages and only plural categories the language has
// (Chinese has only "other": `one {…}` never matches, use `=1 {…}`); every `t('…')` in the code
// names a message; and the renderer and the main process show no hard-coded text (JSX text,
// text attributes, native dialog, menu and notification fields). A line that must show fixed
// text says why with an `i18n-exempt: <reason>` comment on it or the line before.
// The catalogs are read with the TypeScript compiler API (no TypeScript is run); ICU messages are
// parsed with the app's own intl-messageformat.
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import ts from 'typescript';

import { isMain, isRecord, repoRoot } from '../lib/repo.mjs';

const DESKTOP = path.join(repoRoot, 'apps', 'desktop');
const I18N = path.join(DESKTOP, 'src', 'shared', 'i18n');
const CATALOGS = { en: 'en.ts', 'zh-CN': 'zh-CN.ts' };

/** Attributes whose text is shown or read to the user. */
const TEXT_ATTRIBUTES = new Set([
  'aria-label',
  'aria-description',
  'title',
  'placeholder',
  'alt',
  'label',
]);
/** Fields of the main process's dialogs, menus and notifications that are shown. */
const MAIN_FIELDS = new Set([
  'label',
  'message',
  'detail',
  'title',
  'body',
  'buttons',
  'checkboxLabel',
  'sublabel',
  'toolTip',
  'subtitle',
]);
const LETTER = /\p{L}/u;
const EXEMPT = 'i18n-exempt:';

/**
 * The string value of a literal expression (`'a'`, `` `a` ``, `'a' + 'b'`), or undefined.
 * @param {ts.Node} node
 * @returns {string | undefined}
 */
function literal(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return literal(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = literal(node.left);
    const right = literal(node.right);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  return undefined;
}

/**
 * The messages of a catalog file: the properties of its exported object literal.
 * @param {string} file
 * @returns {Promise<Map<string, string>>}
 */
export async function readCatalog(file) {
  const text = await readFile(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  /** @type {Map<string, string>} */
  const messages = new Map();
  /** @param {ts.Node} node */
  const visit = (node) => {
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const key = ts.isStringLiteral(property.name) ? property.name.text : undefined;
        const value = literal(property.initializer);
        if (key !== undefined && value !== undefined) messages.set(key, value);
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return messages;
}

/**
 * The placeholders of a parsed message and the plural categories it uses.
 * @param {unknown[]} elements intl-messageformat's AST
 * @param {Set<string>} names
 * @param {Set<string>} categories
 */
function collect(elements, names, categories) {
  for (const element of elements) {
    if (!isRecord(element)) continue;
    const { type, value, options, children } = element;
    // 1 argument, 2 number, 3 date, 4 time, 5 select, 6 plural, 8 tag.
    if (
      typeof value === 'string' &&
      typeof type === 'number' &&
      [1, 2, 3, 4, 5, 6, 8].includes(type)
    ) {
      names.add(value);
    }
    if (isRecord(options)) {
      for (const [category, option] of Object.entries(options)) {
        if (type === 6) categories.add(category);
        const inner = isRecord(option) ? option.value : undefined;
        if (Array.isArray(inner)) collect(inner, names, categories);
      }
    }
    if (Array.isArray(children)) collect(children, names, categories);
  }
}

/**
 * The app's ICU parser: `new Format(message, locale).getAst()`.
 * @returns {Promise<new (message: string, locale: string) => { getAst(): unknown[] }>}
 */
async function messageFormat() {
  const require = createRequire(path.join(DESKTOP, 'package.json'));
  /** @type {unknown} */
  const loaded = await import(pathToFileURL(require.resolve('intl-messageformat')).href);
  if (!isRecord(loaded) || typeof loaded.IntlMessageFormat !== 'function') {
    throw new Error('intl-messageformat does not export IntlMessageFormat');
  }
  return /** @type {new (message: string, locale: string) => { getAst(): unknown[] }} */ (
    loaded.IntlMessageFormat
  );
}

/**
 * Problems of the two catalogs: keys, ICU syntax, placeholders and plural categories.
 * @param {Record<string, Map<string, string>>} catalogs
 * @param {new (message: string, locale: string) => { getAst(): unknown[] }} Format
 * @returns {string[]}
 */
export function catalogProblems(catalogs, Format) {
  /** @type {string[]} */
  const problems = [];
  /** @type {Map<string, string>} */
  const en = catalogs.en ?? new Map();
  for (const [locale, messages] of Object.entries(catalogs)) {
    for (const key of en.keys()) if (!messages.has(key)) problems.push(`${locale}: missing ${key}`);
    for (const key of messages.keys())
      if (!en.has(key)) problems.push(`${locale}: ${key} is not in en`);
  }
  /** @type {Map<string, string>} */
  const placeholders = new Map();
  for (const [locale, messages] of Object.entries(catalogs)) {
    const allowed = new Set(new Intl.PluralRules(locale).resolvedOptions().pluralCategories);
    for (const [key, message] of messages) {
      /** @type {unknown[]} */
      let ast;
      try {
        ast = new Format(message, locale).getAst();
      } catch (error) {
        problems.push(
          `${locale}: ${key} is not valid ICU: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      /** @type {Set<string>} */
      const names = new Set();
      /** @type {Set<string>} */
      const categories = new Set();
      collect(ast, names, categories);
      for (const category of categories) {
        if (
          !category.startsWith('=') &&
          !allowed.has(/** @type {Intl.LDMLPluralRule} */ (category))
        ) {
          problems.push(
            `${locale}: ${key} uses the plural category "${category}", which ${locale} does not have`,
          );
        }
      }
      const signature = [...names].sort().join(',');
      const other = placeholders.get(key);
      if (other === undefined) placeholders.set(key, signature);
      else if (other !== signature) {
        problems.push(
          `${key}: placeholders differ between languages ({${other}} and {${signature}})`,
        );
      }
    }
  }
  return problems;
}

/**
 * Source files under `dir` (TypeScript, not tests).
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function sources(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && /\.(ts|tsx)$/u.test(e.name) && !/\.test\.tsx?$/u.test(e.name))
    .map((e) => path.join(e.parentPath, e.name));
}

/**
 * Whether the line of `node`, or the line before, carries an `i18n-exempt:` comment.
 * @param {ts.SourceFile} source
 * @param {ts.Node} node
 */
function exempt(source, node) {
  const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
  const lines = source.text.split('\n');
  return [lines[line], lines[line - 1]].some((l) => l?.includes(EXEMPT) === true);
}

/**
 * Hard-coded user-visible text and `t('…')` calls naming no message in one file.
 * @param {string} file
 * @param {string} text
 * @param {Set<string>} keys
 * @param {'renderer' | 'main'} side
 * @returns {string[]}
 */
export function sourceProblems(file, text, keys, side) {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const label = path.relative(repoRoot, file).split(path.sep).join('/');
  /** @type {string[]} */
  const problems = [];
  /** @param {ts.Node} node @param {string} what */
  const report = (node, what) => {
    if (exempt(source, node)) return;
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    problems.push(`${label}:${String(line + 1)}: ${what}`);
  };
  /** @param {ts.Node} node */
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : '';
      const first = node.arguments[0];
      const key = first === undefined ? undefined : literal(first);
      if (name === 't' && key !== undefined && !keys.has(key))
        report(node, `t('${key}') names no message`);
    }
    if (side === 'renderer') {
      if (ts.isJsxText(node) && LETTER.test(node.text.trim())) {
        report(node, `hard-coded text "${node.text.trim().slice(0, 40)}"`);
      }
      if (
        ts.isJsxExpression(node) &&
        node.expression !== undefined &&
        ts.isJsxElement(node.parent)
      ) {
        const value = literal(node.expression);
        if (value !== undefined && LETTER.test(value))
          report(node, `hard-coded text "${value.slice(0, 40)}"`);
      }
      if (
        ts.isJsxAttribute(node) &&
        TEXT_ATTRIBUTES.has(node.name.getText(source)) &&
        node.initializer !== undefined
      ) {
        const init = node.initializer;
        const value = ts.isStringLiteral(init)
          ? init.text
          : ts.isJsxExpression(init) && init.expression !== undefined
            ? literal(init.expression)
            : undefined;
        // A message id is translated by the component that receives it.
        if (value !== undefined && LETTER.test(value) && !keys.has(value)) {
          report(node, `hard-coded ${node.name.getText(source)} "${value.slice(0, 40)}"`);
        }
      }
    } else if (
      ts.isPropertyAssignment(node) &&
      MAIN_FIELDS.has(node.name.getText(source).replace(/['"]/gu, ''))
    ) {
      const values = ts.isArrayLiteralExpression(node.initializer)
        ? node.initializer.elements.map((e) => literal(e))
        : [literal(node.initializer)];
      for (const value of values) {
        if (value !== undefined && LETTER.test(value)) {
          report(node, `hard-coded ${node.name.getText(source)} "${value.slice(0, 40)}"`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return problems;
}

/**
 * Whether `file` shows anything to users (not test pages, test hooks, vendored code or the
 * shared catalogs themselves).
 * @param {string} file
 */
function shown(file) {
  const relative = path.relative(DESKTOP, file).split(path.sep).join('/');
  return !(
    relative.startsWith('src/renderer/lab/') ||
    relative.startsWith('src/renderer/probe/') ||
    relative.startsWith('src/renderer/terminal/vendor/') ||
    relative.startsWith('src/main/core/test-hooks') ||
    relative.includes('/test-hooks') ||
    relative.includes('-lab') ||
    relative.includes('Lab.tsx') ||
    relative.startsWith('src/shared/')
  );
}

/** @returns {Promise<string[]>} */
export async function i18nProblems() {
  /** @type {Record<string, Map<string, string>>} */
  const catalogs = {};
  for (const [locale, file] of Object.entries(CATALOGS)) {
    catalogs[locale] = await readCatalog(path.join(I18N, file));
  }
  const problems = catalogProblems(catalogs, await messageFormat());
  const keys = new Set(catalogs.en?.keys() ?? []);
  for (const side of /** @type {const} */ (['renderer', 'main'])) {
    for (const file of await sources(path.join(DESKTOP, 'src', side))) {
      if (!shown(file)) continue;
      problems.push(...sourceProblems(file, await readFile(file, 'utf8'), keys, side));
    }
  }
  return problems;
}

async function main() {
  const problems = await i18nProblems();
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) {
    console.error(`${String(problems.length)} i18n problem(s).`);
    process.exitCode = 1;
  } else {
    console.log(
      'i18n checks passed: both catalogs, ICU and placeholders, references, no hard-coded text',
    );
  }
}

if (isMain(import.meta.url)) await main();
