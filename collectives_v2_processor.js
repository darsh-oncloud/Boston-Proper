/**
 * @NApiVersion 2.1
 * @NScriptType ScheduledScript
 * @NModuleScope SameAccount
 * // v1.5
 *
 * Scheduled Script: Drop Ship Sales Order Automation
 * Runs every 15 minutes. Handles:
 *   1. Customer Deposit creation if none exists (must exist before fulfillments)
 *   2. Item Fulfillment creation for drop-ship lines marked shipped by Celigo
 *   3. Vendor Bill creation once PO is shipped
 *   4. Ensure custbody_bp_collectives_order is checked on SO and Vendor Bills
 *
 * Script Parameters:
 *   custscript_coll_test_so_id  — (optional) Internal ID of a single SO to process,
 *                                 bypassing the saved search. Use for testing.
 *   custscript_coll_debug_mode  — (optional) Boolean. When true, verbose debug logging is enabled.
 */

define([
  'N/search',
  'N/record',
  'N/runtime',
  'N/log',
  'N/query',
], (search, record, runtime, log, query) => {

  // ─────────────────────────────────────────────────────────────
  // CONFIGURATION
  // ─────────────────────────────────────────────────────────────
  const CONFIG = {
    soSavedSearch:          'customsearch_collective_to_process_2',
    itemDropshipField:      'custitem_bp_collective_flag',
    lineShippedField:       'custcol_bp_collectives_shopify_ffwf',
    collectivesOrderField:  'custbody_bp_collectives_order',
    depositPaymentMethod:   '16',
    arAccountId:            '985',
    apAccountId:            '25',
    subsidiaryId:           '1',   // set null if not OneWorld
  };

  // ─────────────────────────────────────────────────────────────
  // LOGGER
  // ─────────────────────────────────────────────────────────────
  let debugEnabled = false;

  const logger = {
    debug: (title, detail) => {
      if (debugEnabled) log.debug({ title: `[DEBUG] ${title}`, details: JSON.stringify(detail ?? '') });
    },
    info:  (title, detail) => log.audit({ title: `[INFO]  ${title}`, details: JSON.stringify(detail ?? '') }),
    warn:  (title, detail) => log.audit({ title: `[WARN]  ${title}`, details: JSON.stringify(detail ?? '') }),
    error: (title, detail) => log.error({ title: `[ERROR] ${title}`, details: JSON.stringify(detail ?? '') }),
  };

  // ─────────────────────────────────────────────────────────────
  // ENTRY POINT
  // ─────────────────────────────────────────────────────────────
  const execute = (context) => {
    const script   = runtime.getCurrentScript();
    const testSoId = script.getParameter({ name: 'custscript_coll_test_so_id' });
    debugEnabled   = script.getParameter({ name: 'custscript_coll_debug_mode' }) === true;

    logger.info('Script started', {
      testMode:  !!testSoId,
      testSoId:  testSoId || 'N/A',
      debugMode: debugEnabled,
    });

    const soIds = testSoId ? [String(testSoId)] : getOpenSalesOrders();
    logger.info('Sales Orders to process', { count: soIds.length, ids: soIds });

    soIds.forEach(soId => {
      logger.info('═══ Processing SO', soId);
      try {
        const depositExists = ensureCustomerDeposit(soId);
        if (!depositExists) {
          logger.info('Deposit not yet created — skipping fulfillment for this run', { soId });
          return;
        }
        const poIds = createDropShipFulfillments(soId);
        logger.info('Drop-ship POs identified', { soId, poIds });
        poIds.forEach(poId => createVendorBill(poId));
        ensureCollectivesCheckbox(soId, poIds);
      } catch (e) {
        logger.error(`Fatal error on SO ${soId}`, { message: e.message, stack: e.stack });
      }
    });

    logger.info('Script complete');
  };

  // ─────────────────────────────────────────────────────────────
  // LOAD OPEN SALES ORDERS FROM SAVED SEARCH
  // ─────────────────────────────────────────────────────────────
  const getOpenSalesOrders = () => {
    logger.debug('Loading saved search', CONFIG.soSavedSearch);
    const ids = new Set();
    search.load({ id: CONFIG.soSavedSearch }).run().each(result => {
      ids.add(result.id);
      return true;
    });
    const uniqueIds = [...ids];
    logger.debug('Saved search results', { count: uniqueIds.length, ids: uniqueIds });
    return uniqueIds;
  };

  // ─────────────────────────────────────────────────────────────
  // 1. ENSURE CUSTOMER DEPOSIT EXISTS
  //    Returns true if deposit exists or was created.
  //    Returns false if creation was skipped (e.g. no amount due).
  // ─────────────────────────────────────────────────────────────
  const ensureCustomerDeposit = (soId) => {
    logger.debug('Checking for existing Customer Deposit', { soId });

    const suiteQLResult = query.runSuiteQL({
      query: `SELECT id FROM CustomerDeposit WHERE salesorder = ?`,
      params: [soId],
    });

    if (suiteQLResult.results.length > 0) {
      logger.info('Customer Deposit already exists', { soId, depositId: suiteQLResult.results[0].values[0] });
      return true;
    }

    logger.debug('No deposit found — loading SO to create one', { soId });
    const so         = record.load({ type: record.Type.SALES_ORDER, id: soId });
    const customerId = so.getValue('entity');
    const amountDue  = so.getValue('amountdue') || so.getValue('total');
    const currency   = so.getValue('currency');
    const subsidiary = so.getValue('subsidiary');

    logger.debug('SO values for deposit', { customerId, amountDue, currency, subsidiary });

    if (!amountDue || parseFloat(amountDue) <= 0) {
      logger.warn('No amount due on SO — skipping deposit creation', { soId, amountDue });
      return false;
    }

    const deposit = record.create({ type: record.Type.CUSTOMER_DEPOSIT, isDynamic: true });
    deposit.setValue({ fieldId: 'customer',      value: customerId });
    deposit.setValue({ fieldId: 'payment',       value: amountDue });
    deposit.setValue({ fieldId: 'currency',      value: currency });
    deposit.setValue({ fieldId: 'account',       value: CONFIG.arAccountId });
    deposit.setValue({ fieldId: 'undepfunds',    value: 'T' });
    deposit.setValue({ fieldId: 'paymentmethod', value: CONFIG.depositPaymentMethod });
    if (subsidiary) deposit.setValue({ fieldId: 'subsidiary', value: subsidiary });
    deposit.setValue({ fieldId: 'salesorder',    value: soId });

    logger.debug('Saving Customer Deposit', { soId, amountDue });
    const depositId = deposit.save({ ignoreMandatoryFields: false });
    logger.info('Customer Deposit created', { soId, depositId });
    return true;
  };

  // ─────────────────────────────────────────────────────────────
  // HELPER: Ensure custbody_bp_collectives_order is checked
  //         on the SO and any linked vendor bills on every run
  // ─────────────────────────────────────────────────────────────
  const ensureCollectivesCheckbox = (soId, poIds) => {
    logger.debug('Ensuring Collectives checkbox on SO and bills', { soId, poIds });

    // Check SO
    try {
      const soLookup = search.lookupFields({ type: record.Type.SALES_ORDER, id: soId, columns: [CONFIG.collectivesOrderField] });
      if (!soLookup[CONFIG.collectivesOrderField]) {
        record.submitFields({ type: record.Type.SALES_ORDER, id: soId, values: { [CONFIG.collectivesOrderField]: true } });
        logger.info('Collectives checkbox checked on SO', { soId });
      } else {
        logger.debug('Collectives checkbox already checked on SO', { soId });
      }
    } catch (e) {
      logger.error('Failed to check Collectives checkbox on SO', { soId, message: e.message });
    }

    // Check vendor bills linked to each PO
    poIds.forEach(poId => {
      try {
        search.create({
          type: search.Type.VENDOR_BILL,
          filters: [
            ['createdfrom', 'anyof', poId],
            'AND',
            ['mainline', 'is', 'T'],
            'AND',
            ['status', 'noneof', ['vendBill:V']],
          ],
          columns: ['internalid'],
        }).run().each(result => {
          const billId     = result.id;
          const billLookup = search.lookupFields({ type: record.Type.VENDOR_BILL, id: billId, columns: [CONFIG.collectivesOrderField] });
          logger.debug('Vendor Bill Collectives checkbox value', { billId, value: billLookup[CONFIG.collectivesOrderField] });
          if (!billLookup[CONFIG.collectivesOrderField]) {
            record.submitFields({ type: record.Type.VENDOR_BILL, id: billId, values: { [CONFIG.collectivesOrderField]: true } });
            logger.info('Collectives checkbox checked on Vendor Bill', { billId, poId });
          } else {
            logger.debug('Collectives checkbox already checked on Vendor Bill', { billId, poId });
          }
          return true;
        });
      } catch (e) {
        logger.error('Failed to check Collectives checkbox on Vendor Bill', { poId, message: e.message });
      }
    });
  };

  // ─────────────────────────────────────────────────────────────
  // HELPER: Find POs linked to a Sales Order via transaction search
  // ─────────────────────────────────────────────────────────────
  const getLinkedPOs = (soId) => {
    logger.debug('Searching for POs linked to SO', { soId });
    const poIds = [];
    search.create({
      type: search.Type.PURCHASE_ORDER,
      filters: [
        ['createdfrom', 'anyof', soId],
        'AND',
        ['mainline', 'is', 'T'],
        'AND',
        ['status', 'noneof', ['purchaseOrder:H', 'purchaseOrder:G']],
      ],
      columns: ['internalid', 'tranid', 'status'],
    }).run().each(result => {
      logger.debug('Found linked PO', { poId: result.id, tranid: result.getValue('tranid'), status: result.getValue('status') });
      poIds.push(result.id);
      return true;
    });
    logger.info('Linked POs found for SO', { soId, poIds });
    return poIds;
  };

  // ─────────────────────────────────────────────────────────────
  // 2. CREATE DROP-SHIP ITEM FULFILLMENTS
  //    Step 1: SO → Fulfillment Request (scoped to eligible lines)
  //    Step 2: SO → Item Fulfillment linked to FR via fftreqid
  // ─────────────────────────────────────────────────────────────
  const createDropShipFulfillments = (soId) => {
    logger.debug('Loading SO for fulfillment check', { soId });
    const so = record.load({ type: record.Type.SALES_ORDER, id: soId, isDynamic: true });

    const lineCount         = so.getLineCount({ sublistId: 'item' });
    const linesToFulfill    = [];
    const itemDropshipCache = {};

    logger.debug('SO line count', { soId, lineCount });

    for (let i = 0; i < lineCount; i++) {
      const itemId            = so.getSublistValue({ sublistId: 'item', fieldId: 'item',                   line: i });
      const isClosed          = so.getSublistValue({ sublistId: 'item', fieldId: 'isclosed',              line: i });
      const isBilled          = so.getSublistValue({ sublistId: 'item', fieldId: 'isbilled',              line: i });
      const isShipped         = so.getSublistValue({ sublistId: 'item', fieldId: CONFIG.lineShippedField, line: i });
      const quantityFulfilled = parseFloat(so.getSublistValue({ sublistId: 'item', fieldId: 'quantityfulfilled', line: i }) || 0);
      const quantity          = parseFloat(so.getSublistValue({ sublistId: 'item', fieldId: 'quantity',   line: i }) || 0);

      logger.debug(`Line ${i} values`, { itemId, isClosed, isBilled, isShipped, quantityFulfilled, quantity });

      if (!itemId)                       { logger.debug(`Line ${i} skipped — no item`, {}); continue; }
      if (isClosed)                      { logger.debug(`Line ${i} skipped — closed`, { itemId }); continue; }
      if (isBilled)                      { logger.debug(`Line ${i} skipped — already billed`, { itemId }); continue; }
      if (quantityFulfilled >= quantity)  { logger.debug(`Line ${i} skipped — fully fulfilled`, { itemId }); continue; }
      if (!isShipped)                    { logger.debug(`Line ${i} skipped — Celigo shipped checkbox not checked`, { itemId }); continue; }

      // Check item record's dropship flag (cached)
      if (!(itemId in itemDropshipCache)) {
        logger.debug('Looking up dropship flag on item', { itemId });
        const itemLookup = search.lookupFields({
          type: search.Type.ITEM,
          id: itemId,
          columns: [CONFIG.itemDropshipField],
        });
        itemDropshipCache[itemId] = itemLookup[CONFIG.itemDropshipField] === true;
        logger.debug('Item dropship flag result', { itemId, isDropship: itemDropshipCache[itemId] });
      }

      if (!itemDropshipCache[itemId]) { logger.debug(`Line ${i} skipped — item not flagged as drop-ship`, { itemId }); continue; }

      logger.info(`Line ${i} eligible for fulfillment`, { itemId });
      linesToFulfill.push({ index: i, itemId, quantity });
    }

    const poIds = getLinkedPOs(soId);

    if (linesToFulfill.length === 0) {
      logger.info('No lines ready for fulfillment', { soId });
      return poIds;
    }

    if (poIds.length === 0) {
      logger.warn('Eligible lines found but no linked POs found — cannot create Fulfillment Request', { soId });
      return [];
    }

    // ── Step 1: SO → Fulfillment Request ────────────────────────
    logger.info('Creating Fulfillment Request', { soId, lines: linesToFulfill.map(l => l.index) });

    let frId;
    try {
      const fr = record.transform({
        fromType:  record.Type.SALES_ORDER,
        fromId:    soId,
        toType:    'fulfillmentrequest',
        isDynamic: true,
      });

      const frLineCount = fr.getLineCount({ sublistId: 'item' });
      logger.debug('FR line count', { frLineCount });

      // Disable all lines first
      for (let j = 0; j < frLineCount; j++) {
        fr.selectLine({ sublistId: 'item', line: j });
        fr.setCurrentSublistValue({ sublistId: 'item', fieldId: 'itemreceive', value: false });
      }

      fr.setValue({ fieldId: 'transtatus', value: 'B' });

      // Enable only eligible lines
      linesToFulfill.forEach(({ index, itemId, quantity }) => {
        logger.debug('Enabling FR line', { index, itemId, quantity });
        fr.selectLine({ sublistId: 'item', line: index });
        fr.setCurrentSublistValue({ sublistId: 'item', fieldId: 'item',        value: itemId });
        fr.setCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity',    value: quantity });
        fr.setCurrentSublistValue({ sublistId: 'item', fieldId: 'itemreceive', value: true });
        try {
          fr.setCurrentSublistValue({ sublistId: 'item', fieldId: CONFIG.lineShippedField, value: true });
        } catch(e) {
          logger.debug('lineShippedField not available on FR sublist — skipping', { fieldId: CONFIG.lineShippedField });
        }
        fr.commitLine({ sublistId: 'item' });
      });

      frId = fr.save();
      logger.info('Fulfillment Request created', { soId, frId });

    } catch (frErr) {
      logger.error('Fulfillment Request creation failed', { soId, message: frErr.message, stack: frErr.stack, name: frErr.name });
      return poIds;
    }

    // ── Step 2: SO → Item Fulfillment linked to FR ──────────────
    logger.info('Creating Item Fulfillment from FR', { soId, frId });

    try {
      const fulfillment = record.transform({
        fromType:  record.Type.SALES_ORDER,
        fromId:    soId,
        toType:    record.Type.ITEM_FULFILLMENT,
        isDynamic: true,
        defaultValues: {
          fftreqid:  frId,
          shipgroup: 1,
        },
      });

      fulfillment.setValue({ fieldId: 'shipstatus', value: 'C' });

      const fulfillmentId = fulfillment.save({ ignoreMandatoryFields: false });
      logger.info('Item Fulfillment created', { soId, frId, fulfillmentId });

    } catch (ifErr) {
      logger.error('Item Fulfillment creation failed', { soId, frId, message: ifErr.message, stack: ifErr.stack, name: ifErr.name });
    }

    return poIds;
  };

  // ─────────────────────────────────────────────────────────────
  // 3. CREATE VENDOR BILL FROM PURCHASE ORDER
  // ─────────────────────────────────────────────────────────────
  const createVendorBill = (poId) => {
    logger.debug('Checking for existing Vendor Bill', { poId });

    const existingBill = search.create({
      type: search.Type.VENDOR_BILL,
      filters: [
        ['createdfrom', 'anyof', poId],
        'AND',
        ['mainline', 'is', 'T'],
        'AND',
        ['status', 'noneof', ['vendBill:V']],
      ],
      columns: ['internalid'],
    }).run().getRange({ start: 0, end: 1 });

    if (existingBill.length > 0) {
      logger.info('Vendor Bill already exists — skipping', { poId, billId: existingBill[0].id });
      return existingBill[0].id;
    }

    logger.debug('Loading PO to check status', { poId });
    const po       = record.load({ type: record.Type.PURCHASE_ORDER, id: poId });
    const poStatus = po.getValue('status');

    logger.debug('PO status', { poId, poStatus });

    const billableStatuses = ['pendingBilling', 'partiallyReceived', 'pendingBillPartReceived', 'Pending Billing', 'Partially Received', 'Pending Billing/Partially Received'];
    if (!billableStatuses.includes(poStatus)) {
      logger.warn('PO not in a billable status — skipping', { poId, poStatus });
      return null;
    }

    logger.info('Transforming PO → Vendor Bill', { poId });
    const vendorBill = record.transform({
      fromType:  record.Type.PURCHASE_ORDER,
      fromId:    poId,
      toType:    record.Type.VENDOR_BILL,
      isDynamic: true,
    });

    const poTranId = po.getValue('tranid');
    const poDept   = po.getValue('department');
    vendorBill.setValue({ fieldId: 'tranid',                        value: poTranId });
    vendorBill.setValue({ fieldId: CONFIG.collectivesOrderField,    value: true });
    if (poDept) vendorBill.setValue({ fieldId: 'department',        value: poDept });

    const billId = vendorBill.save({ ignoreMandatoryFields: true });
    logger.info('Vendor Bill created', { poId, billId });
    return billId;
  };

  return { execute };
});