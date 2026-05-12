/**
 * Maps PaxMed provider id → env var prefix for B2B / sanctioned HTTP feeds.
 * Each retailer issues base URL + credentials under contract (no public keyless API).
 */

const PREFIX_BY_PROVIDER = {
  medplusmart: "MEDPLUS",
  apollopharmacy: "APOLLO",
  netmeds: "NETMEDS",
  "1mg": "ONE_MG",
  medkart: "MEDKART",
};

export function envPrefixForProvider(providerId) {
  return PREFIX_BY_PROVIDER[providerId] || null;
}

/**
 * @returns {null | {
 *   prefix: string,
 *   baseUrl: string,
 *   searchPath: string,
 *   method: 'GET'|'POST',
 *   queryParam: string,
 *   auth: null | { type: 'bearer'|'header'; headerName: string; value: string },
 *   extraHeaders: Record<string, string>,
 *   postBodyTemplate: string | null,
 * }}
 */
export function readPartnerHttpConfig(providerId) {
  const prefix = envPrefixForProvider(providerId);
  if (!prefix) return null;

  const baseUrl = process.env[`${prefix}_PARTNER_API_BASE`]?.trim();
  if (!baseUrl) return null;

  const searchPath = (process.env[`${prefix}_PARTNER_SEARCH_PATH`] || "/search").trim();
  const method = (process.env[`${prefix}_PARTNER_SEARCH_METHOD`] || "GET").toUpperCase();
  const queryParam = (process.env[`${prefix}_PARTNER_QUERY_PARAM`] || "q").trim();
  const bearer = process.env[`${prefix}_PARTNER_BEARER_TOKEN`]?.trim();
  const apiKey = process.env[`${prefix}_PARTNER_API_KEY`]?.trim();
  const apiKeyHeader =
    process.env[`${prefix}_PARTNER_API_KEY_HEADER`]?.trim() || "X-API-Key";

  let auth = null;
  if (bearer) {
    auth = { type: "bearer", headerName: "Authorization", value: `Bearer ${bearer}` };
  } else if (apiKey) {
    auth = { type: "header", headerName: apiKeyHeader, value: apiKey };
  }

  let extraHeaders = {};
  const raw = process.env[`${prefix}_PARTNER_EXTRA_HEADERS_JSON`]?.trim();
  if (raw) {
    try {
      extraHeaders = JSON.parse(raw);
      if (!extraHeaders || typeof extraHeaders !== "object") extraHeaders = {};
    } catch {
      extraHeaders = {};
    }
  }

  const postBodyTemplate = process.env[`${prefix}_PARTNER_POST_BODY_TEMPLATE`]?.trim() || null;

  return {
    prefix,
    baseUrl: baseUrl.replace(/\/$/, ""),
    searchPath: searchPath.startsWith("/") ? searchPath : `/${searchPath}`,
    method: method === "POST" ? "POST" : "GET",
    queryParam,
    auth,
    extraHeaders,
    postBodyTemplate,
  };
}

export function illustrativeFallbackEnabled() {
  return String(process.env.ONLINE_USE_ILLUSTRATIVE_FALLBACK || "").toLowerCase() === "true";
}
