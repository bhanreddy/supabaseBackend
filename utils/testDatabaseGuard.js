/** Refuse implicit remote database access from Node's test workers. */
export function assertIsolatedTestDatabase(databaseUrl, env = process.env) {
  if (!env.NODE_TEST_CONTEXT) return;
  let url;
  try { url = new URL(databaseUrl); } catch { throw new Error('Tests require an explicit isolated local database URL.'); }
  if (!['localhost','127.0.0.1','[::1]'].includes(url.hostname) || !/_test$/.test(url.pathname)) {
    throw new Error('Database tests require a dedicated local database whose name ends in _test. The configured school database was not accessed.');
  }
}
