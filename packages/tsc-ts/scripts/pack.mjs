// Lays out the tsc-ts npm packages and packs them into dist/npm:
//
//   tsc-ts             the launcher (bin/tsc-ts.js), with an optional
//                      dependency on each platform package, and the
//                      programmatic API (tsc-ts/api): its JS build with
//                      .d.ts files in dist/api, and its sources
//   @tsc-ts/<platform> the native executable for this host, with
//                      TypeScript's lib files next to it in lib/
//
// Usage: node scripts/pack.mjs [main] [platform] [--binary <path>] [--check]
//
// With neither main nor platform, packs both. Builds the executable with
// scriptc unless --binary names one. --check installs the tarballs into a
// temporary project and compiles it with npx tsc-ts.
//
// The optional dependencies are added here rather than in package.json, so
// the workspace installs without the platform packages.
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { executableName, hostDescription, hostPlatform, packageName, platforms } from '../bin/platforms.js';

const root = resolve(import.meta.dirname, '..');
const repo = resolve(root, '../..');
const out = join(root, 'dist/npm');
const windows = process.platform === 'win32';

// The oldest glibc the glibc packages support. The release builds link against
// its sysroot (SCRIPTC_TARGET=<arch>-linux-gnu.2.34).
const glibcMinimum = [2, 34];

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { binary: { type: 'string' }, check: { type: 'boolean' } },
});
for (const kind of positionals) if (kind !== 'main' && kind !== 'platform') throw new Error(`unknown package ${kind}`);
const kinds = positionals.length === 0 ? ['main', 'platform'] : positionals;

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const common = {
  version: manifest.version,
  license: manifest.license,
  repository: manifest.repository,
};

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const tarballs = {};
if (kinds.includes('main')) tarballs.main = packMain();
if (kinds.includes('platform')) tarballs.platform = packPlatform();
for (const tarball of Object.values(tarballs)) console.log(tarball);
if (values.check) check(tarballs);

function packMain() {
  const dir = join(out, 'tsc-ts');
  run('npm', ['run', 'build:api'], { cwd: root });
  for (const file of manifest.files) cpSync(join(root, file), join(dir, file), { recursive: true });
  copyFileSync(join(repo, 'LICENSE'), join(dir, 'LICENSE'));
  copyFileSync(join(repo, 'THIRD_PARTY_NOTICES.md'), join(dir, 'THIRD_PARTY_NOTICES.md'));
  const { scripts: _scripts, devDependencies: _devDependencies, private: _private, ...fields } = manifest;
  fields.files = [...manifest.files, 'THIRD_PARTY_NOTICES.md'];
  fields.optionalDependencies = Object.fromEntries(platforms.map((p) => [packageName(p), manifest.version]));
  writeJson(join(dir, 'package.json'), fields);
  return pack(dir);
}

function packPlatform() {
  const platform = hostPlatform();
  if (platform === undefined) throw new Error(`tsc-ts has no platform package for ${hostDescription()}`);
  const dir = join(out, platform.name);
  const lib = join(dir, 'lib');
  mkdirSync(lib, { recursive: true });
  const executable = join(lib, executableName());
  copyFileSync(values.binary ? resolve(values.binary) : build(), executable);
  chmodSync(executable, 0o755);
  if (platform.libc === 'glibc') checkGlibcVersions(executable);
  const libs = typescriptLib();
  for (const name of readdirSync(libs))
    if (/^lib\..*\.d\.ts$/.test(name)) copyFileSync(join(libs, name), join(lib, name));
  copyFileSync(join(repo, 'LICENSE'), join(dir, 'LICENSE'));
  copyFileSync(join(repo, 'THIRD_PARTY_NOTICES.md'), join(dir, 'THIRD_PARTY_NOTICES.md'));
  writeJson(join(dir, 'package.json'), {
    name: packageName(platform),
    ...common,
    description: `The tsc-ts executable for ${platform.name}.`,
    os: [platform.os],
    cpu: [platform.cpu],
    ...(platform.libc && { libc: [platform.libc] }),
    files: ['lib', 'THIRD_PARTY_NOTICES.md'],
  });
  return pack(dir);
}

// Builds dist/tsc with scriptc and returns its path.
function build() {
  run('npm', ['run', 'build:native'], { cwd: root });
  const path = join(root, 'dist/tsc');
  if (windows && existsSync(path + '.exe')) return path + '.exe';
  if (!existsSync(path)) throw new Error(`scriptc did not write ${path}`);
  return path;
}

// Fails if the executable needs a glibc symbol version newer than glibcMinimum,
// which a host-toolchain build takes from the build machine's glibc.
function checkGlibcVersions(executable) {
  const symbols = run('objdump', ['-T', executable], { stdio: 'pipe' }).stdout;
  const versionOf = (text) => /\bGLIBC_(\d+)\.(\d+)/.exec(text)?.slice(1).map(Number);
  const lines = symbols.split('\n').filter((line) => versionOf(line) !== undefined);
  const newer = lines.filter((line) => isNewerThan(versionOf(line), glibcMinimum));
  if (newer.length > 0)
    throw new Error(`${executable} needs glibc newer than ${glibcMinimum.join('.')}:\n${newer.join('\n')}`);
  const highest = lines.map(versionOf).reduce((a, b) => (isNewerThan(b, a) ? b : a), [0, 0]);
  console.log(`highest glibc symbol version: ${highest.join('.')}`);
}

// Compares [major, minor] versions.
function isNewerThan([major, minor], [baseMajor, baseMinor]) {
  return major > baseMajor || (major === baseMajor && minor > baseMinor);
}

// TypeScript's lib files, from the pinned upstream (npm run fetch:upstream).
function typescriptLib() {
  const lib = join(repo, 'upstream/TypeScript/tsc/internal/bundled/libs');
  if (!existsSync(join(lib, 'lib.d.ts'))) throw new Error(`no lib files in ${lib}: run npm run fetch:upstream`);
  return lib;
}

function pack(dir) {
  const result = run('npm', ['pack', '--json', '--pack-destination', out], { cwd: dir, stdio: 'pipe' });
  return join(out, JSON.parse(result.stdout)[0].filename);
}

// Installs the tarballs into a new project, then checks --version, a clean
// compile, the exit code of a compile with errors, and that tsc-ts/api loads
// in Node, type-checks with its .d.ts files, and parses files and checks a
// program with the platform package's lib files.
function check({ main, platform }) {
  if (!main || !platform) throw new Error('--check needs both packages');
  const dir = join(tmpdir(), `tsc-ts-pack-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'checked'), { recursive: true });
  try {
    writeJson(join(dir, 'package.json'), { name: 'tsc-ts-pack-check', private: true, type: 'module' });
    writeJson(join(dir, 'tsconfig.json'), {
      compilerOptions: { target: 'es2022', module: 'nodenext', strict: true, rootDir: 'src', outDir: 'out' },
      include: ['src'],
    });
    writeFileSync(join(dir, 'src/index.ts'), 'export const greeting: string = ["hello", "world"].join(" ");\n');
    run('npm', ['install', '--no-audit', '--no-fund', main, platform], { cwd: dir });

    const version = run('npx', ['tsc-ts', '--version'], { cwd: dir, stdio: 'pipe' }).stdout.trim();
    console.log(`npx tsc-ts --version: ${version}`);
    run('npx', ['tsc-ts', '-p', '.'], { cwd: dir });
    const emitted = readFileSync(join(dir, 'out/index.js'), 'utf8');
    if (!emitted.includes('greeting')) throw new Error(`unexpected output:\n${emitted}`);

    writeFileSync(join(dir, 'src/error.ts'), 'export const count: number = "one";\n');
    const failed = spawn('npx', ['tsc-ts', '-p', '.'], { cwd: dir, stdio: 'pipe' });
    if (failed.status !== 2 || !failed.stdout.includes('TS2322')) {
      throw new Error(`expected TS2322 and exit code 2, got ${failed.status}:\n${failed.stdout}${failed.stderr}`);
    }
    console.log('npx tsc-ts -p .: ok');

    rmSync(join(dir, 'src/error.ts'));
    writeFileSync(join(dir, 'checked/error.ts'), 'export const count: number = "one";\n');
    // The platform package's lib files serve as the default libraries of a program.
    const lib = join(dir, 'node_modules', packageName(hostPlatform()), 'lib');
    writeFileSync(
      join(dir, 'src/api.ts'),
      "import { createProgram, parseSourceFile, SyntaxKind, type Node } from 'tsc-ts/api';\n" +
        'export const isIdentifier = (node: Node): boolean => node.kind === SyntaxKind.Identifier;\n' +
        'console.log(SyntaxKind[SyntaxKind.Identifier]);\n' +
        "const file = parseSourceFile('a.ts', 'let a = 1;');\n" +
        'console.log(file.statements.nodes[0]!.kind === SyntaxKind.VariableStatement);\n' +
        'const program = createProgram({\n' +
        "  rootNames: ['checked/error.ts'],\n" +
        '  options: { strict: true },\n' +
        '  host: {\n' +
        `    getCurrentDirectory: () => ${JSON.stringify(dir)},\n` +
        `    useCaseSensitiveFileNames: () => ${!windows && process.platform !== 'darwin'},\n` +
        `    getDefaultLibraryDirectory: () => ${JSON.stringify(lib)},\n` +
        '  },\n' +
        '});\n' +
        "console.log(program.getSemanticDiagnostics().map((d) => d.code).join(','));\n" +
        'program.dispose();\n',
    );
    run('npx', ['tsc-ts', '-p', '.'], { cwd: dir });
    const printed = run('node', ['out/api.js'], { cwd: dir, stdio: 'pipe' }).stdout.trim();
    if (printed !== 'Identifier\ntrue\n2322') throw new Error(`unexpected tsc-ts/api output: ${printed}`);
    console.log('tsc-ts/api: ok');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function run(command, args, options) {
  const result = spawn(command, args, options);
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} exited with ${result.status}\n${result.stdout ?? ''}${result.stderr ?? ''}`,
    );
  }
  return result;
}

function spawn(command, args, { stdio = 'inherit', ...options }) {
  // npm and npx are batch files on Windows.
  return spawnSync(command, args, { ...options, stdio, encoding: 'utf8', shell: windows });
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}
