/* =====================================================================
   WMS -> TallyPrime. Builds masters and vouchers as Tally XML.
   WMSTally.load(sb, tenantId, queueRows) -> data
   WMSTally.build(data, queueRows)        -> {byCompany:{name:{masters:[], vouchers:[]}}, problems:[]}
   WMSTally.envelope(company, items, report) -> full import XML (file route)
   Sign rule (same as TDS Desk): a debit is ISDEEMEDPOSITIVE Yes with a
   negative AMOUNT; a credit is No with a positive AMOUNT.
   Every voucher carries "WMS:<id>" in its narration so the bridge can
   read it back and confirm it.
   ===================================================================== */
(function(root){
  const xe = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&#34;',"'":'&#39;'}[c]));
  const num = v => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
  const r2 = n => Math.round((num(n) + Number.EPSILON) * 100) / 100;
  const a2 = n => r2(n).toFixed(2);
  const td = d => String(d || '').slice(0, 10).replace(/-/g, '');
  const q3 = n => String(Math.round(num(n) * 1000) / 1000);
  const rateTxt = r => String(Math.round(num(r) * 100) / 100);
  const STATES = {'01':'Jammu & Kashmir','02':'Himachal Pradesh','03':'Punjab','04':'Chandigarh','05':'Uttarakhand','06':'Haryana','07':'Delhi',
    '08':'Rajasthan','09':'Uttar Pradesh','10':'Bihar','11':'Sikkim','12':'Arunachal Pradesh','13':'Nagaland','14':'Manipur','15':'Mizoram',
    '16':'Tripura','17':'Meghalaya','18':'Assam','19':'West Bengal','20':'Jharkhand','21':'Odisha','22':'Chhattisgarh','23':'Madhya Pradesh',
    '24':'Gujarat','26':'Dadra & Nagar Haveli and Daman & Diu','27':'Maharashtra','29':'Karnataka','30':'Goa','31':'Lakshadweep',
    '32':'Kerala','33':'Tamil Nadu','34':'Puducherry','35':'Andaman & Nicobar Islands','36':'Telangana','37':'Andhra Pradesh','38':'Ladakh','97':'Other Territory'};
  const DUTY = {cgst:'Central Tax', sgst:'State Tax', igst:'Integrated Tax', cess:'Cess'};

  /* ---------------- loading ---------------- */
  async function load(sb, tenant, rows){
    const one = async q => { const {data, error} = await q; if (error) throw error; return data; };
    const ids = kind => [...new Set(rows.filter(r => r.entity === kind).map(r => r.entity_id))];
    const docIds = ids('document'), recIds = ids('receipt'), payIds = ids('payment');
    const chunk = (a, n = 150) => Array.from({length:Math.ceil(a.length / n)}, (_, i) => a.slice(i * n, i * n + n));
    const inq = async (table, col, list, cols = '*') => { const out = []; for (const c of chunk(list)) if (c.length) out.push(...await one(sb.from(table).select(cols).in(col, c))); return out; };
    const [settings, companies, tenantRow, docs, lines, ledger, receipts, payments] = await Promise.all([
      one(sb.from('tally_settings').select('*').eq('tenant_id', tenant).maybeSingle()),
      one(sb.from('tally_companies').select('*').eq('tenant_id', tenant)),
      one(sb.from('tenants').select('*').eq('id', tenant).single()),
      inq('documents', 'id', docIds), inq('document_lines', 'document_id', docIds),
      inq('stock_ledger', 'document_id', docIds, 'document_id,document_line_id,warehouse_id,qty,unit_cost,is_reversal'),
      inq('customer_receipts', 'id', recIds), inq('supplier_payments', 'id', payIds)
    ]);
    const [ralloc, palloc] = await Promise.all([inq('receipt_allocations', 'receipt_id', recIds), inq('bill_allocations', 'payment_id', payIds)]);
    const invIds = [...new Set(ralloc.map(a => a.invoice_id).concat(docs.map(d => d.against_doc_id).filter(Boolean)))];
    const billIds = [...new Set(palloc.map(a => a.bill_id))];
    const [invs, bills, items, parties, whs, logs] = await Promise.all([
      inq('documents', 'id', invIds, 'id,doc_no,doc_date'), inq('supplier_bills', 'id', billIds, 'id,bill_no,bill_date'),
      inq('items', 'id', [...new Set(lines.map(l => l.item_id))]),
      inq('parties', 'id', [...new Set(docs.map(d => d.party_id).concat(receipts.map(r => r.party_id), payments.map(p => p.party_id)).filter(Boolean))]),
      one(sb.from('warehouses').select('*').eq('tenant_id', tenant)),
      inq('tally_sync_log', 'entity_id', docIds.concat(recIds, payIds), 'entity_id,action,side,status,voucher_no,tally_company,guid,id')
    ]);
    const by = (a, k = 'id') => Object.fromEntries(a.map(x => [x[k], x]));
    return {settings:settings || {}, companies, tenant:tenantRow, docs:by(docs), lines, ledger, receipts:by(receipts), payments:by(payments),
            ralloc, palloc, invs:by(invs), bills:by(bills), items:by(items), parties:by(parties), whs:by(whs), logs};
  }

  /* ---------------- helpers over data ---------------- */
  function ctx(D){
    const S = Object.assign({sales_ledger:'Sales @ {rate}%', purchase_ledger:'Purchase @ {rate}%', out_cgst:'Output CGST', out_sgst:'Output SGST',
      out_igst:'Output IGST', out_cess:'Output Cess', in_cgst:'Input CGST', in_sgst:'Input SGST', in_igst:'Input IGST', in_cess:'Input Cess',
      walkin_ledger:'Cash', cash_ledger:'Cash', bank_ledger:'Bank', debtors_group:'Sundry Debtors', creditors_group:'Sundry Creditors',
      branch_ledger_prefix:'Branch - ', vt_sales:'Sales', vt_purchase:'Purchase', vt_credit_note:'Credit Note', vt_debit_note:'Debit Note',
      vt_stock_journal:'Stock Journal', vt_receipt:'Receipt', vt_payment:'Payment'}, D.settings);
    const gstinOf = w => (w && w.gstin) || D.tenant.gstin;
    const companyFor = gstin => (D.companies.find(c => c.gstin === gstin) || {}).company_name;
    const itemName = it => it.tally_stock_item || it.name;
    const godown = w => (w && (w.tally_godown || w.name)) || 'Main Location';
    const partyLedger = p => p.tally_ledger || p.name;
    const branchLedger = w => S.branch_ledger_prefix + w.name;
    const salesLedger = r => S.sales_ledger.replace('{rate}', rateTxt(r));
    const purchaseLedger = r => S.purchase_ledger.replace('{rate}', rateTxt(r));
    return {S, gstinOf, companyFor, itemName, godown, partyLedger, branchLedger, salesLedger, purchaseLedger};
  }

  /* ---------------- masters ---------------- */
  function ledgerMaster(name, parent, extra = ''){
    return `<LEDGER NAME="${xe(name)}" ACTION="Create"><NAME.LIST><NAME>${xe(name)}</NAME></NAME.LIST><PARENT>${xe(parent)}</PARENT>${extra}</LEDGER>`;
  }
  function partyMaster(name, parent, gstin, state, addr){
    return ledgerMaster(name, parent, `<ISBILLWISEON>Yes</ISBILLWISEON>` +
      (gstin ? `<PARTYGSTIN>${xe(gstin)}</PARTYGSTIN><GSTREGISTRATIONTYPE>Regular</GSTREGISTRATIONTYPE>` : `<GSTREGISTRATIONTYPE>Unregistered/Consumer</GSTREGISTRATIONTYPE>`) +
      (state && STATES[state] ? `<LEDSTATENAME>${xe(STATES[state])}</LEDSTATENAME><COUNTRYNAME>India</COUNTRYNAME>` : '') +
      (addr && addr.length ? `<ADDRESS.LIST>${addr.filter(Boolean).slice(0, 4).map(a => `<ADDRESS>${xe(a)}</ADDRESS>`).join('')}</ADDRESS.LIST>` : ''));
  }
  const taxMaster = (name, head) => ledgerMaster(name, 'Duties & Taxes', `<TAXTYPE>GST</TAXTYPE><GSTDUTYHEAD>${xe(head)}</GSTDUTYHEAD>`);
  const unitMaster = u => `<UNIT NAME="${xe(u)}" ACTION="Create"><NAME>${xe(u)}</NAME><ISSIMPLEUNIT>Yes</ISSIMPLEUNIT><DECIMALPLACES>3</DECIMALPLACES></UNIT>`;
  const godownMaster = g => `<GODOWN NAME="${xe(g)}" ACTION="Create"><NAME.LIST><NAME>${xe(g)}</NAME></NAME.LIST></GODOWN>`;
  const itemMaster = (name, uom, hsn) => `<STOCKITEM NAME="${xe(name)}" ACTION="Create"><NAME.LIST><NAME>${xe(name)}</NAME></NAME.LIST><BASEUNITS>${xe(uom)}</BASEUNITS>` +
    (hsn ? `<GSTDETAILS.LIST><APPLICABLEFROM>20170701</APPLICABLEFROM><HSNCODE>${xe(hsn)}</HSNCODE><TAXABILITY>Taxable</TAXABILITY></GSTDETAILS.LIST>` : '') + `</STOCKITEM>`;

  /* ---------------- voucher parts ---------------- */
  function head(vt, view, date, no, extra, narr){
    return `<VOUCHER VCHTYPE="${xe(vt)}" ACTION="Create" OBJVIEW="${view}"><DATE>${td(date)}</DATE><EFFECTIVEDATE>${td(date)}</EFFECTIVEDATE>` +
      `<VOUCHERTYPENAME>${xe(vt)}</VOUCHERTYPENAME><VOUCHERNUMBER>${xe(no)}</VOUCHERNUMBER>${extra}<NARRATION>${xe(narr)}</NARRATION>` +
      `<PERSISTEDVIEW>${view}</PERSISTEDVIEW>`;
  }
  const le = (ledger, dr, amt, bills, isParty) => `<LEDGERENTRIES.LIST><LEDGERNAME>${xe(ledger)}</LEDGERNAME><ISDEEMEDPOSITIVE>${dr ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>` +
    `<ISPARTYLEDGER>${isParty ? 'Yes' : 'No'}</ISPARTYLEDGER><AMOUNT>${dr ? '-' : ''}${a2(amt)}</AMOUNT>` +
    (bills || []).map(b => `<BILLALLOCATIONS.LIST><NAME>${xe(b.name)}</NAME><BILLTYPE>${b.type}</BILLTYPE><AMOUNT>${dr ? '-' : ''}${a2(b.amt)}</AMOUNT></BILLALLOCATIONS.LIST>`).join('') +
    `</LEDGERENTRIES.LIST>`;
  const ale = (ledger, dr, amt, bills, isParty) => le(ledger, dr, amt, bills, isParty).replace(/^<LEDGERENTRIES\.LIST>/, '<ALLLEDGERENTRIES.LIST>').replace(/<\/LEDGERENTRIES\.LIST>$/, '</ALLLEDGERENTRIES.LIST>');
  function inv(tag, name, uom, dr, qty, amt, godown, batch, ledger){
    const q = `${q3(qty)} ${xe(uom)}`, sign = dr ? '-' : '';
    const rate = num(qty) ? `${(num(amt) / num(qty)).toFixed(4)}/${xe(uom)}` : `0/${xe(uom)}`;
    return `<${tag}><STOCKITEMNAME>${xe(name)}</STOCKITEMNAME><ISDEEMEDPOSITIVE>${dr ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE><RATE>${rate}</RATE>` +
      `<AMOUNT>${sign}${a2(amt)}</AMOUNT><ACTUALQTY>${q}</ACTUALQTY><BILLEDQTY>${q}</BILLEDQTY>` +
      `<BATCHALLOCATIONS.LIST><GODOWNNAME>${xe(godown)}</GODOWNNAME>${batch ? `<BATCHNAME>${xe(batch)}</BATCHNAME>` : ''}<AMOUNT>${sign}${a2(amt)}</AMOUNT><ACTUALQTY>${q}</ACTUALQTY><BILLEDQTY>${q}</BILLEDQTY></BATCHALLOCATIONS.LIST>` +
      (ledger ? `<ACCOUNTINGALLOCATIONS.LIST><LEDGERNAME>${xe(ledger)}</LEDGERNAME><ISDEEMEDPOSITIVE>${dr ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE><AMOUNT>${sign}${a2(amt)}</AMOUNT></ACCOUNTINGALLOCATIONS.LIST>` : '') +
      `</${tag}>`;
  }
  function gstParty(gstin, state){
    return (gstin ? `<PARTYGSTIN>${xe(gstin)}</PARTYGSTIN><GSTREGISTRATIONTYPE>Regular</GSTREGISTRATIONTYPE>` : `<GSTREGISTRATIONTYPE>Unregistered/Consumer</GSTREGISTRATIONTYPE>`) +
      (state && STATES[state] ? `<STATENAME>${xe(STATES[state])}</STATENAME><PLACEOFSUPPLY>${xe(STATES[state])}</PLACEOFSUPPLY>` : '') + `<COUNTRYOFRESIDENCE>India</COUNTRYOFRESIDENCE>`;
  }

  /* ---------------- build ---------------- */
  function build(D, rows){
    const C = ctx(D), S = C.S, out = {}, problems = [];
    const bucket = company => (out[company] = out[company] || {masters:new Map(), vouchers:[]});
    const addM = (b, key, xml) => { if (!b.masters.has(key)) b.masters.set(key, xml); };
    const linesOf = id => D.lines.filter(l => l.document_id === id).sort((a, b) => a.line_no - b.line_no);
    const ensureItem = (b, it, w) => { addM(b, 'U:' + it.uom, unitMaster(it.uom)); addM(b, 'G:' + C.godown(w), godownMaster(C.godown(w))); addM(b, 'I:' + C.itemName(it), itemMaster(C.itemName(it), it.uom, it.hsn_code)); };
    const taxMasters = (b, side) => {
      const k = side === 'out' ? ['out_cgst','out_sgst','out_igst','out_cess'] : ['in_cgst','in_sgst','in_igst','in_cess'];
      [['cgst', k[0]], ['sgst', k[1]], ['igst', k[2]], ['cess', k[3]]].forEach(([d, key]) => addM(b, 'L:' + S[key], taxMaster(S[key], DUTY[d])));
    };
    const logFor = (id, side, action) => D.logs.filter(l => l.entity_id === id && l.side === side && l.action === action && l.status === 'ok').pop();
    const narr = (txt, id) => `${txt} | WMS:${id}`;

    rows.forEach(row => {
      try{
        if (row.entity === 'document'){
          const d = D.docs[row.entity_id]; if (!d) throw new Error('Document not loaded.');
          const w = D.whs[d.warehouse_id], tw = D.whs[d.to_warehouse_id], p = D.parties[d.party_id];
          const branch = d.doc_type === 'transfer' && C.gstinOf(w) !== C.gstinOf(tw);
          const sideGstin = row.side === 'receiver' ? C.gstinOf(tw) : C.gstinOf(w);
          const company = C.companyFor(sideGstin);
          if (!company) throw new Error(`No Tally company set for GSTIN ${sideGstin || '(none)'}. Add it in Settings, Tally companies.`);
          const b = bucket(company);
          const L = linesOf(d.id);
          const vtFor = () => ({sales_invoice:S.vt_sales, sales_return:S.vt_credit_note, grn:S.vt_purchase, purchase_return:S.vt_debit_note}[d.doc_type]
                                || (branch ? (row.side === 'receiver' ? S.vt_purchase : S.vt_sales) : S.vt_stock_journal));

          if (row.action === 'cancel'){
            const lg = logFor(d.id, row.side, 'create');
            const vt = vtFor(), no = (lg && lg.voucher_no) || d.doc_no;
            const x = lg && lg.guid
              ? `<VOUCHER REMOTEID="${xe(lg.guid)}" VCHTYPE="${xe(vt)}" ACTION="Cancel"><DATE>${td(d.doc_date)}</DATE><VOUCHERTYPENAME>${xe(vt)}</VOUCHERTYPENAME><NARRATION>${xe(narr('Cancelled in WMS: ' + (d.reason || ''), d.id))}</NARRATION></VOUCHER>`
              : `<VOUCHER DATE="${td(d.doc_date)}" TAGNAME="Voucher Number" TAGVALUE="${xe(no)}" VCHTYPE="${xe(vt)}" ACTION="Cancel"><DATE>${td(d.doc_date)}</DATE><VOUCHERTYPENAME>${xe(vt)}</VOUCHERTYPENAME><VOUCHERNUMBER>${xe(no)}</VOUCHERNUMBER><NARRATION>${xe(narr('Cancelled in WMS: ' + (d.reason || ''), d.id))}</NARRATION></VOUCHER>`;
            b.vouchers.push({row, xml:x, voucherNo:no});
            return;
          }

          L.forEach(l => { const it = D.items[l.item_id]; if (!it) throw new Error('Item not loaded.'); ensureItem(b, it, row.side === 'receiver' ? tw : w); });
          const tot = f => r2(L.reduce((a, l) => a + num(l[f]), 0));
          const total = tot('line_total');
          const taxEntries = (side, dr) => [['cgst', side + '_cgst'], ['sgst', side + '_sgst'], ['igst', side + '_igst'], ['cess', side + '_cess']]
            .map(([f, key]) => tot(f) ? le(S[key], dr, tot(f)) : '').join('');
          const batchOf = l => (D.items[l.item_id].track_batch && l.batch_no) ? l.batch_no : '';

          if (d.doc_type === 'sales_invoice' || d.doc_type === 'sales_return' || (branch && row.side === 'main')){
            const isCN = d.doc_type === 'sales_return';
            let party, gstin, state, bills;
            if (branch){ party = C.branchLedger(tw); gstin = C.gstinOf(tw); state = tw.state_code; addM(b, 'L:' + party, partyMaster(party, S.debtors_group, gstin, state, [tw.address, tw.city])); }
            else if (p){ party = C.partyLedger(p); gstin = p.gstin; state = d.place_of_supply || p.state_code; addM(b, 'L:' + party, partyMaster(party, S.debtors_group, p.gstin, p.state_code, [p.address1, p.address2, p.city])); }
            else { party = S.walkin_ledger; gstin = null; state = d.place_of_supply || w.state_code; }
            const orig = isCN && d.against_doc_id && D.invs[d.against_doc_id];
            bills = (p || branch) ? [{name:orig ? orig.doc_no : d.doc_no, type:orig ? 'Agst Ref' : 'New Ref', amt:total}] : null;
            taxMasters(b, 'out');
            const vt = isCN ? S.vt_credit_note : S.vt_sales;
            let x = head(vt, 'Invoice Voucher View', d.doc_date, d.doc_no,
              `<REFERENCE>${xe(orig ? orig.doc_no : d.doc_no)}</REFERENCE><PARTYLEDGERNAME>${xe(party)}</PARTYLEDGERNAME><PARTYNAME>${xe(party)}</PARTYNAME><BASICBUYERNAME>${xe(party)}</BASICBUYERNAME>` +
              gstParty(gstin, state) + (C.gstinOf(w) ? `<CMPGSTIN>${xe(C.gstinOf(w))}</CMPGSTIN>` : '') + (d.irn ? `<IRN>${xe(d.irn)}</IRN>` : '') +
              `<ISINVOICE>Yes</ISINVOICE><VCHENTRYMODE>Item Invoice</VCHENTRYMODE>`,
              narr(`${isCN ? 'Credit note' : branch ? 'Branch transfer to ' + tw.name : 'Sales invoice'} ${d.doc_no}${orig ? ' against ' + orig.doc_no : ''}`, d.id));
            x += le(party, !isCN, total, bills, true);
            L.forEach(l => { const it = D.items[l.item_id]; addM(b, 'L:' + C.salesLedger(l.gst_rate), ledgerMaster(C.salesLedger(l.gst_rate), 'Sales Accounts'));
              x += inv('ALLINVENTORYENTRIES.LIST', C.itemName(it), it.uom, isCN, l.qty, l.taxable_value, C.godown(w), batchOf(l), C.salesLedger(l.gst_rate)); });
            x += taxEntries('out', isCN);
            b.vouchers.push({row, xml:x + '</VOUCHER>', voucherNo:d.doc_no});
            return;
          }

          if (d.doc_type === 'grn' || d.doc_type === 'purchase_return' || (branch && row.side === 'receiver')){
            const isDN = d.doc_type === 'purchase_return';
            let party, gstin, state, ref, refDate;
            const gw = branch ? tw : w;
            if (branch){ party = C.branchLedger(w); gstin = C.gstinOf(w); state = w.state_code; ref = d.doc_no; refDate = d.doc_date;
              addM(b, 'L:' + party, partyMaster(party, S.creditors_group, gstin, state, [w.address, w.city])); }
            else { if (!p) throw new Error('Supplier missing.'); party = C.partyLedger(p); gstin = p.gstin; state = p.state_code;
              ref = d.party_doc_no || d.doc_no; refDate = d.party_doc_date || d.doc_date;
              addM(b, 'L:' + party, partyMaster(party, S.creditors_group, p.gstin, p.state_code, [p.address1, p.address2, p.city])); }
            taxMasters(b, 'in');
            const vt = isDN ? S.vt_debit_note : S.vt_purchase;
            let x = head(vt, 'Invoice Voucher View', d.doc_date, d.doc_no,
              `<REFERENCE>${xe(ref)}</REFERENCE><REFERENCEDATE>${td(refDate)}</REFERENCEDATE><PARTYLEDGERNAME>${xe(party)}</PARTYLEDGERNAME><PARTYNAME>${xe(party)}</PARTYNAME>` +
              gstParty(gstin, state) + (C.gstinOf(gw) ? `<CMPGSTIN>${xe(C.gstinOf(gw))}</CMPGSTIN>` : '') + `<ISINVOICE>Yes</ISINVOICE><VCHENTRYMODE>Item Invoice</VCHENTRYMODE>`,
              narr(`${isDN ? 'Goods returned to supplier' : branch ? 'Branch transfer from ' + w.name : 'Goods received'} ${d.doc_no}${d.party_doc_no ? ', supplier bill ' + d.party_doc_no : ''}`, d.id));
            x += le(party, isDN, total, [{name:ref, type:isDN ? 'New Ref' : 'New Ref', amt:total}], true);
            L.forEach(l => { const it = D.items[l.item_id]; addM(b, 'L:' + C.purchaseLedger(l.gst_rate), ledgerMaster(C.purchaseLedger(l.gst_rate), 'Purchase Accounts'));
              x += inv('ALLINVENTORYENTRIES.LIST', C.itemName(it), it.uom, !isDN, l.qty, l.taxable_value, C.godown(gw), batchOf(l), C.purchaseLedger(l.gst_rate)); });
            x += taxEntries('in', !isDN);
            b.vouchers.push({row, xml:x + '</VOUCHER>', voucherNo:d.doc_no});
            return;
          }

          // stock journal: same-GSTIN transfer, adjustments, opening stock — valued at actual cost
          const costOf = (l, sign) => r2(D.ledger.filter(m => m.document_line_id === l.id && !m.is_reversal && Math.sign(num(m.qty)) === sign)
                                         .reduce((a, m) => a + Math.abs(num(m.qty) * num(m.unit_cost)), 0));
          let x = head(S.vt_stock_journal, 'Consumption Voucher View', d.doc_date, d.doc_no, '',
            narr(`${d.doc_type === 'transfer' ? `Transfer ${w.name} to ${tw.name}` : d.doc_type === 'opening' ? 'Opening stock' : 'Stock adjustment'} ${d.doc_no}${d.reason ? ': ' + d.reason : ''}`, d.id));
          if (d.doc_type === 'transfer') L.forEach(l => ensureItem(b, D.items[l.item_id], tw));
          L.forEach(l => {
            const it = D.items[l.item_id];
            if (d.doc_type === 'transfer' || d.doc_type === 'adjustment_out')
              x += inv('INVENTORYENTRIESOUT.LIST', C.itemName(it), it.uom, false, l.qty, costOf(l, -1), C.godown(w), batchOf(l));
            if (d.doc_type === 'transfer' || d.doc_type === 'adjustment_in' || d.doc_type === 'opening')
              x += inv('INVENTORYENTRIESIN.LIST', C.itemName(it), it.uom, true, l.qty, d.doc_type === 'transfer' ? costOf(l, -1) : costOf(l, 1), C.godown(d.doc_type === 'transfer' ? tw : w), batchOf(l));
          });
          b.vouchers.push({row, xml:x + '</VOUCHER>', voucherNo:d.doc_no});
          return;
        }

        // receipts and payments
        const isR = row.entity === 'receipt', m = isR ? D.receipts[row.entity_id] : D.payments[row.entity_id];
        if (!m) throw new Error('Entry not loaded.');
        const company = C.companyFor(D.tenant.gstin) || (D.companies[0] || {}).company_name;
        if (!company) throw new Error('No Tally company set. Add one in Settings, Tally companies.');
        const b = bucket(company), p = D.parties[m.party_id], party = C.partyLedger(p);
        addM(b, 'L:' + party, partyMaster(party, isR ? S.debtors_group : S.creditors_group, p.gstin, p.state_code, [p.address1, p.address2, p.city]));
        const allocs = isR ? D.ralloc.filter(a => a.receipt_id === m.id).map(a => ({name:(D.invs[a.invoice_id] || {}).doc_no, amt:num(a.amount), type:'Agst Ref'}))
                           : D.palloc.filter(a => a.payment_id === m.id).map(a => ({name:(D.bills[a.bill_id] || {}).bill_no, amt:num(a.amount), type:'Agst Ref'}));
        const used = r2(allocs.reduce((a, x) => a + x.amt, 0));
        if (r2(num(m.amount) - used) > 0) allocs.push({name:(m.reference || (isR ? 'Advance' : 'Advance paid')) + ' ' + String(m.id).slice(0, 8), amt:r2(num(m.amount) - used), type:'Advance'});
        const cashBank = m.mode === 'cash' ? S.cash_ledger : S.bank_ledger;
        const vt = isR ? S.vt_receipt : S.vt_payment;
        let x = head(vt, 'Accounting Voucher View', isR ? m.receipt_date : m.payment_date, '',
          `<PARTYLEDGERNAME>${xe(party)}</PARTYLEDGERNAME><ISINVOICE>No</ISINVOICE>`,
          narr(`${isR ? 'Received from' : 'Paid to'} ${p.name}${m.reference ? ', ref ' + m.reference : ''}`, m.id));
        x = x.replace('<VOUCHERNUMBER></VOUCHERNUMBER>', '');
        if (isR){ x += ale(cashBank, true, m.amount) + ale(party, false, m.amount, allocs, true); }
        else { x += ale(party, true, m.amount, allocs, true) + ale(cashBank, false, m.amount); }
        b.vouchers.push({row, xml:x + '</VOUCHER>', voucherNo:''});
      }catch(e){ problems.push({row, message:e.message}); }
    });
    const byCompany = {};
    Object.entries(out).forEach(([c, v]) => { byCompany[c] = {masters:[...v.masters.entries()].map(([k, xml]) => ({id:k, xml})), vouchers:v.vouchers}; });
    return {byCompany, problems};
  }

  function envelope(company, list, report){
    return `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>${report}</REPORTNAME>` +
      `<STATICVARIABLES><SVCURRENTCOMPANY>${xe(company)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA>` +
      list.map(x => `<TALLYMESSAGE xmlns:UDF="TallyUDF">${x.xml}</TALLYMESSAGE>`).join('') +
      `</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
  }

  /* =====================================================================
     TALLY -> WMS: stock items and parties
     Pure functions (no network): the office app fetches Tally's XML through
     the bridge's read-only /export address and passes the text in here.
     Rules: never renames, deletes or deactivates anything in WMS; fills
     blanks; links names; adds a GST rate row only when Tally's rate is newer.
     ===================================================================== */
  const exportRequest = (id, type, fetch, company) =>
    '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>' + id + '</ID></HEADER>' +
    '<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>' + (company ? `<SVCURRENTCOMPANY>${xe(company)}</SVCURRENTCOMPANY>` : '') +
    '</STATICVARIABLES><TDL><TDLMESSAGE>' +
    `<COLLECTION NAME="${id}" ISMODIFY="No"><TYPE>${type}</TYPE><FETCH>${fetch}</FETCH></COLLECTION>` +
    '</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>';
  const PULL_REQUESTS = {
    items:  c => exportRequest('WMSPullItems', 'StockItem',
      'NAME,PARENT,BASEUNITS,GUID,ALTERID,ISBATCHWISEON,ISPERISHABLEON,HSNCODE,GSTDETAILS.LIST,HSNDETAILS.LIST,MRPDETAILS.LIST,STANDARDCOSTLIST.LIST,STANDARDPRICELIST.LIST', c),
    ledgers:c => exportRequest('WMSPullLedgers', 'Ledger',
      'NAME,PARENT,GUID,ALTERID,PARTYGSTIN,LEDSTATENAME,STATENAME,ADDRESS.LIST,PINCODE,LEDGERPHONE,LEDGERMOBILE,EMAIL,LEDGSTREGDETAILS.LIST,LEDMAILINGDETAILS.LIST', c),
    groups: c => exportRequest('WMSPullGroups', 'Group', 'NAME,PARENT', c)
  };

  // Tally sometimes sends control characters that no XML reader accepts
  const cleanXml = t => String(t || '').replace(/&#(x0*[0-8bcef]|x0*1[0-9a-f]|0*[0-8]|0*1[1-2]|0*1[4-9]|0*2[0-9]|0*3[01]);/gi, '')
                                     .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  function parseXml(text){
    const P = root.DOMParser ? new root.DOMParser() : null;
    if (!P) throw new Error('No XML reader in this browser.');
    const doc = P.parseFromString(cleanXml(text), 'text/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('Tally sent data that could not be read.');
    return doc;
  }
  const kids = (el, tag) => el ? [...el.children].filter(c => c.tagName === tag) : [];
  const kid = (el, tag) => kids(el, tag)[0] || null;
  const txt = (el, tag) => { const k = kid(el, tag); return k ? k.textContent.trim() : ''; };
  const nameOf = el => el.getAttribute('NAME') || txt(el, 'NAME') || (kid(el, 'NAME.LIST') ? txt(kid(el, 'NAME.LIST'), 'NAME') : '');
  const tdate = s => /^\d{8}$/.test(s || '') ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null;
  // of several dated blocks (GST details, MRP, cost), use the latest
  const latest = (blocks, dateTag) => blocks.slice().sort((a, b) => (tdate(txt(b, dateTag)) || '') > (tdate(txt(a, dateTag)) || '') ? 1 : -1)[0] || null;
  const rateNum = s => { const m = String(s || '').replace(/,/g, '').match(/-?\d+(\.\d+)?/); return m ? parseFloat(m[0]) : null; };
  const STATE_BY_NAME = Object.fromEntries(Object.entries(STATES).map(([k, v]) => [v.toLowerCase().replace(/&/g, 'and').replace(/[^a-z]/g, ''), k]));
  const stateCode = name => STATE_BY_NAME[String(name || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z]/g, '')] || null;
  const GSTIN_RE = /^[0-9]{2}[A-Z0-9]{13}$/;

  function parseItems(text){
    const doc = parseXml(text);
    return [...doc.getElementsByTagName('STOCKITEM')].map(el => {
      const name = nameOf(el); if (!name) return null;
      const gd = latest(kids(el, 'GSTDETAILS.LIST'), 'APPLICABLEFROM');
      const hd = latest(kids(el, 'HSNDETAILS.LIST'), 'APPLICABLEFROM');
      const hsn = (txt(hd, 'HSNCODE') || txt(gd, 'HSNCODE') || txt(el, 'HSNCODE')).replace(/\s/g, '');
      let gst = null, taxability = txt(gd, 'TAXABILITY');
      if (gd){
        const rates = [...gd.getElementsByTagName('RATEDETAILS.LIST')].map(r => ({head:txt(r, 'GSTRATEDUTYHEAD').toUpperCase(), rate:rateNum(txt(r, 'GSTRATE'))}));
        const ig = rates.find(r => /IGST|INTEGRATED/.test(r.head) && r.rate !== null);
        const cg = rates.find(r => /^CGST|CENTRAL/.test(r.head) && r.rate !== null);
        gst = ig ? ig.rate : cg ? cg.rate * 2 : null;
        if (gst === null && /exempt|nil|non-gst/i.test(taxability)) gst = 0;
      }
      const cess = gd ? ([...gd.getElementsByTagName('RATEDETAILS.LIST')].map(r => ({head:txt(r, 'GSTRATEDUTYHEAD').toUpperCase(), rate:rateNum(txt(r, 'GSTRATE'))}))
                         .find(r => /CESS/.test(r.head) && !/STATE/.test(r.head)) || {}).rate || 0 : 0;
      const mrpBlock = latest(kids(el, 'MRPDETAILS.LIST'), 'FROMDATE');
      const mrp = mrpBlock ? rateNum(txt(kid(mrpBlock, 'MRPRATEDETAILS.LIST'), 'MRPRATE')) : null;
      const cost = latest(kids(el, 'STANDARDCOSTLIST.LIST'), 'DATE');
      return {name, group:txt(el, 'PARENT'), unit:txt(el, 'BASEUNITS') || 'Nos', guid:txt(el, 'GUID'),
              hsn, gst_rate:gst, cess_rate:cess || 0, gst_from:tdate(txt(gd, 'APPLICABLEFROM')),
              mrp:mrp || null, cost:cost ? rateNum(txt(cost, 'RATE')) : null,
              batch:/^yes$/i.test(txt(el, 'ISBATCHWISEON')), expiry:/^yes$/i.test(txt(el, 'ISPERISHABLEON'))};
    }).filter(Boolean);
  }

  function parseParties(ledgerText, groupText){
    const gdoc = parseXml(groupText), parent = {};
    [...gdoc.getElementsByTagName('GROUP')].forEach(g => { const n = nameOf(g); if (n) parent[n] = txt(g, 'PARENT'); });
    const kindOf = grp => {                      // walk up the group tree to Sundry Debtors / Creditors
      for (let g = grp, i = 0; g && i < 30; g = parent[g], i++){
        if (/^sundry debtors$/i.test(g)) return 'customer';
        if (/^sundry creditors$/i.test(g)) return 'supplier';
      }
      return null;
    };
    const doc = parseXml(ledgerText);
    return [...doc.getElementsByTagName('LEDGER')].map(el => {
      const name = nameOf(el), kind = kindOf(txt(el, 'PARENT'));
      if (!name || !kind) return null;
      const reg = latest(kids(el, 'LEDGSTREGDETAILS.LIST'), 'APPLICABLEFROM');
      const mail = latest(kids(el, 'LEDMAILINGDETAILS.LIST'), 'APPLICABLEFROM');
      const addrList = kid(mail, 'ADDRESS.LIST') || kid(el, 'ADDRESS.LIST');
      const addr = addrList ? kids(addrList, 'ADDRESS').map(a => a.textContent.trim()).filter(Boolean) : [];
      let gstin = (txt(reg, 'GSTIN') || txt(el, 'PARTYGSTIN')).toUpperCase().replace(/\s/g, '');
      if (!GSTIN_RE.test(gstin)) gstin = null;
      const stateName = txt(reg, 'STATE') || txt(mail, 'STATE') || txt(el, 'LEDSTATENAME') || txt(el, 'STATENAME');
      const pin = (txt(mail, 'PINCODE') || txt(el, 'PINCODE')).replace(/\s/g, '');
      return {name, kind, group:txt(el, 'PARENT'), guid:txt(el, 'GUID'), gstin,
              state_code:gstin ? gstin.slice(0, 2) : stateCode(stateName),
              address1:addr[0] || null, address2:addr.slice(1).join(', ') || null,
              pincode:/^\d{6}$/.test(pin) ? pin : null,
              phone:txt(el, 'LEDGERMOBILE') || txt(el, 'LEDGERPHONE') || null, email:txt(el, 'EMAIL') || null};
    }).filter(Boolean);
  }

  // What to change in WMS. wms = {items:[...v_items_master rows], parties:[...parties rows], today:'yyyy-mm-dd'}
  function planPull(tally, wms){
    const lc = s => String(s || '').trim().toLowerCase();
    const plan = {items:{create:[], update:[], rates:[], skipped:[]}, parties:{create:[], update:[], skipped:[]}};
    const byTally = new Map(), byName = new Map(), skus = new Set(wms.items.map(i => lc(i.sku)));
    wms.items.forEach(i => { if (i.tally_stock_item) byTally.set(lc(i.tally_stock_item), i); byName.set(lc(i.name), i); });
    const seenItem = new Set();
    for (const t of tally.items || []){
      if (seenItem.has(lc(t.name))) continue; seenItem.add(lc(t.name));
      const w = byTally.get(lc(t.name)) || byName.get(lc(t.name));
      const hsnOk = /^\d{4,8}$/.test(t.hsn);
      if (!w){
        if (!hsnOk){ plan.items.skipped.push({name:t.name, why:t.hsn ? `HSN "${t.hsn}" is not 4 to 8 digits` : 'no HSN code in Tally'}); continue; }
        if (t.gst_rate === null){ plan.items.skipped.push({name:t.name, why:'no GST rate in Tally'}); continue; }
        let base = t.name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 36) || 'ITEM', sku = base;
        for (let n = 2; skus.has(lc(sku)); n++) sku = base.slice(0, 32) + '-' + n;
        skus.add(lc(sku));
        const from = !t.gst_from || t.gst_from < '2017-07-01' ? '2017-07-01' : t.gst_from;
        plan.items.create.push({row:{sku, name:t.name, uom:t.unit, hsn_code:t.hsn, mrp:t.mrp, std_purchase_price:t.cost,
                                     track_batch:t.batch, track_expiry:t.expiry, tally_stock_item:t.name},
                                rate:{effective_from:from, gst_rate:t.gst_rate, cess_rate:t.cess_rate}});
        continue;
      }
      const ch = {};
      if (!w.tally_stock_item) ch.tally_stock_item = t.name;
      if (hsnOk && t.hsn !== w.hsn_code) ch.hsn_code = t.hsn;
      if ((w.mrp === null || w.mrp === undefined || num(w.mrp) === 0) && t.mrp) ch.mrp = t.mrp;
      if ((w.std_purchase_price === null || w.std_purchase_price === undefined || num(w.std_purchase_price) === 0) && t.cost) ch.std_purchase_price = t.cost;
      if (t.batch && !w.track_batch) ch.track_batch = true;
      if (t.expiry && !w.track_expiry) ch.track_expiry = true;
      if (Object.keys(ch).length) plan.items.update.push({id:w.id, name:w.name, changes:ch});
      // a GST rate change is added only when Tally's rate is newer than the one WMS has
      if (t.gst_rate !== null && (w.current_gst_rate === null || w.current_gst_rate === undefined || num(w.current_gst_rate) !== num(t.gst_rate) || num(w.current_cess_rate) !== num(t.cess_rate))){
        const from = t.gst_from && t.gst_from > (w.gst_from || '') ? t.gst_from : null;
        if (from || w.current_gst_rate === null || w.current_gst_rate === undefined)
          plan.items.rates.push({item_id:w.id, name:w.name, effective_from:from || (t.gst_from && t.gst_from >= '2017-07-01' ? t.gst_from : '2017-07-01'),
                                 gst_rate:t.gst_rate, cess_rate:t.cess_rate, was:w.current_gst_rate});
        else plan.items.skipped.push({name:w.name, why:`GST ${t.gst_rate}% in Tally but ${w.current_gst_rate}% in WMS from a later date; left as it is`});
      }
    }
    const pByTally = new Map(), pByName = new Map(), pByGstin = new Map();
    wms.parties.forEach(p => { if (p.tally_ledger) pByTally.set(lc(p.tally_ledger), p); pByName.set(lc(p.name), p); if (p.gstin) pByGstin.set(p.gstin, p); });
    const seenP = new Set();
    for (const t of tally.parties || []){
      if (seenP.has(lc(t.name))) continue; seenP.add(lc(t.name));
      const w = pByTally.get(lc(t.name)) || pByName.get(lc(t.name)) || (t.gstin && pByGstin.get(t.gstin));
      if (!w){
        plan.parties.create.push({party_type:t.kind, name:t.name, gstin:t.gstin, state_code:t.state_code, address1:t.address1, address2:t.address2,
                                  pincode:t.pincode, phone:t.phone, email:t.email, tally_ledger:t.name});
        continue;
      }
      const ch = {};
      if (!w.tally_ledger) ch.tally_ledger = t.name;
      ['gstin','state_code','address1','address2','pincode','phone','email'].forEach(k => { if (!w[k] && t[k]) ch[k] = t[k]; });
      if (w.party_type !== 'both' && w.party_type !== t.kind) ch.party_type = 'both';
      if (Object.keys(ch).length) plan.parties.update.push({id:w.id, name:w.name, changes:ch});
    }
    return plan;
  }

  root.WMSTally = {load, build, envelope, PULL_REQUESTS, parseItems, parseParties, planPull};
})(typeof window !== 'undefined' ? window : globalThis);
