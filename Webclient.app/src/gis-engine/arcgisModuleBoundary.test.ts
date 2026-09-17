import { readdirSync, readFileSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';
import {
  ScriptKind,
  ScriptTarget,
  SyntaxKind,
  createSourceFile,
  forEachChild,
  isCallExpression,
  isIdentifier,
  isImportDeclaration,
  isStringLiteralLike,
} from 'typescript';
import type { Node } from 'typescript';
import { describe, expect, it } from 'vitest';

const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx']);
const LEGACY_LOADER_PACKAGE = ['esri', 'loader'].join('-');
const ALLOWED_LEGACY_IMPORT = 'gis-engine/arcgisModuleRuntime.ts';

const collectSourceFiles = (directory: string): string[] => readdirSync(directory, { withFileTypes: true })
  .flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(path);
    return SOURCE_EXTENSIONS.has(extname(entry.name)) ? [path] : [];
  });

const getScriptKind = (file: string): ScriptKind => {
  switch (extname(file)) {
    case '.tsx': return ScriptKind.TSX;
    case '.jsx': return ScriptKind.JSX;
    case '.js': return ScriptKind.JS;
    default: return ScriptKind.TS;
  }
};

const hasLegacyLoaderImport = (file: string): boolean => {
  const sourceFile = createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ScriptTarget.Latest,
    true,
    getScriptKind(file),
  );
  let found = false;

  const visit = (node: Node): void => {
    if (found) return;

    if (
      isImportDeclaration(node)
      && isStringLiteralLike(node.moduleSpecifier)
      && node.moduleSpecifier.text === LEGACY_LOADER_PACKAGE
    ) {
      found = true;
      return;
    }

    if (
      isCallExpression(node)
      && node.arguments.length === 1
      && isStringLiteralLike(node.arguments[0])
      && node.arguments[0].text === LEGACY_LOADER_PACKAGE
      && (
        node.expression.kind === SyntaxKind.ImportKeyword
        || (isIdentifier(node.expression) && node.expression.text === 'require')
      )
    ) {
      found = true;
      return;
    }

    forEachChild(node, visit);
  };

  visit(sourceFile);
  return found;
};

const sourceRoot = resolve(process.cwd(), 'src');
const offenders = collectSourceFiles(sourceRoot)
  .filter((file) => !file.includes('.test.'))
  .filter(hasLegacyLoaderImport)
  .map((file) => relative(sourceRoot, file).replaceAll('\\', '/'))
  .filter((file) => file !== ALLOWED_LEGACY_IMPORT)
  .sort();

describe('ArcGIS module loading boundary', () => {
  it(`keeps the legacy loader isolated behind arcgisModuleRuntime in production sources [offenders: ${offenders.join(', ') || 'none'}]`, () => {
    expect(offenders).toEqual([]);
  });
});
