/* One ordering policy for the browser and Node.js. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DisplayOrder = factory();
})(globalThis, function () {
  function names(config, kind, extra = []) {
    const available = [...new Set([...Object.keys(config[kind] || {}), ...extra])];
    const known = new Set(available);
    const requested = config.displayOrder?.[kind];
    return [...new Set([...(Array.isArray(requested) ? requested.filter(id => known.has(id)) : []), ...available])];
  }
  function order(config) {
    return { servers: names(config, 'servers'), routers: names(config, 'routers') };
  }
  function mappings(config) {
    const rows = config.mappings || [];
    const rank = kind => new Map(names(config, kind, rows.map(m => m[kind === 'routers' ? 'router' : 'server'])).map((id, i) => [id, i]));
    const routers = rank('routers'), servers = rank('servers');
    // Stable sort keeps protocol/client order within each server intact.
    return [...rows].sort((a, b) => routers.get(a.router) - routers.get(b.router) || servers.get(a.server) - servers.get(b.server));
  }
  return Object.freeze({ names, order, mappings });
});
