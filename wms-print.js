/* =====================================================================
   WMS print formats — shared by wms-office.html and wms-scanner.html
   WMSPrint.doc(sb, documentId, {format:'a4'|'thermal'})
   WMSPrint.pick(sb, pickListId)
   Shows a print preview with Print / Save PDF, Share and Close.
   Needs qrcodejs (window.QRCode) for the e-invoice QR code.
   ===================================================================== */
(function(){
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const num = v => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
  const INR = new Intl.NumberFormat('en-IN', {minimumFractionDigits:2, maximumFractionDigits:2});
  const QTY = new Intl.NumberFormat('en-IN', {maximumFractionDigits:3});
  const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const dt = v => { if (!v) return ''; const s = String(v).slice(0, 10).split('-'); return `${s[2]} ${MON[+s[1] - 1]} ${s[0]}`; };
  const dtt = v => { if (!v) return ''; const x = new Date(v); if (isNaN(x)) return '';
    const p2 = n => String(n).padStart(2, '0'); return `${p2(x.getDate())} ${MON[x.getMonth()]} ${x.getFullYear()} ${p2(x.getHours())}:${p2(x.getMinutes())}`; };
  const STATES = {'01':'Jammu and Kashmir','02':'Himachal Pradesh','03':'Punjab','04':'Chandigarh','05':'Uttarakhand','06':'Haryana','07':'Delhi',
    '08':'Rajasthan','09':'Uttar Pradesh','10':'Bihar','11':'Sikkim','12':'Arunachal Pradesh','13':'Nagaland','14':'Manipur','15':'Mizoram',
    '16':'Tripura','17':'Meghalaya','18':'Assam','19':'West Bengal','20':'Jharkhand','21':'Odisha','22':'Chhattisgarh','23':'Madhya Pradesh',
    '24':'Gujarat','26':'Dadra and Nagar Haveli and Daman and Diu','27':'Maharashtra','29':'Karnataka','30':'Goa','31':'Lakshadweep',
    '32':'Kerala','33':'Tamil Nadu','34':'Puducherry','35':'Andaman and Nicobar Islands','36':'Telangana','37':'Andhra Pradesh','38':'Ladakh','97':'Other Territory'};
  const stateTxt = c => c ? `${c} ${STATES[c] || ''}`.trim() : '';

  /* Indian number words: 12,34,567.50 -> Twelve lakh thirty four thousand five hundred sixty seven rupees and fifty paise */
  const ONES = ['','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen'];
  const TENS = ['','','twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety'];
  const two = n => n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : '');
  const three = n => (n >= 100 ? ONES[Math.floor(n / 100)] + ' hundred' + (n % 100 ? ' ' : '') : '') + (n % 100 ? two(n % 100) : '');
  function words(amount){
    const a = Math.round(Math.abs(num(amount)) * 100), r = Math.floor(a / 100), p = a % 100;
    const parts = []; let n = r;
    const crore = Math.floor(n / 1e7); n %= 1e7;
    const lakh = Math.floor(n / 1e5); n %= 1e5;
    const thou = Math.floor(n / 1e3); n %= 1e3;
    if (crore) parts.push((crore > 999 ? words(crore).replace(/ rupees.*$/, '') : three(crore)) + ' crore');
    if (lakh) parts.push(two(lakh) + ' lakh');
    if (thou) parts.push(two(thou) + ' thousand');
    if (n) parts.push(three(n));
    let s = (parts.join(' ') || 'zero') + ' rupees';
    if (p) s += ' and ' + two(p) + ' paise';
    s = s + ' only';
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  /* ---------------- data ---------------- */
  async function loadDoc(sb, id){
    const one = async q => { const {data, error} = await q; if (error) throw error; return data; };
    const d = await one(sb.from('documents').select('*').eq('id', id).single());
    const [lines, t, whs, p, ag, ord] = await Promise.all([
      one(sb.from('document_lines').select('*').eq('document_id', id).order('line_no')),
      one(sb.from('tenants').select('*').eq('id', d.tenant_id).single()),
      one(sb.from('warehouses').select('*').in('id', [d.warehouse_id, d.to_warehouse_id].filter(Boolean))),
      d.party_id ? one(sb.from('parties').select('*').eq('id', d.party_id).single()) : null,
      d.against_doc_id ? one(sb.from('documents').select('doc_no,doc_date').eq('id', d.against_doc_id).single()) : null,
      d.order_id ? one(sb.from('orders').select('order_no,order_date').eq('id', d.order_id).single()) : null
    ]);
    const items = await one(sb.from('items').select('id,sku,name,uom').in('id', [...new Set(lines.map(l => l.item_id))]));
    const it = Object.fromEntries(items.map(x => [x.id, x]));
    const w = whs.find(x => x.id === d.warehouse_id), tw = whs.find(x => x.id === d.to_warehouse_id);
    return {d, lines:lines.map(l => ({...l, item:it[l.item_id] || {}})), t, w, tw, p, ag, ord};
  }

  function kindOf(x){
    const {d, t, w, tw, lines} = x;
    const branch = d.doc_type === 'transfer' && (w.gstin || t.gstin) !== ((tw && tw.gstin) || t.gstin);
    const anyTax = lines.some(l => num(l.cgst) + num(l.sgst) + num(l.igst) + num(l.cess) > 0);
    const title = {
      sales_invoice: anyTax || lines.some(l => num(l.gst_rate) > 0) ? 'Tax invoice' : 'Bill of supply',
      sales_return: 'Credit note', purchase_return: 'Debit note', grn: 'Goods receipt note', opening: 'Opening stock',
      adjustment_in: 'Stock adjustment (added)', adjustment_out: 'Stock adjustment (removed)',
      transfer: branch ? 'Tax invoice (branch transfer)' : 'Delivery challan'
    }[d.doc_type];
    const gstDoc = ['sales_invoice','sales_return','purchase_return'].includes(d.doc_type) || branch;
    const copies = d.doc_type === 'sales_invoice' || branch ? ['Original for recipient','Duplicate for transporter','Triplicate for supplier']
                 : d.doc_type === 'transfer' ? ['Original for consignee','Duplicate for transporter','Triplicate for consigner']
                 : ['Original','Duplicate'];
    return {branch, title, gstDoc, copies};
  }

  /* ---------------- A4 ---------------- */
  function a4(x, copyLabel){
    const {d, t, w, tw, p, ag, ord, lines} = x, k = kindOf(x);
    const inter = lines.some(l => num(l.igst) > 0);
    const hasCess = lines.some(l => num(l.cess) > 0);
    const showMoney = !['adjustment_in','adjustment_out','opening'].includes(d.doc_type) || true;
    const seller = {name:t.legal_name || t.name, trade:t.trade_name && t.trade_name !== (t.legal_name || t.name) ? t.trade_name : '',
      addr:[w.address || t.address1, w.address ? '' : t.address2, [w.city || t.city, w.pincode || t.pincode].filter(Boolean).join(' - ')].filter(Boolean),
      gstin:w.gstin || t.gstin, state:stateTxt(w.state_code), pan:t.pan, phone:t.phone, email:t.email};
    // the other side
    let other = null, otherTitle = 'Bill to';
    if (d.doc_type === 'transfer'){
      otherTitle = k.branch ? 'Bill to (branch)' : 'Consignee (own branch)';
      other = {name:(t.legal_name || t.name) + ' - ' + tw.name, addr:[tw.address, [tw.city, tw.pincode].filter(Boolean).join(' - ')].filter(Boolean), gstin:tw.gstin || t.gstin, state:stateTxt(tw.state_code)};
    } else if (p){
      otherTitle = ['grn','purchase_return'].includes(d.doc_type) ? 'Supplier' : 'Bill to';
      other = {name:p.name, addr:[p.address1, p.address2, [p.city, p.pincode].filter(Boolean).join(' - ')].filter(Boolean), gstin:p.gstin, state:stateTxt(p.state_code || (p.gstin || '').slice(0, 2))};
    } else if (d.doc_type === 'sales_invoice'){
      other = {name:'Walk-in customer', addr:d.remarks ? [d.remarks] : [], gstin:'', state:stateTxt(d.place_of_supply || w.state_code)};
    }
    const pos = d.doc_type === 'transfer' ? (tw && tw.state_code) : d.place_of_supply || (p && p.state_code) || w.state_code;
    const meta = [
      [k.title.startsWith('Tax invoice') || k.title === 'Bill of supply' ? 'Invoice no.' : 'Number', d.doc_no],
      ['Date', dt(d.doc_date)],
      k.gstDoc && ['Place of supply', stateTxt(pos)],
      k.gstDoc && ['Reverse charge', d.reverse_charge ? 'Yes' : 'No'],
      ag && ['Against invoice', `${ag.doc_no}, ${dt(ag.doc_date)}`],
      d.doc_type === 'grn' && d.party_doc_no && ['Supplier bill', `${d.party_doc_no}${d.party_doc_date ? ', ' + dt(d.party_doc_date) : ''}`],
      ord && ['Order', `${ord.order_no}, ${dt(ord.order_date)}`],
      d.eway_bill_no && ['E-way bill', `${d.eway_bill_no}${d.eway_bill_date ? ', ' + dt(d.eway_bill_date) : ''}`],
      d.vehicle_no && ['Vehicle', d.vehicle_no],
      d.transporter_name && ['Transporter', d.transporter_name],
      d.status === 'cancelled' && ['Status', 'CANCELLED']
    ].filter(Boolean);
    const cols = [['#','n'],['Item',''],['HSN',''],['Qty','n'],['Rate','n'],['Disc %','n'],['Taxable value','n'],['GST %','n']]
      .concat(inter ? [['IGST','n']] : [['CGST','n'],['SGST','n']]).concat(hasCess ? [['Cess','n']] : []).concat([['Amount','n']]);
    const rows = lines.map((l, i) => {
      const it = l.item, sub = [it.sku, l.batch_no && 'Batch ' + l.batch_no, l.expiry_date && 'Exp ' + dt(l.expiry_date), l.is_free && 'Free under scheme', l.condition !== 'good' && d.doc_type === 'sales_return' && l.condition].filter(Boolean).join(', ');
      const cells = [i + 1, `<b>${esc(it.name)}</b>${sub ? `<br><span class="wp-sub">${esc(sub)}</span>` : ''}`, esc(l.hsn_code),
        `${QTY.format(l.unit_qty ?? l.qty)} ${esc(l.unit || it.uom)}`, INR.format(l.rate), num(l.discount_pct) ? QTY.format(l.discount_pct) : '',
        INR.format(l.taxable_value), QTY.format(l.gst_rate)]
        .concat(inter ? [INR.format(l.igst)] : [INR.format(l.cgst), INR.format(l.sgst)]).concat(hasCess ? [INR.format(l.cess)] : []).concat([INR.format(l.line_total)]);
      return `<tr>${cells.map((c, j) => `<td class="${cols[j][1]}">${c}</td>`).join('')}</tr>`;
    }).join('');
    const tot = f => lines.reduce((a, l) => a + num(l[f]), 0);
    const totals = {taxable:tot('taxable_value'), cgst:tot('cgst'), sgst:tot('sgst'), igst:tot('igst'), cess:tot('cess'), total:tot('line_total'), qty:tot('qty')};
    // HSN and rate summary
    const hs = {};
    lines.forEach(l => { const key = l.hsn_code + '|' + l.gst_rate; hs[key] = hs[key] || {hsn:l.hsn_code, rate:l.gst_rate, tv:0, c:0, s:0, i:0, ce:0};
      const h = hs[key]; h.tv += num(l.taxable_value); h.c += num(l.cgst); h.s += num(l.sgst); h.i += num(l.igst); h.ce += num(l.cess); });
    const hsn = Object.values(hs);
    const qr = d.signed_qr ? `<div class="wp-qr" data-qr="${esc(d.signed_qr)}"></div>` : '';
    return `<section class="wp-page">
      <div class="wp-copy">${esc(copyLabel)}</div>
      <header class="wp-head"><div>
        <div class="wp-co">${esc(seller.name)}</div>${seller.trade ? `<div>${esc(seller.trade)}</div>` : ''}
        ${seller.addr.map(a => `<div>${esc(a)}</div>`).join('')}
        <div>${seller.gstin ? `GSTIN <b>${esc(seller.gstin)}</b>` : ''}${seller.state ? ` &nbsp; State ${esc(seller.state)}` : ''}${seller.pan ? ` &nbsp; PAN ${esc(seller.pan)}` : ''}</div>
        ${seller.phone || seller.email ? `<div>${esc([seller.phone, seller.email].filter(Boolean).join('  '))}</div>` : ''}
      </div>${qr}</header>
      <h1 class="wp-title">${esc(k.title)}</h1>
      ${d.irn ? `<div class="wp-irn">IRN ${esc(d.irn)}${d.ack_no ? ` &nbsp; Ack ${esc(d.ack_no)}${d.ack_date ? ', ' + esc(dtt(d.ack_date)) : ''}` : ''}</div>` : ''}
      <div class="wp-grid">
        <div class="wp-box">${other ? `<div class="wp-lbl">${esc(otherTitle)}</div><div class="wp-name">${esc(other.name)}</div>
          ${other.addr.map(a => `<div>${esc(a)}</div>`).join('')}
          ${other.gstin ? `<div>GSTIN <b>${esc(other.gstin)}</b></div>` : ''}${other.state ? `<div>State ${esc(other.state)}</div>` : ''}` : `<div class="wp-lbl">Warehouse</div><div class="wp-name">${esc(w.name)}</div>`}</div>
        <div class="wp-box"><table class="wp-meta">${meta.map(([a, b]) => `<tr><td>${esc(a)}</td><td><b>${esc(b)}</b></td></tr>`).join('')}</table></div>
      </div>
      ${d.doc_type === 'transfer' || d.doc_type === 'sales_invoice' ? `<div class="wp-disp">Dispatched from: ${esc(w.name)}${w.address ? ', ' + esc(w.address) : ''}${w.city ? ', ' + esc(w.city) : ''}</div>` : ''}
      <table class="wp-items"><thead><tr>${cols.map(c => `<th class="${c[1]}">${c[0]}</th>`).join('')}</tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td></td><td>Total</td><td></td><td class="n">${QTY.format(totals.qty)}</td><td></td><td></td><td class="n">${INR.format(totals.taxable)}</td><td></td>
          ${inter ? `<td class="n">${INR.format(totals.igst)}</td>` : `<td class="n">${INR.format(totals.cgst)}</td><td class="n">${INR.format(totals.sgst)}</td>`}
          ${hasCess ? `<td class="n">${INR.format(totals.cess)}</td>` : ''}<td class="n">${INR.format(totals.total)}</td></tr></tfoot></table>
      <div class="wp-grid wp-bottom">
        <div>${k.gstDoc && hsn.length ? `<table class="wp-hsn"><thead><tr><th>HSN</th><th class="n">GST %</th><th class="n">Taxable</th>${inter ? '<th class="n">IGST</th>' : '<th class="n">CGST</th><th class="n">SGST</th>'}${hasCess ? '<th class="n">Cess</th>' : ''}</tr></thead>
            <tbody>${hsn.map(h => `<tr><td>${esc(h.hsn)}</td><td class="n">${QTY.format(h.rate)}</td><td class="n">${INR.format(h.tv)}</td>${inter ? `<td class="n">${INR.format(h.i)}</td>` : `<td class="n">${INR.format(h.c)}</td><td class="n">${INR.format(h.s)}</td>`}${hasCess ? `<td class="n">${INR.format(h.ce)}</td>` : ''}</tr>`).join('')}</tbody></table>` : ''}
          <div class="wp-words"><span class="wp-lbl">Amount in words</span><br>${esc(words(totals.total))}</div>
          ${d.doc_type === 'sales_invoice' && t.bank_account ? `<div class="wp-bank"><span class="wp-lbl">Bank details</span><br>${esc(t.bank_name || '')} &nbsp; A/c ${esc(t.bank_account)} &nbsp; IFSC ${esc(t.bank_ifsc || '')}</div>` : ''}
          ${d.reason ? `<div class="wp-bank"><span class="wp-lbl">Reason</span><br>${esc(d.reason)}</div>` : ''}
        </div>
        <div><table class="wp-tot">
          <tr><td>Taxable value</td><td class="n">${INR.format(totals.taxable)}</td></tr>
          ${inter ? `<tr><td>IGST</td><td class="n">${INR.format(totals.igst)}</td></tr>` : `<tr><td>CGST</td><td class="n">${INR.format(totals.cgst)}</td></tr><tr><td>SGST</td><td class="n">${INR.format(totals.sgst)}</td></tr>`}
          ${hasCess ? `<tr><td>Cess</td><td class="n">${INR.format(totals.cess)}</td></tr>` : ''}
          <tr class="wp-grand"><td>Total</td><td class="n">₹ ${INR.format(totals.total)}</td></tr></table>
          <div class="wp-sign">For ${esc(seller.name)}<br><br><br>Authorised signatory</div></div>
      </div>
      ${t.invoice_terms && d.doc_type === 'sales_invoice' ? `<div class="wp-terms">${esc(t.invoice_terms)}</div>` : ''}
      ${d.doc_type === 'transfer' && !k.branch ? '<div class="wp-terms">Movement of goods between branches under the same GSTIN. Not a supply.</div>' : ''}
      <div class="wp-foot">This is a computer-generated document.</div>
    </section>`;
  }

  /* ---------------- thermal 80 mm ---------------- */
  function thermal(x){
    const {d, t, w, p, lines} = x, k = kindOf(x);
    const tot = f => lines.reduce((a, l) => a + num(l[f]), 0);
    const inter = tot('igst') > 0;
    return `<section class="wp-page wp-thermal">
      <div class="c"><b>${esc(t.trade_name || t.name)}</b><br>${esc(w.address || t.address1 || '')}${w.city ? ', ' + esc(w.city) : ''}
      ${w.gstin || t.gstin ? `<br>GSTIN ${esc(w.gstin || t.gstin)}` : ''}</div>
      <div class="c wp-t2">${esc(k.title)}</div>
      <div>No. ${esc(d.doc_no)}<br>Date ${esc(dtt(d.posted_at || d.created_at))}${p ? `<br>${esc(p.name)}${p.gstin ? '<br>GSTIN ' + esc(p.gstin) : ''}` : ''}</div>
      <hr>${lines.map(l => `<div class="r"><span>${esc(l.item.name)}${l.is_free ? ' (free)' : ''}</span></div>
        <div class="r"><span>${QTY.format(l.unit_qty ?? l.qty)} ${esc(l.unit || l.item.uom)} x ${INR.format(l.rate)}${num(l.discount_pct) ? ` -${QTY.format(l.discount_pct)}%` : ''}</span><span>${INR.format(l.line_total)}</span></div>`).join('')}
      <hr><div class="r"><span>Taxable</span><span>${INR.format(tot('taxable_value'))}</span></div>
      ${inter ? `<div class="r"><span>IGST</span><span>${INR.format(tot('igst'))}</span></div>` : `<div class="r"><span>CGST</span><span>${INR.format(tot('cgst'))}</span></div><div class="r"><span>SGST</span><span>${INR.format(tot('sgst'))}</span></div>`}
      ${tot('cess') ? `<div class="r"><span>Cess</span><span>${INR.format(tot('cess'))}</span></div>` : ''}
      <div class="r wp-big"><span>Total</span><span>₹ ${INR.format(tot('line_total'))}</span></div>
      <hr><div class="c">${d.status === 'cancelled' ? '<b>CANCELLED</b><br>' : ''}Thank you</div></section>`;
  }

  /* ---------------- pick slip ---------------- */
  async function loadPick(sb, id){
    const {data:h, error} = await sb.from('v_pick_lists').select('*').eq('id', id).single(); if (error) throw error;
    const {data:l, error:e2} = await sb.from('v_pick_lines').select('*').eq('pick_list_id', id).order('bin').order('line_no'); if (e2) throw e2;
    return {h, l};
  }
  function pickHtml({h, l}){
    return `<section class="wp-page"><h1 class="wp-title">Pick slip ${esc(h.pick_no)}</h1>
      <div class="wp-grid"><div class="wp-box"><div class="wp-lbl">Order</div><div class="wp-name">${esc(h.order_no)}</div><div>${esc(h.customer || 'Walk-in')}</div></div>
      <div class="wp-box"><div class="wp-lbl">Warehouse</div><div class="wp-name">${esc(h.warehouse)}</div><div>Made ${esc(dtt(h.created_at))}</div></div></div>
      <table class="wp-items"><thead><tr><th>Bin</th><th>Item</th><th>SKU</th><th>Batch</th><th>Expiry</th><th class="n">To pick</th><th class="n">Picked</th></tr></thead>
      <tbody>${l.map(r => `<tr><td><b>${esc(r.bin)}</b></td><td>${esc(r.item_name)}</td><td>${esc(r.sku)}</td><td>${esc(r.batch_no || '')}</td><td>${esc(dt(r.expiry_date))}</td>
        <td class="n">${QTY.format(r.qty_to_pick)}</td><td class="n" style="min-width:60px">${num(r.qty_picked) ? QTY.format(r.qty_picked) : ''}</td></tr>`).join('')}</tbody></table>
      <div class="wp-grid wp-bottom"><div>Picked by<br><br>__________________</div><div>Checked by<br><br>__________________</div></div></section>`;
  }

  /* ---------------- preview overlay ---------------- */
  const CSS = `
  #wpOverlay{position:fixed;inset:0;z-index:100;background:#5c6474;overflow:auto;font-family:"Barlow",system-ui,sans-serif}
  #wpOverlay .wp-bar{position:sticky;top:0;z-index:2;display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:10px 12px;padding-top:calc(10px + env(safe-area-inset-top,0px));background:#16213A;color:#fff}
  #wpOverlay .wp-bar b{flex:1;font-size:16px}
  #wpOverlay .wp-bar button,#wpOverlay .wp-bar select{height:36px;border-radius:6px;border:1px solid #3C4E78;background:#24345A;color:#fff;padding:0 12px;font:inherit}
  #wpOverlay .wp-bar .pri{background:#FFC400;color:#16213A;border-color:#FFC400;font-weight:700}
  #wpPages{padding:16px 8px 40px}
  .wp-page{background:#fff;color:#000;width:210mm;max-width:100%;min-height:270mm;margin:0 auto 16px;padding:10mm;box-sizing:border-box;font-size:9.5pt;line-height:1.35;position:relative}
  .wp-page.wp-thermal{width:80mm;min-height:0;padding:3mm;font-size:9pt}
  .wp-copy{position:absolute;top:6mm;right:10mm;font-size:8pt;color:#444}
  .wp-head{display:flex;justify-content:space-between;gap:10px;border-bottom:2px solid #000;padding-bottom:6px}
  .wp-co{font-size:15pt;font-weight:700}
  .wp-title{font-size:13pt;text-align:center;margin:8px 0 4px;letter-spacing:.3px}
  .wp-irn{font-size:7.5pt;text-align:center;word-break:break-all;margin-bottom:6px}
  .wp-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
  .wp-box{border:1px solid #000;padding:6px}
  .wp-lbl{font-size:7.5pt;color:#444}
  .wp-name{font-weight:700;font-size:10.5pt}
  .wp-meta td{padding:1px 6px 1px 0;vertical-align:top}
  .wp-disp{margin:6px 0 0;font-size:8.5pt}
  .wp-items{width:100%;border-collapse:collapse;margin-top:8px}
  .wp-items th,.wp-items td{border:1px solid #000;padding:3px 4px;vertical-align:top}
  .wp-items th{background:#eee;font-size:8pt}
  .wp-items tfoot td{font-weight:700}
  .wp-sub{font-size:7.5pt;color:#333}
  .n{text-align:right;white-space:nowrap}
  .wp-bottom{margin-top:8px}
  .wp-hsn{border-collapse:collapse;font-size:8pt;width:100%}
  .wp-hsn th,.wp-hsn td{border:1px solid #000;padding:2px 4px}
  .wp-words,.wp-bank{margin-top:6px}
  .wp-tot{width:100%;border-collapse:collapse}
  .wp-tot td{padding:2px 4px;border-bottom:1px solid #ccc}
  .wp-grand td{font-weight:700;font-size:11pt;border-top:2px solid #000;border-bottom:2px solid #000}
  .wp-sign{text-align:right;margin-top:14px}
  .wp-terms{margin-top:8px;font-size:8pt;border-top:1px solid #ccc;padding-top:4px;white-space:pre-wrap}
  .wp-foot{margin-top:10px;font-size:7pt;color:#555;text-align:center}
  .wp-qr{width:110px;height:110px}
  .wp-thermal .c{text-align:center}.wp-thermal .r{display:flex;justify-content:space-between;gap:6px}
  .wp-thermal .wp-t2{font-weight:700;margin:4px 0}.wp-thermal .wp-big{font-weight:700;font-size:11pt}
  .wp-thermal hr{border:0;border-top:1px dashed #000;margin:4px 0}
  @media print{
    body.wp-printing > *:not(#wpOverlay){display:none !important}
    body.wp-printing #wpOverlay{position:static;background:#fff;overflow:visible}
    body.wp-printing .wp-bar{display:none}
    body.wp-printing #wpPages{padding:0}
    body.wp-printing .wp-page{margin:0;min-height:0;page-break-after:always;width:auto}
  }`;
  function ensureCss(){ if (!document.getElementById('wpCss')){ const s = document.createElement('style'); s.id = 'wpCss'; s.textContent = CSS; document.head.appendChild(s); } }
  function setPage(size){
    let ps = document.getElementById('wpPageCss'); if (!ps){ ps = document.createElement('style'); ps.id = 'wpPageCss'; document.head.appendChild(ps); }
    ps.textContent = size === 'thermal' ? '@media print{@page{size:80mm auto;margin:2mm}}' : '@media print{@page{size:A4;margin:6mm}}';
  }
  function drawQr(root){
    root.querySelectorAll('[data-qr]').forEach(el => {
      el.innerHTML = '';
      try{ new window.QRCode(el, {text:el.dataset.qr, width:110, height:110, correctLevel:window.QRCode.CorrectLevel.L}); }
      catch(e){ el.textContent = 'QR could not be drawn'; }
    });
  }
  function show(title, render, opts){
    ensureCss();
    const old = document.getElementById('wpOverlay'); if (old) old.remove();
    const ov = document.createElement('div'); ov.id = 'wpOverlay';
    ov.innerHTML = `<div class="wp-bar"><b>${esc(title)}</b>
      ${opts.formats ? `<select data-wp="fmt" aria-label="Paper"><option value="a4">A4</option><option value="thermal">80 mm receipt</option></select>` : ''}
      ${opts.copies ? `<select data-wp="copies" aria-label="Copies">${opts.copies.map((c, i) => `<option value="${i + 1}">${i + 1} ${i ? 'copies' : 'copy'}</option>`).join('')}</select>` : ''}
      <button class="pri" data-wp="print">Print or save PDF</button>${opts.share ? '<button data-wp="share">Share</button>' : ''}<button data-wp="close">Close</button></div>
      <div id="wpPages"></div>`;
    document.body.appendChild(ov);
    const state = {fmt:opts.defaultFormat || 'a4', copies:1};
    if (opts.formats) ov.querySelector('[data-wp=fmt]').value = state.fmt;
    const paint = () => { ov.querySelector('#wpPages').innerHTML = render(state); setPage(state.fmt); if (window.QRCode) drawQr(ov); };
    ov.addEventListener('change', e => { const k = e.target.dataset.wp; if (k === 'fmt') state.fmt = e.target.value; if (k === 'copies') state.copies = +e.target.value; paint(); });
    ov.addEventListener('click', async e => {
      const k = e.target.dataset && e.target.dataset.wp;
      if (k === 'close') ov.remove();
      if (k === 'print'){ document.body.classList.add('wp-printing'); setTimeout(() => { window.print(); setTimeout(() => document.body.classList.remove('wp-printing'), 500); }, 50); }
      if (k === 'share'){
        const text = opts.share;
        if (navigator.share){ try{ await navigator.share({title, text}); }catch(err){} }
        else window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank');
      }
    });
    paint();
  }

  window.WMSPrint = {
    words,
    async doc(sb, id, o = {}){
      const x = await loadDoc(sb, id), k = kindOf(x);
      const total = x.lines.reduce((a, l) => a + num(l.line_total), 0);
      const share = `${k.title} ${x.d.doc_no} dated ${dt(x.d.doc_date)} for Rs ${INR.format(total)} from ${x.t.trade_name || x.t.name}.` +
        (x.d.eway_bill_no ? ` E-way bill ${x.d.eway_bill_no}.` : '');
      show(`${k.title} ${x.d.doc_no}`, st => st.fmt === 'thermal' ? thermal(x) : k.copies.slice(0, st.copies).map(c => a4(x, c)).join(''),
        {formats:x.d.doc_type === 'sales_invoice', defaultFormat:o.format || 'a4', copies:k.copies, share});
    },
    async pick(sb, id){
      const x = await loadPick(sb, id);
      show(`Pick slip ${x.h.pick_no}`, () => pickHtml(x), {});
    }
  };
})();
