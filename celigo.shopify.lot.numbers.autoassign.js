/**
 * Auto-assign lot/serialized inventory numbers on transaction creation
 * for integration contexts (Celigo / REST / Suitelet / Web Services).
 * - Only handles line item types: InvtPart, Assembly
 * - Assigns:
 *   - SERIAL: assigns qty distinct inventory numbers, qty=1 each
 *   - LOT: splits across lots by FEFO (expiration ascending) and available qty
 * - Uses Inventory Number search with filters:
 *   item + location + quantityavailable > 0
 *
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(["N/search", "N/runtime", "N/error"], (search, runtime, error) => {
  const ITEM_SUBLIST = "item";
  const INV_DETAIL_FIELD = "inventorydetail";
  const INV_ASSIGN_SUBLIST = "inventoryassignment";

  const ITEM_TYPE_REQUIRES_INV_DETAIL = new Set(["InvtPart", "Assembly"]);
  const INVENTORY_MODE = Object.freeze({ LOT: "LOT", SERIAL: "SERIAL" });

  /**
   * Entry point
   * @param context
   */
  function beforeSubmit(context) {
    const ALLOWED_EXECUTION_CONTEXTS = [
      runtime.ContextType.WEBSERVICES,
      runtime.ContextType.RESTLET,
      runtime.ContextType.SUITELET
    ];
    const transaction = context.newRecord;
    const autoAssignSet = transaction.getValue({ fieldId: 'custbody_celigo_shopify_auto_assign_in' });

    if (!shouldRun(context, autoAssignSet, ALLOWED_EXECUTION_CONTEXTS)) return;

    const headerLocationId = transaction.getValue({ fieldId: "location" });
    const lineCount = transaction.getLineCount({ sublistId: ITEM_SUBLIST });

    for (let line = 0; line < lineCount; line++) {
      processItemLine({
        transaction,
        line,
        headerLocationId
      });
    }
  }

  /**
   * Helpers
   */

  function shouldRun(context, autoAssignSet, ALLOWED_EXECUTION_CONTEXTS) {
    const isCreateOrEdit = context.type === context.UserEventType.CREATE || context.type === context.UserEventType.EDIT;
    const execContextAllowed = ALLOWED_EXECUTION_CONTEXTS.includes(runtime.executionContext);

    return isCreateOrEdit && execContextAllowed && (autoAssignSet === 'T' || autoAssignSet === true);
  }

  function processItemLine({ transaction, line, headerLocationId }) {
    const itemId = transaction.getSublistValue({ sublistId: ITEM_SUBLIST, fieldId: "item", line });
    const qty = Number(transaction.getSublistValue({ sublistId: ITEM_SUBLIST, fieldId: "quantity", line }) || 0);

    if (!itemId || qty <= 0) return;

    const itemType = transaction.getSublistValue({ sublistId: ITEM_SUBLIST, fieldId: "itemtype", line });
    if (!ITEM_TYPE_REQUIRES_INV_DETAIL.has(itemType)) return;

    const mode = getItemInventoryMode(itemId);
    if (!mode) return; // Not lot/serialized

    const lineLocationId = transaction.getSublistValue({ sublistId: ITEM_SUBLIST, fieldId: "location", line });
    const effectiveLocationId = lineLocationId || headerLocationId;

    if (!effectiveLocationId) {
      throw makeErr(
        "MISSING_LOCATION",
        `Line ${line + 1}: location is required to auto-assign ${mode} numbers.`
      );
    }

    if (hasInventoryDetail(transaction, line)) return;

    const assignments = allocateInventoryNumbers({
      itemId,
      locationId: effectiveLocationId,
      qty,
      mode
    });

    if (!assignments || assignments.length === 0) {
      throw makeErr(
        "NO_AVAILABLE_NUMBERS",
        `Line ${line + 1}: no available ${mode} numbers found for item ${itemId} at location ${effectiveLocationId} for qty ${qty}.`
      );
    }

    const assignedQty = assignments.reduce((sum, a) => sum + Number(a.qty || 0), 0);
    if (assignedQty !== qty) {
      throw makeErr(
        "INSUFFICIENT_NUMBERS",
        `Line ${line + 1}: needed qty ${qty} but could only assign ${assignedQty} for item ${itemId} at location ${effectiveLocationId}.`
      );
    }

    writeInventoryDetail(transaction, line, assignments);
  }

  /**
   * Returns INVENTORY_MODE.SERIAL, INVENTORY_MODE.LOT, or null
   */
  function getItemInventoryMode(itemId) {
    const fields = search.lookupFields({
      type: search.Type.ITEM,
      id: itemId,
      columns: ["islotitem", "isserialitem"]
    });

    const isLot = !!fields.islotitem;
    const isSerial = !!fields.isserialitem;

    if (isSerial) return INVENTORY_MODE.SERIAL;
    if (isLot) return INVENTORY_MODE.LOT;
    return null;
  }

  function hasInventoryDetail(transaction, line) {
    try {
      const invDetail = transaction.getSublistSubrecord({
        sublistId: ITEM_SUBLIST,
        fieldId: INV_DETAIL_FIELD,
        line
      });

      if (!invDetail) return false;

      const count = invDetail.getLineCount({ sublistId: INV_ASSIGN_SUBLIST });
      return count > 0;
    } catch (e) {
      // getSublistSubrecord throws when inventory detail doesn't exist
      return false;
    }
  }

  /**
   * Returns array of { inventoryNumberId, qty }
   */
  function allocateInventoryNumbers({ itemId, locationId, qty, mode }) {
    if (mode === INVENTORY_MODE.SERIAL) {
      const serialIds = findAvailableInventoryNumbers({
        itemId,
        locationId,
        limit: qty
      });

      return serialIds.map((id) => ({ inventoryNumberId: id, qty: 1 }));
    }

    // LOT allocation: split across lots if needed
    const lots = findAvailableLotsWithQty({ itemId, locationId, qtyNeeded: qty });

    const assignments = [];
    let remaining = qty;

    for (let i = 0; i < lots.length && remaining > 0; i++) {
      const take = Math.min(remaining, lots[i].availableQty);
      if (take > 0) {
        assignments.push({ inventoryNumberId: lots[i].inventoryNumberId, qty: take });
        remaining -= take;
      }
    }

    return assignments;
  }

  /**
   * SERIAL: returns array of inventorynumber internal IDs.
   * NOTE: `mode` param removed (was unused) to reduce noise; behavior unchanged.
   */
  function findAvailableInventoryNumbers({ itemId, locationId, limit }) {
    const ids = [];

    const invNumSearch = search.create({
      type: "inventorynumber",
      filters: [
        ["item", "anyof", itemId],
        "AND",
        ["quantityavailable", "greaterthan", "0"],
        "AND",
        ["location", "anyof", locationId]
      ],
      columns: [
        search.createColumn({ name: "internalid" }),
        search.createColumn({ name: "inventorynumber" })
      ]
    });

    invNumSearch.run().each((res) => {
      ids.push(res.getValue({ name: "internalid" }));
      return ids.length < limit;
    });

    return ids;
  }

  /**
   * LOT: returns array of { inventoryNumberId, availableQty } sorted by expirationdate asc (FEFO).
   */
  function findAvailableLotsWithQty({ itemId, locationId, qtyNeeded }) {
    const rows = [];

    const lotSearch = search.create({
      type: "inventorynumber",
      filters: [
        ["item", "anyof", itemId],
        "AND",
        ["location", "anyof", locationId],
        "AND",
        ["quantityavailable", "greaterthan", "0"]
      ],
      columns: [
        search.createColumn({ name: "internalid" }),
        search.createColumn({ name: "quantityavailable" }),
        search.createColumn({ name: "expirationdate", sort: search.Sort.ASC })
      ]
    });

    lotSearch.run().each((res) => {
      rows.push({
        inventoryNumberId: res.getValue({ name: "internalid" }),
        availableQty: Number(res.getValue({ name: "quantityavailable" }) || 0),
        expiration: res.getValue({ name: "expirationdate" }) || null
      });

      // Stop early if we already have enough available qty to cover the line qty
      const covered = rows.reduce((sum, r) => sum + r.availableQty, 0);
      return covered < qtyNeeded;
    });

    return rows;
  }

  function writeInventoryDetail(transaction, line, assignments) {
    const invDetail = transaction.getSublistSubrecord({
      sublistId: ITEM_SUBLIST,
      fieldId: INV_DETAIL_FIELD,
      line
    });

    for (let i = 0; i < assignments.length; i++) {
      invDetail.insertLine({ sublistId: INV_ASSIGN_SUBLIST, line: i });

      invDetail.setSublistValue({
        sublistId: INV_ASSIGN_SUBLIST,
        fieldId: "issueinventorynumber",
        line: i,
        value: assignments[i].inventoryNumberId
      });

      invDetail.setSublistValue({
        sublistId: INV_ASSIGN_SUBLIST,
        fieldId: "quantity",
        line: i,
        value: assignments[i].qty
      });
    }
  }

  function makeErr(name, message) {
    return error.create({ name, message, notifyOff: false });
  }

  return { beforeSubmit };
});
