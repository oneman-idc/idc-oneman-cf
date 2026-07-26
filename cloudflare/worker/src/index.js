import { account, confirmRefund, createOrder, createTopup, instanceAccess, instanceAction, requestRefund, resendCard, resendRefund } from "./routes/account.js";
import { catalog, getSettingsRoute, importCards, plans as adminPlans, productAction, products, refunds as adminRefunds, retryJob, reviewRefund, savePlan, saveSettingsRoute, summary, testResend, togglePlan } from "./routes/admin.js";
import { bootstrap, getSession, login, logout, register } from "./routes/auth.js";
import { hashPayCallback } from "./routes/payments.js";
import { config, plans } from "./routes/public.js";
import { createVncSession, proxyVnc } from "./routes/vnc.js";
import { consumeQueue, scheduledMaintenance } from "./lib/jobs.js";
import { corsHeaders, originAllowed } from "./lib/cors.js";
import { ensureSchema } from "./lib/schema.js";
import { fail, HttpError, json, route } from "./lib/util.js";

function withCors(response, request, env) {
  if (response.status === 101) return response;
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(request, env))) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function dispatch(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, "") || "/";
  const method = request.method.toUpperCase();
  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: {
      ...corsHeaders(request, env),
      "Access-Control-Allow-Headers": "Content-Type, X-CSRF-Token, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Max-Age": "86400",
    } });
  }
  if (!env.DB) return fail(503, "d1_binding_missing", "D1 binding DB is not configured");
  await ensureSchema(env);
  const missingBindings = ["SECRET_KEY", "MASTER_KEY"].filter((name) => !env[name]);
  if ((path === "/healthz" || path === "/api/healthz") && method === "GET") {
    return json({ status: missingBindings.length ? "degraded" : "ok", runtime: "cloudflare-workers", environment: env.ENVIRONMENT || "production", missing_bindings: missingBindings }, missingBindings.length ? 503 : 200);
  }
  if (missingBindings.length) return fail(503, "bindings_missing", `Missing Worker bindings: ${missingBindings.join(", ")}`);
  if (path === "/api/config" && method === "GET") return config(request, env);
  if (path === "/api/plans" && method === "GET") return plans(request, env);
  if (path === "/api/session" && method === "GET") return getSession(request, env);
  if (path === "/api/bootstrap" && method === "POST") return bootstrap(request, env);
  if (path === "/api/auth/register" && method === "POST") return register(request, env);
  if (path === "/api/auth/login" && method === "POST") return login(request, env);
  if (path === "/api/auth/logout" && method === "POST") return logout(request, env);
  if (path === "/api/account" && method === "GET") return account(request, env);
  if (path === "/api/orders" && method === "POST") return createOrder(request, env);
  if (path === "/api/account/topups" && method === "POST") return createTopup(request, env);
  if (path === "/api/payments/hashpay/callback" && method === "POST") return hashPayCallback(request, env);

  let match = route(path, /^\/api\/account\/orders\/(\d+)\/refunds$/);
  if (match && method === "POST") return requestRefund(request, env, Number(match[0]));
  match = route(path, /^\/api\/account\/orders\/(\d+)\/card-email$/);
  if (match && method === "POST") return resendCard(request, env, Number(match[0]));
  match = route(path, /^\/api\/account\/refunds\/(\d+)\/(confirm|resend)$/);
  if (match && method === "POST") return match[1] === "confirm" ? confirmRefund(request, env, Number(match[0])) : resendRefund(request, env, Number(match[0]));
  match = route(path, /^\/api\/instances\/(\d+)\/access$/);
  if (match && method === "GET") return instanceAccess(request, env, Number(match[0]));
  match = route(path, /^\/api\/instances\/(\d+)\/actions\/(start|stop|restart|reset-password)$/);
  if (match && method === "POST") return instanceAction(request, env, Number(match[0]), match[1]);
  match = route(path, /^\/api\/instances\/(\d+)\/vnc-session$/);
  if (match && method === "POST") return createVncSession(request, env, Number(match[0]));
  match = route(path, /^\/api\/instances\/(\d+)\/vnc$/);
  if (match && method === "GET") return proxyVnc(request, env, Number(match[0]));

  if (path === "/api/admin" && method === "GET") return summary(request, env);
  if (path === "/api/admin/plans" && method === "GET") return adminPlans(request, env);
  if (path === "/api/admin/plans" && method === "POST") return savePlan(request, env);
  if (path === "/api/admin/clicd/images" && method === "GET") return catalog(request, env);
  if (path === "/api/admin/refunds" && method === "GET") return adminRefunds(request, env);
  if (path === "/api/admin/settings" && method === "GET") return getSettingsRoute(request, env);
  if (path === "/api/admin/settings" && method === "POST") return saveSettingsRoute(request, env);
  if (path === "/api/admin/settings/test/resend" && method === "POST") return testResend(request, env);
  if (path === "/api/admin/products" && method === "GET") return products(request, env);
  if (path === "/api/admin/products/action" && method === "POST") {
    const action = url.searchParams.get("action") || "";
    return productAction(request, env, action);
  }
  match = route(path, /^\/api\/admin\/plans\/(\d+)\/(toggle|cards)$/);
  if (match && method === "POST") return match[1] === "toggle" ? togglePlan(request, env, Number(match[0])) : importCards(request, env, Number(match[0]));
  match = route(path, /^\/api\/admin\/refunds\/(\d+)\/(approve|reject|retry)$/);
  if (match && method === "POST") return reviewRefund(request, env, Number(match[0]), match[1]);
  match = route(path, /^\/api\/admin\/jobs\/(\d+)\/retry$/);
  if (match && method === "POST") return retryJob(request, env, Number(match[0]));
  return fail(404, "not_found", "API route was not found");
}

export default {
  async fetch(request, env, ctx) {
    const callback = new URL(request.url).pathname.endsWith("/payments/hashpay/callback");
    if (!originAllowed(request, env) && !callback) return fail(403, "origin_not_allowed", "Request origin is not allowed");
    try {
      return withCors(await dispatch(request, env, ctx), request, env);
    } catch (error) {
      if (error instanceof HttpError) return withCors(fail(error.status, error.code, error.message, error.details), request, env);
      console.error("unhandled worker error", error);
      return withCors(fail(500, "internal_error", "An unexpected Worker error occurred", env.ENVIRONMENT === "beta" ? String(error.stack || error) : undefined), request, env);
    }
  },
  async queue(batch, env, ctx) {
    await ensureSchema(env);
    return consumeQueue(batch, env, ctx);
  },
  scheduled(_controller, env, ctx) {
    ctx.waitUntil(ensureSchema(env).then(() => scheduledMaintenance(env)));
  },
};
