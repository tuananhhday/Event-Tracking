const tlsCodes = new Set(['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED', 'UND_ERR_PRX_TLS']);
const timeoutCodes = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
const reasons = new Set(['OPENROUTER_TLS_ERROR', 'OPENROUTER_DNS_ERROR', 'OPENROUTER_NETWORK_UNREACHABLE', 'OPENROUTER_CONNECTION_RESET', 'OPENROUTER_PROXY_AUTH_REQUIRED', 'OPENROUTER_PROXY_CONFIG_ERROR', 'OPENROUTER_PROXY_BLOCKED', 'OPENROUTER_PROXY_ERROR', 'OPENROUTER_TIMEOUT', 'OPENROUTER_UNAVAILABLE']);
export const isNetworkReason = reason => reasons.has(reason);
export const permanentNetworkReason = reason => ['OPENROUTER_TLS_ERROR', 'OPENROUTER_PROXY_AUTH_REQUIRED', 'OPENROUTER_PROXY_CONFIG_ERROR', 'OPENROUTER_PROXY_BLOCKED'].includes(reason);

/** Return fixed reason/code values only. Transport messages can contain proxy
 * passwords, API tokens and internal addresses and must never reach diagnostics. */
export function networkFailure(error) {
  const queue = [error], seen = new Set(); let fallback = null;
  for (let index = 0; index < queue.length && index < 24; index++) {
    const current = queue[index]; if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const code = String(current.code || '');
    let reason;
    if (tlsCodes.has(code)) reason = 'OPENROUTER_TLS_ERROR';
    else if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) reason = 'OPENROUTER_DNS_ERROR';
    else if (['ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH'].includes(code)) reason = 'OPENROUTER_NETWORK_UNREACHABLE';
    else if (['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET'].includes(code)) reason = 'OPENROUTER_CONNECTION_RESET';
    else if (timeoutCodes.has(code)) reason = 'OPENROUTER_TIMEOUT';
    else if (code === 'ERR_INVALID_URL' || code === 'UND_ERR_INVALID_ARG') reason = 'OPENROUTER_PROXY_CONFIG_ERROR';
    // Undici's CONNECT proxy rejection does not expose an HTTP Response.
    if (/\bProxy response \(407\)/i.test(String(current.message || ''))) return { reason: 'OPENROUTER_PROXY_AUTH_REQUIRED', code: 'HTTP_407' };
    const proxyStatus = String(current.message || '').match(/\bProxy response \(([45]\d\d)\)/i)?.[1];
    if (proxyStatus) return { reason: proxyStatus === '403' ? 'OPENROUTER_PROXY_BLOCKED' : 'OPENROUTER_PROXY_ERROR', code: `HTTP_${proxyStatus}` };
    if (reason) return { reason, code };
    if (['TimeoutError', 'AbortError'].includes(current.name)) fallback = { reason: 'OPENROUTER_TIMEOUT', code: current.name };
    if (current.cause) queue.push(current.cause);
    if (Array.isArray(current.errors)) queue.push(...current.errors.slice(0, 12));
  }
  return fallback || { reason: 'OPENROUTER_UNAVAILABLE', code: 'UNKNOWN' };
}

export function networkRuntime() {
  const enabled = (flag, variable) => process.execArgv.includes(flag) || process.env[variable] === '1' || String(process.env.NODE_OPTIONS || '').split(/\s+/).includes(flag);
  return {
    system_ca_enabled: enabled('--use-system-ca', 'NODE_USE_SYSTEM_CA'),
    env_proxy_enabled: enabled('--use-env-proxy', 'NODE_USE_ENV_PROXY'),
    proxy_configured: Boolean(process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy),
    extra_ca_configured: Boolean(process.env.NODE_EXTRA_CA_CERTS),
  };
}
