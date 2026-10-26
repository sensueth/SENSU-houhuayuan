function renderHoldings() {
  const box = $('#holdings-list');
  const tbody = $('#holdings-tbody');
  const meta = $('#holdings-meta');
  if (!meta) return;
  const h = S.holdings;
  if (!h) {
    meta.textContent = '加载中…';
    return;
  }
  if (!h.ok && !(h.items && h.items.length)) {
    meta.textContent = h.error || '持仓读取失败';
    if (tbody) tbody.innerHTML = '';
    if (box) box.innerHTML = '';
    return;
  }
  const t = h.updatedAt ? new Date(h.updatedAt) : null;
  const filtered = filterHoldItems(h.items || []);
  let sumFilt = 0, nVal = 0;
  for (const it of filtered) {
    const v = holdItemValueUsd(it);
    if (v != null) { sumFilt += v; nVal += 1; }
  }
  const totAll = h.totalValueUsd != null && Number.isFinite(h.totalValueUsd)
    ? fmtHoldUsd(h.totalValueUsd) : null;
  meta.textContent = (filtered.length !== (h.items || []).length
    ? `筛选 ${filtered.length}/${(h.items || []).length} 项`
    : `${(h.items || []).length} 项`)
    + (nVal ? ` · 表内合计 ${fmtHoldUsd(sumFilt)}` : '')
    + (totAll ? ` · 全仓 ${totAll}` : '')
    + (h.meta?.unvaluedCount ? `（${h.meta.unvaluedCount} 无估值）` : '')
    + (t ? ` · ${t.toLocaleTimeString('zh-CN', { hour12: false })}` : '')
    + (h.meta?.bawError ? ` · baw: ${h.meta.bawError}` : '');

  if (tbody) {
    tbody.innerHTML = '';
    if (!(h.items || []).length) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="8" class="holdings-empty">当前无曲线/相关持仓（baw + 看板链上探测）</td>';
      tbody.append(tr);
    } else if (!filtered.length) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="8" class="holdings-empty">没有符合筛选的持仓</td>';
      tbody.append(tr);
    } else if ((S.holdSort || 'value-desc') === 'group') {
      const buckets = Object.fromEntries(HOLD_GROUPS.map(g => [g.key, []]));
      for (const it of filtered) buckets[holdGroupKey(it)].push(it);
      for (const g of HOLD_GROUPS) {
        const items = sortHoldItems(buckets[g.key], 'value-desc');
        if (!items.length) continue;
        const hr = document.createElement('tr');
        hr.className = 'hold-group-row';
        hr.innerHTML = `<td colspan="8"><span class="hold-group-label ${esc(g.platClass)}">${esc(g.label)}</span> <span class="hold-group-count">${items.length}</span></td>`;
        tbody.append(hr);
        for (const it of items) tbody.append(makeHoldRow(it));
      }
    } else {
      for (const it of sortHoldItems(filtered)) tbody.append(makeHoldRow(it));
    }
  }

  if (box) { box.innerHTML = ''; box.hidden = true; }
}
