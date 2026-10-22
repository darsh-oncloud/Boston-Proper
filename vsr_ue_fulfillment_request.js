/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(["N/record","./vsr_lib_fulfillmentrequest"], /**
 * @param{record} record
 */ (record,vsr_lib_fulfillmentrequest) => {
  /**
   * Defines the function definition that is executed after record is submitted.
   * @param {Object} scriptContext
   * @param {Record} scriptContext.newRecord - New record
   * @param {Record} scriptContext.oldRecord - Old record
   * @param {string} scriptContext.type - Trigger type; use values from the context.UserEventType enum
   * @since 2015.2
   */
  const afterSubmit = (scriptContext) => {
    let salesOrder = scriptContext.newRecord;
    let salesOrderId = salesOrder.id;
    let linesToFulfill = [];
    let toBeFulfilled;
    for (i = 0; i < salesOrder.getLineCount("item"); i++) {
      let committedQty = salesOrder.getSublistValue({
        sublistId: "item",
        fieldId: "quantitycommitted",
        line: i,
      });
      let requestedQty = salesOrder.getSublistValue({
        sublistId: "item",
        fieldId: "quantityrequestedtofulfill",
        line: i,
      });
      let lineId = salesOrder.getSublistValue({
        sublistId: "item",
        fieldId: "line",
        line: i,
      });
      let item = salesOrder.getSublistValue({
        sublistId: "item",
        fieldId: "item",
        line: i,
      });
      let qtyLeftToRequest = committedQty - requestedQty;
      log.debug("qtylefttoreq", qtyLeftToRequest);
      if (qtyLeftToRequest != 0 || committedQty == 0) {
        if (qtyLeftToRequest <= 0) {
          toBeFulfilled = false;
        } else if (qtyLeftToRequest > 0) {
          toBeFulfilled = true;
        }
        linesToFulfill.push({
          item: item,
          lineId: lineId,
          qtyToFulfill: qtyLeftToRequest,
          toBeFulfilled: toBeFulfilled,
        });
        log.debug("linesToFulfill", linesToFulfill);
      }
    }
    vsr_lib_fulfillmentrequest.createFulfillmentRequest(salesOrderId, linesToFulfill);
  };
  

  return { afterSubmit };
});
