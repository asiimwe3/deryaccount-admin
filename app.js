/* DeryAccount Admin — owner dashboard (read-only).
 *
 * Data comes from Supabase, uploaded by the tills. This file never writes to
 * sales: it only reads. Local books on each till remain authoritative.
 *
 * Time: every "day" is a Uganda day (Africa/Kampala, UTC+3, no DST). A sale at
 * 00:30 in Kampala belongs to that day, not the previous UTC day.
 */
(function () {
  'use strict';

  var TZ = 'Africa/Kampala';
  var sb = null;
  var state = {
    rows: [],
    branches: [],
    staff: {},
    devices: [],
    filter: { branch: 'ALL', platform: 'ALL', days: 7 },
    loading: false,
    error: null,
    loadedAt: null
  };

  var el = document.getElementById('app');

  // ── helpers ───────────────────────────────────────────────────────────────
  function configured() {
    return !!(window.DERY_CONFIG && window.DERY_CONFIG.supabaseUrl && window.DERY_CONFIG.supabaseAnonKey);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Uganda-local calendar day for an instant, as YYYY-MM-DD.
  function localDay(d) {
    var parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(d);
    var o = {};
    parts.forEach(function (p) { o[p.type] = p.value; });
    return o.year + '-' + o.month + '-' + o.day;
  }

  function dayOffset(n) {
    var d = new Date();
    d.setUTCDate(d.getUTCDate() - n);
    return localDay(d);
  }

  // Start of a Uganda day, as a UTC instant (Kampala = UTC+3, fixed).
  function dayStartUtc(dayStr) {
    return new Date(dayStr + 'T00:00:00+03:00');
  }

  function money(n) {
    var v = Number(n || 0);
    return 'UGX ' + v.toLocaleString('en-UG', { maximumFractionDigits: 0 });
  }

  function stamp(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d)) return '—';
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
    }).format(d);
  }

  function ago(iso) {
    if (!iso) return 'never';
    var mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' min ago';
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + ' h ago';
    return Math.round(hrs / 24) + ' d ago';
  }

  // ── data ──────────────────────────────────────────────────────────────────
  function filtered() {
    var since = dayStartUtc(dayOffset(state.filter.days - 1));
    return state.rows.filter(function (r) {
      var t = new Date(r.sold_at || r.created_at || 0);
      if (isNaN(t) || t < since) return false;
      if (state.filter.branch !== 'ALL' && r.branch_id !== state.filter.branch) return false;
      if (state.filter.platform !== 'ALL' && (r.platform || 'unknown') !== state.filter.platform) return false;
      return true;
    });
  }

  function totals(rows) {
    var t = { revenue: 0, vat: 0, discount: 0, tickets: rows.length };
    rows.forEach(function (r) {
      t.revenue += Number(r.total || 0);
      t.vat += Number(r.tax_total || 0);
      t.discount += Number(r.discount || 0);
    });
    return t;
  }

  function byDay(rows) {
    var map = {};
    rows.forEach(function (r) {
      var d = localDay(new Date(r.sold_at || r.created_at));
      if (!map[d]) map[d] = { day: d, revenue: 0, tickets: 0 };
      map[d].revenue += Number(r.total || 0);
      map[d].tickets += 1;
    });
    var out = [];
    for (var i = state.filter.days - 1; i >= 0; i--) {
      var d = dayOffset(i);
      out.push(map[d] || { day: d, revenue: 0, tickets: 0 });
    }
    return out;
  }

  function load() {
    state.loading = true;
    state.error = null;
    render();

    var since = new Date(Date.now() - 100 * 24 * 3600 * 1000).toISOString();
    Promise.all([
      sb.from('sales').select('*').gte('sold_at', since).order('sold_at', { ascending: false }).limit(20000),
      sb.from('branches').select('id,name,code'),
      sb.from('staff').select('id,name'),
      sb.from('devices').select('id,name,platform,branch_id,last_sync_at,last_seen_at')
    ]).then(function (res) {
      var err = res[0].error || res[1].error;
      if (err) throw err;
      state.rows = res[0].data || [];
      state.branches = res[1].data || [];
      state.staff = {};
      (res[2].data || []).forEach(function (s) { state.staff[s.id] = s.name; });
      state.devices = res[3].data || [];
      state.loadedAt = new Date().toISOString();
      state.loading = false;
      render();
    }).catch(function (e) {
      state.error = (e && e.message) ? e.message : 'Could not reach the database.';
      state.loading = false;
      render();
    });
  }

  function csv() {
    var rows = filtered();
    var head = ['receipt_no', 'sold_at_kampala', 'branch', 'platform', 'cashier', 'payment_method',
      'subtotal', 'vat', 'discount', 'total', 'amount_paid', 'change_given', 'status'];
    var lines = [head.join(',')];
    rows.forEach(function (r) {
      var vals = [
        r.receipt_no || '', stamp(r.sold_at || r.created_at),
        branchName(r.branch_id), r.platform || '', state.staff[r.user_id] || r.user_id || '',
        r.payment_method || '', r.subtotal, r.tax_total, r.discount, r.total,
        r.amount_paid, r.change_given, r.status || ''
      ];
      lines.push(vals.map(function (v) {
        var s = String(v == null ? '' : v);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(','));
    });
    var blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'deryaccount-sales-' + dayOffset(0) + '.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function branchName(id) {
    for (var i = 0; i < state.branches.length; i++) {
      if (state.branches[i].id === id) return state.branches[i].name || id;
    }
    return id || '—';
  }

  // ── views ─────────────────────────────────────────────────────────────────
  function setupScreen() {
    el.innerHTML = '' +
      '<div class="center"><div class="card narrow">' +
      '<h1>Connect the database</h1>' +
      '<p>This dashboard is live but not yet pointed at a Supabase project.</p>' +
      '<ol>' +
      '<li>Create a Supabase project.</li>' +
      '<li>SQL editor: run <code>supabase/schema.sql</code>.</li>' +
      '<li>Project Settings → API: copy the URL and the <b>anon</b> key.</li>' +
      '<li>Put both into <code>config.js</code> and redeploy.</li>' +
      '</ol>' +
      '<p class="muted">Never put the service_role key here. This file is public.</p>' +
      '</div></div>';
  }

  function loginScreen(message) {
    el.innerHTML = '' +
      '<div class="center"><form class="card narrow" id="login">' +
      '<h1>DeryAccount Admin</h1>' +
      '<p class="muted">Sign in with your owner account.</p>' +
      (message ? '<p class="error">' + esc(message) + '</p>' : '') +
      '<label>Email<input type="email" id="email" autocomplete="username" required></label>' +
      '<label>Password<input type="password" id="password" autocomplete="current-password" required></label>' +
      '<button type="submit">Sign in</button>' +
      '</form></div>';
    document.getElementById('login').addEventListener('submit', function (e) {
      e.preventDefault();
      var email = document.getElementById('email').value.trim();
      var pass = document.getElementById('password').value;
      sb.auth.signInWithPassword({ email: email, password: pass }).then(function (r) {
        if (r.error) loginScreen(r.error.message);
        else load();
      });
    });
  }

  function chart(days) {
    var max = Math.max.apply(null, days.map(function (d) { return d.revenue; }).concat([1]));
    var bars = days.map(function (d) {
      var h = Math.round((d.revenue / max) * 100);
      return '<div class="bar-wrap" title="' + esc(d.day) + ': ' + esc(money(d.revenue)) + '">' +
        '<div class="bar" style="height:' + Math.max(h, 2) + '%"></div>' +
        '<span>' + esc(d.day.slice(8)) + '</span></div>';
    }).join('');
    return '<div class="chart">' + bars + '</div>';
  }

  function syncPanel() {
    if (!state.devices.length) {
      return '<div class="card"><h3>Devices</h3><p class="muted">No till has synced yet. ' +
        'Register a device in Supabase and add its token in the app settings.</p></div>';
    }
    var rows = state.devices.map(function (d) {
      var stale = !d.last_sync_at || (Date.now() - new Date(d.last_sync_at).getTime()) > 24 * 3600 * 1000;
      return '<tr><td>' + esc(d.name || d.id) + '</td><td>' + esc(d.platform || '—') + '</td>' +
        '<td>' + esc(branchName(d.branch_id)) + '</td>' +
        '<td class="' + (stale ? 'warn' : 'ok') + '">' + esc(ago(d.last_sync_at)) + '</td></tr>';
    }).join('');
    return '<div class="card"><h3>Devices</h3><table class="mini">' +
      '<thead><tr><th>Till</th><th>Platform</th><th>Branch</th><th>Last sync</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div>';
  }

  function dashboard() {
    var rows = filtered();
    var t = totals(rows);
    var android = rows.filter(function (r) { return r.platform === 'android'; });
    var desktop = rows.filter(function (r) { return r.platform === 'desktop'; });

    var branchOpts = ['<option value="ALL">All branches</option>'].concat(
      state.branches.map(function (b) {
        return '<option value="' + esc(b.id) + '"' + (state.filter.branch === b.id ? ' selected' : '') + '>' +
          esc(b.name || b.id) + '</option>';
      })).join('');

    var recent = rows.slice(0, 40).map(function (r) {
      return '<tr><td>' + esc(r.receipt_no || '—') + '</td>' +
        '<td>' + esc(stamp(r.sold_at || r.created_at)) + '</td>' +
        '<td>' + esc(branchName(r.branch_id)) + '</td>' +
        '<td>' + esc(r.platform || '—') + '</td>' +
        '<td>' + esc(state.staff[r.user_id] || r.user_id || '—') + '</td>' +
        '<td>' + esc(r.payment_method || '—') + '</td>' +
        '<td class="num">' + esc(money(r.total)) + '</td></tr>';
    }).join('');

    el.innerHTML = '' +
      '<header class="topbar">' +
      '<div><strong>DeryAccount</strong> <span class="muted">Admin</span></div>' +
      '<div class="right">' +
      '<span class="muted" id="synced">' + (state.loadedAt ? 'Updated ' + esc(ago(state.loadedAt)) : '') + '</span>' +
      '<button class="ghost" id="refresh">Refresh</button>' +
      '<button class="ghost" id="logout">Sign out</button>' +
      '</div></header>' +

      '<div class="filters">' +
      '<select id="days">' + [1, 7, 30, 90].map(function (d) {
        return '<option value="' + d + '"' + (state.filter.days === d ? ' selected' : '') + '>Last ' + d + ' day' + (d > 1 ? 's' : '') + '</option>';
      }).join('') + '</select>' +
      '<select id="branch">' + branchOpts + '</select>' +
      '<select id="platform">' + ['ALL', 'android', 'desktop'].map(function (p) {
        return '<option value="' + p + '"' + (state.filter.platform === p ? ' selected' : '') + '>' +
          (p === 'ALL' ? 'All tills' : p === 'android' ? 'Android' : 'Desktop') + '</option>';
      }).join('') + '</select>' +
      '<button class="ghost" id="export">Export CSV</button>' +
      '</div>' +

      (state.error ? '<div class="banner error">' + esc(state.error) + ' <button class="ghost" id="retry">Retry</button></div>' : '') +

      '<div class="kpis">' +
      kpi('Revenue', money(t.revenue)) +
      kpi('VAT collected', money(t.vat)) +
      kpi('Discounts', money(t.discount)) +
      kpi('Tickets', String(t.tickets)) +
      '</div>' +

      '<div class="grid">' +
      '<div class="card"><h3>Daily sales</h3>' + chart(byDay(rows)) + '</div>' +
      '<div class="card"><h3>Till split</h3>' +
      '<p>Android <b>' + esc(money(totals(android).revenue)) + '</b> · ' + android.length + ' tickets</p>' +
      '<p>Desktop <b>' + esc(money(totals(desktop).revenue)) + '</b> · ' + desktop.length + ' tickets</p>' +
      '<p class="muted">All amounts include VAT; VAT shown separately above.</p>' +
      '</div></div>' +

      syncPanel() +

      '<div class="card"><h3>Recent sales</h3>' +
      (rows.length ? '<table><thead><tr><th>Receipt</th><th>When</th><th>Branch</th><th>Till</th><th>Cashier</th><th>Payment</th><th class="num">Total</th></tr></thead><tbody>' + recent + '</tbody></table>'
        : '<p class="muted">No sales in this period yet. Sales appear here after a till syncs.</p>') +
      '</div>' +

      '<p class="muted foot">Read-only view. Selling and accounting stay on the tills.</p>';

    document.getElementById('refresh').onclick = load;
    document.getElementById('logout').onclick = function () { sb.auth.signOut().then(function () { render(); }); };
    document.getElementById('export').onclick = csv;
    document.getElementById('days').onchange = function (e) { state.filter.days = Number(e.target.value); render(); };
    document.getElementById('branch').onchange = function (e) { state.filter.branch = e.target.value; render(); };
    document.getElementById('platform').onchange = function (e) { state.filter.platform = e.target.value; render(); };
    var retry = document.getElementById('retry');
    if (retry) retry.onclick = load;
  }

  function kpi(label, value) {
    return '<div class="card kpi"><span class="muted">' + esc(label) + '</span><strong>' + esc(value) + '</strong></div>';
  }

  function render() {
    if (!configured()) return setupScreen();
    if (state.loading && !state.rows.length) {
      el.innerHTML = '<div class="center"><div class="card narrow"><div class="spinner"></div><p>Loading your sales…</p></div></div>';
      return;
    }
    dashboard();
  }

  // ── boot ──────────────────────────────────────────────────────────────────
  function boot() {
    if (!configured()) return render();
    sb = window.supabase.createClient(window.DERY_CONFIG.supabaseUrl, window.DERY_CONFIG.supabaseAnonKey);
    sb.auth.getSession().then(function (r) {
      if (r.data && r.data.session) load();
      else loginScreen();
    });
    sb.auth.onAuthStateChange(function (_e, session) {
      if (!session) loginScreen();
    });
  }

  boot();
})();
