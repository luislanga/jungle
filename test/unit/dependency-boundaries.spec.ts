import { expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';

async function typescriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? typescriptFiles(path) : [path];
    }),
  );
  return files.flat().filter((file) => file.endsWith('.ts'));
}

test('application and HTTP boundaries do not import database or queue implementations', async () => {
  const modules = await typescriptFiles('src/modules');
  const interfaces = await typescriptFiles('src/shared/interfaces');
  const files = [
    ...modules.filter(
      (file) =>
        file.includes('/application/') ||
        file.includes('/presentation/') ||
        file.endsWith('.controller.ts'),
    ),
    ...interfaces,
  ];
  const violations: string[] = [];
  for (const file of files) {
    const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest);
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
        continue;
      const dependency = statement.moduleSpecifier.text;
      if (
        dependency === 'typeorm' ||
        dependency === 'pg' ||
        dependency.startsWith('@aws-sdk/') ||
        dependency.startsWith('@/database/') ||
        dependency.includes('/infrastructure/persistence/') ||
        dependency.includes('/infrastructure/sqs/')
      ) {
        violations.push(`${file}: ${dependency}`);
      }
    }
  }
  expect(violations).toEqual([]);
});
