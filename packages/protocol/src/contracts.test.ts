// L1 contract tests (TypeScript side): every sample under tests/contracts/<contract>/ must
// validate against the exported JSON Schema and survive a parse → stringify round trip;
// every sample under invalid/ must fail validation.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schemaDir = path.join(packageRoot, 'schema');
const contractsRoot = path.join(packageRoot, '..', '..', 'tests', 'contracts');

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface ContractEntry {
  name: string;
  schema: string;
}

function loadContracts(): ContractEntry[] {
  const registry = readJson(path.join(schemaDir, 'contracts.json'));
  if (!isRecord(registry) || !Array.isArray(registry.contracts)) {
    throw new Error('contracts.json has no contracts array');
  }
  return registry.contracts.map((entry: unknown) => {
    if (!isRecord(entry) || typeof entry.name !== 'string' || typeof entry.schema !== 'string') {
      throw new Error(`malformed contract entry: ${JSON.stringify(entry)}`);
    }
    return { name: entry.name, schema: entry.schema };
  });
}

/** The `*.json` files directly inside `dir`, sorted; none when it does not exist. */
function sampleFiles(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

const integer = (min: number) => (n: number) => Number.isInteger(n) && n >= min;

const ajv = new Ajv2020({
  strict: true,
  allErrors: true,
  // Integer formats emitted by schemars; `minimum` carries the sign constraint too.
  formats: {
    int32: { type: 'number', validate: (n: number) => integer(-(2 ** 31))(n) && n < 2 ** 31 },
    int64: { type: 'number', validate: integer(Number.MIN_SAFE_INTEGER) },
    uint64: { type: 'number', validate: integer(0) },
    double: { type: 'number', validate: Number.isFinite },
  },
});
const rootSchema = readJson(path.join(schemaDir, 'ahp.schema.json'));
if (!isRecord(rootSchema)) {
  throw new Error('ahp.schema.json is not a JSON object');
}
ajv.addSchema(rootSchema, 'ahp');

function validatorFor(contract: ContractEntry) {
  const validate = ajv.getSchema(`ahp#/$defs/${contract.schema}`);
  if (validate === undefined) {
    throw new Error(`schema ${contract.schema} is not defined`);
  }
  return validate;
}

const contracts = loadContracts();
const relative = (file: string) => path.relative(contractsRoot, file).split(path.sep).join('/');

describe.each(contracts)('contract $name', (contract) => {
  const dir = path.join(contractsRoot, ...contract.name.split('/'));
  const valid = sampleFiles(dir);
  const invalid = sampleFiles(path.join(dir, 'invalid'));

  it('has valid and invalid samples', () => {
    expect(valid.length).toBeGreaterThan(0);
    expect(invalid.length).toBeGreaterThan(0);
  });

  it.each(valid.map(relative))('accepts %s and round-trips it', (file) => {
    const text = readFileSync(path.join(contractsRoot, file), 'utf8');
    const sample: unknown = JSON.parse(text);
    const validate = validatorFor(contract);
    expect(validate(sample), ajv.errorsText(validate.errors)).toBe(true);
    expect(JSON.parse(JSON.stringify(sample))).toStrictEqual(sample);
  });

  it.each(invalid.map(relative))('rejects %s', (file) => {
    const validate = validatorFor(contract);
    expect(validate(readJson(path.join(contractsRoot, file)))).toBe(false);
  });
});

describe('the root schema', () => {
  it('accepts every valid sample as some AHP message', () => {
    const validate = ajv.getSchema('ahp');
    if (validate === undefined) {
      throw new Error('root schema is not registered');
    }
    for (const contract of contracts) {
      for (const file of sampleFiles(path.join(contractsRoot, ...contract.name.split('/')))) {
        expect(validate(readJson(file)), relative(file)).toBe(true);
      }
    }
  });
});

describe('terminal frame golden samples (tests/contracts/term-frame/)', () => {
  const samples = readJson(path.join(contractsRoot, 'term-frame', 'samples.json'));
  const cases = isRecord(samples) && Array.isArray(samples.cases) ? samples.cases : [];

  it('has samples', () => {
    expect(cases.length).toBeGreaterThanOrEqual(4);
  });

  it('describes every frame by the TermFrame schema', () => {
    const validate = ajv.getSchema('ahp#/$defs/TermFrame');
    if (validate === undefined) {
      throw new Error('TermFrame is not defined');
    }
    for (const sample of cases) {
      const frame: unknown = isRecord(sample) ? sample.frame : undefined;
      expect(validate(frame), ajv.errorsText(validate.errors)).toBe(true);
    }
    // A palette that is not 256 colors, or a color that is not "#rrggbb", is not a frame.
    const first: unknown = isRecord(cases[0]) ? cases[0].frame : undefined;
    const broken = JSON.parse(JSON.stringify(first).replace('"#1e1e2e"', '"blue"')) as unknown;
    expect(validate(broken)).toBe(false);
  });
});
