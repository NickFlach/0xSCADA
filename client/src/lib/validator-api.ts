/**
 * validator-api.ts — same-origin client for the Validator Dashboard (issue #453).
 *
 * This module is deliberately the ONLY way the dashboard obtains validator data,
 * and it can only ever reach one URL: the relative, same-origin
 * `/api/validators`. There is no node URL, no configurable host and no
 * `import.meta.env` read anywhere in the client bundle.
 *
 * That is the point of the endpoint. Talking to each node's `:9090` RPC from the
 * browser breaks under TLS (the page is https, the node is http → blocked mixed
 * content) and requires every node to serve permissive CORS headers. Going
 * through the server removes both problems and lets the request be authenticated
 * with the operator's control-plane API key, which `apiFetch` attaches.
 *
 * The response is validated against the shared Zod schema, so a server/client
 * contract drift surfaces as a parse error rather than as `undefined` in the UI.
 */

import {
  validatorOverviewSchema,
  type ValidatorOverview,
} from '@shared/types/services/validator-dashboard';
import { apiFetch } from './api-credential';

/** The single, relative endpoint this client is allowed to call. */
export const VALIDATOR_OVERVIEW_PATH = '/api/validators';

/** Error carrying the HTTP status so the UI can distinguish 401/403 from 5xx. */
export class ValidatorApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'ValidatorApiError';
  }
}

/** Map a transport/HTTP failure onto an operator-readable message. */
function describeStatus(status: number): string {
  if (status === 401) return 'Not authenticated — set an API key with the validators.read scope.';
  if (status === 403) return 'This API key lacks the validators.read scope.';
  if (status === 503) return 'The validator proxy is unavailable.';
  return `Validator API returned HTTP ${status}.`;
}

/**
 * Fetch the aggregated validator overview from the server-side proxy.
 *
 * Throws `ValidatorApiError` on transport failure, a non-2xx status, or a
 * response that does not match the shared contract.
 */
export async function fetchValidatorOverview(signal?: AbortSignal): Promise<ValidatorOverview> {
  let res: Response;
  try {
    res = await apiFetch(VALIDATOR_OVERVIEW_PATH, { signal, headers: { accept: 'application/json' } });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ValidatorApiError(
      err instanceof Error ? err.message : 'Validator API request failed',
      null,
    );
  }

  if (!res.ok) {
    throw new ValidatorApiError(describeStatus(res.status), res.status);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ValidatorApiError('Validator API returned a non-JSON body.', res.status);
  }

  const parsed = validatorOverviewSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidatorApiError(
      `Validator API response did not match the expected contract: ${parsed.error.message}`,
      res.status,
    );
  }
  return parsed.data;
}
