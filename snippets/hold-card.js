function holdCardEl(it) {
  const el = document.createElement('article');
  el.className = 'card hold-card' + (it.tradeable === false ? ' untradeable' : '');
  el.dataset.platform = it.platform || '';
  el.dataset.ca = it.address || '';
  el.dataset.tradeCa = it.tradeCa || it.address || '';

  const plat = it.platform || '?';
  const pad = (it.gangPad || '').toLowerCase();
  const padLbl = pad === 'u' ? 'U' : pad === 's' ? 'S' : pad;
  const valN = holdItemValueUsd(it);
  const cost = fmtHoldCost(it);
  const pnl = fmtHoldPnl(it);
  const qty = esc(it.amountDisplay || fmtAmtHold(it.amount)) + (it.unit === 'shares' ? ' 份' : '');
  const name = it.name || it.symbol || '?';
  const sym = it.symbol || '?';

  const info = document.createElement('div');
  info.className = 'info';
  info.innerHTML = `
    <div class="row1">
      <span class="name" title="${esc(name)}">${esc(name)}</span>
      <span class="sym">$${esc(sym)}</span>
    </div>
    <div class="tags">
      <span class="tag ${esc(plat)}">${esc(String(plat).toUpperCase())}</span>
      ${padLbl ? `<span class="tag pad">${esc(padLbl)}</span>` : ''}
      ${it.tradeable === false ? `<span class="tag blocked" title="${esc(it.untradeableReason || '')}">不可卖</span>` : ''}
    </div>
    <div class="stats hold-stats">
      <span>数量 <b>${qty}</b></span>
      <span>价值 <b class="${valN == null ? 'unk' : ''}">${valN != null ? esc(fmtHoldUsd(valN)) : '?'}</b></span>
      <span class="hold-pnl-stat ${pnl ? esc(pnl.cls) : 'unk'}" title="${pnl ? esc(pnl.title || '') : ''}">${pnl ? esc(pnl.text) : '盈亏?'}</span>
      ${cost ? `<span class="hold-cost-stat ${esc(cost.cls)}" title="${esc(cost.title || '')}">${esc(cost.text)}</span>` : ''}
      <span class="ca" data-ca="${esc(it.tradeCa || it.address || '')}" title="${esc(it.address || '')}（点击复制）">${esc(it.shortCa || shortCa(it.address || '') || '—')}</span>
    </div>`;
  el.append(info);

  const caEl = info.querySelector('.stats .ca');
  if (caEl) {
    caEl.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      const ca = caEl.dataset.ca || it.tradeCa || it.address || '';
      if (ca && ca !== 'BNB') copyCa(ca);
    });
  }

  const side = document.createElement('div');
  side.className = 'side';
  const actions = document.createElement('div');
  actions.className = 'actions';

  if (it.address && it.address !== 'BNB' && plat !== 'native' && plat !== 'quote') {
    const sell = document.createElement('button');
    sell.type = 'button';
    sell.className = 'btn-sell h-sell';
    const can = it.tradeable !== false;
    sell.textContent = can ? `卖 ${getSellAmount()}` : '不可卖';
    sell.disabled = !can;
    const sellCaHint = (it.platform === 'flap' && it.market && !it.graduated) ? it.market : (it.tradeCa || it.address);
    sell.title = can ? `卖出 ${getSellAmount()} · ${sellCaHint}` : (it.untradeableReason || '不可交易');
    sell.addEventListener('click', async e => {
      e.preventDefault();
      e.stopPropagation();
      if (!can) { toast(it.untradeableReason || '不可卖', 'err'); return; }
      const sellCa = (it.platform === 'flap' && it.market && !it.graduated)
        ? it.market
        : (it.tradeCa || it.address);
      await doTrade('sell', el, sellCa, sell, {
        platform: it.platform, track: it.track, graduated: it.graduated,
        market: it.market, tradeCa: sellCa, address: it.address,
        tradeable: it.tradeable, untradeableReason: it.untradeableReason,
        symbol: it.symbol, gangPad: it.gangPad, tradePath: it.tradePath,
      });
      refreshHoldings(true);
    });
    actions.append(sell);

    if (Number(it.amount) > 0) {
      const xfer = document.createElement('button');
      xfer.type = 'button';
      xfer.className = 'btn-xfer h-xfer';
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
      actions.append(xfer);
    }
  }
  side.append(actions);
  el.append(side);

  el.addEventListener('click', e => {
    if (e.target.closest('.btn-sell, .btn-xfer, .h-sell, .h-xfer, .ca, .actions')) return;
    if (!it.address || it.address === 'BNB' || it.platform === 'native' || it.platform === 'quote') return;
    openDetailFromHolding(it);
  });
  return el;
}
