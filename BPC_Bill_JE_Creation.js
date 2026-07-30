/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/search', 'N/record', 'N/log', 'N/runtime'], function (search, record, log, runtime) {

  // ------------------- CONFIG -------------------
  var SUBSIDIARY_ID = 2;

  // Script Parameters
  var PARAM_DEBIT_ACCT      = 'custscript_debit_account';          // Account field
  var PARAM_CREDIT_ACCT     = 'custscript_je_credit_account';      // Account field
  var PARAM_SAVED_SEARCH_ID = 'custscript_saved_search_id';        // Free-form text (saved search id)

  // JE line detail column
  var JE_LINE_DETAIL_COL = 'custcol_related_transaction_details';

  // Vendor Bill fields
  var VB_JE_CREATED_CHK = 'custbody_je_created';
  var VB_RELATED_JE_FLD = 'custbody_related_je';

  // PO field
  var PO_RELATED_JE_FLD = 'custbody_related_je';

  // --------------------------------------------------------

  function remUsage() {
    try { return runtime.getCurrentScript().getRemainingUsage(); }
    catch (e) { return null; }
  }

  function todayText() {
    var d = new Date();
    return (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear();
  }

  function safeGetGroupedValue(valuesObj, key) {
    var v = valuesObj[key];
    if (v == null) return '';
    if (typeof v === 'object') {
      if (v.value != null) return String(v.value);
      if (v.text != null) return String(v.text);
      return JSON.stringify(v);
    }
    return String(v);
  }

  function safeGetNumber(valuesObj, key) {
    var v = valuesObj[key];
    if (v == null) return 0;
    if (typeof v === 'object') {
      if (v.value != null) return parseFloat(v.value) || 0;
      if (v.text != null) return parseFloat(v.text) || 0;
      return 0;
    }
    return parseFloat(v) || 0;
  }

  // -------------------- INPUT = SAVED SEARCH PARAM --------------------
  function getInputData() {
    var script = runtime.getCurrentScript();
    var savedSearchId = script.getParameter({ name: PARAM_SAVED_SEARCH_ID });

    log.audit('getInputData START', {
      savedSearchId: savedSearchId,
      usage: remUsage()
    });

    if (!savedSearchId) {
      throw new Error('Missing required parameter: ' + PARAM_SAVED_SEARCH_ID + ' (Saved Search ID)');
    }

    try {
      var s = search.load({ id: savedSearchId });
      var count = s.runPaged({ pageSize: 1000 }).count;

      log.audit('Saved Search loaded', { id: savedSearchId, count: count, usage: remUsage() });
      return s;

    } catch (e) {
      log.error('getInputData ERROR loading saved search', {
        savedSearchId: savedSearchId,
        message: e.message,
        stack: e.stack,
        usage: remUsage()
      });
      throw e;
    }
  }

  function map(context) {
    try {
      context.write({ key: 'ALL', value: context.value });
    } catch (e) {
      log.error('map ERROR', { message: e.message, stack: e.stack, value: context.value, usage: remUsage() });
      throw e;
    }
  }

  function reduce(context) {
    log.audit('reduce START', { key: context.key, rows: context.values.length, usage: remUsage() });

    // READ ACCOUNT PARAMETERS
    var script = runtime.getCurrentScript();
    var JE_DEBIT_ACCOUNT  = script.getParameter({ name: PARAM_DEBIT_ACCT });
    var JE_CREDIT_ACCOUNT = script.getParameter({ name: PARAM_CREDIT_ACCT });

    log.audit('JE Accounts (from params)', { debit: JE_DEBIT_ACCOUNT, credit: JE_CREDIT_ACCOUNT });

    if (!JE_DEBIT_ACCOUNT || !JE_CREDIT_ACCOUNT) {
      throw new Error(
        'Missing JE account parameter(s). ' +
        'Debit(' + PARAM_DEBIT_ACCT + '): ' + JE_DEBIT_ACCOUNT + ', ' +
        'Credit(' + PARAM_CREDIT_ACCT + '): ' + JE_CREDIT_ACCOUNT
      );
    }

    // -------------------- Parse Search rows --------------------
    // Your saved search must match the same output columns (summary keys)
    var rows = [];
    var poIdMap = {};

    try {
      for (var i = 0; i < context.values.length; i++) {
        var raw = JSON.parse(context.values[i]);
        var vals = raw.values || {};

        var vbId    = safeGetGroupedValue(vals, 'GROUP(internalid)');
        var vbTran  = safeGetGroupedValue(vals, 'GROUP(tranid)');
        var vbDate  = safeGetGroupedValue(vals, 'GROUP(trandate)');
        var vendor  = safeGetGroupedValue(vals, 'GROUP(entity)');
        var poId    = safeGetGroupedValue(vals, 'GROUP(appliedtotransaction)');
        var amt     = safeGetNumber(vals, 'SUM(amount)');

        if (!vbId || !vendor || !poId || amt <= 0) continue;

        poIdMap[poId] = true;

        rows.push({
          vbId: vbId,
          vbTran: vbTran,
          vbDate: vbDate,
          vendorId: vendor,
          poId: poId,
          amount: amt
        });
      }

      log.audit('Search PARSE summary', {
        parsedRows: rows.length,
        uniquePOs: Object.keys(poIdMap).length,
        usage: remUsage()
      });

    } catch (e1) {
      log.error('Parse Search ERROR', { message: e1.message, stack: e1.stack, usage: remUsage() });
      throw e1;
    }

    if (!rows.length) {
      log.audit('reduce EXIT', 'No rows matched after parsing.');
      return;
    }



    // -------------------- Filter rows (now = same rows) --------------------
    var filtered = rows;

    log.audit('FILTER RESULT', {
      before: rows.length,
      after: filtered.length,
      removed: rows.length - filtered.length,
      usage: remUsage()
    });

    if (!filtered.length) {
      log.audit('reduce EXIT', 'No rows left after filter.');
      return;
    }

    // -------------------- Group by Vendor --------------------
    var vendorAgg = {}; // vendorId -> { total, bills[], minDate, maxDate }
    var billSet = {};
    var poSet = {};

    for (var k = 0; k < filtered.length; k++) {
      var r = filtered[k];
      var vendorId = r.vendorId;

      if (!vendorAgg[vendorId]) vendorAgg[vendorId] = { total: 0, bills: [], minDate: '', maxDate: '' };
      vendorAgg[vendorId].total += r.amount;

      vendorAgg[vendorId].bills.push({
        vbId: r.vbId,
        vbTran: r.vbTran,
        vbDate: r.vbDate,
        amount: r.amount
      });

      var d = r.vbDate || '';
      if (d) {
        if (!vendorAgg[vendorId].minDate) vendorAgg[vendorId].minDate = d;
        if (!vendorAgg[vendorId].maxDate) vendorAgg[vendorId].maxDate = d;
        if (d < vendorAgg[vendorId].minDate) vendorAgg[vendorId].minDate = d;
        if (d > vendorAgg[vendorId].maxDate) vendorAgg[vendorId].maxDate = d;
      }

      billSet[r.vbId] = true;
      poSet[r.poId] = true;
    }

    var vendorIds = Object.keys(vendorAgg);
    var grandTotal = 0;
    for (var v = 0; v < vendorIds.length; v++) grandTotal += vendorAgg[vendorIds[v]].total;

    log.audit('GROUP SUMMARY', {
      vendors: vendorIds.length,
      uniqueBills: Object.keys(billSet).length,
      uniquePOs: Object.keys(poSet).length,
      grandTotal: grandTotal,
      usage: remUsage()
    });

    // -------------------- CREATE JE --------------------
    log.audit('JE CREATE START', { usage: remUsage() });

    var je = record.create({ type: record.Type.JOURNAL_ENTRY, isDynamic: true });
    je.setValue({ fieldId: 'subsidiary', value: SUBSIDIARY_ID });
    je.setValue({ fieldId: 'memo', value: 'Consolidated Vendor Bill JE' });

    // Credit line per vendor with simplified details (BILL ONLY)
    for (var c = 0; c < vendorIds.length; c++) {
      var vId = vendorIds[c];
      var bucket = vendorAgg[vId];
      var vendTot = bucket.total;

      var lineDetail = '';

      for (var b = 0; b < bucket.bills.length; b++) {
        var bill = bucket.bills[b];
        lineDetail +=
          '- Bill: ' + (bill.vbTran || '') + ' (ID ' + (bill.vbId || '') + ')' +
          ' | Amount: ' + (bill.amount || 0).toFixed(2) +
          '\n';
      }

      lineDetail += 'Vendor Total: ' + vendTot.toFixed(2) + '\n';

      je.selectNewLine({ sublistId: 'line' });
      je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'account', value: JE_CREDIT_ACCOUNT });
      je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'entity', value: vId });
      je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'credit', value: vendTot });

      try {
        je.setCurrentSublistValue({ sublistId: 'line', fieldId: JE_LINE_DETAIL_COL, value: lineDetail });
      } catch (eCol) {
        log.error('SET LINE DETAIL COL FAILED', {
          vendor: vId,
          fieldId: JE_LINE_DETAIL_COL,
          message: eCol.message,
          stack: eCol.stack
        });
      }

      je.commitLine({ sublistId: 'line' });
    }

    // Debit grand total
    je.selectNewLine({ sublistId: 'line' });
    je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'account', value: JE_DEBIT_ACCOUNT });
    je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'debit', value: grandTotal });
    je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'department', value: 30 });
    je.commitLine({ sublistId: 'line' });

    var jeId = je.save({ enableSourcing: false, ignoreMandatoryFields: true });
    log.audit('JE CREATED', { jeId: jeId, usage: remUsage() });

    // -------------------- UPDATE VBs --------------------
    var vbIds = Object.keys(billSet);
    log.audit('UPDATE VBs START', { count: vbIds.length, usage: remUsage() });

    for (var bb = 0; bb < vbIds.length; bb++) {
      var vbId2 = vbIds[bb];
      try {
        var vbVals = {};
        vbVals[VB_JE_CREATED_CHK] = true;
        vbVals[VB_RELATED_JE_FLD] = jeId;

        record.submitFields({
          type: record.Type.VENDOR_BILL,
          id: vbId2,
          values: vbVals,
          options: { enableSourcing: false, ignoreMandatoryFields: true }
        });
      } catch (eVB) {
        log.error('VB UPDATE FAILED', { vbId: vbId2, message: eVB.message, stack: eVB.stack });
      }
    }


    log.audit('reduce DONE', { jeId: jeId, usage: remUsage() });
  }

  return { getInputData: getInputData, map: map, reduce: reduce };
});