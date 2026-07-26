const state = {
  config: null,
  session: { user: null, csrf_token: "" },
  plans: [],
  account: null,
  adminTab: "overview",
  admin: {},
  editPlan: null,
  vnc: null,
  loadingAdmin: new Set(),
};

const app = document.getElementById("app");
const nav = document.getElementById("primary-nav");
const flashHost = document.getElementById("flash");

function english() {
  return (window.VPS_UI?.getState().language || document.documentElement.lang) === "en";
}

function l(zh, en) {
  return english() ? en : zh;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

function money(cents, currency = "CNY") {
  return new Intl.NumberFormat(english() ? "en-US" : "zh-CN", { style: "currency", currency }).format(Number(cents || 0) / 100);
}

function dateTime(value) {
  return value ? new Intl.DateTimeFormat(english() ? "en-US" : "zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(`${value}`.endsWith("Z") || `${value}`.includes("+") ? value : `${value}Z`)) : "-";
}

function status(value) {
  const labels = {
    pending: ["待处理", "Pending"], payment_pending: ["待支付", "Awaiting payment"], payment_error: ["支付失败", "Payment failed"],
    paid: ["已支付", "Paid"], provisioning: ["交付中", "Provisioning"], fulfilled: ["已完成", "Completed"],
    delivery_failed: ["交付异常", "Delivery issue"], refunded: ["已退款", "Refunded"], running: ["运行中", "Running"],
    starting: ["启动中", "Starting"], stopped: ["已停止", "Stopped"], stopping: ["关机中", "Stopping"],
    confirmation_pending: ["待邮箱确认", "Awaiting email confirmation"], pending_review: ["待审核", "Awaiting review"],
    approved: ["已批准", "Approved"], processing: ["处理中", "Processing"], processing_failed: ["处理失败", "Processing failed"],
    completed: ["已完成", "Completed"], rejected: ["已拒绝", "Rejected"], done: ["完成", "Done"], failed: ["失败", "Failed"],
  };
  return labels[value]?.[english() ? 1 : 0] || value || "-";
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && typeof options.body !== "string") {
    headers.set("Content-Type", "application/json");
    options.body = JSON.stringify(options.body);
  }
  if (state.session.csrf_token && (options.method || "GET") !== "GET") headers.set("X-CSRF-Token", state.session.csrf_token);
  const response = await fetch(`/api${path}`, { credentials: "include", ...options, headers });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error?.message || `Request failed (${response.status})`);
    error.code = result.error?.code;
    error.details = result.error?.details;
    throw error;
  }
  return result;
}

function flash(message, danger = false) {
  flashHost.innerHTML = `<div class="notice ${danger ? "danger" : "success-text"}">${escapeHtml(message)}</div>`;
  window.setTimeout(() => { flashHost.innerHTML = ""; }, 5000);
}

function view() {
  return (location.hash.replace(/^#/, "").split("?")[0] || "store").toLowerCase();
}

function go(target) {
  location.hash = target;
}

function button(label, action, extra = "") {
  return `<button type="button" class="btn ${extra}" data-action="${action}">${label}</button>`;
}

function renderNav() {
  const user = state.session.user;
  nav.innerHTML = [
    `<button type="button" class="text-link" data-action="nav" data-target="store">${l("产品", "Products")}</button>`,
    user ? `<button type="button" class="text-link" data-action="nav" data-target="dashboard">${l("云主机", "Servers")}</button>` : "",
    user ? `<button type="button" class="text-link" data-action="nav" data-target="account">${escapeHtml(user.username)}</button>` : "",
    user?.is_admin ? `<button type="button" class="text-link" data-action="nav" data-target="admin">${l("管理", "Admin")}</button>` : "",
    user ? button(l("退出", "Sign out"), "logout", "ghost") : button(l("登录", "Sign in"), "nav-login", "ghost"),
  ].join("");
}

function empty(message) {
  return `<div class="cf-empty">${escapeHtml(message)}</div>`;
}

function loadingMarkup() {
  return `<section class="cf-loading"><span></span><span></span><span></span></section>`;
}

function missingDetailLabel(value) {
  const labels = {
    container_id: ["容器 ID", "container ID"], container_node: ["节点", "node"], container_name: ["容器名称", "container name"],
    expires_at: ["到期时间", "expiry"], status: ["运行状态", "status"], ipv4: ["IPv4", "IPv4"], ipv6: ["IPv6", "IPv6"],
    ssh_port: ["SSH 端口", "SSH port"], ssh_username: ["SSH 用户名", "SSH username"], ssh_password: ["SSH 密码", "SSH password"],
    management_username: ["管理用户名", "management username"], management_password: ["管理密码", "management password"],
    management_access_code: ["访问码", "access code"], management_management_url: ["管理链接", "management URL"],
  };
  return labels[value]?.[english() ? 1 : 0] || value;
}

function renderStore() {
  const site = state.config?.site || {};
  const cards = state.plans.map((plan) => `<article class="card cf-card">
    <div class="row"><div class="eyebrow">${plan.product_type === "card" ? l("自动发卡", "DIGITAL DELIVERY") : escapeHtml(plan.virtualization).toUpperCase()}</div><span class="status">${plan.stock < 0 ? l("可用", "Available") : `${l("库存", "Stock")} ${plan.stock}`}</span></div>
    <h2>${escapeHtml(plan.name)}</h2><p class="muted">${escapeHtml(plan.description)}</p>
    <div class="cf-price">${money(plan.price_cents, plan.currency)} <small>/${plan.product_type === "card" ? l("份", "item") : `${plan.months} ${l("月", "mo")}`}</small></div>
    <div class="cf-facts">${plan.product_type === "card"
      ? `<div><span>${l("交付", "Delivery")}</span><strong>RESEND</strong></div><div><span>${l("卡密", "Code")}</span><strong>${l("邮件发送", "Email")}</strong></div>`
      : `<div><span>vCPU</span><strong>${plan.cpu}</strong></div><div><span>${l("内存", "Memory")}</span><strong>${plan.memory_mb} MB</strong></div><div><span>${l("磁盘", "Disk")}</span><strong>${plan.disk_gb} GB</strong></div><div><span>${l("流量", "Traffic")}</span><strong>${plan.traffic_gb} GB</strong></div>`}
    </div>
    <div class="cf-actions">${state.session.user ? `${button(l("钱包购买", "Wallet"), `buy-wallet:${plan.id}`, "secondary")}${button(l("在线支付", "Online payment"), `buy-hashpay:${plan.id}`)}` : button(l("登录购买", "Sign in to buy"), "nav-login")}</div>
  </article>`).join("");
  app.innerHTML = `<section class="cf-band"><div class="container"><div class="eyebrow">${escapeHtml(site.site_name || "VPS-ONE")}</div><h1>${escapeHtml(site.site_tagline || l("云主机与数字产品交付", "Cloud servers and digital delivery"))}</h1><p>${l("选择合适的套餐，在线完成购买与交付。", "Choose a plan and complete delivery online.")}</p></div></section>
    <section class="cf-shell"><div class="cf-toolbar"><div><div class="eyebrow">PRODUCTS</div><h2>${l("产品套餐", "Product plans")}</h2></div>${state.session.user ? button(l("进入控制台", "Open console"), "nav-dashboard", "secondary") : ""}</div>
    <div class="cf-grid">${cards || empty(l("暂无在售产品", "No products are available"))}</div></section>`;
  document.getElementById("footer-brand").textContent = site.site_footer || site.site_name || "VPS-ONE";
}

function renderAuth(kind) {
  const register = kind === "register";
  app.innerHTML = `<section class="cf-auth card"><div class="eyebrow">${register ? "REGISTER" : "SIGN IN"}</div><h1>${register ? l("创建账户", "Create account") : l("欢迎回来", "Welcome back")}</h1>
    <form class="cf-stack" data-form="${kind}"><label class="field">${l("邮箱", "Email")}<input name="email" type="email" autocomplete="email" required></label>
    <label class="field">${l("密码", "Password")}<input name="password" type="password" minlength="10" autocomplete="${register ? "new-password" : "current-password"}" required></label>
    <button class="btn" type="submit">${register ? l("注册", "Register") : l("登录", "Sign in")}</button></form>
    <p>${register ? l("已有账户？", "Already registered?") : l("还没有账户？", "New here?")} <button class="text-link" type="button" data-action="nav" data-target="${register ? "login" : "register"}">${register ? l("返回登录", "Back to sign in") : l("立即注册", "Create one")}</button></p></section>`;
}

function renderSetup() {
  app.innerHTML = `<section class="cf-auth card"><div class="eyebrow">FIRST RUN</div><h1>${l("创建管理员", "Create administrator")}</h1>
    <p class="muted">${l("使用部署时填写的一次性初始化令牌完成实例设置。", "Finish setup with the one-time bootstrap token entered during deployment.")}</p>
    <form class="cf-stack" data-form="bootstrap"><label class="field">${l("管理员邮箱", "Administrator email")}<input name="email" type="email" autocomplete="email" required></label>
    <label class="field">${l("管理员密码", "Administrator password")}<input name="password" type="password" minlength="10" autocomplete="new-password" required></label>
    <label class="field">${l("初始化令牌", "Bootstrap token")}<input name="bootstrap_token" type="password" autocomplete="off" required></label>
    <button class="btn" type="submit">${l("初始化 VPS-ONE", "Initialize VPS-ONE")}</button></form></section>`;
}

function renderDashboard() {
  const data = state.account;
  if (!data) return loadingAccount("dashboard");
  const cards = data.instances.map((instance) => {
    const ready = instance.details_state === "complete";
    const missing = (instance.missing_details || []).map(missingDetailLabel).join("、");
    const ipv4 = instance.ip || (instance.assign_ipv4 || instance.assign_nat ? l("同步中", "Syncing") : l("未分配", "Not assigned"));
    const ipv6 = instance.ipv6 || (instance.assign_ipv6 ? l("同步中", "Syncing") : l("未分配", "Not assigned"));
    const actions = ready
      ? `${button(l("详细", "Access"), `access:${instance.id}`, "secondary")}${button(l("开机", "Start"), `instance:start:${instance.id}`, "ghost")}${button(l("关机", "Stop"), `instance:stop:${instance.id}`, "ghost")}${button(l("重启", "Restart"), `instance:restart:${instance.id}`, "ghost")}${button(l("重置密码", "Reset password"), `instance:reset-password:${instance.id}`, "secondary")}${instance.virtualization === "kvm" ? button("VNC", `vnc:${instance.id}`) : ""}`
      : `<button type="button" class="btn secondary" disabled>${l("详情同步中", "Details syncing")}</button>`;
    return `<article class="card cf-card"><div class="row"><div><div class="eyebrow">${escapeHtml(instance.virtualization).toUpperCase()}</div><h2>${escapeHtml(instance.plan_name)}</h2></div><span class="status">${status(ready ? instance.status : "provisioning")}</span></div>
      ${ready ? "" : `<div class="notice"><b>${l("正在核对容器完整信息", "Verifying complete container details")}</b>${missing ? `<p>${escapeHtml(missing)}</p>` : ""}</div>`}
      <div class="cf-facts"><div><span>${l("订单号", "Order")}</span><strong class="cf-code">${escapeHtml(instance.order_no)}</strong></div><div><span>${l("容器 ID", "Container ID")}</span><strong class="cf-code">${escapeHtml(instance.clicd_id || l("同步中", "Syncing"))}</strong></div><div><span>${l("容器名称", "Container")}</span><strong>${escapeHtml(instance.remote_name || l("同步中", "Syncing"))}</strong></div><div><span>${l("到期时间", "Expires")}</span><strong>${dateTime(instance.expires_at)}</strong></div><div><span>IPv4</span><strong>${escapeHtml(ipv4)}</strong></div><div><span>IPv6</span><strong>${escapeHtml(ipv6)}</strong></div></div>
      <div class="cf-actions">${actions}</div><div id="access-${instance.id}" class="top-gap"></div></article>`;
  }).join("");
  app.innerHTML = `<section class="cf-shell"><div class="cf-toolbar"><div><div class="eyebrow">SERVERS</div><h1>${l("我的云主机", "My cloud servers")}</h1></div>${button(l("购买产品", "Buy products"), "nav-store")}</div><div class="cf-grid two">${cards || empty(l("暂无云主机", "No servers"))}</div></section>`;
}

function orderCard(order, refunds) {
  const refund = refunds.find((item) => item.order_id === order.id);
  const eligible = order.product_type === "cloud" && order.status === "fulfilled" && order.paid_at && Date.now() - new Date(`${order.paid_at}Z`).getTime() <= 86_400_000 && !refund;
  return `<article class="card cf-card"><div class="row"><div><h3>${escapeHtml(order.plan_name)}</h3><code>${escapeHtml(order.order_no)}</code></div><span class="status">${status(order.status)}</span></div>
    <div class="cf-facts"><div><span>${l("金额", "Amount")}</span><strong>${money(order.amount_cents, order.currency)}</strong></div><div><span>${l("支付方式", "Payment")}</span><strong>${escapeHtml(order.payment_method)}</strong></div><div><span>${l("订单时间", "Ordered")}</span><strong>${dateTime(order.created_at)}</strong></div><div><span>${l("支付时间", "Paid")}</span><strong>${dateTime(order.paid_at)}</strong></div></div>
    ${order.masked_value ? `<p>${l("卡密摘要", "Masked code")}: <code>${escapeHtml(order.masked_value)}</code></p>` : ""}
    ${order.product_type === "card" && order.status === "fulfilled" && order.masked_value ? button(l("重发交付邮件", "Resend delivery email"), `card-resend:${order.id}`, "secondary") : ""}
    ${eligible ? button(l("撤销", "Cancel order"), `refund-request:${order.id}`, "danger-btn") : ""}
    ${refund ? `<div class="notice"><b>${l("撤销申请", "Cancellation")}</b> · ${status(refund.status)}${refund.status === "confirmation_pending" ? `<form data-form="refund-confirm" data-id="${refund.id}" class="cf-actions top-gap"><input name="code" inputmode="numeric" maxlength="6" placeholder="${l("6 位确认码", "6-digit code")}" required><button class="btn small">${l("确认", "Confirm")}</button><button type="button" class="btn ghost small" data-action="refund-resend:${refund.id}">${l("重发", "Resend")}</button></form>` : ""}</div>` : ""}</article>`;
}

function renderAccount() {
  const data = state.account;
  if (!data) return loadingAccount("account");
  app.innerHTML = `<section class="cf-shell"><div class="cf-toolbar"><div><div class="eyebrow">ACCOUNT</div><h1>${escapeHtml(data.user.username)}</h1><p class="muted">${escapeHtml(data.user.email)}</p></div><div><span class="muted">${l("钱包余额", "Wallet balance")}</span><div class="cf-price">${money(data.wallet.balance_cents, data.wallet.currency)}</div></div></div>
    <div class="cf-grid two"><section class="card"><h2>${l("钱包充值", "Wallet top-up")}</h2><form data-form="topup" class="cf-form-grid"><label class="wide"><span>${l("充值金额", "Amount")}</span><input name="amount" type="number" min="1" max="50000" step="0.01" required></label><button class="btn wide">${l("在线支付", "Online payment")}</button></form></section>
    <section class="card"><h2>${l("钱包流水", "Wallet ledger")}</h2><div class="cf-table-scroll"><table><thead><tr><th>${l("时间", "Time")}</th><th>${l("说明", "Description")}</th><th>${l("变动", "Change")}</th></tr></thead><tbody>${data.entries.map((entry) => `<tr><td>${dateTime(entry.created_at)}</td><td>${escapeHtml(entry.description)}</td><td>${money(entry.amount_cents, data.wallet.currency)}</td></tr>`).join("") || `<tr><td colspan="3">${l("暂无流水", "No entries")}</td></tr>`}</tbody></table></div></section></div>
    <div class="section-head compact"><h2>${l("订单列表", "Orders")}</h2></div><div class="cf-grid two">${data.orders.map((order) => orderCard(order, data.refunds)).join("") || empty(l("暂无订单", "No orders"))}</div></section>`;
}

function adminTabs() {
  const tabs = [["overview", l("总览", "Overview")], ["plans", l("套餐", "Plans")], ["products", l("容器", "Containers")], ["refunds", l("退款", "Refunds")], ["settings", l("设置", "Settings")]];
  return `<div class="cf-tabs">${tabs.map(([key, label]) => `<button type="button" class="btn ghost" data-action="admin-tab:${key}" aria-current="${state.adminTab === key ? "page" : "false"}">${label}</button>`).join("")}</div>`;
}

function renderAdminOverview() {
  const data = state.admin.overview;
  if (!data) return loadingMarkup();
  const stats = Object.entries(data.stats || {}).map(([key, value]) => `<article class="card stat"><span>${escapeHtml(key.replace(/_/g, " "))}</span><strong>${value}</strong></article>`).join("");
  const jobs = data.jobs.map((item) => `<tr><td><code>${escapeHtml(item.job_key)}</code></td><td>${escapeHtml(item.kind)}</td><td>${status(item.status)}</td><td>${item.attempts}</td><td class="error-cell">${escapeHtml(item.error || "-")}</td><td>${item.status === "failed" ? button(l("重试", "Retry"), `job-retry:${item.id}`, "secondary small") : ""}</td></tr>`).join("");
  return `<div class="stats">${stats}</div><div class="section-head compact"><h2>${l("最新订单", "Latest orders")}</h2></div><div class="table-wrap cf-table-scroll"><table><thead><tr><th>${l("订单号", "Order")}</th><th>${l("类型", "Type")}</th><th>${l("金额", "Amount")}</th><th>${l("状态", "Status")}</th></tr></thead><tbody>${data.orders.map((item) => `<tr><td>${escapeHtml(item.order_no)}</td><td>${escapeHtml(item.product_type)}</td><td>${money(item.amount_cents, item.currency)}</td><td>${status(item.status)}</td></tr>`).join("")}</tbody></table></div><div class="section-head compact"><h2>${l("交付任务", "Delivery jobs")}</h2></div><div class="table-wrap cf-table-scroll"><table><thead><tr><th>Job</th><th>${l("类型", "Type")}</th><th>${l("状态", "Status")}</th><th>${l("次数", "Attempts")}</th><th>${l("错误", "Error")}</th><th></th></tr></thead><tbody>${jobs || `<tr><td colspan="6">${l("暂无任务", "No jobs")}</td></tr>`}</tbody></table></div>`;
}

function planForm(plan = {}) {
  const images = state.admin.catalog?.images?.filter((item) => !item.error) || [];
  return `<form data-form="admin-plan" class="card cf-form-grid"><input type="hidden" name="id" value="${plan.id || ""}"><label><span>${l("套餐名称", "Name")}</span><input name="name" value="${escapeHtml(plan.name || "")}" required></label><label><span>Slug</span><input name="slug" pattern="[a-z0-9][a-z0-9-]+" value="${escapeHtml(plan.slug || "")}" required></label>
    <label class="wide"><span>${l("描述", "Description")}</span><textarea name="description">${escapeHtml(plan.description || "")}</textarea></label><label><span>${l("类型", "Type")}</span><select name="product_type"><option value="cloud" ${plan.product_type !== "card" ? "selected" : ""}>${l("云主机", "Cloud server")}</option><option value="card" ${plan.product_type === "card" ? "selected" : ""}>${l("自动发卡", "Digital delivery")}</option></select></label>
    <label><span>${l("价格（分）", "Price (cents)")}</span><input name="price_cents" type="number" min="1" value="${plan.price_cents || 100}" required></label><label><span>${l("周期（月）", "Term (months)")}</span><input name="months" type="number" min="1" value="${plan.months || 1}"></label><label><span>${l("排序", "Sort")}</span><input name="sort_order" type="number" value="${plan.sort_order || 0}"></label>
    <div class="wide cf-form-grid" data-cloud-fields><label><span>${l("虚拟化", "Virtualization")}</span><select name="virtualization"><option value="lxc" ${plan.virtualization !== "kvm" ? "selected" : ""}>LXC</option><option value="kvm" ${plan.virtualization === "kvm" ? "selected" : ""}>KVM</option></select></label><label><span>${l("CLICD 节点与镜像", "CLICD node and image")}</span><select name="clicd_choice" required><option value="">${l("选择镜像", "Select image")}</option>${images.map((image) => `<option data-type="${image.type}" value="${escapeHtml(`${image.node}\u001f${image.id}`)}" ${plan.clicd_node === image.node && plan.clicd_image === image.id ? "selected" : ""}>${escapeHtml(image.node_label)} · ${escapeHtml(image.type.toUpperCase())} · ${escapeHtml(image.name)}</option>`).join("")}</select></label>
      <label><span>vCPU</span><input name="cpu" type="number" min="1" value="${plan.cpu || 1}"></label><label><span>${l("内存 MB", "Memory MB")}</span><input name="memory_mb" type="number" min="128" value="${plan.memory_mb || 512}"></label><label><span>${l("磁盘 GB", "Disk GB")}</span><input name="disk_gb" type="number" min="1" value="${plan.disk_gb || 10}"></label><label><span>${l("流量 GB", "Traffic GB")}</span><input name="traffic_gb" type="number" min="0" value="${plan.traffic_gb || 0}"></label><label><span>${l("下行 Mbps", "Download Mbps")}</span><input name="network_down_mbps" type="number" min="0" value="${plan.network_down_mbps || 100}"></label><label><span>${l("上行 Mbps", "Upload Mbps")}</span><input name="network_up_mbps" type="number" min="0" value="${plan.network_up_mbps || 50}"></label>
      <label><span>NAT</span><input name="assign_nat" type="checkbox" ${plan.assign_nat !== 0 ? "checked" : ""}></label><label><span>${l("端口数量", "Port count")}</span><input name="port_mapping_count" type="number" min="2" max="64" value="${plan.port_mapping_count || 2}"></label><label><span>IPv4</span><input name="assign_ipv4" type="checkbox" ${plan.assign_ipv4 ? "checked" : ""}></label><label><span>IPv6</span><input name="assign_ipv6" type="checkbox" ${plan.assign_ipv6 !== 0 ? "checked" : ""}></label></div>
    <label class="wide" data-card-fields><span>${l("交付说明", "Delivery note")}</span><textarea name="card_delivery_note">${escapeHtml(plan.card_delivery_note || "")}</textarea></label><label><span>${l("上架", "Published")}</span><input name="active" type="checkbox" ${plan.active ? "checked" : ""}></label><div class="wide cf-actions"><button class="btn">${plan.id ? l("保存修改", "Save changes") : l("新增套餐", "Add plan")}</button>${plan.id ? `<button type="button" class="btn ghost" data-action="plan-edit-cancel">${l("取消", "Cancel")}</button>` : ""}</div></form>`;
}

function renderAdminPlans() {
  const data = state.admin.plans;
  if (!data || !state.admin.catalog) return loadingMarkup();
  const list = data.plans.map((plan) => `<article class="card"><div class="row"><div><div class="eyebrow">${escapeHtml(plan.product_type)}</div><h3>${escapeHtml(plan.name)}</h3><code>${escapeHtml(plan.slug)}</code></div><span class="status">${plan.active ? l("上架", "Published") : l("下架", "Draft")}</span></div><p>${escapeHtml(plan.description)}</p><div class="cf-facts"><div><span>${l("价格", "Price")}</span><strong>${money(plan.price_cents, plan.currency)}</strong></div><div><span>${l("库存", "Stock")}</span><strong>${plan.product_type === "card" ? plan.card_available : "∞"}</strong></div></div><div class="cf-actions">${button(l("编辑", "Edit"), `plan-edit:${plan.id}`, "secondary")}${button(plan.active ? l("下架", "Unpublish") : l("上架", "Publish"), `plan-toggle:${plan.id}`, "ghost")}</div>${plan.product_type === "card" ? `<form data-form="card-import" data-id="${plan.id}" class="top-gap"><label class="field">${l("追加卡密", "Add codes")}<textarea name="inventory" rows="3" required></textarea></label><button class="btn secondary small">${l("导入库存", "Import")}</button></form>` : ""}</article>`).join("");
  return `${planForm(state.editPlan || {})}<div class="section-head compact"><h2>${l("现有套餐", "Existing plans")}</h2></div><div class="cf-grid two">${list || empty(l("暂无套餐", "No plans"))}</div>`;
}

function renderAdminProducts() {
  const data = state.admin.products;
  if (!data) return loadingMarkup();
  return `<div class="cf-grid two">${data.containers.map((item) => `<article class="card"><div class="row"><div><h3>${escapeHtml(item.name || item.hostname || item.id)}</h3><code>${escapeHtml(item.uuid || item.id)}</code><p class="muted">${escapeHtml(item._node_label)}</p></div><span class="status">${status(item.status || item.state)}</span></div><div class="cf-actions">${["start", "stop", "restart"].map((action) => button(status(action), `product:${action}:${encodeURIComponent(item._node)}:${encodeURIComponent(item.uuid || item.id)}`, "ghost")).join("")}${button(l("删除", "Delete"), `product:delete:${encodeURIComponent(item._node)}:${encodeURIComponent(item.uuid || item.id)}`, "danger-btn")}</div></article>`).join("") || empty(l("暂无容器", "No containers"))}</div>`;
}

function renderAdminRefunds() {
  const data = state.admin.refunds;
  if (!data) return loadingMarkup();
  return `<div class="cf-stack">${data.refunds.map((item) => `<article class="card"><div class="row"><div><h3>${escapeHtml(item.refund_no)}</h3><code>${escapeHtml(item.order_no)}</code><p>${escapeHtml(item.username)} · ${escapeHtml(item.email)}</p></div><span class="status">${status(item.status)}</span></div><p>${escapeHtml(item.reason || l("未填写原因", "No reason"))}</p><div class="cf-actions">${item.status === "pending_review" ? `${button(l("批准", "Approve"), `refund-review:approve:${item.id}`)}${button(l("拒绝", "Reject"), `refund-review:reject:${item.id}`, "danger-btn")}` : ""}${item.status === "processing_failed" ? button(l("重试", "Retry"), `refund-review:retry:${item.id}`, "secondary") : ""}</div></article>`).join("") || empty(l("暂无退款申请", "No refund requests"))}</div>`;
}

function renderAdminSettings() {
  const data = state.admin.settings;
  if (!data) return loadingMarkup();
  const settings = data.settings;
  const nodes = (settings.clicd_nodes || []).map((node) => `${node.label}|${node.url}|`).join("\n");
  const insecureNodes = (settings.clicd_nodes || []).filter((node) => node.insecure).map((node) => node.label).join("、");
  return `<div class="cf-stack">${insecureNodes ? `<div class="notice warning"><b>${l("HTTP CLICD 节点", "HTTP CLICD nodes")}</b><p>${escapeHtml(insecureNodes)} · ${l("API Token 将由 Worker 通过明文 HTTP 传输。", "The Worker sends API tokens over plaintext HTTP.")}</p></div>` : ""}
    <form data-form="admin-settings" class="card cf-form-grid"><label><span>${l("网站名称", "Site name")}</span><input name="site_name" value="${escapeHtml(settings.site_name)}"></label><label><span>${l("网站副标题", "Site tagline")}</span><input name="site_tagline" value="${escapeHtml(settings.site_tagline)}"></label><label class="wide"><span>${l("网站公开地址", "Public site URL")}</span><input name="site_url" type="url" value="${escapeHtml(settings.site_url)}" placeholder="https://example.workers.dev"></label><label class="wide"><span>${l("页脚文案", "Footer")}</span><input name="site_footer" value="${escapeHtml(settings.site_footer)}"></label>
    <label class="wide"><span>CLICD · ${l("每行 label|url|token，留空 token 保留原值；支持 http/https", "one label|url|token per line; blank token keeps current value; HTTP/HTTPS supported")}</span><textarea name="clicd_nodes" rows="5">${escapeHtml(nodes)}</textarea></label><label><span>HashPay URL</span><input name="hashpay_base_url" type="url" value="${escapeHtml(settings.hashpay_base_url)}"></label><label><span>HashPay Merchant ID</span><input name="hashpay_merchant_id" value="${escapeHtml(settings.hashpay_merchant_id)}"></label><label class="wide"><span>HashPay RSA Private Key · ${settings.hashpay_private_key_configured ? l("已配置", "configured") : l("未配置", "not configured")}</span><textarea name="hashpay_private_key" rows="5" placeholder="${l("留空保留现值", "Leave blank to keep current value")}"></textarea></label><label class="wide"><span>Resend From · ${settings.resend_api_token_configured ? l("API Token 已配置", "API token configured") : l("API Token 未配置", "API token missing")}</span><input name="resend_from" value="${escapeHtml(settings.resend_from)}" placeholder="VPS-ONE &lt;noreply@example.com&gt;"></label><button class="btn wide">${l("保存设置", "Save settings")}</button></form>
    <form data-form="resend-test" class="card cf-form-grid"><div class="wide"><div class="eyebrow">RESEND</div><h2>${l("邮件投递测试", "Email delivery test")}</h2></div><label class="wide"><span>${l("收件邮箱", "Recipient")}</span><input name="recipient" type="email" value="${escapeHtml(state.session.user?.email || "")}" required></label><button class="btn wide" ${settings.resend_api_token_configured ? "" : "disabled"}>${l("发送测试邮件", "Send test email")}</button></form></div>`;
}

function renderAdmin() {
  if (!state.session.user?.is_admin) return go("store");
  const content = state.adminTab === "overview" ? renderAdminOverview() : state.adminTab === "plans" ? renderAdminPlans() : state.adminTab === "products" ? renderAdminProducts() : state.adminTab === "refunds" ? renderAdminRefunds() : renderAdminSettings();
  app.innerHTML = `<section class="cf-shell"><div class="cf-toolbar"><div><div class="eyebrow">EDGE ADMIN</div><h1>${l("管理工作区", "Admin workspace")}</h1></div></div>${adminTabs()}<div id="admin-content">${content || ""}</div></section>`;
  syncPlanFields();
  const ready = state.adminTab === "plans" ? state.admin.plans && state.admin.catalog : state.admin[state.adminTab];
  if (!ready && !state.loadingAdmin.has(state.adminTab)) queueMicrotask(() => loadAdmin(state.adminTab));
}

function render() {
  renderNav();
  if (state.config && !state.config.initialized) return renderSetup();
  const current = view();
  if (current === "login" || current === "register") renderAuth(current);
  else if (current === "dashboard") state.session.user ? renderDashboard() : renderAuth("login");
  else if (current === "account") state.session.user ? renderAccount() : renderAuth("login");
  else if (current === "admin") renderAdmin();
  else renderStore();
}

async function loadingAccount(target) {
  app.innerHTML = `<section class="cf-loading"><span></span><span></span><span></span></section>`;
  try { state.account = await api("/account"); render(); } catch (error) { flash(error.message, true); go("login"); }
}

async function loadAdmin(tab) {
  if (state.loadingAdmin.has(tab)) return;
  state.loadingAdmin.add(tab);
  const host = document.getElementById("admin-content");
  if (host) host.innerHTML = `<section class="cf-loading"><span></span><span></span><span></span></section>`;
  try {
    if (tab === "overview") state.admin.overview = await api("/admin");
    if (tab === "plans") {
      [state.admin.plans, state.admin.catalog] = await Promise.all([api("/admin/plans"), api("/admin/clicd/images")]);
    }
    if (tab === "products") state.admin.products = await api("/admin/products");
    if (tab === "refunds") state.admin.refunds = await api("/admin/refunds");
    if (tab === "settings") state.admin.settings = await api("/admin/settings");
    render();
  } catch (error) { flash(error.message, true); }
  finally { state.loadingAdmin.delete(tab); }
}

function formObject(form) {
  const data = Object.fromEntries(new FormData(form));
  for (const input of form.querySelectorAll('input[type="checkbox"]')) data[input.name] = input.checked;
  return data;
}

function syncPlanFields() {
  const form = document.querySelector('[data-form="admin-plan"]');
  if (!form) return;
  const card = form.elements.product_type.value === "card";
  form.querySelector("[data-cloud-fields]").hidden = card;
  form.querySelector("[data-card-fields]").hidden = !card;
  for (const control of form.querySelectorAll("[data-cloud-fields] input,[data-cloud-fields] select")) control.disabled = card;
  for (const option of form.elements.clicd_choice?.options || []) {
    if (!option.dataset.type) continue;
    const matches = option.dataset.type === form.elements.virtualization.value;
    option.hidden = !matches;
    option.disabled = !matches;
  }
}

async function openVnc(instanceId) {
  const result = await api(`/instances/${instanceId}/vnc-session`, { method: "POST", body: {} });
  const dialog = document.getElementById("vnc-dialog");
  const screen = document.getElementById("vnc-screen");
  document.getElementById("vnc-title").textContent = result.instance;
  screen.textContent = l("连接中", "Connecting");
  dialog.showModal();
  const { default: RFB } = await import("/assets/vendor/novnc/core/rfb.js");
  const url = new URL(result.websocket_url, location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  screen.textContent = "";
  state.vnc?.disconnect();
  state.vnc = new RFB(screen, url.toString(), { shared: true });
  state.vnc.scaleViewport = true;
  state.vnc.resizeSession = false;
  state.vnc.addEventListener("securityfailure", () => flash(l("VNC 安全协商失败", "VNC security negotiation failed"), true));
  state.vnc.addEventListener("disconnect", (event) => { if (!event.detail.clean) flash(l("VNC 连接已断开", "VNC disconnected"), true); });
}

document.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-action],[data-close-vnc]");
  if (!target) return;
  if (target.hasAttribute("data-close-vnc")) {
    state.vnc?.disconnect(); state.vnc = null; document.getElementById("vnc-dialog").close(); return;
  }
  const action = target.dataset.action || "";
  try {
    if (action === "nav" || action.startsWith("nav-")) return go(target.dataset.target || action.slice(4));
    if (action === "logout") { await api("/auth/logout", { method: "POST" }); state.session = { user: null, csrf_token: "" }; state.account = null; go("store"); return render(); }
    if (action.startsWith("buy-")) {
      const parsed = action.match(/^buy-(wallet|hashpay):(\d+)$/);
      if (!parsed) throw new Error("Invalid purchase action");
      const [, method, id] = parsed;
      const result = await api("/orders", { method: "POST", body: { plan_id: Number(id), payment_method: method } });
      if (result.checkout_url) location.href = result.checkout_url; else { flash(l("购买成功，正在交付", "Purchase complete; delivery started")); state.account = null; go("account"); }
      return;
    }
    if (action.startsWith("access:")) {
      const id = Number(action.split(":")[1]); const result = await api(`/instances/${id}/access`); const host = document.getElementById(`access-${id}`);
      const managementUrl = /^https?:\/\//i.test(result.access.management_url || "") ? result.access.management_url : "";
      host.innerHTML = `<div class="notice"><div class="cf-facts"><div><span>${l("SSH 用户名", "SSH username")}</span><strong>${escapeHtml(result.access.ssh_username || "root")}</strong></div><div><span>${l("SSH 密码", "SSH password")}</span><strong class="cf-code">${escapeHtml(result.access.ssh_password || "-")}</strong></div><div><span>${l("管理用户名", "Management username")}</span><strong>${escapeHtml(result.access.username || "-")}</strong></div><div><span>${l("初始密码", "Initial password")}</span><strong class="cf-code">${escapeHtml(result.access.password || "-")}</strong></div><div><span>${l("访问码", "Access code")}</span><strong class="cf-code">${escapeHtml(result.access.access_code || "-")}</strong></div><div><span>${l("访问链接", "Management URL")}</span><strong class="cf-code">${managementUrl ? `<a href="${escapeHtml(managementUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(managementUrl)}</a>` : "-"}</strong></div><div><span>IPv4</span><strong>${escapeHtml(result.instance.ip || "-")}</strong></div><div><span>IPv6</span><strong>${escapeHtml(result.instance.ipv6 || "-")}</strong></div><div><span>SSH</span><strong>${escapeHtml(result.instance.ip || result.instance.ipv6 || "-")}:${result.instance.ssh_port || 22}</strong></div></div></div>`; return;
    }
    if (action.startsWith("instance:")) { const [, operation, id] = action.split(":"); await api(`/instances/${id}/actions/${operation}`, { method: "POST", body: {} }); flash(l("操作已提交", "Action submitted")); state.account = null; return render(); }
    if (action.startsWith("vnc:")) return openVnc(Number(action.split(":")[1]));
    if (action.startsWith("refund-request:")) { await api(`/account/orders/${action.split(":")[1]}/refunds`, { method: "POST", body: { reason: l("用户自助撤销", "Customer cancellation") } }); flash(l("确认码已发送", "Confirmation code sent")); state.account = null; return render(); }
    if (action.startsWith("refund-resend:")) { await api(`/account/refunds/${action.split(":")[1]}/resend`, { method: "POST", body: {} }); return flash(l("确认码已重新发送", "Code sent again")); }
    if (action.startsWith("card-resend:")) { await api(`/account/orders/${action.split(":")[1]}/card-email`, { method: "POST", body: {} }); return flash(l("交付邮件已重新入队", "Delivery email queued")); }
    if (action.startsWith("admin-tab:")) { state.adminTab = action.split(":")[1]; render(); return; }
    if (action.startsWith("plan-edit:")) { state.editPlan = state.admin.plans.plans.find((item) => item.id === Number(action.split(":")[1])); return render(); }
    if (action === "plan-edit-cancel") { state.editPlan = null; return render(); }
    if (action.startsWith("plan-toggle:")) { await api(`/admin/plans/${action.split(":")[1]}/toggle`, { method: "POST", body: {} }); state.admin.plans = null; return loadAdmin("plans"); }
    if (action.startsWith("refund-review:")) { const [, operation, id] = action.split(":"); await api(`/admin/refunds/${id}/${operation}`, { method: "POST", body: { review_note: "Cloudflare admin review" } }); state.admin.refunds = null; return loadAdmin("refunds"); }
    if (action.startsWith("job-retry:")) { await api(`/admin/jobs/${action.split(":")[1]}/retry`, { method: "POST", body: {} }); flash(l("任务已重新入队", "Job queued again")); state.admin.overview = null; return loadAdmin("overview"); }
    if (action.startsWith("product:")) { const [, operation, node, id] = action.split(":"); if (operation === "delete" && !confirm(l("永久删除该容器？", "Delete this container permanently?"))) return; await api(`/admin/products/action?action=${operation}`, { method: "POST", body: { node: decodeURIComponent(node), id: decodeURIComponent(id) } }); state.admin.products = null; return loadAdmin("products"); }
  } catch (error) { flash(error.message, true); }
});

document.addEventListener("change", (event) => {
  if (event.target.closest('[data-form="admin-plan"]')) syncPlanFields();
});

document.addEventListener("submit", async (event) => {
  const form = event.target.closest("[data-form]");
  if (!form) return;
  event.preventDefault();
  const data = formObject(form);
  try {
    if (form.dataset.form === "bootstrap") {
      const token = data.bootstrap_token;
      delete data.bootstrap_token;
      state.session = await api("/bootstrap", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: data });
      state.config.initialized = true;
      flash(l("管理员创建完成", "Administrator created"));
      go("admin");
      return render();
    }
    if (form.dataset.form === "login" || form.dataset.form === "register") {
      state.session = await api(`/auth/${form.dataset.form}`, { method: "POST", body: data }); state.account = null; go("store"); return render();
    }
    if (form.dataset.form === "topup") { const result = await api("/account/topups", { method: "POST", body: data }); location.href = result.checkout_url; return; }
    if (form.dataset.form === "refund-confirm") { await api(`/account/refunds/${form.dataset.id}/confirm`, { method: "POST", body: data }); flash(l("已提交后台审核", "Submitted for review")); state.account = null; return render(); }
    if (form.dataset.form === "admin-plan") {
      const [node, image] = String(data.clicd_choice || "").split("\u001f"); data.clicd_node = node || ""; data.clicd_image = image || ""; delete data.clicd_choice;
      await api("/admin/plans", { method: "POST", body: data }); state.editPlan = null; state.admin.plans = null; return loadAdmin("plans");
    }
    if (form.dataset.form === "card-import") { await api(`/admin/plans/${form.dataset.id}/cards`, { method: "POST", body: data }); flash(l("库存已导入", "Inventory imported")); state.admin.plans = null; return loadAdmin("plans"); }
    if (form.dataset.form === "resend-test") { const result = await api("/admin/settings/test/resend", { method: "POST", body: data }); return flash(`${l("测试邮件已发送至", "Test email sent to")} ${result.recipient}`); }
    if (form.dataset.form === "admin-settings") {
      data.clicd_nodes = String(data.clicd_nodes || "").split("\n").map((line) => line.trim()).filter(Boolean).map((line) => { const [label, url, token] = line.split("|"); return { label, url, token }; });
      await api("/admin/settings", { method: "POST", body: data }); flash(l("设置已保存", "Settings saved")); state.admin.settings = null; return loadAdmin("settings");
    }
  } catch (error) { flash(error.message, true); }
});

window.addEventListener("hashchange", render);
window.addEventListener("vps-ui-change", render);

async function start() {
  try {
    const [config, session, plans] = await Promise.all([api("/config"), api("/session"), api("/plans")]);
    state.config = config;
    state.session = session;
    state.plans = plans.plans || [];
    render();
  } catch (error) {
    app.innerHTML = `<section class="cf-auth card"><h1>${l("服务不可用", "Service unavailable")}</h1><p class="danger">${escapeHtml(error.message)}</p></section>`;
  }
}

start();
