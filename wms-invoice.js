/* =====================================================================
   Supplier invoice check: match the lines Claude read from the supplier's
   invoice to the goods received, and compare quantity, rate, taxable value
   and GST. Pure functions, shared by the office app and the scanner.
   WMSInvoice.compare(invoice, received, ctx) -> result
     invoice : what the read-invoice function returned
     received: [{key, item_id, name, sku, hsn, barcodes:[], qty (base units), rate (per base unit, before discount),
                 discount_pct, taxable_value|null, gst_rate|null, units:[{unit, factor}], uom}]
     ctx     : {party_doc_no, party_gstin, our_gstins:[], doc_total|null, learned:[{supplier_text, item_id, factor}],
                force:{invoiceLineIndex: receivedKey|''}}
   ===================================================================== */
(function(root){
  const num = v => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
  const r2 = n => Math.round((num(n) + Number.EPSILON) * 100) / 100;
  const UNIT = {gm:'g', gms:'g', grm:'g', gram:'g', grams:'g', kgs:'kg', ltr:'l', ltrs:'l', litre:'l', liter:'l', mls:'ml',
                pc:'pcs', piece:'pcs', pieces:'pcs', nos:'pcs', no:'pcs', nos_:'pcs', ctn:'carton', cartons:'carton', bx:'box', boxes:'box', btl:'bottle', btls:'bottle'};
  const STOP = new Set(['the','of','and','for','with','new','pack','pkt','item','goods','x']);
  const norm = s => String(s || '').toLowerCase().replace(/(\d)\s*(gm|gms|g|kg|ml|l|ltr)\b/g, '$1$2').replace(/[^a-z0-9.]+/g, ' ').trim()
    .split(/\s+/).map(t => t.replace(/^(\d+(?:\.\d+)?)(gms|gm|grm)$/, '$1g').replace(/^(\d+(?:\.\d+)?)(ltr|ltrs)$/, '$1l')).map(t => UNIT[t] || t).filter(t => t && !STOP.has(t));
  const key = s => norm(s).join(' ');
  function sim(a, b){                                     // Dice similarity of word sets, with partial credit for prefixes
    const A = norm(a), B = norm(b); if (!A.length || !B.length) return 0;
    let hit = 0; const used = new Set();
    for (const x of A){
      let best = 0, bj = -1;
      B.forEach((y, j) => { if (used.has(j)) return; const s = x === y ? 1 : (x.length >= 3 && y.length >= 3 && (x.startsWith(y) || y.startsWith(x))) ? 0.7 : 0; if (s > best){ best = s; bj = j; } });
      if (bj >= 0){ used.add(bj); hit += best; }
    }
    const dice = 2 * hit / (A.length + B.length), ja = A.join(''), jb = B.join('');
    if (ja === jb) return 1;                                        // "tooth brush" = "toothbrush"
    if (ja.length >= 6 && jb.length >= 6 && (ja.includes(jb) || jb.includes(ja))) return Math.max(dice, 0.8);
    return dice;
  }
  const unitNorm = u => { const t = String(u || '').toLowerCase().replace(/[^a-z]/g, ''); return UNIT[t] || t; };
  const sameNo = (a, b) => String(a || '').toUpperCase().replace(/[^A-Z0-9]/g, '') === String(b || '').toUpperCase().replace(/[^A-Z0-9]/g, '') && !!a;

  // how many of our base units one invoice unit is
  function factorFor(invLine, rec, learned){
    if (learned && learned.factor) return {f:num(learned.factor), how:'learned'};
    const u = unitNorm(invLine.unit);
    if (!u || u === unitNorm(rec.uom) || (u === 'pcs' && ['pcs','nos'].includes(unitNorm(rec.uom)))) return {f:1, how:'same unit'};
    const iu = (rec.units || []).find(x => unitNorm(x.unit) === u);
    if (iu) return {f:num(iu.factor), how:`1 ${invLine.unit} = ${num(iu.factor)} ${rec.uom}`};
    return {f:1, how:'unit not set up', unknown:true};
  }

  function score(inv, rec, learnedMap){
    const L = learnedMap.get(key(inv.description));
    if (L && L.item_id === rec.item_id) return {s:100, why:'matched before for this supplier', learned:L};
    let s = 0, why = [];
    const code = String(inv.item_code || '').toUpperCase().replace(/\s/g, '');
    if (code && (code === String(rec.sku || '').toUpperCase() || (rec.barcodes || []).some(b => String(b).toUpperCase() === code))){ s += 70; why.push('item code'); }
    const n = sim(inv.description, rec.name + ' ' + (rec.sku || ''));
    s += Math.round(n * 60); if (n >= 0.5) why.push('name');
    const h1 = String(inv.hsn || '').replace(/\D/g, ''), h2 = String(rec.hsn || '').replace(/\D/g, '');
    if (h1 && h2){ if (h1.slice(0, 4) === h2.slice(0, 4)){ s += 15; why.push('HSN'); } else s -= 10; }
    if (inv.rate && rec.rate){ const f = factorFor(inv, rec, null).f || 1; const d = Math.abs(num(inv.rate) / f - num(rec.rate)) / Math.max(num(rec.rate), 0.01); if (d <= 0.02){ s += 10; why.push('rate'); } }
    return {s, why:why.join(', ') || 'weak'};
  }

  function compare(invoice, received, ctx){
    ctx = ctx || {};
    const lines = (invoice.lines || []).map((l, i) => ({...l, i}));
    const learnedMap = new Map((ctx.learned || []).map(x => [key(x.supplier_text), x]));
    const force = ctx.force || {};
    // score every pair, then pair off the best first
    const pairs = [];
    lines.forEach(inv => received.forEach(rec => { const sc = score(inv, rec, learnedMap); pairs.push({inv, rec, ...sc}); }));
    pairs.sort((a, b) => b.s - a.s);
    const takenInv = new Set(), takenRec = new Set(), match = {};
    Object.entries(force).forEach(([i, k]) => { takenInv.add(+i); if (k){ takenRec.add(k); const p = pairs.find(x => x.inv.i === +i && x.rec.key === k); match[i] = {rec:received.find(r => r.key === k), why:'chosen by you', learned:p && p.learned}; } });
    for (const p of pairs){
      if (p.s < 35 || takenInv.has(p.inv.i) || takenRec.has(p.rec.key)) continue;
      takenInv.add(p.inv.i); takenRec.add(p.rec.key); match[p.inv.i] = {rec:p.rec, why:p.why, learned:p.learned, score:p.s};
    }
    const rows = lines.map(inv => {
      const m = match[inv.i];
      const row = {i:inv.i, description:inv.description, unit:inv.unit, inv_qty:num(inv.qty), free_qty:num(inv.free_qty), inv_rate:inv.rate, inv_discount:inv.discount_pct,
                   inv_taxable:inv.taxable_value, inv_gst:inv.gst_rate, batch:inv.batch, expiry:inv.expiry, problems:[]};
      if (!m || !m.rec){ row.status = 'missing'; row.problems.push('On the invoice but not received'); return row; }
      const rec = m.rec, fx = factorFor(inv, rec, m.learned);
      Object.assign(row, {key:rec.key, item_id:rec.item_id, item_name:rec.name, why:m.why, factor:fx.f, factor_how:fx.how,
                          billed_base:r2((num(inv.qty)) * fx.f), free_base:r2(num(inv.free_qty) * fx.f), rec_qty:num(rec.qty),
                          our_rate:rec.rate, our_discount:rec.discount_pct, our_taxable:rec.taxable_value, our_gst:rec.gst_rate});
      row.inv_total_base = r2(row.billed_base + row.free_base);
      if (fx.unknown) row.problems.push(`Invoice unit "${inv.unit}" is not set up for this item; compared as 1 to 1`);
      if (Math.abs(row.inv_total_base - row.rec_qty) > 0.0005){
        row.problems.push(`Quantity: invoice ${row.inv_total_base}${row.free_base ? ` (${row.billed_base} + ${row.free_base} free)` : ''}, received ${row.rec_qty}`);
        row.qty_diff = r2(row.rec_qty - row.inv_total_base);
      }
      if (inv.rate !== null && inv.rate !== undefined && rec.rate !== null && rec.rate !== undefined){
        // with free goods, compare the cost of each unit actually received (billed value / all units)
        const withFree = row.free_base > 0 && inv.taxable_value !== null && inv.taxable_value !== undefined && row.inv_total_base > 0;
        const invNet = withFree ? num(inv.taxable_value) / row.inv_total_base : num(inv.rate) / (fx.f || 1) * (1 - num(inv.discount_pct) / 100);
        const ourNet = withFree && rec.taxable_value !== null && rec.taxable_value !== undefined && num(rec.qty) > 0 ? num(rec.taxable_value) / num(rec.qty) : num(rec.rate) * (1 - num(rec.discount_pct) / 100);
        if (Math.abs(invNet - ourNet) > Math.max(0.01, ourNet * 0.005))
          row.problems.push(`${withFree ? 'Cost per unit incl. free goods' : 'Rate'}: invoice ₹${r2(invNet)} per ${rec.uom || 'unit'}, ours ₹${r2(ourNet)}`);
      }
      if (ctx.three_way && rec.po_rate !== null && rec.po_rate !== undefined){
        const invNet = num(inv.rate) / (fx.f || 1) * (1 - num(inv.discount_pct) / 100), poNet = num(rec.po_rate) * (1 - num(rec.po_discount) / 100);
        row.po_rate = r2(poNet);
        if (inv.rate !== null && inv.rate !== undefined && Math.abs(invNet - poNet) > Math.max(0.01, poNet * 0.005))
          row.problems.push(`${invNet > poNet ? 'Billed above' : 'Billed below'} the purchase order: invoice ₹${r2(invNet)}, PO ₹${r2(poNet)} per ${rec.uom || 'unit'}`);
      }
      if (inv.gst_rate !== null && inv.gst_rate !== undefined && rec.gst_rate !== null && rec.gst_rate !== undefined && num(inv.gst_rate) !== num(rec.gst_rate))
        row.problems.push(`GST: invoice ${num(inv.gst_rate)}%, ours ${num(rec.gst_rate)}%`);
      if (inv.taxable_value !== null && inv.taxable_value !== undefined && rec.taxable_value !== null && rec.taxable_value !== undefined
          && Math.abs(num(inv.taxable_value) - num(rec.taxable_value)) > 1 && !row.problems.some(p => /^Quantity|^Rate/.test(p)))
        row.problems.push(`Taxable value: invoice ₹${r2(inv.taxable_value)}, ours ₹${r2(rec.taxable_value)}`);
      row.status = row.problems.some(p => /^Quantity/.test(p)) ? 'qty' : row.problems.length ? 'amount' : 'ok';
      return row;
    });
    const notOnInvoice = received.filter(r => !Object.values(match).some(m => m.rec && m.rec.key === r.key))
      .map(r => ({key:r.key, item_id:r.item_id, item_name:r.name, rec_qty:num(r.qty), status:'extra', problems:['Received but not on the invoice']}));
    const head = [];
    if (ctx.party_doc_no !== undefined){
      if (!invoice.invoice_no) head.push({ok:false, text:'Invoice number could not be read'});
      else head.push(sameNo(invoice.invoice_no, ctx.party_doc_no) ? {ok:true, text:`Invoice no. ${invoice.invoice_no}`}
        : {ok:false, text:`Invoice no. on the bill is ${invoice.invoice_no}; entered as ${ctx.party_doc_no || '(blank)'}`, fix:{party_doc_no:invoice.invoice_no}});
    }
    if (invoice.supplier_gstin && ctx.party_gstin) head.push(String(invoice.supplier_gstin).toUpperCase() === String(ctx.party_gstin).toUpperCase()
      ? {ok:true, text:`Supplier GSTIN ${invoice.supplier_gstin}`} : {ok:false, text:`Supplier GSTIN on the bill is ${invoice.supplier_gstin}; our supplier has ${ctx.party_gstin}`});
    if (invoice.buyer_gstin && (ctx.our_gstins || []).length) head.push((ctx.our_gstins || []).map(g => String(g).toUpperCase()).includes(String(invoice.buyer_gstin).toUpperCase())
      ? {ok:true, text:`Billed to our GSTIN ${invoice.buyer_gstin}`} : {ok:false, text:`Billed to GSTIN ${invoice.buyer_gstin}, which is not ours`});
    const t = invoice.totals || {};
    if (t.total !== null && t.total !== undefined && ctx.doc_total !== null && ctx.doc_total !== undefined){
      const diff = r2(num(t.total) - num(ctx.doc_total) - num(t.other_charges));
      head.push(Math.abs(diff) <= Math.max(1, Math.abs(num(t.round_off)) + 0.5) ? {ok:true, text:`Invoice total ₹${r2(t.total)}${num(t.other_charges) ? ` (incl. ₹${r2(t.other_charges)} charges)` : ''}`}
        : {ok:false, text:`Invoice total ₹${r2(t.total)}${num(t.other_charges) ? ` incl. ₹${r2(t.other_charges)} charges` : ''}; ours ₹${r2(ctx.doc_total)} (difference ₹${diff})`});
    }
    if (ctx.qr){
      const q = ctx.qr;
      if (q.DocNo) head.push(sameNo(q.DocNo, invoice.invoice_no || ctx.party_doc_no) ? {ok:true, text:`E-invoice QR: bill no. ${q.DocNo}, IRN ${String(q.Irn || '').slice(0, 10)}…`}
                                                                                : {ok:false, text:`E-invoice QR says bill no. ${q.DocNo}; the bill reads ${invoice.invoice_no || ctx.party_doc_no || '(none)'}`});
      if (q.TotInvVal !== undefined && t.total !== null && t.total !== undefined && Math.abs(num(q.TotInvVal) - num(t.total)) > 1)
        head.push({ok:false, text:`E-invoice QR total ₹${r2(q.TotInvVal)} differs from the bill total ₹${r2(t.total)}`});
      if (q.ItemCnt && lines.length && num(q.ItemCnt) !== lines.length) head.push({ok:false, text:`E-invoice QR lists ${q.ItemCnt} items; ${lines.length} were read from the bill`});
      if (q.SellerGstin && ctx.party_gstin && String(q.SellerGstin).toUpperCase() !== String(ctx.party_gstin).toUpperCase())
        head.push({ok:false, text:`E-invoice QR seller GSTIN ${q.SellerGstin} is not our supplier's ${ctx.party_gstin}`});
    }
    (ctx.duplicates || []).forEach(dp => head.push({ok:false, text:`This bill is already on ${dp.doc_no} (${dp.how})`}));
    const qtyOk = rows.every(r => r.status === 'ok' || r.status === 'amount') && !notOnInvoice.length && rows.length > 0;
    const allOk = qtyOk && rows.every(r => r.status === 'ok') && head.every(h => h.ok);
    return {status:allOk ? 'matched' : 'differences', quantities_match:qtyOk, rows, extra:notOnInvoice, head,
            summary:{invoice_lines:rows.length, matched_lines:rows.filter(r => r.item_id).length, qty_problems:rows.filter(r => r.status === 'qty' || r.status === 'missing').length + notOnInvoice.length,
                     amount_problems:rows.filter(r => r.status === 'amount').length, header_problems:head.filter(h => !h.ok).length},
            invoice:{no:invoice.invoice_no, date:invoice.invoice_date, supplier:invoice.supplier_name, supplier_gstin:invoice.supplier_gstin, totals:invoice.totals, notes:invoice.reading_notes}};
  }
  // what to remember for next time: this supplier's wording -> our item
  const learnRows = (result, partyId, tenantId) => result.rows.filter(r => r.item_id && r.description)
    .map(r => ({tenant_id:tenantId, party_id:partyId, supplier_text:key(r.description), item_id:r.item_id, factor:r.factor || 1, updated_at:new Date().toISOString()}));
  // GST e-invoice QR: a signed token from the IRP. Returns its fields, or null if it is not one.
  function parseEInvoiceQR(text){
    const t = String(text || '').trim();
    const parts = t.split('.');
    if (parts.length !== 3 || t.length < 200 || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return null;
    try{
      const b = parts[1].replace(/-/g, '+').replace(/_/g, '/'), pad = b + '='.repeat((4 - b.length % 4) % 4);
      const raw = typeof atob === 'function' ? decodeURIComponent(escape(atob(pad))) : Buffer.from(pad, 'base64').toString('utf8');
      let p = JSON.parse(raw); if (typeof p.data === 'string') p = JSON.parse(p.data); else if (p.data) p = p.data;
      if (!p.Irn && !p.SellerGstin) return null;
      const dt = String(p.DocDt || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
      return {SellerGstin:p.SellerGstin, BuyerGstin:p.BuyerGstin, DocNo:p.DocNo, DocTyp:p.DocTyp, DocDt:dt ? `${dt[3]}-${dt[2]}-${dt[1]}` : p.DocDt,
              TotInvVal:p.TotInvVal, ItemCnt:p.ItemCnt, MainHsnCode:p.MainHsnCode, Irn:p.Irn ? String(p.Irn).toLowerCase() : null, IrnDt:p.IrnDt};
    }catch(e){ return null; }
  }
  // blind receiving: what to recount, never the expected quantity
  function blindSummary(result){
    const recount = result.rows.filter(r => r.status === 'qty').map(r => r.item_name)
      .concat(result.extra.map(r => r.item_name + ' (not on the bill)'));
    const missing = result.rows.filter(r => r.status === 'missing').length;
    return {ok:result.quantities_match, recount, missing};
  }
  root.WMSInvoice = {compare, learnRows, norm, sim, key, parseEInvoiceQR, blindSummary};
})(typeof window !== 'undefined' ? window : globalThis);
