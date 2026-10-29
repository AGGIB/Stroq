import { jsonAction } from './control-http.mjs';
import { parseMcpRequestJson as parseScalarRequestJson } from './mcp-request-json.mjs';

/** The outer server authenticates Bearer, exact Host/Origin and Fetch-Site first. */
export async function routeCredentialFilters(req, path, origin, service) {
  if (path === '/api/credential-filters')
    return req.method === 'GET'
      ? service.state()
      : { status: 405, body: { error: 'method-not-allowed' } };
  if (path === '/api/credential-filters/preview' || path === '/api/credential-filters/apply')
    return jsonAction(
      req,
      origin,
      (input) => service[path.endsWith('/preview') ? 'preview' : 'apply'](input),
      4096,
      parseScalarRequestJson,
    );
  return { status: 404, body: { error: 'not-found' } };
}
