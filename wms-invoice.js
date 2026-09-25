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
            invoice:{no:invoice.invoice_no, date:invoice.invoice_date, supplier:invoice.supplier_name, supplier_gstin:invoice.supplier_gstin, totals:invoice.totals, notes:invoice.reading_notes,
                     read_label:invoice.read_label, read_confident:invoice.read_confident}};
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
  /* =====================================================================
     FREE READER: no Claude, no cost.
     Computer-made PDFs carry their text; scans and photos go through free OCR (Tesseract).
     Item lines are found by arithmetic, not by layout: in a row, qty x rate (less discount)
     = amount. The line amounts must add up to the bill's taxable value for a confident reading.
     ===================================================================== */
  const GSTIN_G = /\b\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z]\b/g;
  const UNITS = 'NOS|NO|PCS|PC|PIECES?|CTN|CARTONS?|BOX(?:ES)?|BOXS|KGS?|KG|GMS?|GM|LTRS?|LTR|LITRES?|ML|BTLS?|BTL|BOTTLES?|PKTS?|PKT|PACKS?|DOZ|DZN|SETS?|PAIRS?|MTRS?|MTR|MT|QTL|BAGS?|ROLLS?|STRIPS?|TABS?|UNITS?|JARS?|TINS?|CANS?|BUNDLES?|REAMS?|SQFT|SQ\.? ?FT|RFT';
  const UNIT_RE = new RegExp('^(' + UNITS + ')\\.?$', 'i');
  const MON = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,sept:9,oct:10,nov:11,dec:12};
  function toISO(s){
    s = String(s || '').trim();
    let m = s.match(/^(\d{1,2})[-\/. ](\d{1,2})[-\/. ](\d{2}|\d{4})$/);
    if (m){ const y = m[3].length === 2 ? 2000 + +m[3] : +m[3]; if (+m[2] >= 1 && +m[2] <= 12 && +m[1] >= 1 && +m[1] <= 31) return `${y}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`; }
    m = s.match(/^(\d{1,2})[-\/. ]?([A-Za-z]{3,4})[a-z]*[-\/., ]+(\d{2}|\d{4})$/);
    if (m && MON[m[2].toLowerCase()]){ const y = m[3].length === 2 ? 2000 + +m[3] : +m[3]; return `${y}-${String(MON[m[2].toLowerCase()]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`; }
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/); if (m) return s;
    return null;
  }
  function expiryISO(s){                                   // "08/27", "Aug-27", "08/2027" -> last day of the month
    s = String(s || '').trim(); let y, mo;
    let m = s.match(/^(\d{1,2})[-\/.](\d{2}|\d{4})$/); if (m){ mo = +m[1]; y = m[2].length === 2 ? 2000 + +m[2] : +m[2]; }
    m = !mo && s.match(/^([A-Za-z]{3,4})[a-z]*[-\/. ]*(\d{2}|\d{4})$/); if (m && MON[m[1].toLowerCase()]){ mo = MON[m[1].toLowerCase()]; y = m[2].length === 2 ? 2000 + +m[2] : +m[2]; }
    if (mo >= 1 && mo <= 12 && y) return `${y}-${String(mo).padStart(2, '0')}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, '0')}`;
    return toISO(s);
  }
  const numTok = t => { let c = String(t).replace(/,/g, '').replace(/^₹|^Rs\.?/i, ''); let neg = false;
    if (/^\(-\)/.test(c)){ neg = true; c = c.slice(3); } else if (/^\(.*\)$/.test(c)){ neg = true; c = c.slice(1, -1); }
    return /^-?\d+(\.\d+)?$/.test(c) ? (neg ? -1 : 1) * parseFloat(c) : null; };
  const GST_SET = [0, 0.25, 1.5, 3, 5, 6, 12, 18, 28, 40];
  const SKIP_ROW = /\b(sub ?total|grand total|total|cgst|sgst|utgst|igst|cess|round(ed)? ?off|freight|cartage|packing|forwarding|insurance|amount in words|rupees|tax amount|taxable value|less|discount total|e ?& ?o ?e|bank|ifsc|a\/c|declaration|signatory|terms)\b/i;

  // rows of text in reading order; cells kept apart by 3 spaces (from PDF positions or OCR)
  // GSTIN pattern: 2 digits, 5 letters, 4 digits, letter, digit/letter, Z, digit/letter. OCR mixes O/0, I/1, S/5, B/8 - fix by position.
  const TO_D = {O:'0', D:'0', Q:'0', I:'1', L:'1', S:'5', B:'8', Z:'2', G:'6'}, TO_L = {'0':'O', '1':'I', '5':'S', '8':'B', '2':'Z', '6':'G'};
  function fixGstin(t){
    t = String(t).toUpperCase().replace(/[^A-Z0-9]/g, ''); if (t.length !== 15) return null;
    const kind = 'DDLLLLLDDDDLXZX';
    const f = [...t].map((c, i) => kind[i] === 'D' ? (TO_D[c] || c) : kind[i] === 'L' ? (TO_L[c] || c) : kind[i] === 'Z' ? (c === '2' ? 'Z' : c) : c).join('');
    return /^\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/.test(f) ? f : null;
  }
  function parseInvoiceText(lines, hints){
    hints = hints || {};
    const ours = (hints.our_gstins || []).map(g => String(g).toUpperCase());
    const UNIT_GLUE = new RegExp('\\b(\\d+(?:\\.\\d+)?)(' + UNITS + ')\\b', 'gi');       // "2CTN" -> "2 CTN"
    const L = lines.map(l => String(l || '').replace(/\u00a0/g, ' ').replace(/¢/g, 'c').replace(UNIT_GLUE, '$1 $2').trim()).filter(Boolean);
    const all = L.join('\n'), flat = all.replace(/\s+/g, '');
    const out = {supplier_name:null, supplier_gstin:null, buyer_gstin:null, invoice_no:null, invoice_date:null, irn:null, ack_no:null, eway_bill_no:null,
                 lines:[], totals:{taxable:null, cgst:null, sgst:null, igst:null, cess:null, other_charges:null, round_off:null, total:null}, reading_notes:null};
    // GSTINs: ours is the buyer; the other one (usually printed first) is the supplier
    const gs = [...new Set((all.toUpperCase().match(GSTIN_G) || [])
      .concat((all.toUpperCase().match(/\b[0-9A-Z]{15}\b/g) || []).map(fixGstin).filter(Boolean)))];
    out.buyer_gstin = gs.find(g => ours.includes(g)) || null;
    out.supplier_gstin = gs.find(g => !ours.includes(g) && g !== out.buyer_gstin) || (hints.party_gstin && gs.includes(String(hints.party_gstin).toUpperCase()) ? hints.party_gstin : null);
    if (!out.buyer_gstin && gs.length > 1 && out.supplier_gstin) out.buyer_gstin = gs.find(g => g !== out.supplier_gstin) || null;
    let irn = flat.match(/[0-9a-f]{64}/i);
    if (!irn){                                               // IRN printed over two lines: join the hex pieces after the label
      const at = L.findIndex(l => /\bIRN\b/i.test(l));
      if (at >= 0){ const hex = L.slice(at, at + 3).map(l => (l.match(/[0-9a-f]{16,}/gi) || []).join('')).join(''); if (hex.length >= 64) irn = [hex.slice(0, 64)]; }
    }
    out.irn = irn ? irn[0].toLowerCase() : null;
    const ack = all.match(/ack(?:nowledgement)?\.?\s*(?:no|number)\.?\s*[:\-]?\s*(\d{12,18})/i); out.ack_no = ack ? ack[1] : null;
    const ewb = all.match(/e-?\s?way\s*bill\s*(?:no|number)?\.?\s*[:\-]?\s*(\d{4}\s?\d{4}\s?\d{4})/i); out.eway_bill_no = ewb ? ewb[1].replace(/\s/g, '') : null;
    // invoice number and date: value after the label on the same row, else the cell below it
    const labelValue = (re, valRe) => {
      for (let i = 0; i < L.length; i++){
        const m = L[i].match(re); if (!m) continue;
        const rest = L[i].slice(m.index + m[0].length).replace(/^[\s:.\-#]+/, '');
        const v1 = rest.split(/\s{3,}/)[0].trim().split(/\s+(?=dated|date)/i)[0];
        if (v1 && valRe.test(v1)) return v1;
        const cellIdx = L[i].split(/\s{3,}/).findIndex(c => re.test(c));
        for (const j of [i + 1, i + 2]){
          if (!L[j]) continue;
          const cells = L[j].split(/\s{3,}/), c = cells[Math.min(cellIdx, cells.length - 1)] || cells[0];
          if (c && valRe.test(c.trim())) return c.trim();
        }
      }
      return null;
    };
    out.invoice_no = labelValue(/\b(?:tax\s+)?(?:invoice|inv|bill|voucher)\s*(?:no|number|#)\b\.?/i, /^(?=.*\d)[A-Z0-9][A-Z0-9\/\-_.]{0,24}$/i);
    const dv = labelValue(/\b(?:dated|invoice date|inv\.? date|bill date|date of invoice|date)\b/i, /^\d{1,2}[-\/. ](\d{1,2}|[A-Za-z]{3,9})[-\/., ]+\d{2,4}$/);
    out.invoice_date = dv ? toISO(dv) : null;
    if (!out.invoice_date){ const m = all.match(/\b(\d{1,2}[-\/.](?:\d{1,2}|[A-Za-z]{3})[-\/.]\d{2,4})\b/); if (m) out.invoice_date = toISO(m[1]); }
    // supplier name: first line of the bill that is not a heading, a GSTIN or an address-looking line
    const heading = /tax invoice|invoice|original|duplicate|triplicate|gstin|e-?invoice|irn|ack|bill|e-?way|dated?|buyer|consignee|ship|to\b|page/i;
    out.supplier_name = null;
    for (const l of L.slice(0, 12)){ const c = l.split(/\s{3,}/)[0].trim(); if (c && !heading.test(c) && /[A-Za-z]{3}/.test(c) && c.length < 60 && !/^\d/.test(c)){ out.supplier_name = c; break; } }

    // item rows
    let last = null, cols = {};
    const found = [];
    for (let i = 0; i < L.length; i++){
      const line = L[i].replace(/(\d)\s+%/g, '$1%');
      // a table heading tells which extra columns exist (free, GST %, discount, batch, expiry)
      if (/\b(qty|quantity)\b/i.test(line) && /\b(rate|price)\b/i.test(line) && /\b(amount|value|total)\b/i.test(line)){
        cols = {free:/\b(free|sch(?:eme)?|bonus)\b/i.test(line), gst:/\b(gst|tax)\s*%|\bgst\b/i.test(line), disc:/\bdisc/i.test(line),
                batch:/\bbatch\b/i.test(line), exp:/\bexp/i.test(line)}; continue;
      }
      // batch / expiry printed under an item
      if (last){
        const b = line.match(/\bbatch(?:\s*no)?\.?\s*[:\-]?\s*([A-Z0-9][A-Z0-9\/\-]{1,20})/i); if (b && !last.batch) last.batch = b[1];
        const e = line.match(/\bexp(?:iry)?(?:\s*date)?\.?\s*[:\-]?\s*([0-9]{1,2}[\/\-.][0-9]{2,4}|[A-Za-z]{3,4}[\-\/ ]?[0-9]{2,4})/i); if (e && !last.expiry) last.expiry = expiryISO(e[1]);
      }
      if (SKIP_ROW.test(line) && !/\d+\s*(?:x|×)\s*\d/.test(line)) { if (/\b(grand total|invoice total|total amount|net amount|amount payable|total)\b/i.test(line)) last = null; continue; }
      const toks = line.split(/\s+/);
      const nums = [];
      toks.forEach((t, k) => {
        const plus = t.match(/^(\d+(?:\.\d+)?)\+(\d+(?:\.\d+)?)$/);            // "10+2" = billed + free
        if (plus){ nums.push({v:+plus[1], free:+plus[2], k, raw:t}); return; }
        const pct = t.match(/^(\d+(?:\.\d+)?)%$/); if (pct){ nums.push({v:+pct[1], pct:true, k, raw:t}); return; }
        const v = numTok(t); if (v !== null) nums.push({v, k, raw:t, int:/^\d+$/.test(t.replace(/,/g, '')), dec:/\.\d+$/.test(t)});
      });
      if (nums.length < 3) continue;
      // find qty x rate (x (1 - disc)) = amount; amount comes after qty and rate
      let best = null;
      const plain = nums.filter(n => !n.pct);
      for (let a = plain.length - 1; a >= 2; a--){
        const amt = plain[a]; if (amt.v <= 0) continue;
        for (let qi = 0; qi < a; qi++) for (let ri = 0; ri < a; ri++){
          if (qi === ri) continue;
          const q = plain[qi], r = plain[ri]; if (q.v <= 0 || r.v <= 0) continue;
          const discs = [0].concat(nums.filter(n => n.pct && n.v > 0 && n.v < 100).map(n => n.v))
                          .concat(cols.disc ? plain.filter((n, j) => j !== qi && j !== ri && j !== a && n.v > 0 && n.v < 100).map(n => n.v) : []);
          for (const d of [...new Set(discs)]){
            const calc = q.v * r.v * (1 - d / 100);
            if (Math.abs(calc - amt.v) <= Math.max(0.51, amt.v * 0.002)){
              // prefer: qty next to a unit, qty before rate, rate with decimals, HSN not used as qty
              const unitNear = UNIT_RE.test(toks[q.k + 1] || '') || UNIT_RE.test(toks[q.k - 1] || '') || /[A-Za-z]{2,5}$/.test(q.raw);
              const dTok = d ? nums.find(n => n.v === d && (n.pct || cols.disc)) : null;
              let score = (unitNear ? 4 : 0) + (qi < ri ? 2 : 0) + (r.dec ? 1 : 0) + (a === plain.length - 1 ? 2 : 0) - (q.int && String(q.v).length >= 4 && !unitNear ? 3 : 0)
                        - (d ? (dTok && dTok.pct ? 0.5 : 1.5) : 0) + (!q.dec || /\.0+$/.test(q.raw) ? 0.5 : 0) + (dTok && (dTok.k > r.k) ? 0.5 : 0);
              if (d && dTok && !dTok.pct && !(dTok.k > r.k && dTok.k < amt.k)) continue;   // a plain-number discount sits between rate and amount
              if (!q.int && q.v !== Math.round(q.v) && !unitNear) score -= 1;
              if (!best || score > best.score) best = {q, r, amt, d, dk:dTok ? dTok.k : -1, score};
            }
          }
        }
      }
      if (!best) continue;
      const used = new Set([best.q.k, best.r.k, best.amt.k, best.dk]);
      const hsnTok = toks.find((t, k) => !used.has(k) && k < best.amt.k && /^\d{4}(\d{2}){0,2}$/.test(t));
      // batch and expiry columns on the same row
      const expK = toks.findIndex((t, k) => !used.has(k) && /^(0?[1-9]|1[0-2])[\/\-.](\d{2}|\d{4})$/.test(t));
      const batchLike = (t, k) => !used.has(k) && k !== expK && t !== hsnTok && /[A-Z]/i.test(t) && /\d/.test(t) && /^[A-Z0-9\-\/]{3,20}$/i.test(t) && !UNIT_RE.test(t) && k > 1;
      // the batch is usually printed just before the expiry; otherwise the first batch-like code after the HSN
      const hsnK = toks.indexOf(hsnTok);
      let batchK = expK > 0 && batchLike(toks[expK - 1], expK - 1) ? expK - 1 : -1;
      if (batchK < 0 && cols.batch) batchK = toks.findIndex((t, k) => batchLike(t, k) && (hsnK < 0 || k > hsnK));
      // free quantity: its own column right after the quantity
      let free = best.q.free || 0;
      if (cols.free && !free){ const nx = nums.find(n => n.k === best.q.k + 1 && !used.has(n.k) && !n.pct && (n.int || /\.0+$/.test(n.raw))); if (nx){ free = nx.v; used.add(nx.k); } }
      // GST %: a % token, or a plain rate-like number in a GST column after the rate
      let gstTok = nums.find(n => n.pct && GST_SET.includes(n.v) && n.k !== best.dk);
      if (!gstTok && cols.gst) gstTok = nums.find(n => !used.has(n.k) && !n.pct && GST_SET.includes(n.v) && n.v > 0 && n.k > best.r.k && n.k < best.amt.k);
      // description: the words before the first number used, without the serial number, HSN, batch and expiry
      const firstNumK = Math.min(best.q.k, best.r.k);
      const skip = new Set([expK, batchK].filter(k => k >= 0));
      let words = toks.slice(0, firstNumK).filter((t, k) => !skip.has(k) && t !== hsnTok);
      if (words.length && /^\d{1,3}[.)]?$/.test(words[0])) words = words.slice(1);        // serial number
      const desc = words.join(' ').trim();
      if (!/[A-Za-z]{2}/.test(desc)) continue;
      const unitTok = [toks[best.q.k + 1], toks[best.q.k - 1]].find(t => UNIT_RE.test(t || '')) || (best.q.raw.match(/[A-Za-z]{2,5}$/) || [])[0] || null;
      last = {description:desc, item_code:null, hsn:hsnTok || null, qty:best.q.v, free_qty:free, unit:unitTok ? unitTok.replace(/\.$/, '') : null,
              rate:best.r.v, discount_pct:best.d || null, taxable_value:best.amt.v, gst_rate:gstTok ? gstTok.v : null,
              batch:batchK >= 0 ? toks[batchK] : null, expiry:expK >= 0 ? expiryISO(toks[expK]) : null};
      found.push(last);
    }
    out.lines = found;
    // totals
    const amountAfter = re => { for (let i = L.length - 1; i >= 0; i--){ if (re.test(L[i])){ const ns = L[i].split(/\s+/).map(numTok).filter(v => v !== null); if (ns.length) return ns[ns.length - 1]; } } return null; };
    out.totals.total = amountAfter(/\b(grand total|invoice total|total amount|net amount|amount payable|total invoice value|bill amount)\b/i) ?? amountAfter(/^total\b/i);
    out.totals.taxable = amountAfter(/\b(taxable (?:value|amount)|sub ?total|total before tax|assessable value)\b/i);
    const taxSum = re => { let t = 0, any = false;
      L.forEach(l => { for (const m of l.matchAll(new RegExp('\\b(?:' + re + ')\\b[^0-9\\n]{0,12}(?:@\\s*)?(?:\\d+(?:\\.\\d+)?\\s*%)?[\\s:]*(?:rs\\.?|₹)?\\s*([\\d,]+\\.\\d{1,2})', 'gi'))){ any = true; t += parseFloat(m[1].replace(/,/g, '')); } });
      return any ? r2(t) : null; };
    out.totals.cgst = taxSum('cgst'); out.totals.sgst = taxSum('sgst|utgst'); out.totals.igst = taxSum('igst'); out.totals.cess = taxSum('cess');
    out.totals.round_off = amountAfter(/\bround(?:ed)?\s*off\b/i);
    out.totals.other_charges = amountAfter(/\b(freight|cartage|packing|forwarding|insurance)\b/i);
    // how sure are we?
    const sum = r2(found.reduce((a, l) => a + num(l.taxable_value), 0));
    const notes = [], checks = [];
    let confident = found.length > 0;
    const tol = Math.max(1, found.length * 0.5);
    if (out.totals.taxable){
      if (Math.abs(sum - out.totals.taxable) <= tol) checks.push(`line amounts add up to the taxable value ₹${out.totals.taxable}`);
      else if (out.totals.other_charges && Math.abs(sum + num(out.totals.other_charges) - out.totals.taxable) <= tol)
        checks.push(`line amounts plus ₹${out.totals.other_charges} charges add up to the taxable value ₹${out.totals.taxable}`);
      else { confident = false; notes.push(`Line amounts add up to ₹${sum}, but the bill's taxable value is ₹${out.totals.taxable}: a line may have been missed.`); }
    } else if (out.totals.total){
      const tax = num(out.totals.cgst) + num(out.totals.sgst) + num(out.totals.igst) + num(out.totals.cess);
      if (tax && Math.abs(sum + tax + num(out.totals.other_charges) + num(out.totals.round_off) - out.totals.total) <= 2) checks.push(`lines + GST add up to the total ₹${out.totals.total}`);
      else { notes.push('The line amounts could not be tied to the bill total.'); confident = confident && found.length === 1 ? true : false; }
    } else { notes.push('No bill total was found to check the lines against.'); confident = false; }
    if (!out.invoice_no) notes.push('Invoice number not found.');
    out.reading_notes = [checks.length ? 'Checked: ' + checks.join('; ') + '.' : '', ...notes].filter(Boolean).join(' ') || null;
    return {invoice:out, confident, found:found.length, sum};
  }

  // Browser side: read a file for free. PDFs with text -> text; scans and photos -> OCR (loaded when first needed).
  const loadScript = src => new Promise((ok, bad) => {
    const prev = document.querySelector(`script[src="${src}"]`);
    if (prev && prev.dataset.loaded) return ok();
    const s = prev || document.createElement('script');
    const t = setTimeout(() => bad(new Error('The free reader could not be downloaded (' + src.split('/').pop() + '). Check the internet connection.')), 25000);
    s.addEventListener('load', () => { clearTimeout(t); s.dataset.loaded = '1'; ok(); });
    s.addEventListener('error', () => { clearTimeout(t); bad(new Error('Could not load ' + src.split('/').pop())); });
    if (!prev){ s.src = src; document.head.appendChild(s); }
  });
  const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
  const TESS = {script:'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js', workerPath:'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js',
                corePath:'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1', langPath:'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int'};
  function rowsFromItems(items){                            // group text pieces into rows by height on the page
    const rows = [];
    for (const it of items){
      if (!it.s || !it.s.trim()) continue;
      let row = rows.find(r => Math.abs(r.y - it.y) <= Math.max(r.h, it.h) * 0.5);
      if (!row){ row = {y:it.y, h:it.h, items:[]}; rows.push(row); }
      row.items.push(it);
    }
    rows.sort((a, b) => a.y - b.y);
    return rows.map(r => { r.items.sort((a, b) => a.x - b.x); let line = '', end = null;
      for (const it of r.items){ if (end !== null) line += it.x - end > r.h * 1.2 ? '   ' : (it.x - end > r.h * 0.12 ? ' ' : ''); line += it.s; end = it.x + it.w; }
      return line.replace(/[ \t]{4,}/g, '   ').trim(); });
  }
  async function pdfLines(file, maxPages){
    if (!root.pdfjsLib){ await loadScript(PDFJS + 'pdf.min.js'); root.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js'; }
    const pdf = await root.pdfjsLib.getDocument({data:new Uint8Array(await file.arrayBuffer()), isEvalSupported:false}).promise;
    const lines = [], canvases = [];
    for (let p = 1; p <= Math.min(pdf.numPages, maxPages || 4); p++){
      const page = await pdf.getPage(p), tc = await page.getTextContent();
      lines.push(...rowsFromItems((tc.items || []).map(it => ({s:it.str, x:it.transform[4], y:-it.transform[5], h:Math.abs(it.transform[3]) || it.height || 10, w:it.width || 0}))));
      canvases.push(page);
    }
    return {lines, pages:canvases, pdf};
  }
  async function ocrLines(source){
    if (!root.Tesseract) await loadScript(TESS.script);
    const worker = await root.Tesseract.createWorker('eng', 1, {workerPath:TESS.workerPath, corePath:TESS.corePath, langPath:TESS.langPath});
    try{
      const {data} = await worker.recognize(source);
      return ocrDataLines(data);
    } finally { await worker.terminate(); }
  }
  // lines as Tesseract found them (robust to a tilted photo); a wide gap between words becomes a cell break
  function ocrDataLines(data){
    const lines = data.lines && data.lines.length ? data.lines : null;
    if (!lines) return String(data.text || '').split('\n');
    return lines.map(ln => {
      const ws = (ln.words || []).slice().sort((a, b) => a.bbox.x0 - b.bbox.x0);
      if (!ws.length) return String(ln.text || '').trim();
      const h = Math.max(8, ...ws.map(w => w.bbox.y1 - w.bbox.y0));
      let out = '', end = null;
      for (const w of ws){ if (end !== null) out += w.bbox.x0 - end > h * 1.2 ? '   ' : ' '; out += w.text; end = w.bbox.x1; }
      return out.trim();
    });
  }
  async function pageCanvas(page){
    const vp0 = page.getViewport({scale:1}), vp = page.getViewport({scale:Math.min(3, 2400 / Math.max(vp0.width, vp0.height))});
    const c = document.createElement('canvas'); c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    await page.render({canvasContext:g, viewport:vp}).promise; return c;
  }
  // returns {invoice, method, confident}
  async function readFree(file, hints, onStep){
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '');
    if (isPdf){
      onStep && onStep('Reading the PDF text (free)…');
      const r = await pdfLines(file);
      if (r.lines.join('').replace(/\s/g, '').length >= 80){
        const p = parseInvoiceText(r.lines, hints);
        return {...p, method:'pdf-text'};
      }
      onStep && onStep('The PDF is a scan. Reading it with free OCR (first time downloads about 10 MB)…');
      const lines = [];
      for (const page of r.pages.slice(0, 2)) lines.push(...await ocrLines(await pageCanvas(page)));
      return {...parseInvoiceText(lines, hints), method:'ocr'};
    }
    onStep && onStep('Reading the photo with free OCR (first time downloads about 10 MB)…');
    return {...parseInvoiceText(await ocrLines(file), hints), method:'ocr'};
  }

  // Claude through the read-invoice server function (needs the ANTHROPIC_API_KEY secret)
  async function readClaude(sb, file){
    const b64 = await new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = () => bad(r.error); r.readAsDataURL(file); });
    const {data, error} = await sb.functions.invoke('read-invoice', {body:{file_base64:b64, media_type:file.type || 'image/jpeg'}});
    if (error){ let m = error.message, code = null; try{ const j = await error.context.json(); m = j.error || m; code = j.code || null; }catch(e){}
      const e2 = new Error(m); e2.code = code; throw e2; }
    if (!data || !data.ok) throw new Error((data && data.error) || 'The invoice could not be read.');
    return data.invoice;
  }
  // mode: 'free_first' (free, then Claude if the free reading does not tie up), 'free_only', 'claude_first'
  async function readSmart(file, opts){
    const {sb, hints, mode = 'free_first', onStep} = opts || {};
    const LABEL = {'pdf-text':'Read free from the PDF text', ocr:'Read free by OCR from the image', claude:'Read by Claude'};
    const done = (invoice, method, confident, extra) => ({invoice, method, label:LABEL[method] + (extra ? ` (${extra})` : ''), confident});
    let free = null, freeErr = null, claudeErr = null;
    const tryFree = async () => { try{ free = await readFree(file, hints, onStep); }catch(e){ freeErr = e; } };
    const tryClaude = async () => { try{ onStep && onStep('Reading with Claude…'); return await readClaude(sb, file); }catch(e){ claudeErr = e; return null; } };
    if (mode === 'claude_first'){
      const c = await tryClaude(); if (c) return done(c, 'claude', true);
      await tryFree();
    } else {
      await tryFree();
      if (free && free.confident) return done(free.invoice, free.method, true);
      if (mode === 'free_first'){ const c = await tryClaude(); if (c) return done(c, 'claude', true, free ? 'the free reading did not tie up' : ''); }
    }
    if (free && free.found) return done(free.invoice, free.method, false, 'not fully checked: compare with the bill');
    const why = [freeErr && freeErr.message, free && !free.found && 'no item lines were found', claudeErr && (claudeErr.code === 'not_configured' ? 'Claude is not set up' : claudeErr.message)].filter(Boolean).join('; ');
    throw new Error('The invoice could not be read' + (why ? ': ' + why : '.') + ' Try a clearer PDF or photo.');
  }

  root.WMSInvoice = {compare, learnRows, norm, sim, key, parseEInvoiceQR, blindSummary, parseInvoiceText, readFree, readClaude, readSmart, rowsFromItems, ocrDataLines, fixGstin, toISO, expiryISO};
})(typeof window !== 'undefined' ? window : globalThis);
