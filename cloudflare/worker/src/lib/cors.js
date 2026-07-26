function origin(value) {
  if (!value) return "";
  try {
    const parsed = new URL(String(value).trim());
    return new Set(["http:", "https:"]).has(parsed.protocol) && parsed.origin !== "null" ? parsed.origin : "";
  } catch {
    return "";
  }
}

export function allowedOrigins(request, env) {
  const configured = [env.PAGES_ORIGIN, ...(env.ALLOWED_ORIGINS || "").split(",")];
  return new Set([origin(request.url), ...configured.map(origin)].filter(Boolean));
}

export function originAllowed(request, env) {
  const requestOrigin = request.headers.get("Origin");
  return !requestOrigin || allowedOrigins(request, env).has(origin(requestOrigin));
}

export function corsHeaders(request, env) {
  const requestOrigin = origin(request.headers.get("Origin"));
  if (!requestOrigin || !allowedOrigins(request, env).has(requestOrigin)) return {};
  return {
    "Access-Control-Allow-Origin": requestOrigin,
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin",
  };
}
