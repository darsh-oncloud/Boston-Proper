/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/search', 'N/record', 'N/log'], (search, record, log) => {

  // ---------- CONFIG ----------
  const SAVED_SEARCH_ID     = 'customsearch_collectives_order_deposit_2';
  const TARGET_ACCOUNT_ID   = '1032';       // 1105 Collective Accounts Receivable
  const INVOICE_OPEN_STATUS = 'CustInvc:A'; // Open
  const BUFFER_MS           = 2500;
  // ----------------------------

  const getInputData = () => search.load({ id: SAVED_SEARCH_ID });

  const map = (context) => {
    try {
      const res      = JSON.parse(context.value);
      const depAppId = res.id;
      const values   = res.values || {};

      const so           = findVal(values, 'salesorder');
      const salesOrderId = so && (so.value !== undefined ? so.value : so);

      const amt    = findVal(values, 'amount');
      const amount = amt && (amt.value !== undefined ? amt.value : amt);

      if (!salesOrderId) return;

      context.write({
        key: String(depAppId),
        value: JSON.stringify({
          salesOrderId: String(salesOrderId),
          amount: amount
        })
      });

    } catch (e) {
      log.error('MAP ERROR', {
        key: context.key,
        name: e.name,
        message: e.message
      });
    }
  };

  const reduce = (context) => {
    const depAppId = context.key;

    try {
      const first        = JSON.parse(context.values[0]);
      const salesOrderId = first.salesOrderId;
      const depAppAmount = Math.abs(parseFloat(first.amount) || 0);

      // 1. Find open invoice created from Sales Order
      const invoices = [];

      search.create({
        type: 'invoice',
        filters: [
          ['createdfrom', 'anyof', salesOrderId],
          'AND',
          ['mainline', 'is', 'T'],
          'AND',
          ['status', 'anyof', INVOICE_OPEN_STATUS],
          'AND',
          ['amountremaining', 'greaterthan', '0']
        ],
        columns: [
          search.createColumn({ name: 'internalid' }),
          search.createColumn({ name: 'tranid' }),
          search.createColumn({ name: 'amountremaining' })
        ]
      }).run().each((r) => {
        invoices.push({
          id: String(r.getValue({ name: 'internalid' })),
          tranid: r.getValue({ name: 'tranid' }),
          open: Math.abs(parseFloat(r.getValue({ name: 'amountremaining' })) || 0)
        });
        return true;
      });

      if (!invoices.length) {
        log.audit('NO OPEN INVOICE FOUND', {
          depAppId: depAppId,
          salesOrderId: salesOrderId
        });
        return;
      }

      // 2. Pick closest invoice by amount
      invoices.sort((a, b) => {
        return Math.abs(a.open - depAppAmount) - Math.abs(b.open - depAppAmount);
      });

      const targetInvoiceId = invoices[0].id;

      log.audit('TARGET INVOICE FOUND', {
        depAppId: depAppId,
        salesOrderId: salesOrderId,
        depAppAmount: depAppAmount,
        invoiceId: targetInvoiceId,
        invoiceNumber: invoices[0].tranid,
        invoiceOpenAmount: invoices[0].open,
        openInvoiceCount: invoices.length
      });

      // 3. Load Deposit Application and set A/R account
      const depApp = record.load({
        type: 'depositapplication',
        id: depAppId,
        isDynamic: true
      });

      depApp.setValue({
        fieldId: 'aracct',
        value: TARGET_ACCOUNT_ID,
        ignoreFieldChange: false
      });

      waitMs(BUFFER_MS);

      // 4. Find invoice in Apply tab
      const lineCount = depApp.getLineCount({
        sublistId: 'apply'
      });

      let chosenLine = -1;

      for (let i = 0; i < lineCount; i++) {
        const doc = depApp.getSublistValue({
          sublistId: 'apply',
          fieldId: 'doc',
          line: i
        });

        if (String(doc) === String(targetInvoiceId)) {
          chosenLine = i;
          break;
        }
      }

      if (chosenLine === -1) {
        log.error('INVOICE NOT FOUND IN APPLY TAB', {
          depAppId: depAppId,
          targetInvoiceId: targetInvoiceId,
          applyLineCount: lineCount
        });
        return;
      }

      // 5. Uncheck all lines and apply only selected invoice
      for (let i = 0; i < lineCount; i++) {
        depApp.selectLine({
          sublistId: 'apply',
          line: i
        });

        depApp.setCurrentSublistValue({
          sublistId: 'apply',
          fieldId: 'apply',
          value: i === chosenLine
        });

        depApp.commitLine({
          sublistId: 'apply'
        });
      }

      const appliedInvoiceId = depApp.getSublistValue({
        sublistId: 'apply',
        fieldId: 'doc',
        line: chosenLine
      });

      const savedId = depApp.save({
        enableSourcing: true,
        ignoreMandatoryFields: false
      });

      log.audit('DEPOSIT APPLICATION APPLIED', {
        depAppId: savedId,
        appliedInvoiceId: appliedInvoiceId,
        arAccount: TARGET_ACCOUNT_ID
      });

    } catch (e) {
      log.error('REDUCE ERROR', {
        depAppId: depAppId,
        name: e.name,
        message: e.message
      });
    }
  };

  const summarize = (summary) => {
    summary.reduceSummary.errors.iterator().each((key, err) => {
      log.error('UNHANDLED DEPAPP ERROR', {
        depAppId: key,
        error: err
      });
      return true;
    });

    log.audit('DONE', {
      usage: summary.usage,
      yields: summary.yields
    });
  };

  const findVal = (values, name) => {
    name = name.toLowerCase();

    for (const k in values) {
      if (k.toLowerCase().split('.').indexOf(name) !== -1) {
        return values[k];
      }
    }

    return null;
  };

  function waitMs(ms) {
    const start = new Date().getTime();

    while (new Date().getTime() - start < ms) {
      // small buffer after setting A/R account
    }
  }

  return {
    getInputData,
    map,
    reduce,
    summarize
  };
});