export function renderUsagePage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Browserless Key Balancer</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 24px; max-width: 1100px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  #meta { color: #888; font-size: 13px; margin: 0 0 16px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { border: 1px solid #ddd; padding: 6px 10px; text-align: left; vertical-align: top; }
  th { background: rgba(128,128,128,.12); }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  details > summary { cursor: pointer; color: #3b82f6; }
  details table { margin-top: 6px; }
  pre { white-space: pre-wrap; word-break: break-all; font-size: 11px; background: rgba(128,128,128,.08); padding: 8px; border-radius: 6px; }
  .ok { color: #16a34a; }
  .bad { color: #dc2626; }
  .note { font-size: 12px; color: #888; margin-top: 16px; }
</style>
</head>
<body>
  <h1>Browserless Key Balancer</h1>
  <p id="meta">Loading…</p>
  <div id="keys"></div>
  <p class="note">用量来自 Browserless 账号级 Usage API（默认 <code>api.browserless.io/v1/account/usage</code>）。同一账号下的多个 Key 会显示相同的用量。</p>
  <script>
    const token = new URLSearchParams(location.search).get('token');
    if (!token) {
      document.getElementById('meta').textContent = '缺少 ?token=… 参数，请带上代理 Token 访问。';
    } else {
      async function refresh() {
        try {
          const res = await fetch('/api/usage?token=' + encodeURIComponent(token), { cache: 'no-store' });
          if (!res.ok) {
            const text = await res.text();
            throw new Error(res.status + ' ' + text.slice(0, 120));
          }
          render(await res.json());
        } catch (err) {
          document.getElementById('meta').textContent = '加载失败：' + err.message;
        }
      }

      function esc(value) {
        return String(value).replace(/[&<>"']/g, (c) => (
          { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
        ));
      }

      function usageFields(json) {
        return Object.entries(json).map(([name, value]) =>
          '<tr><td>' + esc(name) + '</td><td>' + esc(typeof value === 'object' ? JSON.stringify(value) : value) + '</td></tr>'
        ).join('');
      }

      function render(data) {
        document.getElementById('meta').textContent =
          '更新于 ' + new Date(data.generatedAt).toLocaleString() + ' · 每 30 秒自动刷新';
        const rows = data.keys.map((k) => {
          const u = k.usage || {};
          const status = u.ok
            ? '<span class="ok">正常</span>'
            : '<span class="bad">' + esc(u.error || '未知') + '</span>';
          const cooldown = k.coolingDown
            ? '冷却中 ' + Math.ceil((k.cooldownRemainingMs || 0) / 1000) + 's'
            : '正常';
          const fields = u.ok && u.json ? usageFields(u.json) : '';
          return '<tr>' +
            '<td>#' + k.id + '</td>' +
            '<td><code>' + esc(k.masked) + '</code></td>' +
            '<td>' + cooldown + '</td>' +
            '<td>' + status + '</td>' +
            '<td><details><summary>详情</summary><table>' + fields + '</table>' +
            (u.raw ? '<pre>' + esc(u.raw) + '</pre>' : '') + '</details></td>' +
            '</tr>';
        }).join('');
        document.getElementById('keys').innerHTML =
          '<table><thead><tr><th>#</th><th>Key</th><th>状态</th><th>用量查询</th><th>详情</th></tr></thead>' +
          '<tbody>' + rows + '</tbody></table>';
      }

      refresh();
      setInterval(refresh, 30000);
    }
  <\/script>
</body>
</html>`;
}
