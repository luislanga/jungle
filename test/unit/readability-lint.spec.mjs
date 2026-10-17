import { expect, test } from 'bun:test';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import readability, { READABILITY_RULES } from '../../tooling/eslint/readability.mjs';
import { formatCode } from '../../tooling/format.mjs';

const LINTER = new Linter();
const CONFIG = {
  languageOptions: { parser: tseslint.parser },
  plugins: { readability },
  rules: READABILITY_RULES,
};
const OPTIONS = {
  parser: 'typescript',
  singleQuote: true,
  objectWrap: 'preserve',
};

test('three items per line are allowed; four properties, arguments or parameters are rejected', () => {
  for (const code of [
    'send({ a: 1, b: 2, c: 3 });',
    'new Client(a, b, c);',
    'function f(a, b, c) {}',
    'send({\n a: 1, b: 2,\n c: 3\n});',
  ]) {
    expect(LINTER.verify(code, CONFIG)).toHaveLength(0);
  }
  for (const code of [
    'send({ a: 1, b: 2, c: 3, d: 4 });',
    'send(a, b, c, d);',
    'new Client(a, b, c, d);',
    'function f(a, b, c, d) {}',
    'const f = (a, b, c, d) => a;',
    'class Client { constructor(a, b, c, d) {} }',
    'send({ nested: { a: 1, b: 2, c: 3, d: 4 } });',
    'const { a, b, c, d } = input;',
  ]) {
    expect(
      LINTER.verify(code, CONFIG).some(
        (message) => message.ruleId === 'readability/max-items-per-line',
      ),
    ).toBe(true);
  }
});

test('class methods require a blank line while statements and arrow properties require semicolons', () => {
  const code = 'class Repo { find() {} save() {} }';
  expect(
    LINTER.verify(code, CONFIG).some((message) => message.ruleId === 'lines-between-class-members'),
  ).toBe(true);
  const fixed = LINTER.verifyAndFix(code, CONFIG);
  expect(fixed.messages).toHaveLength(0);
  expect(fixed.output).not.toContain('};');
  expect(
    LINTER.verify('const f = () => {}', CONFIG).some((message) => message.ruleId === 'semi'),
  ).toBe(true);
});

test('autofix preserves comments and tokens; repeated formatting is stable', async () => {
  for (const source of [
    'send({ a: 1, /* keep this */ b: 2, c: 3, d: 4 });',
    'send(a, /* keep this */ b, c, d);',
    'function f(a: string, b: string, c: string, d: string) { return [a, b, c]; }',
    'class Client { constructor(private a: string, private b: string, private c: string, d: string) {} }',
    'send({ nested: { a: 1, b: 2, c: 3, d: 4 } }, second, third);',
    'send(first, second, third, {\n  value: 1,\n});',
    'send(first, second, third, `line one\n  keep template spaces`);',
    'type Options = { a: string; b: string; c: string; d: string };',
  ]) {
    const fixed = LINTER.verifyAndFix(source, CONFIG);
    expect(fixed.fixed).toBe(true);
    expect(fixed.messages).toHaveLength(0);
    const tokens = (code) =>
      tseslint.parser.parseForESLint(code, { tokens: true }).ast.tokens.map((token) => token.value);
    expect(tokens(fixed.output)).toEqual(tokens(source));
    if (source.includes('keep this')) expect(fixed.output).toContain('/* keep this */');
    const formatted = await formatCode(source, OPTIONS);
    expect(LINTER.verify(formatted, CONFIG)).toHaveLength(0);
    expect(await formatCode(formatted, OPTIONS)).toBe(formatted);
  }
});

test('wrapping call arguments keeps nested object indentation readable', async () => {
  const result = await formatCode('send(first, second, third, {\n  value: 1,\n});', OPTIONS);
  expect(result).toContain('  {\n    value: 1,\n  }');
  expect(result).toContain('\n);');
});
