import { readdir, readFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
export async function validateTourCoverage(frontend, catalog) {
  const metadata = JSON.parse(await readFile(resolve(frontend, 'src/features/app-tour/content/features.json'), 'utf8'));
  const bindings = JSON.parse(await readFile(resolve(frontend, 'src/features/app-tour/content/target-bindings.json'), 'utf8'));
  for (const [route, binding] of Object.entries(bindings)) {
    const text = await readFile(resolve(frontend, binding.source), 'utf8');
    for (const id of [binding.overview, binding.workspace]) if (!text.includes(`id="${id}"`)) throw Error(`Stale screen target binding: ${route}: ${id}`);
    if (!binding.overviewControl || !binding.workspaceControl) throw Error(`Missing measurable screen area: ${route}`);
  }
  const files = [];
  async function walk(dir) { for (const entry of await readdir(dir, { withFileTypes: true })) { const path = resolve(dir, entry.name); if (entry.isDirectory()) await walk(path); else if (/\.(tsx?|json)$/.test(entry.name)) files.push(path); } }
  await walk(resolve(frontend, 'app')); await walk(resolve(frontend, 'src/components'));
  const source = (await Promise.all(files.map(file => readFile(file, 'utf8')))).join('\n');
  const flags = await readFile(resolve(frontend, 'src/config/featureFlags.ts'), 'utf8');
  const featureGuides = catalog.filter(t => t.kind === 'feature');
  const covered = new Set(featureGuides.flatMap(t => t.routes));
  const exclusions = metadata.excludedRoutes;
  const canonical = file => '/' + file.slice(resolve(frontend, 'app').length + 1, -4).replace(/\/index$/, '');
  for (const file of files.filter(f => f.startsWith(resolve(frontend, 'app') + '/') && f.endsWith('.tsx') && !f.endsWith('/_layout.tsx'))) {
    const route = canonical(file);
    if (!covered.has(route) && !exclusions[route]) throw Error(`Untoured feature route: ${route}. Add a reviewed guide or an explicit non-feature exclusion.`);
  }
  const byId = new Map(featureGuides.map(t => [t.id, t]));
  for (const feature of metadata.features) {
    const guide = byId.get(feature.id);
    if (!guide || guide.steps.length < 3 || !feature.routes.every(route => guide.routes.includes(route))) throw Error(`Incomplete feature guide: ${feature.id}`);
    if (!guide.steps.every(step => step.permission === feature.permission && step.featureFlag === feature.featureFlag && step.feature === feature.feature && step.portalSetting === feature.portalSetting)) throw Error(`Stale tour eligibility: ${feature.id}`);
  }
  for (const tour of catalog) for (const step of tour.steps) {
    const registered = step.target.endsWith('.launcher') ? source.includes(`<AppTourQuickAction portal="${tour.portal}"`) : source.includes(`id="${step.target}"`) || step.target.endsWith('.navigation') && source.includes(`'${step.target}'`);
    if (!registered) throw Error(`Unregistered target: ${step.target}`);
    if (step.portalSetting && step.portalSetting !== 'staff.payslips_enabled') throw Error(`Unknown portal setting: ${step.portalSetting}`);
    if (step.featureFlag && !flags.includes(`'${step.featureFlag}'`)) throw Error(`Unknown school feature flag: ${step.featureFlag}`);
    const alternatives = [resolve(frontend, `app${step.route}.tsx`), resolve(frontend, `app${step.route}/index.tsx`)];
    if (!(await Promise.all(alternatives.map(path => access(path).then(() => true, () => false)))).some(Boolean)) throw Error(`Missing tour route: ${step.route}`);
  }
  // Navigation entries added later must not silently escape feature coverage.
  const navigationFiles = ['src/config/staffNavigation.ts', 'src/constants/adminNav.ts', 'src/constants/adminSidebarNav.ts', 'src/components/AccountsWebSidebar.tsx', 'src/components/MenuOverlay.tsx', 'src/components/StudentBottomDock.tsx'];
  const legacy = { '/admin/document-alerts': 'admin.feature-students' }; // Existing menu has no implemented route; student records explain documents.
  for (const file of navigationFiles) {
    const text = await readFile(resolve(frontend, file), 'utf8');
    for (const [, route] of text.matchAll(/(?:route|href|link):\s*['"]([^'"]+)['"]/g)) {
      if (!route.startsWith('/') || route.includes('${')) continue;
      if (!covered.has(route) && !exclusions[route] && !byId.has(legacy[route])) throw Error(`Untoured navigation destination: ${file}: ${route}`);
    }
  }
  return { features: featureGuides.length, routes: covered.size, exclusions: Object.keys(exclusions).length };
}
