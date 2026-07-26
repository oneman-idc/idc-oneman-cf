export async function onRequest(context) {
  const source = new URL(context.request.url);
  const parts = Array.isArray(context.params.path) ? context.params.path : [context.params.path || ""];
  const pathname = `/api/${parts.filter(Boolean).join("/")}`;
  const target = new URL(pathname + source.search, context.env.API_BASE_URL || "https://vps-one-api.internal");
  const forwarded = new Request(target, context.request);
  if (context.env.API && typeof context.env.API.fetch === "function") return context.env.API.fetch(forwarded);
  if (context.env.API_BASE_URL) return fetch(forwarded);
  return Response.json({ ok: false, error: { code: "api_binding_missing", message: "Pages API service binding is not configured" } }, { status: 503 });
}
