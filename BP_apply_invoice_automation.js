/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 *
 * Input  : your saved search (account 6, collectives, not applied, has SO).
 * map    : pulls deposit application id + sales order + amount from the search
 *          row, and keys by deposit id (mainline=F can return duplicate rows).
 * reduce : once per deposit -> find open invoice, change account, apply, save.
 */
define(['N/search', 'N/record', 'N/log'], (search, record, log) => {

  // ---------- CONFIG ----------
  const SAVED_SEARCH_ID     = 'customsearch1782429009740'; // your Collectives Order Deposit search
  const TARGET_ACCOUNT_ID   = 'CHANGE_ME';                 // <-- account to switch the deposit application TO
  const INVOICE_OPEN_STATUS = 'CustInvc:A';                // Open
  // ----------------------------

  const getInputData = () => search.load({ id: SAVED_SEARCH_ID });

  const map = (context) => {
    try {
      const res      = JSON.parse(context.value);
      const depAppId = res.id;
      const values   = res.values || {};

      const so           = findVal(values, 'salesorder');
      const salesOrderId = so && (so.value !== undefined ? so.value : so);
      const amt          = findVal(values, 'amount');
      const amount       = amt && (amt.value !== undefined ? amt.value : amt);

      if (!salesOrderId) { log.error('No sales order in search row', depAppId); return; }

      // key by deposit id so each deposit application is handled once
      context.write({
        key:   String(depAppId),
        value: JSON.stringify({ salesOrderId: String(salesOrderId), amount: amount })
      });
    } catch (e) {
      log.error('map error key ' + context.key, e);
    }
  };

  const reduce = (context) => {
    try {
      const depAppId     = context.key;
      const first        = JSON.parse(context.values[0]); // dupes collapse here
      const salesOrderId = first.salesOrderId;
      const depAppAmount = Math.abs(parseFloat(first.amount) || 0);

      // --- open invoices created from that sales order ---
      const invoices = [];
      search.create({
        type: 'invoice',
        filters: [
          ['createdfrom', 'anyof', salesOrderId], 'AND',
          ['mainline', 'is', 'T'], 'AND',
          ['status', 'anyof', INVOICE_OPEN_STATUS], 'AND',
          ['amountremaining', 'greaterthan', '0']
        ],
        columns: ['internalid', 'amountremaining']
      }).run().each((r) => {
        invoices.push({ id: r.getValue('internalid'), open: Math.abs(parseFloat(r.getValue('amountremaining')) || 0) });
        return true;
      });

      if (!invoices.length) { log.audit('No open invoice -> skipped', 'depApp ' + depAppId + ' SO ' + salesOrderId); return; }

      // if multiple, pick the open balance closest to the deposit amount
      invoices.sort((a, b) => Math.abs(a.open - depAppAmount) - Math.abs(b.open - depAppAmount));
      const targetInvoiceId = invoices[0].id;

      // --- load dynamic, change account (re-sources Apply tab), apply, save ---
      const depApp = record.load({ type: 'depositapplication', id: depAppId, isDynamic: true });
      depApp.setValue({ fieldId: 'account', value: TARGET_ACCOUNT_ID });

      const lineCount = depApp.getLineCount({ sublistId: 'apply' });
      let applied = false;
      for (let i = 0; i < lineCount; i++) {
        const doc         = depApp.getSublistValue({ sublistId: 'apply', fieldId: 'doc', line: i });
        const shouldApply = String(doc) === String(targetInvoiceId);
        depApp.selectLine({ sublistId: 'apply', line: i });
        depApp.setCurrentSublistValue({ sublistId: 'apply', fieldId: 'apply', value: shouldApply });
        depApp.commitLine({ sublistId: 'apply' });
        if (shouldApply) applied = true;
      }

      if (!applied) {
        log.error('Invoice not in Apply tab after account change',
          'depApp ' + depAppId + ' invoice ' + targetInvoiceId + ' (apply lines: ' + lineCount + ')');
        return;
      }

      depApp.save(); // has an applied line now, so native validation passes
      log.audit('Applied', 'depApp ' + depAppId + ' -> invoice ' + targetInvoiceId + ' (of ' + invoices.length + ' open)');

    } catch (e) {
      log.error('reduce error depApp ' + context.key, e);
    }
  };

  const summarize = (summary) => {
    summary.reduceSummary.errors.iterator().each((key, err) => { log.error('Unhandled depApp ' + key, err); return true; });
    log.audit('Done', 'Usage: ' + summary.usage + ' | Yields: ' + summary.yields);
  };

  // finds a value whether the column key is "salesorder", "salesorder.createdFrom", "createdFrom.salesorder", etc.
  const findVal = (values, name) => {
    name = name.toLowerCase();
    for (const k in values) {
      if (k.toLowerCase().split('.').indexOf(name) !== -1) return values[k];
    }
    return null;
  };

  return { getInputData, map, reduce, summarize };
});
