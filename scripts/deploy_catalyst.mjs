import { cp, mkdir, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import dotenv from 'dotenv';

const root = fileURLToPath(new URL('../', import.meta.url));
const build = path.join(root, '.catalyst/build');
const envFile = path.resolve(root, process.env.CATALYST_ENV_FILE || '.env');
const vars = dotenv.parse(await readFile(envFile));
for (const key of ['DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) {
  if (!vars[key]) throw new Error(`Missing ${key} in the Catalyst environment file`);
}

// Catalyst supplies its own HTTP port. Local integration addresses cannot be
// reached from AppSail; an external PaperForge URL can be supplied in the env file.
delete vars.PORT;
delete vars.X_ZOHO_CATALYST_LISTEN_PORT;
if (vars.PAPERFORGE_ENGINE_URL && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(vars.PAPERFORGE_ENGINE_URL).hostname)) {
  delete vars.PAPERFORGE_ENGINE_URL;
  console.log('PaperForge integration disabled: configure a reachable PAPERFORGE_ENGINE_URL to enable it.');
}
vars.NODE_ENV = 'production';
vars.LOG_LEVEL ||= 'info';
// Authorized Domains at Catalyst's gateway handle both OPTIONS and API replies.
// Express must not add a second origin/credentials header in that environment.
vars.PLATFORM_MANAGED_CORS = 'true';

await rm(build, { recursive: true, force: true });
await mkdir(build, { recursive: true });
for (const name of ['server.js', 'db.js', 'package.json', 'package-lock.json', 'config', 'middleware', 'routes', 'services', 'utils']) {
  await cp(path.join(root, name), path.join(build, name), {
    recursive: true,
    filter: (source) => !source.endsWith('.test.js') && !source.endsWith('.test.mjs') && !path.basename(source).startsWith('._'),
  });
}

// Install Linux x64 native assets rather than copying macOS node_modules.
// bcrypt ships its native binaries; sharp's platform packages are optional deps.
const install = spawnSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--os=linux', '--cpu=x64', '--libc=glibc', '--no-audit', '--no-fund'], { cwd: build, stdio: 'inherit' });
if (install.status !== 0) process.exit(install.status || 1);
for (const required of ['node_modules/@img/sharp-linux-x64', 'node_modules/@img/sharp-libvips-linux-x64', 'node_modules/bcrypt/prebuilds/linux-x64/bcrypt.glibc.node']) {
  await readFile(path.join(build, required.endsWith('.node') ? required : `${required}/package.json`));
}

const template = JSON.parse(await readFile(path.join(root, 'app-config.example.json'), 'utf8'));
const configPath = path.join(root, 'app-config.json');
await writeFile(configPath, `${JSON.stringify({ ...template, env_variables: { ...template.env_variables, ...vars } }, null, 2)}\n`, { mode: 0o600 });
await chmod(configPath, 0o600);
console.log(`Prepared SchoolIMS API with ${Object.keys(vars).length} server environment variables (values hidden).`);
if (!process.argv.includes('--prepare-only')) {
  const result = spawnSync('catalyst', ['deploy', '--only', 'appsail:simsapi'], { cwd: root, stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
