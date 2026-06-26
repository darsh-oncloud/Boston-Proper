/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/search', 'N/record', 'N/log'], (search, record, log) => {

  // ---------- CONFIG ----------
  const SAVED_SEARCH_ID     = 'customsearch_collectives_order_deposit_2';
  const TARGET_ACCOUNT_ID   = '1032';       // 1105 Collective Accounts Receivable
  const INVOICE_OPEN_STATUS = 'CustInvc:A'; // Open
  const BUFFER_MS           = 2500;         // small buffer after setting A/R account
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

      if (!salesOrderId) {
        log.error('No sales order in search row', {
          depAppId: depAppId,
          values: values
        });
        return;
      }

      context.write({
        key: String(depAppId),
        value: JSON.stringify({
          salesOrderId: String(salesOrderId),
          amount: amount
        })
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

      log.audit('START PROCESSING DEPOSIT APPLICATION', {
        depAppId: depAppId,
        salesOrderId: salesOrderId,
        depAppAmount: depAppAmount
      });

      // 1. Find target open invoice from Sales Order
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
        log.audit('No open invoice found for Sales Order', {
          depAppId: depAppId,
          salesOrderId: salesOrderId
        });
        return;
      }

      // If multiple open invoices, pick closest amount
      invoices.sort((a, b) => {
        return Math.abs(a.open - depAppAmount) - Math.abs(b.open - depAppAmount);
      });

      const targetInvoiceId = invoices[0].id;

      log.audit('TARGET INVOICE SELECTED FROM SEARCH', {
        depAppId: depAppId,
        salesOrderId: salesOrderId,
        depAppAmount: depAppAmount,
        targetInvoiceId: targetInvoiceId,
        targetInvoiceNumber: invoices[0].tranid,
        targetInvoiceOpenAmount: invoices[0].open,
        openInvoiceCount: invoices.length,
        allOpenInvoices: invoices
      });

      /**
       * IMPORTANT CHANGE:
       * Do not use submitFields here.
       * submitFields is failing because Deposit Application requires at least one applied item.
       *
       * Load record in dynamic mode, set A/R Account field aracct,
       * wait small buffer, then read Apply tab.
       */
      const depApp = record.load({
        type: 'depositapplication',
        id: depAppId,
        isDynamic: true
      });

      const oldArAccount = depApp.getValue({
        fieldId: 'aracct'
      });

      depApp.setValue({
        fieldId: 'aracct',
        value: TARGET_ACCOUNT_ID,
        ignoreFieldChange: false
      });

      const newArAccount = depApp.getValue({
        fieldId: 'aracct'
      });

      log.audit('A/R ACCOUNT SELECTED ON DEPOSIT APPLICATION', {
        depAppId: depAppId,
        fieldId: 'aracct',
        oldArAccount: oldArAccount,
        newArAccount: newArAccount,
        targetAccountId: TARGET_ACCOUNT_ID
      });

      // Small buffer after setting A/R account
      waitMs(BUFFER_MS);

      log.audit('BUFFER COMPLETED AFTER A/R ACCOUNT SET', {
        depAppId: depAppId,
        bufferMs: BUFFER_MS,
        currentArAccount: depApp.getValue({ fieldId: 'aracct' })
      });

      const lineCount = depApp.getLineCount({
        sublistId: 'apply'
      });

      log.audit('APPLY TAB LINE COUNT AFTER ACCOUNT SET', {
        depAppId: depAppId,
        targetInvoiceId: targetInvoiceId,
        applyLineCount: lineCount
      });

      if (!lineCount) {
        log.audit('No invoices in Apply tab after account change', {
          depAppId: depAppId,
          targetInvoiceId: targetInvoiceId
        });
        return;
      }

      // 2. Choose target invoice line from Apply tab
      let chosenLine = -1;

      for (let i = 0; i < lineCount; i++) {
        const doc = depApp.getSublistValue({
          sublistId: 'apply',
          fieldId: 'doc',
          line: i
        });

        const refNum = depApp.getSublistValue({
          sublistId: 'apply',
          fieldId: 'refnum',
          line: i
        });

        const due = depApp.getSublistValue({
          sublistId: 'apply',
          fieldId: 'due',
          line: i
        });

        log.debug('APPLY LINE CHECK AFTER ACCOUNT SET', {
          depAppId: depAppId,
          line: i,
          doc: doc,
          refNum: refNum,
          due: due,
          targetInvoiceId: targetInvoiceId,
          isTarget: String(doc) === String(targetInvoiceId)
        });

        if (String(doc) === String(targetInvoiceId)) {
          chosenLine = i;
          break;
        }
      }

      if (chosenLine === -1) {
        log.error('Invoice not in Apply tab after account change', {
          depAppId: depAppId,
          targetInvoiceId: targetInvoiceId,
          applyLineCount: lineCount,
          note: 'A/R Account was set using fieldId aracct, but target invoice still did not appear.'
        });
        return;
      }

      // 3. Uncheck all lines, then check only selected invoice line
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

      const invId = depApp.getSublistValue({
        sublistId: 'apply',
        fieldId: 'doc',
        line: chosenLine
      });

      log.audit('TARGET INVOICE LINE SELECTED', {
        depAppId: depAppId,
        chosenLine: chosenLine,
        invoiceId: invId
      });

      const savedId = depApp.save({
        enableSourcing: true,
        ignoreMandatoryFields: false
      });

      log.audit('DEPOSIT APPLICATION SAVED SUCCESSFULLY', {
        depAppId: savedId,
        appliedInvoiceId: invId,
        arAccount: TARGET_ACCOUNT_ID
      });

    } catch (e) {
      log.error('reduce error depApp ' + depAppId, {
        name: e.name,
        message: e.message,
        stack: e.stack
      });
    }
  };

  const summarize = (summary) => {
    summary.reduceSummary.errors.iterator().each((key, err) => {
      log.error('Unhandled depApp ' + key, err);
      return true;
    });

    log.audit('Done', {
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
      // intentional small buffer
    }
  }

  return {
    getInputData,
    map,
    reduce,
    summarize
  };
});