// The entrypoints auto-imports offer from a package's `exports` (package-entrypoints.ts). A target with `..` or `.`
// after its leading `./` offers nothing, as in tsc. tsc still lists the directories a wildcard target names outside
// the package before it drops the files there; tsc-ts does not read outside the package for such a target.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileSources, tempDir } from './temp.mjs';

const out = compileSources('tsc-ts-package-entrypoints-', ['main.ts', 'services/auto-import-packages.ts']);
const load = (path) => import(pathToFileURL(join(out, path)).href);
const { getEntrypointsFromPackageJsonInfo } = await load('compiler/package-entrypoints.js');
const { readPackageJson } = await load('services/auto-import-packages.js');
const { SystemFileSystem } = await load('compiler/tsc-cli.js');
const { CompilerHost } = await load('compiler/file-loader.js');
const { Resolver } = await load('compiler/module-resolution.js');
const { createNodeSystem } = await load('drivers/node-system.js');
const { normalizePath } = await load('compiler/path.js');

// A file system over the disk that records each directory it lists.
class RecordingFileSystem extends SystemFileSystem {
  listed = [];

  getAccessibleEntries(path) {
    this.listed.push(path);
    return super.getAccessibleEntries(path);
  }
}

test('wildcard exports targets that leave the package offer nothing and read nothing outside it', () => {
  const dir = normalizePath(tempDir('tsc-ts-package-entrypoints-'));
  const outside = join(dir, 'outside');
  mkdirSync(join(outside, 'deep'), { recursive: true });
  writeFileSync(join(outside, 'deep/escaped.d.ts'), 'export declare const escaped: number;\n');
  const pkg = join(dir, 'app/node_modules/evil');
  mkdirSync(join(pkg, 'lib'), { recursive: true });
  writeFileSync(join(pkg, 'lib/inside.d.ts'), 'export declare const inside: number;\n');
  writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify({
      name: 'evil',
      exports: {
        './up/*': './../../../outside/*.js',
        './back/*': './..\\..\\..\\outside\\*.js',
        './later/*': './lib/../../../../outside/*.js',
        './after/*': './lib/*/../../../../outside/deep/escaped.js',
        './dot/*': './lib/./*.js',
        './ok/*': './lib/*.js',
      },
    }),
  );

  const fs = new RecordingFileSystem(createNodeSystem('', ''));
  const resolver = new Resolver(new CompilerHost(fs, dir, ''), {});
  const info = readPackageJson(fs, normalizePath(join(pkg, 'package.json')));
  const entrypoints = getEntrypointsFromPackageJsonInfo(resolver, fs, info, 'evil', false);

  assert.deepEqual(
    entrypoints.map((e) => [e.moduleSpecifier, e.resolvedFileName]),
    [['evil/ok/inside', normalizePath(join(pkg, 'lib/inside.d.ts'))]],
  );
  const packageDirectory = normalizePath(pkg);
  const outsidePackage = fs.listed.filter(
    (path) => path !== packageDirectory && !path.startsWith(packageDirectory + '/'),
  );
  assert.deepEqual(outsidePackage, []);
});
