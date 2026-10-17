import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import * as prettier from 'prettier';
import readability, { READABILITY_RULES } from './eslint/readability.mjs';

const LINTER = new Linter();
const LAYOUT_CONFIG = {
  languageOptions: { parser: tseslint.parser },
  plugins: { readability },
  rules: READABILITY_RULES,
};

// Prettier has no option to limit arguments per line. Apply our whitespace rules
// after Prettier so `format`, `format:check` and lint agree on the final layout.
const MAX_FORMAT_PASSES = 4;
export async function formatCode(source, options) {
  const applyLayout = ['typescript', 'babel', 'babel-ts', 'espree', 'meriyah'].includes(
    options.parser,
  );
  let current = source;
  for (let pass = 0; pass < MAX_FORMAT_PASSES; pass++) {
    const formatted = await prettier.format(current, options);
    if (!applyLayout) return formatted;
    const result = LINTER.verifyAndFix(formatted, LAYOUT_CONFIG);
    if (result.messages.length)
      throw new Error(result.messages.map((message) => message.message).join('\n'));
    if (result.output === current) return result.output;
    // Expanding an object may let Prettier settle comment placement and trailing
    // commas on the next pass. Require a stable result before writing the file.
    current = result.output;
  }
  throw new Error('Prettier and readability rules did not reach a stable layout');
}

async function run() {
  const check = process.argv.includes('--check');
  // Git excludes dependencies, build output and local secrets from this inventory.
  // Prettier's ignore file additionally preserves the README and local Codex files.
  const files = [
    ...new Set(
      execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
        encoding: 'utf8',
      })
        .split('\0')
        .filter(Boolean),
    ),
  ];
  let changed = 0;
  for (const file of files) {
    const info = await prettier.getFileInfo(file, { ignorePath: '.prettierignore' });
    if (info.ignored || !info.inferredParser) continue;
    const source = await readFile(file, 'utf8');
    const options = await prettier.resolveConfig(file);
    const formatted = await formatCode(source, {
      ...options,
      filepath: file,
      parser: info.inferredParser,
    });
    if (formatted === source) continue;
    changed++;
    if (check) process.stderr.write(`Formatting differs: ${file}\n`);
    else await writeFile(file, formatted);
  }
  if (check && changed) process.exitCode = 1;
  process.stdout.write(
    check ? `Formatting check: ${changed} files need changes.\n` : `Formatted ${changed} files.\n`,
  );
}

if (import.meta.main) await run();
