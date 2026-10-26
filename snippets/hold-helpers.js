function holdItemPnlUsd(it) {
  if (it?.pnlUsd != null && Number.isFinite(Number(it.pnlUsd))) return Number(it.pnlUsd);
  return null;
}

function holdItemPnlPct(it) {
  if (it?.pnlPct != null && Number.isFinite(Number(it.pnlPct))) return Number(it.pnlPct);
  return null;
}

function filterHoldItems(items) {
  let out = items.slice();
  const plat = S.holdPlat || 'all';
  if (plat !== 'all') out = out.filter(it => holdGroupKey(it) === plat);
  const vf = S.holdVal || 'all';
  if (vf === 'valued') out = out.filter(it => holdItemValueUsd(it) != null);
  else if (vf === 'unvalued') out = out.filter(it => holdItemValueUsd(it) == null);
  else if (vf !== 'all') {
    const min = Number(vf);
    if (Number.isFinite(min)) out = out.filter(it => {
      const v = holdItemValueUsd(it);
      return v != null && v >= min;
    });
  }
  const pf = S.holdPnl || 'all';
  if (pf === 'profit') out = out.filter(it => {
    const p = holdItemPnlUsd(it);
    return p != null ? p > 0 : (it.pnlBnb != null && Number(it.pnlBnb) > 0);
  });
  else if (pf === 'loss') out = out.filter(it => {
    const p = holdItemPnlUsd(it);
    return p != null ? p < 0 : (it.pnlBnb != null && Number(it.pnlBnb) < 0);
  });
  else if (pf === 'known') out = out.filter(it => it.pnlUsd != null || it.pnlBnb != null);
  else if (pf === 'unk') out = out.filter(it => it.pnlUsd == null && it.pnlBnb == null
    && it.platform !== 'native' && it.platform !== 'quote');
  return out;
}

function sortHoldItems(items, forceMode) {
  const mode = forceMode || S.holdSort || 'value-desc';
  if (mode === 'group') return sortHoldItems(items, 'value-desc');
  const arr = items.slice();
  const keyNum = (it, kind) => {
    if (kind === 'value') {
      const v = holdItemValueUsd(it);
      return v == null ? -Infinity : v;
    }
    if (kind === 'pnl') {
      const p = holdItemPnlUsd(it);
      if (p != null) return p;
      if (it.pnlBnb != null && Number.isFinite(Number(it.pnlBnb))) {
        return Number(it.pnlBnb) * (S.holdings?.meta?.bnbUsd || 0);
      }
      return -Infinity;
    }
    if (kind === 'pnlpct') {
      const p = holdItemPnlPct(it);
      return p == null ? -Infinity : p;
    }
    return 0;
  };
  const [kind, dir] = mode.split('-');
  const mul = dir === 'asc' ? 1 : -1;
  arr.sort((a, b) => {
    const av = keyNum(a, kind);
    const bv = keyNum(b, kind);
    if (av === bv) return String(a.symbol || '').localeCompare(String(b.symbol || ''));
    if (av === -Infinity && bv !== -Infinity) return 1;
    if (bv === -Infinity && av !== -Infinity) return -1;
    return (av - bv) * mul;
  });
  return arr;
}

function makeHoldRow(it) {
  const tr = document.createElement('tr');
  tr.className = 'hold-row' + (it.tradeable === false ? ' blocked' : '');
  const plat = it.platform || '?';
  const pad = (it.gangPad || '').toLowerCase();
  const padLbl = pad === 'u' ? 'U' : pad === 's' ? 'S' : pad;
  const valN = holdItemValueUsd(it);
  const valHtml = valN != null
    ? `<span class="h-usd" title="价值 · ${esc(it.valueSource || 'usd')}">${esc(fmtHoldUsd(valN))}</span>`
    : `<span class="h-usd unk" title="无可靠估值">价值?</span>`;
  const cost = fmtHoldCost(it);
  const costHtml = cost
    ? `<span class="h-cost ${cost.cls}" title="${esc(cost.title || '')}">${esc(cost.text)}</span>`
    : '—';
  const pnl = fmtHoldPnl(it);
  const pnlHtml = pnl
    ? `<span class="h-pnl ${pnl.cls}" title="${esc(pnl.title || '')}">${esc(pnl.text)}</span>`
    : '—';
  const nameHtml = it.name && it.symbol && String(it.name) !== String(it.symbol)
    ? `<span class="h-name" title="${esc(it.name)}">${esc(it.name)}</span> <span class="h-sym">$${esc(it.symbol)}</span>`
    : `<span class="h-sym" title="${esc(it.name || '')}">$${esc(it.symbol || '?')}</span>`;
  tr.innerHTML = `
    <td class="col-plat"><span class="h-plat ${esc(plat)}">${esc(String(plat).toUpperCase())}</span>${padLbl ? ` <span class="h-pad">${esc(padLbl)}</span>` : ''}</td>
    <td class="col-name">${nameHtml}</td>
    <td class="col-amt"><span class="h-amt">${esc(it.amountDisplay || fmtAmtHold(it.amount))}${it.unit === 'shares' ? ' 份' : ''}</span></td>
    <td class="col-val num">${valHtml}</td>
    <td class="col-cost num">${costHtml}</td>
    <td class="col-pnl num">${pnlHtml}</td>
    <td class="col-ca"><button type="button" class="h-ca" title="${esc(it.address || '')}">${esc(it.shortCa || '—')}</button></td>
    <td class="col-act"></td>
  `;
  const caBtn = tr.querySelector('.h-ca');
  caBtn?.addEventListener('click', e => {
    e.stopPropagation();
    const copy = it.tradeCa || it.address;
    if (copy && copy !== 'BNB') copyCa(copy);
  });
  const act = tr.querySelector('.col-act');
  if (it.address && it.address !== 'BNB' && plat !== 'native' && plat !== 'quote') {
    const sell = document.createElement('button');
    sell.type = 'button';
    sell.className = 'h-sell';
    const can = it.tradeable !== false;
    sell.textContent = can ? `卖 ${getSellAmount()}` : '不可卖';
    sell.disabled = !can;
    const sellCaHint = (it.platform === 'flap' && it.market && !it.graduated) ? it.market : (it.tradeCa || it.address);
    const pathHint = it.tradePath === 'gang-cli' ? ` · gang CLI (${it.gangPad || '?'})` : '';
    sell.title = can
      ? `卖出 ${getSellAmount()} · ${sellCaHint}${pathHint}`
      : (it.untradeableReason || '不可交易');
    sell.addEventListener('click', async e => {
      e.preventDefault();
      e.stopPropagation();
      if (!can) { toast(it.untradeableReason || '不可卖', 'err'); return; }
      const fakeCard = document.createElement('div');
      fakeCard.className = 'card';
      const sellCa = (it.platform === 'flap' && it.market && !it.graduated)
        ? it.market
        : (it.tradeCa || it.address);
      await doTrade('sell', fakeCard, sellCa, sell, {
        platform: it.platform, track: it.track, graduated: it.graduated,
        market: it.market, tradeCa: sellCa, address: it.address,
        tradeable: it.tradeable, untradeableReason: it.untradeableReason,
        symbol: it.symbol, gangPad: it.gangPad, tradePath: it.tradePath,
      });
      refreshHoldings(true);
    });
    act.append(sell);
    if (Number(it.amount) > 0) {
      const xfer = document.createElement('button');
      xfer.type = 'button';
      xfer.className = 'h-xfer';
      xfer.textContent = '转';
      xfer.title = `转全部到主钱包 ${S.mainWalletShort || shortCa(S.mainWallet)}`;
      xfer.addEventListener('click', async e => {
        e.preventDefault();
        e.stopPropagation();
        const xferCa = it.tradeCa || it.address;
        await doTransfer(xferCa, xfer, {
          platform: it.platform, track: it.track, graduated: it.graduated,
          tradeCa: xferCa, address: it.address, symbol: it.symbol,
        }, { max: true, percent: 100 });
      });
      act.append(xfer);
    }
  }
  tr.addEventListener('click', e => {
    if (e.target.closest('.h-sell, .h-xfer, .h-ca, .col-act')) return;
    if (!it.address || it.address === 'BNB' || it.platform === 'native' || it.platform === 'quote') return;
    openDetailFromHolding(it);
  });
  return tr;
}

