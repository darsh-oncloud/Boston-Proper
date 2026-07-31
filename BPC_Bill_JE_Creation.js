/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/search', 'N/record', 'N/log', 'N/runtime'], function (search, record, log, runtime) {

  // ------------------- CONFIG -------------------
  var SUBSIDIARY_ID = 2;
  var DEBIT_DEPARTMENT = 30;

  // Script Parameters
  var PARAM_DEBIT_ACCT      = 'custscript_debit_account';
  var PARAM_CREDIT_ACCT     = 'custscript_je_credit_account';
  var PARAM_SAVED_SEARCH_ID = 'custscript_saved_search_id';

  // NEW fixed accounts (internal ids)
  var AP_DEBIT_ACCOUNT   = 1043; // debit, per vendor (must be A/P so JE is applicable on payment)
  var OFFSET_CREDIT_ACCT = 1035; // credit, grand total

  // Fields
  var JE_LINE_DETAIL_COL   = 'custcol_related_transaction_details';
  var JE_RELATED_BILLS_FLD = 'custbody_related_bills'; // multiselect on JE
  var VB_JE_CREATED_CHK    = 'custbody_je_created';
  var VB_RELATED_JE_FLD    = 'custbody_related_je';
  // ----------------------------------------------

  function remUsage() {
    try { return runtime.getCurrentScript().getRemainingUsage(); } catch (e) { return null; }
  }

  function gv(vals, key) {
    var v = vals[key];
    if (v == null) return '';
    if (typeof v === 'object') return String(v.value != null ? v.value : (v.text != null ? v.text : ''));
    return String(v);
  }

  function gn(vals, key) {
    var v = vals[key];
    if (v == null) return 0;
    if (typeof v === 'object') return parseFloat(v.value != null ? v.value : v.text) || 0;
    return parseFloat(v) || 0;
  }

  function getInputData() {
    var savedSearchId = runtime.getCurrentScript().getParameter({ name: PARAM_SAVED_SEARCH_ID });
    if (!savedSearchId) throw new Error('Missing parameter: ' + PARAM_SAVED_SEARCH_ID);
    log.audit('getInputData', { savedSearchId: savedSearchId, usage: remUsage() });
    return search.load({ id: savedSearchId });
  }

  function map(context) {
    context.write({ key: 'ALL', value: context.value });
  }

  function reduce(context) {
    var script = runtime.getCurrentScript();
    var JE_DEBIT_ACCOUNT  = script.getParameter({ name: PARAM_DEBIT_ACCT });
    var JE_CREDIT_ACCOUNT = script.getParameter({ name: PARAM_CREDIT_ACCT });

    if (!JE_DEBIT_ACCOUNT || !JE_CREDIT_ACCOUNT) {
      throw new Error('Missing JE account parameter(s). Debit: ' + JE_DEBIT_ACCOUNT + ', Credit: ' + JE_CREDIT_ACCOUNT);
    }

    // -------------------- Parse + group by vendor --------------------
    var vendorAgg = {};   // vendorId -> { total, bills[] }
    var billSet   = {};
    var grandTotal = 0;

    for (var i = 0; i < context.values.length; i++) {
      var vals = (JSON.parse(context.values[i]).values) || {};

      var vbId   = gv(vals, 'GROUP(internalid)');
      var vbTran = gv(vals, 'GROUP(tranid)');
      var vendor = gv(vals, 'GROUP(entity)');
      var poId   = gv(vals, 'GROUP(appliedtotransaction)');
      var amt    = gn(vals, 'SUM(amount)');

      if (!vbId || !vendor || !poId || amt <= 0) continue;

      if (!vendorAgg[vendor]) vendorAgg[vendor] = { total: 0, bills: [] };
      vendorAgg[vendor].total += amt;
      vendorAgg[vendor].bills.push({ vbId: vbId, vbTran: vbTran, amount: amt });

      billSet[vbId] = true;
      grandTotal += amt;
    }

    var vendorIds = Object.keys(vendorAgg);
    var billIds = Object.keys(billSet);

    if (!vendorIds.length) {
      log.audit('reduce EXIT', 'No rows matched.');
      return;
    }

    log.audit('GROUP SUMMARY', { vendors: vendorIds.length, bills: billIds.length, grandTotal: grandTotal, usage: remUsage() });

    // -------------------- CREATE JE --------------------
    var je = record.create({ type: record.Type.JOURNAL_ENTRY, isDynamic: true });
    je.setValue({ fieldId: 'subsidiary', value: SUBSIDIARY_ID });
    je.setValue({ fieldId: 'memo', value: 'Consolidated Vendor Bill JE' });

    try {
      je.setValue({ fieldId: JE_RELATED_BILLS_FLD, value: billIds });
    } catch (eMS) {
      log.error('SET RELATED BILLS FAILED', eMS.message);
    }

    // 1) Credit line per vendor (param account) + detail
    for (var c = 0; c < vendorIds.length; c++) {
      var vId = vendorIds[c];
      var bucket = vendorAgg[vId];

      var detail = '';
      for (var b = 0; b < bucket.bills.length; b++) {
        detail += '- Bill: ' + bucket.bills[b].vbTran + ' (ID ' + bucket.bills[b].vbId + ')' +
                  ' | Amount: ' + bucket.bills[b].amount.toFixed(2) + '\n';
      }
      detail += 'Vendor Total: ' + bucket.total.toFixed(2) + '\n';

      je.selectNewLine({ sublistId: 'line' });
      je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'account', value: JE_CREDIT_ACCOUNT });
      je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'entity', value: vId });
      je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'credit', value: bucket.total });
      try {
        je.setCurrentSublistValue({ sublistId: 'line', fieldId: JE_LINE_DETAIL_COL, value: detail });
      } catch (eCol) {
        log.error('SET LINE DETAIL FAILED', { vendor: vId, message: eCol.message });
      }
      je.commitLine({ sublistId: 'line' });
    }

    // 2) Debit grand total (param account)
    je.selectNewLine({ sublistId: 'line' });
    je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'account', value: JE_DEBIT_ACCOUNT });
    je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'debit', value: grandTotal });
    je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'department', value: DEBIT_DEPARTMENT });
    je.commitLine({ sublistId: 'line' });

    // 3) NEW: Debit A/P (1043) per vendor - this is what makes the JE applicable on the payment
    for (var d = 0; d < vendorIds.length; d++) {
      je.selectNewLine({ sublistId: 'line' });
      je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'account', value: AP_DEBIT_ACCOUNT });
      je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'entity', value: vendorIds[d] });
      je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'debit', value: vendorAgg[vendorIds[d]].total });
      je.commitLine({ sublistId: 'line' });
    }

    // 4) NEW: Credit offset (1035) grand total
    je.selectNewLine({ sublistId: 'line' });
    je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'account', value: OFFSET_CREDIT_ACCT });
    je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'credit', value: grandTotal });
    je.commitLine({ sublistId: 'line' });

    var jeId = je.save({ enableSourcing: false, ignoreMandatoryFields: true });
    log.audit('JE CREATED', { jeId: jeId, usage: remUsage() });

// =====================================================
// TEMPORARY: TEST ONLY JE CREATION
// Remove this return after validating the Journal Entry.
// =====================================================
log.audit('TEST MODE', {
  message: 'Only JE was created. Bills were not updated and payment was not created.',
  jeId: jeId
});

return;


    
    // -------------------- UPDATE BILLS --------------------
    for (var bb = 0; bb < billIds.length; bb++) {
      try {
        var vbVals = {};
        vbVals[VB_JE_CREATED_CHK] = true;
        vbVals[VB_RELATED_JE_FLD] = jeId;
        record.submitFields({
          type: record.Type.VENDOR_BILL,
          id: billIds[bb],
          values: vbVals,
          options: { enableSourcing: false, ignoreMandatoryFields: true }
        });
      } catch (eVB) {
        log.error('VB UPDATE FAILED', { vbId: billIds[bb], message: eVB.message });
      }
    }

    // -------------------- PAYMENT PER VENDOR (apply bills + JE credit) --------------------
    for (var p = 0; p < vendorIds.length; p++) {
      try {
        var payId = createPayment(vendorAgg[vendorIds[p]].bills, jeId);
        log.audit('PAYMENT CREATED', { vendor: vendorIds[p], paymentId: payId });
      } catch (ePay) {
        log.error('PAYMENT FAILED', { vendor: vendorIds[p], message: ePay.message, stack: ePay.stack });
      }
    }

    log.audit('reduce DONE', { jeId: jeId, usage: remUsage() });
  }

  function createPayment(bills, jeId) {
    var wanted = {};
    for (var i = 0; i < bills.length; i++) wanted[String(bills[i].vbId)] = true;

    var pay = record.transform({
      fromType: record.Type.VENDOR_BILL,
      fromId: bills[0].vbId,
      toType: record.Type.VENDOR_PAYMENT,
      isDynamic: true
    });

    // Apply only this vendor's bills
    var applyCount = pay.getLineCount({ sublistId: 'apply' });
    for (var a = 0; a < applyCount; a++) {
      pay.selectLine({ sublistId: 'apply', line: a });
      var doc = String(pay.getCurrentSublistValue({ sublistId: 'apply', fieldId: 'doc' }));
      pay.setCurrentSublistValue({ sublistId: 'apply', fieldId: 'apply', value: !!wanted[doc] });
      pay.commitLine({ sublistId: 'apply' });
    }

    // Apply the JE credit
    var creditCount = pay.getLineCount({ sublistId: 'credit' });
    var jeApplied = false;
    for (var c = 0; c < creditCount; c++) {
      pay.selectLine({ sublistId: 'credit', line: c });
      var cdoc = String(pay.getCurrentSublistValue({ sublistId: 'credit', fieldId: 'doc' }));
      var isJE = (cdoc === String(jeId));
      if (isJE) jeApplied = true;
      pay.setCurrentSublistValue({ sublistId: 'credit', fieldId: 'apply', value: isJE });
      pay.commitLine({ sublistId: 'credit' });
    }

    if (!jeApplied) log.error('JE NOT FOUND IN CREDIT SUBLIST', { jeId: jeId, bill: bills[0].vbId });

    return pay.save({ enableSourcing: false, ignoreMandatoryFields: true });
  }

  return { getInputData: getInputData, map: map, reduce: reduce };
});