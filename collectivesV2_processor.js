/**
 * @NApiVersion 2.1
 * @NScriptType ScheduledScript
 * @NModuleScope SameAccount
 * // v1.2
 *
 * Scheduled Script: Drop Ship Sales Order Automation
 * Handles:
 *   1. Customer Deposit creation if none exists
 *   2. Item Fulfillment creation for drop-ship lines marked shipped by Celigo
 *   3. Vendor Bill creation once PO is shipped
 *
 * Script Parameters:
 *   custscript_test_so_id  — (optional) Internal ID of a single SO to process,
 *                            bypassing the saved search. Use for testing.
 *   custscript_debug_mode  — (optional) Boolean. When true, verbose debug logging is enabled.
 */

define([
  'N/search',
  'N/record',
  'N/runtime',
  'N/log',
], (search, record, runtime, log) => {

  // ─────────────────────────────────────────────────────────────
  // CONFIGURATION
  // ─────────────────────────────────────────────────────────────
  const CONFIG = {
    soSavedSearch:             'customsearch_collective_to_process',
    itemDropshipField:         'custitem_bp_collective_flag',
    lineShippedField:          'custcol_bp_collectives_shopify_ffwf',
    undepositedFundsAccountId: '5',
    depositPaymentMethod:      '16',
    arAccountId:               '985',
    apAccountId:               '25',
    subsidiaryId:              '1',   // set null if not OneWorld
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
    const script = runtime.getCurrentScript();
    const testSoId  = script.getParameter({ name: 'custscript_test_so_id' });
    debugEnabled    = script.getParameter({ name: 'custscript_debug_mode' }) === true;

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
        ensureCustomerDeposit(soId);
        const poIds = createDropShipFulfillments(soId);
        logger.info('Drop-ship POs identified', { soId, poIds });
        poIds.forEach(poId => createVendorBill(poId));
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
    const ids = [];
    search.load({ id: CONFIG.soSavedSearch }).run().each(result => {
      ids.push(result.id);
      return true;
    });
    logger.debug('Saved search results', { count: ids.length, ids });
    return ids;
  };

  // ─────────────────────────────────────────────────────────────
  // 1. ENSURE CUSTOMER DEPOSIT EXISTS
  // ─────────────────────────────────────────────────────────────
  const ensureCustomerDeposit = (soId) => {
    logger.debug('Checking for existing Customer Deposit', { soId });

    const existingDeposit = search.create({
      type: search.Type.CUSTOMER_DEPOSIT,
      filters: [
        ['salesorder', 'anyof', soId],
        'AND',
        ['status', 'anyof', ['deposited', 'notdeposited']],
      ],
      columns: ['internalid'],
    }).run().getRange({ start: 0, end: 1 });

    if (existingDeposit.length > 0) {
      logger.info('Customer Deposit already exists — skipping', { soId, depositId: existingDeposit[0].id });
      return;
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
      return;
    }

    const deposit = record.create({ type: record.Type.CUSTOMER_DEPOSIT });
    deposit.setValue('salesorder',    soId);
    deposit.setValue('customer',      customerId);
    deposit.setValue('payment',       amountDue);
    deposit.setValue('currency',      currency);
    deposit.setValue('account',       CONFIG.arAccountId);
    deposit.setValue('toundeposited', true);
    deposit.setValue('paymentmethod', CONFIG.depositPaymentMethod);
    if (subsidiary) deposit.setValue('subsidiary', subsidiary);

    logger.debug('Saving Customer Deposit', { soId, amountDue });
    const depositId = deposit.save({ ignoreMandatoryFields: false });
    logger.info('Customer Deposit created', { soId, depositId });

    // Apply any open invoices to the deposit
    applyInvoicesToDeposit(depositId, customerId, soId);
  };

  // ─────────────────────────────────────────────────────────────
  // HELPER: Apply open invoices to a Customer Deposit
  // ─────────────────────────────────────────────────────────────
  const applyInvoicesToDeposit = (depositId, customerId, soId) => {
    logger.debug('Searching for open invoices to apply to deposit', { depositId, customerId });

    const openInvoices = [];
    search.create({
      type: search.Type.INVOICE,
      filters: [
        ['entity', 'anyof', customerId],
        'AND',
        ['createdfrom', 'anyof', soId],
        'AND',
        ['status', 'anyof', ['CustInvc:A', 'CustInvc:B']],
        'AND',
        ['mainline', 'is', 'T'],
      ],
      columns: ['internalid', 'tranid', 'amountremaining'],
    }).run().each(result => {
      const amountRemaining = parseFloat(result.getValue('amountremaining') || 0);
      if (amountRemaining > 0) {
        openInvoices.push({ id: result.id, tranid: result.getValue('tranid'), amountRemaining });
      }
      return true;
    });

    if (openInvoices.length === 0) {
      logger.info('No open invoices found to apply to deposit', { depositId, customerId });
      return;
    }

    logger.info('Open invoices found to apply', { depositId, count: openInvoices.length, invoices: openInvoices });

    // Apply deposit from the invoice's deposit sublist
    openInvoices.forEach(invoice => {
      try {
        logger.debug('Loading invoice to apply deposit', { invoiceId: invoice.id, depositId });
        const invoiceRecord  = record.load({ type: record.Type.INVOICE, id: invoice.id, isDynamic: true });
        const depositLineCount = invoiceRecord.getLineCount({ sublistId: 'deposit' });
        logger.debug('Invoice deposit sublist line count', { invoiceId: invoice.id, depositLineCount });

        let depositFound = false;
        for (let i = 0; i < depositLineCount; i++) {
          invoiceRecord.selectLine({ sublistId: 'deposit', line: i });
          const lineDoc = invoiceRecord.getCurrentSublistValue({ sublistId: 'deposit', fieldId: 'doc' });
          const lineRef = invoiceRecord.getCurrentSublistValue({ sublistId: 'deposit', fieldId: 'refnum' });
          logger.debug(`Invoice deposit line ${i}`, { lineDoc, lineRef });

          if (String(lineDoc) === String(depositId)) {
            invoiceRecord.setCurrentSublistValue({ sublistId: 'deposit', fieldId: 'apply',  value: true });
            invoiceRecord.setCurrentSublistValue({ sublistId: 'deposit', fieldId: 'amount', value: invoice.amountRemaining });
            invoiceRecord.commitLine({ sublistId: 'deposit' });
            depositFound = true;
            logger.info('Deposit applied to invoice', { invoiceId: invoice.id, depositId, amount: invoice.amountRemaining });
            break;
          }
        }

        if (!depositFound) {
          logger.warn('Deposit not found on invoice deposit sublist', { invoiceId: invoice.id, depositId });
          return;
        }

        invoiceRecord.save({ ignoreMandatoryFields: false });
        logger.info('Invoice saved with deposit applied', { invoiceId: invoice.id, depositId });

      } catch (e) {
        logger.error('Failed to apply deposit to invoice', { invoiceId: invoice.id, depositId, message: e.message });
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
  //    Step 2: Fulfillment Request → Item Fulfillment
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

    // Look up linked POs via search rather than relying on createdFrom line field
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

      // Disable all lines first
      const frLineCount = fr.getLineCount({ sublistId: 'item' });
      logger.debug('FR line count', { frLineCount });
      for (let j = 0; j < frLineCount; j++) {
        fr.selectLine({ sublistId: 'item', line: j });
        fr.setCurrentSublistValue({ sublistId: 'item', fieldId: 'itemreceive', value: false });
      }

      fr.setValue({ fieldId: 'transtatus', value: 'B' });

      // Enable only eligible lines using your proven approach
      linesToFulfill.forEach(({ index, itemId, quantity }) => {
        logger.debug('Enabling FR line', { index, itemId, quantity });
        fr.selectLine({ sublistId: 'item', line: index });
        fr.setCurrentSublistValue({ sublistId: 'item', fieldId: 'item',                  value: itemId });
        fr.setCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity',              value: quantity });
        fr.setCurrentSublistValue({ sublistId: 'item', fieldId: CONFIG.lineShippedField, value: true });
        fr.setCurrentSublistValue({ sublistId: 'item', fieldId: 'itemreceive',           value: true });
        fr.commitLine({ sublistId: 'item' });
      });

      frId = fr.save();
      logger.info('Fulfillment Request created', { soId, frId });

    } catch (frErr) {
      logger.error('Fulfillment Request creation failed', { soId, message: frErr.message });
      return poIds;
    }

    // ── Step 2: FR → Item Fulfillment ───────────────────────────
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
      logger.error('Item Fulfillment creation failed', { soId, frId, message: ifErr.message });
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

    const billableStatuses = ['pendingBilling', 'partiallyReceived'];
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

    const billId = vendorBill.save({ ignoreMandatoryFields: false });
    logger.info('Vendor Bill created', { poId, billId });
    return billId;
  };

  return { execute };
});