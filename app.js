/* DeryAccount Admin — owner dashboard.
 * Reads the tables the Android/desktop sync engine already pushes.
 * No data is ever written from the browser; this screen is read-only.
 */
(function () {
  const cfg = window.DERY_CONFIG || {};
  const root = document.getElementById("app");
  let sb = null, profile = null, branches = [], state = { days: 7, branch: "ALL" };

  const money = (n) =>
    "UGX " + (Number(n) || 0).toLocaleString("en-UG", { maximumFractionDigits: 0 });
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function configured() {
    return !!(cfg.supabaseUrl && cfg.supabaseAnonKey);
  }

  function shell(inner) {
    root.innerHTML =
      '<div class="topbar"><div class="brand"><span class="dot"></span>DeryAccount <b>Admin</b></div>' +
      (profile ? '<div class="who">' + esc(profile.email || "") +
        ' <button id="out" class="ghost">Sign out</button></div>' : "") +
      "</div><main>" + inner + "</main>";
    const out = document.getElementById("out");
    if (out) out.onclick = async () => { await sb.auth.signOut(); profile = null; render(); };
  }

  function setupScreen() {
    shell(
      '<section class="card"><h1>Connect the database</h1>' +
      "<p>This dashboard reads the sales your phones and desktops push to Supabase. " +
      "Open <code>config.js</code> and paste the project URL and the <b>anon</b> key from " +
      "Supabase &rarr; Project Settings &rarr; API, then reload.</p>" +
      '<p class="muted">Never paste the service_role key here.</p></section>'
    );
  }

  function loginScreen() {
    shell(
      '<section class="card narrow"><h1>Owner sign in</h1>' +
      '<p class="muted">The same account you use to manage the business.</p>' +
      '<label>Email<input id="em" type="email" autocomplete="username"></label>' +
      '<label>Password<input id="pw" type="password" autocomplete="current-password"></label>' +
      '<button id="go" class="primary">Sign in</button>' +
      '<p id="err" class="err"></p></section>'
    );
    document.getElementById("go").onclick = async () => {
      const em = document.getElementById("em").value.trim();
      const pw = document.getElementById("pw").value;
      const err = document.getElementById("err");
      err.textContent = "";
      const { error } = await sb.auth.signInWithPassword({ email: em, password: pw });
      if (error) { err.textContent = error.message; return; }
      await boot();
    };
  }

  async function loadProfile() {
    const { data: userData } = await sb.auth.getUser();
    if (!userData || !userData.user) return null;
    const { data } = await sb.from("profiles").select("org_id,email,role").eq("id", userData.user.id).maybeSingle();
    if (!data) {
      return { email: userData.user.email, org_id: null, role: null, missing: true };
    }
    return { email: data.email || userData.user.email, org_id: data.org_id, role: data.role };
  }

  async function loadBranches() {
    const { data } = await sb.from("branches").select("id,name").order("name");
    branches = data || [];
  }

  function sinceIso(days) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - (days - 1));
    return d.toISOString();
  }

  async function loadSales() {
    let q = sb.from("sales")
      .select("id,receiptNo,total,taxTotal,discount,paymentMethod,createdAt,branchId,platform,isDeleted")
      .gte("createdAt", sinceIso(state.days))
      .eq("isDeleted", false)
      .order("createdAt", { ascending: false })
      .limit(500);
    if (state.branch !== "ALL") q = q.eq("branchId", state.branch);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  }

  function groupByDay(rows, days) {
    const map = new Map();
    for (let i = 0; i < days; i++) {
      const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i);
      map.set(d.toISOString().slice(0, 10), 0);
    }
    rows.forEach((r) => {
      const k = new Date(r.createdAt).toISOString().slice(0, 10);
      if (map.has(k)) map.set(k, map.get(k) + Number(r.total || 0));
    });
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }

  function bars(series) {
    const max = Math.max(1, ...series.map((s) => s[1]));
    return '<div class="bars">' + series.map(([day, v]) =>
      '<div class="bar" title="' + day + ": " + money(v) + '">' +
      '<i style="height:' + Math.round((v / max) * 100) + '%"></i></div>').join("") + "</div>";
  }

  async function dashboard() {
    let rows = [];
    let failed = "";
    try { rows = await loadSales(); } catch (e) { failed = e.message || String(e); }

    const todayKey = new Date().toISOString().slice(0, 10);
    const today = rows.filter((r) => new Date(r.createdAt).toISOString().slice(0, 10) === todayKey);
    const total = rows.reduce((a, r) => a + Number(r.total || 0), 0);
    const vat = rows.reduce((a, r) => a + Number(r.taxTotal || 0), 0);
    const android = rows.filter((r) => (r.platform || "android") === "android").length;
    const desktop = rows.filter((r) => r.platform === "desktop").length;

    const branchOptions = ['<option value="ALL">All branches</option>'].concat(
      branches.map((b) => '<option value="' + esc(b.id) + '"' +
        (state.branch === b.id ? " selected" : "") + ">" + esc(b.name || b.id) + "</option>")
    ).join("");

    shell(
      '<section class="filters">' +
      '<select id="branch">' + branchOptions + "</select>" +
      [7, 30, 90].map((d) => '<button class="chip' + (state.days === d ? " on" : "") +
        '" data-days="' + d + '">Last ' + d + " days</button>").join("") +
      '<button id="csv" class="ghost">Export CSV</button></section>' +
      (failed ? '<section class="card err">Could not read sales: ' + esc(failed) + "</section>" : "") +
      '<section class="kpis">' +
      kpi("Today", money(today.reduce((a, r) => a + Number(r.total || 0), 0)), today.length + " tickets") +
      kpi("Last " + state.days + " days", money(total), rows.length + " tickets") +
      kpi("VAT collected", money(vat), "included in totals") +
      kpi("Devices", android + " phone", desktop + " desktop") +
      "</section>" +
      '<section class="card"><h2>Daily sales</h2>' + bars(groupByDay(rows, state.days)) + "</section>" +
      '<section class="card"><h2>Recent sales</h2><div class="tablewrap"><table><thead><tr>' +
      "<th>Time</th><th>Receipt</th><th>Branch</th><th>Device</th><th>Payment</th><th class=\"r\">Total</th>" +
      "</tr></thead><tbody>" +
      (rows.slice(0, 100).map((r) =>
        "<tr><td>" + new Date(r.createdAt).toLocaleString() + "</td><td>" + esc(r.receiptNo) +
        "</td><td>" + esc(branchName(r.branchId)) + "</td><td>" + esc(r.platform || "android") +
        "</td><td>" + esc(r.paymentMethod) + '</td><td class="r">' + money(r.total) + "</td></tr>"
      ).join("") || '<tr><td colspan="6" class="muted">No sales in this period yet.</td></tr>') +
      "</tbody></table></div></section>"
    );

    document.getElementById("branch").onchange = (e) => { state.branch = e.target.value; dashboard(); };
    document.querySelectorAll("[data-days]").forEach((b) => {
      b.onclick = () => { state.days = Number(b.dataset.days); dashboard(); };
    });
    document.getElementById("csv").onclick = () => exportCsv(rows);
  }

  function kpi(label, value, sub) {
    return '<div class="card kpi"><span>' + esc(label) + "</span><b>" + esc(value) +
      "</b><small>" + esc(sub) + "</small></div>";
  }

  function branchName(id) {
    const b = branches.find((x) => x.id === id);
    return b ? (b.name || b.id) : (id || "");
  }

  function exportCsv(rows) {
    const head = ["createdAt", "receiptNo", "branch", "platform", "paymentMethod", "total", "taxTotal", "discount"];
    const body = rows.map((r) => [r.createdAt, r.receiptNo, branchName(r.branchId), r.platform || "android",
      r.paymentMethod, r.total, r.taxTotal, r.discount].map((v) =>
      '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"').join(","));
    const blob = new Blob([[head.join(",")].concat(body).join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "deryaccount-sales.csv";
    a.click();
  }

  async function boot() {
    profile = await loadProfile();
    if (!profile) { loginScreen(); return; }
    if (profile.missing) {
      shell('<section class="card"><h1>Almost there</h1><p>Your login works but no business is ' +
        "linked to it yet. Add a row to <code>profiles</code> with your user id and the org id, " +
        "then reload.</p></section>");
      return;
    }
    await loadBranches();
    await dashboard();
  }

  function render() {
    if (!configured()) { setupScreen(); return; }
    sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
    sb.auth.getSession().then(({ data }) => { if (data && data.session) boot(); else loginScreen(); });
  }

  render();
})();
