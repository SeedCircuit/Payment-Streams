#!/usr/bin/env node

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mainDir = resolve(root, 'packages/daml/main');
const interfaceDir = resolve(root, 'packages/daml/interfaces');
const libDir = resolve(mainDir, '.lib');
const requiredTokenDars = [
  ['splice-api-token-metadata-v1', 'splice-api-token-metadata-v1-1.0.0.dar'],
  ['splice-api-token-holding-v2', 'splice-api-token-holding-v2-1.0.0.dar'],
  ['splice-api-token-allocation-v2', 'splice-api-token-allocation-v2-1.0.0.dar'],
  ['splice-api-token-allocation-request-v2', 'splice-api-token-allocation-request-v2-1.0.0.dar'],
];

function parseArgs(argv) {
  const args = { officialDir: '', interfacesDar: '', outputDir: resolve(root, 'dist/network') };
  for (let index = 2; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--') continue;
    if (value === '--official-dir') args.officialDir = argv[++index] ?? '';
    else if (value === '--interfaces-dar') args.interfacesDar = argv[++index] ?? '';
    else if (value === '--output-dir') args.outputDir = resolve(argv[++index] ?? '');
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!args.officialDir) throw new Error('--official-dir is required');
  args.officialDir = resolve(args.officialDir);
  if (args.interfacesDar) args.interfacesDar = resolve(args.interfacesDar);
  return args;
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd,
    encoding: options.capture ? 'utf8' : undefined,
    stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(' ')} exited with ${result.status}`);
  }
  return options.capture ? result.stdout.trim() : '';
}

function resolveDamlTool() {
  for (const command of ['dpm', 'daml']) {
    const result = spawnSync(command, command === 'daml' ? ['version'] : ['--version'], {
      stdio: 'ignore',
    });
    if (!result.error && result.status === 0) return command;
  }
  throw new Error('DPM or the Daml SDK is required');
}

function inspectDar(tool, path) {
  const output = run(tool, ['damlc', 'inspect-dar', path, '--json'], { capture: true });
  return JSON.parse(output);
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function mainPackage(inspected) {
  const packageId = inspected.main_package_id;
  const details = inspected.packages?.[packageId];
  if (!packageId || !details) throw new Error('DAR inspection did not return a main package');
  return { packageId, name: details.name, version: details.version };
}

function findBuiltDar(directory, prefix) {
  const dist = resolve(directory, '.daml/dist');
  const filename = readdirSync(dist).find(
    (entry) => entry.startsWith(`${prefix}-`) && entry.endsWith('.dar'),
  );
  if (!filename) throw new Error(`No ${prefix} DAR found in ${dist}`);
  return resolve(dist, filename);
}

function verifyDependencySet(inspected, expected) {
  const packages = Object.entries(inspected.packages ?? {});
  for (const dependency of expected) {
    if (!inspected.packages?.[dependency.packageId]) {
      throw new Error(
        `Built DAR does not contain ${dependency.name} package ${dependency.packageId}`,
      );
    }
    const conflicts = packages.filter(
      ([packageId, details]) =>
        details.name === dependency.name && packageId !== dependency.packageId,
    );
    if (conflicts.length > 0) {
      throw new Error(
        `Built DAR contains conflicting ${dependency.name} package ids: ${conflicts
          .map(([packageId]) => packageId)
          .join(', ')}`,
      );
    }
  }
}

const args = parseArgs(process.argv);
const tool = resolveDamlTool();
const expectedDependencies = [];

mkdirSync(libDir, { recursive: true });
for (const [expectedName, filename] of requiredTokenDars) {
  const source = resolve(args.officialDir, filename);
  if (!existsSync(source)) throw new Error(`Missing official DAR: ${source}`);
  const dependency = mainPackage(inspectDar(tool, source));
  if (dependency.name !== expectedName || dependency.version !== '1.0.0') {
    throw new Error(
      `Expected ${expectedName} 1.0.0 in ${source}, found ${dependency.name} ${dependency.version}`,
    );
  }
  const destination = resolve(libDir, filename);
  if (source !== destination) copyFileSync(source, destination);
  expectedDependencies.push({ ...dependency, sha256: sha256(source) });
}

let interfacesDar;
if (args.interfacesDar) {
  if (!existsSync(args.interfacesDar)) {
    throw new Error(`Missing interfaces DAR: ${args.interfacesDar}`);
  }
  interfacesDar = resolve(interfaceDir, '.daml/dist/canton-streams-interfaces-1.0.0.dar');
  mkdirSync(dirname(interfacesDar), { recursive: true });
  if (args.interfacesDar !== interfacesDar) copyFileSync(args.interfacesDar, interfacesDar);
} else {
  rmSync(resolve(interfaceDir, '.daml'), { recursive: true, force: true });
  run(tool, ['build'], { cwd: interfaceDir });
  interfacesDar = findBuiltDar(interfaceDir, 'canton-streams-interfaces');
}

const interfaceDependency = mainPackage(inspectDar(tool, interfacesDar));
if (interfaceDependency.name !== 'canton-streams-interfaces') {
  throw new Error(`Expected canton-streams-interfaces in ${interfacesDar}`);
}
expectedDependencies.push({ ...interfaceDependency, sha256: sha256(interfacesDar) });

rmSync(resolve(mainDir, '.daml'), { recursive: true, force: true });
run(tool, ['build'], { cwd: mainDir });

const builtDar = findBuiltDar(mainDir, 'canton-streams');
const inspected = inspectDar(tool, builtDar);
const streamsPackage = mainPackage(inspected);
if (streamsPackage.name !== 'canton-streams' || streamsPackage.version !== '1.4.0') {
  throw new Error(
    `Expected canton-streams 1.4.0, found ${streamsPackage.name} ${streamsPackage.version}`,
  );
}
verifyDependencySet(inspected, expectedDependencies);

mkdirSync(args.outputDir, { recursive: true });
const outputDar = resolve(
  args.outputDir,
  `canton-streams-1.4.0-${streamsPackage.packageId.slice(0, 12)}.dar`,
);
copyFileSync(builtDar, outputDar);
writeFileSync(
  `${outputDar}.json`,
  `${JSON.stringify(
    {
      package: { ...streamsPackage, sha256: sha256(outputDar) },
      dependencies: expectedDependencies,
    },
    null,
    2,
  )}\n`,
);

process.stdout.write(`${outputDar}\n${streamsPackage.packageId}\n`);
