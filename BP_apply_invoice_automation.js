/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 *
 * Why this version exists:
 * Changing the A/R account in memory does NOT refresh the Apply tab. The list
 * of applicable invoices is sourced from the account, so we must persist the
 * account change FIRST, then RELOAD so the Apply tab re-sources for the new
 * account (this mirrors the UI "record reloads everything" behaviour).
 *
 * We use record.submitFields to change just the account, which skips the
 * "you must apply the deposit to at least one item" full-save validation.
 */
define(['N/search', 'N/record', 'N/log'], (search, record, log) => {

  // ---------- CONFIG ----------
  const SAVED_SEARCH_ID     = 'customsearch1782429009740'; // your Collectives Order Deposit search
  const TARGET_ACCOUNT_ID   = '1032';                 // <-- 1105 Collective Accounts Receivable internal id
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

      context.write({
        key:   String(depAppId),
        value: JSON.stringify({ salesOrderId: String(salesOrderId), amount: amount })
      });
    } catch (e) {
      log.error('map error key ' + context.key, e);
    }
  };

  const reduce = (context) => {
    const depAppId = context.key;
    try {
      const first        = JSON.parse(context.values[0]);
      const salesOrderId = first.salesOrderId;
      const depAppAmount = Math.abs(parseFloat(first.amount) || 0);

      // 1. Identify the target open invoice for the sales order (its internal id)
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
        invoices.push({ id: String(r.getValue('internalid')), open: Math.abs(parseFloat(r.getValue('amountremaining')) || 0) });
        return true;
      });
      invoices.sort((a, b) => Math.abs(a.open - depAppAmount) - Math.abs(b.open - depAppAmount));
      const targetInvoiceId = invoices.length ? invoices[0].id : null;

      // 2. Persist the account change WITHOUT a full save (skips the apply validation)
      record.submitFields({
        type:   'depositapplication',
        id:     depAppId,
        values: { account: TARGET_ACCOUNT_ID },
        options: { enableSourcing: true, ignoreMandatoryFields: true }
      });

      // 3. Reload -> Apply tab is now sourced for the NEW account
      const depApp    = record.load({ type: 'depositapplication', id: depAppId, isDynamic: true });
      const lineCount = depApp.getLineCount({ sublistId: 'apply' });
      if (!lineCount) { log.audit('No invoices in Apply tab after account change', 'depApp ' + depAppId); return; }

      // 4. Choose the line: prefer the sales-order invoice; else closest open amount
      let chosenLine = -1;
      if (targetInvoiceId) {
        for (let i = 0; i < lineCount; i++) {
          if (String(depApp.getSublistValue({ sublistId: 'apply', fieldId: 'doc', line: i })) === targetInvoiceId) {
            chosenLine = i;
            break;
          }
        }
      }
      if (chosenLine === -1) {
        let best = Infinity;
        for (let i = 0; i < lineCount; i++) {
          const due  = Math.abs(parseFloat(depApp.getSublistValue({ sublistId: 'apply', fieldId: 'due', line: i })) || 0);
          const diff = Math.abs(due - depAppAmount);
          if (diff < best) { best = diff; chosenLine = i; }
        }
        log.audit('SO invoice not in tab, used closest amount', 'depApp ' + depAppId + ' line ' + chosenLine);
      }
      if (chosenLine === -1) { log.error('Could not choose an invoice line', 'depApp ' + depAppId); return; }

      // 5. Apply that one line and save (now it has an applied item -> validation passes)
      depApp.selectLine({ sublistId: 'apply', line: chosenLine });
      depApp.setCurrentSublistValue({ sublistId: 'apply', fieldId: 'apply', value: true });
      depApp.commitLine({ sublistId: 'apply' });

      const invId = depApp.getSublistValue({ sublistId: 'apply', fieldId: 'doc', line: chosenLine });
      depApp.save();
      log.audit('Applied', 'depApp ' + depAppId + ' -> invoice ' + invId);

    } catch (e) {
      log.error('reduce error depApp ' + depAppId, e);
    }
  };

  const summarize = (summary) => {
    summary.reduceSummary.errors.iterator().each((key, err) => { log.error('Unhandled depApp ' + key, err); return true; });
    log.audit('Done', 'Usage: ' + summary.usage + ' | Yields: ' + summary.yields);
  };

  const findVal = (values, name) => {
    name = name.toLowerCase();
    for (const k in values) {
      if (k.toLowerCase().split('.').indexOf(name) !== -1) return values[k];
    }
    return null;
  };

  return { getInputData, map, reduce, summarize };
});