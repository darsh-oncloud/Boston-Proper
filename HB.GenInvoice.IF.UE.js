/**
 * @NApiVersion 2.x
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 */	

define(['N/record', 'N/log', 'N/search'],

function(record, log, search) {

    function afterSubmitFF(scriptContext) {
        try {
            // Context Filter, ignore if type is delete or ship status is not shipped
            if (scriptContext.type == scriptContext.UserEventType.DELETE) {
                return;
            }

            // Load item shipment and order
            var ffRec = record.load({
                type: scriptContext.newRecord.type,
                id: scriptContext.newRecord.id
            });
            log.debug('start', ffRec.getValue({fieldId: 'tranid'}));

            if (ffRec.getValue({fieldId: 'status'}) != 'Shipped' || ffRec.getValue({fieldId: 'custbody_hb_related_invoice'})) {
                log.debug('ignored', ffRec.getValue({fieldId: 'status'}) + ' ; ' + ffRec.getValue({fieldId: 'custbody_hb_related_invoice'}));
                return;
            }

            //if (!ffRec.getValue({fieldId: 'custbody_celigo_etail_channel'})) {
            //   log.debug('ignored', 'non etail order');
            //    return;
        // }

            // Ignore if item shipment is created for Transfer Order
            var createdFrom = ffRec.getValue({fieldId: 'createdfrom'});
            var createdFromRecType = search.lookupFields({
                type: 'transaction',
                id: createdFrom,
                columns: ['recordtype', 'shippingcost', 'total']
            });
            if (createdFromRecType.recordtype != record.Type.SALES_ORDER) {
                log.debug('ignore', 'created from ' + createdFromRecType);
                return;
            }
            //Check if IF exists otherwise exit so it does not error on Collectives order
            if (!itemFulfillmentFromSalesOrderExists(createdFrom)) {
                log.debug('IF Check:','Item Fulfillment created from the specified Sales Order does not exist.');
                return;
            }
          
          
          	            var soRec = record.load({
                type: record.Type.SALES_ORDER,
                id: createdFrom,
                isDynamic: true
            });
          
            var shippingtax1rate = soRec.getValue({fieldId: 'shippingtax1rate'});
          log.debug("shippingtax1rate To Set",shippingtax1rate);

          	//Checking For Gift Card Item In SO

          var GiftCardAmount = 0.00;
          	for(var SoLineCount = 0; SoLineCount < soRec.getLineCount({sublistId: 'item'}); SoLineCount++)
              {
                var SOItem = soRec.getSublistValue({sublistId: 'item', fieldId: 'item', line: SoLineCount});
              	var SOAmount = soRec.getSublistValue({sublistId: 'item', fieldId: 'amount', line: SoLineCount});
                if(SOItem == "428301")//10003 Gift Card Payment
                  {
                    //Updated 10-2-2023 Chris Audie to fix rounding on invoice GC
                    //GiftCardAmount += parseInt(SOAmount);

                    //change to int prior to assigning to maintain decimals
                        var gcamt = +SOAmount;
                        log.debug('RAW GiftCardAmount In Sales Order', gcamt);
                        Math.round(gcamt * 100 / 100);
                        log.debug('Rounded GiftCardAmount In Sales Order', gcamt);
                        //GiftCardAmount += Math.round(parseInt(SOAmount)* 100/100);
                        GiftCardAmount = gcamt;
                        log.debug('FINAL GiftCardAmount In Sales Order', GiftCardAmount);
                  }
              }//SoLineCount

          	GiftCardAmount = GiftCardAmount * -1;
          	log.debug('GiftCardAmount In Sales Order', GiftCardAmount);

          	//Checking For Gift Card Item In SO - Ends

            // Generate an Invoice
            var isFinalInvoice = true;

            var invRec = record.transform({
                fromType: record.Type.SALES_ORDER,
                fromId: createdFrom,
                toType: record.Type.INVOICE,
                isDynamic: true
            });

            for (var i = invRec.getLineCount({sublistId: 'item'}) - 1; i >= 0; i--) {
                invRec.selectLine({sublistId: 'item', line: i});

                var invLineId = invRec.getCurrentSublistValue({sublistId: 'item', fieldId: 'line'});
                var isNonInvt = invRec.getCurrentSublistValue({sublistId: 'item', fieldId: 'isnoninventory'});
                var itemSku = invRec.getCurrentSublistText({sublistId: 'item', fieldId: 'item'});
                var itemId = invRec.getCurrentSublistValue({sublistId: 'item', fieldId: 'item'});
                var shipIns = invRec.getCurrentSublistValue({sublistId: 'item', fieldId: 'itemtype'})
                log.debug('line start: ' + isNonInvt, itemSku);

                if (isNonInvt == 'F') {
                    // Set Tax From SO
                    var soLineIndex = soRec.findSublistLineWithValue({sublistId: 'item', fieldId: 'item', value: itemId});
                    var soTaxRate = soRec.getSublistValue({sublistId: 'item', fieldId: 'taxrate1', line: soLineIndex});
                    invRec.setCurrentSublistValue({sublistId: 'item', fieldId: 'taxrate1', value: soTaxRate});

                    var ffLineIndex = ffRec.findSublistLineWithValue({sublistId: 'item', fieldId: 'orderline', value: invLineId});
                    log.debug('ffLineIndex', ffLineIndex);

                    if (ffLineIndex > -1) {
                        var quantityShipped = ffRec.getSublistValue({sublistId: 'item', fieldId: 'quantity', line: ffLineIndex});

                        if (invRec.getCurrentSublistValue({sublistId: 'item', fieldId: 'quantity'}) > quantityShipped) {
                            isFinalInvoice = false;
                            log.debug('item sku - not final', itemSku);
                        }

                        invRec.setCurrentSublistValue({sublistId: 'item', fieldId: 'quantity', value: quantityShipped});
                        invRec.commitLine({sublistId: 'item'});
                    } else {
                        log.error('ff line not found', invLineId);
                        if(shipIns == 'Service') {
                          invRec.commitLine({sublistId: 'item'});
                        } else { 
                        invRec.removeLine({sublistId: 'item', line: i});

                        isFinalInvoice = false;
                        log.debug('item sku - not final', itemSku);
                        }
                    }
                }
            }

            invRec.setValue({fieldId: 'location', value: ffRec.getSublistValue({sublistId: 'item', fieldId: 'location', line: 0})});

            var existingInvoiceData = getExistingInvoiceInfo(createdFrom)||null;   
 log.debug('existingInvoiceData', existingInvoiceData);
            if (createdFromRecType.shippingcost > 0) 
            {
                if (isFinalInvoice) {
                    var billedShippingCost = existingInvoiceData.billedShippingCost;
                    log.debug('billedShippingCost', billedShippingCost);

                   // invRec.setValue({fieldId: 'shippingcost', value: createdFromRecType.shippingcost - billedShippingCost});
                    log.debug('finalinvoice shipcost: ' + createdFromRecType.shippingcost, createdFromRecType.shippingcost - billedShippingCost);
                } else {
                    var soTotalWeight = calcTranTotalWeight(soRec);

                    if (soTotalWeight > 0) {
                        var ffTotalWeight = calcTranTotalWeight(ffRec);
                        
                        if(existingInvoiceData == null)
                        {
                            var invShippingCost = createdFromRecType.shippingcost / soTotalWeight * ffTotalWeight;
                          //  invRec.setValue({fieldId: 'shippingcost', value: invShippingCost.toFixed(2)});
                        //    invRec.setValue({fieldId: 'shippingtax1rate', value: shippingtax1rate});
                            log.debug('invShippingCost: ' + invShippingCost, 'so-' + soTotalWeight + 'g;ff-' + ffTotalWeight + 'g');                    
                        }
                    } 
                  else {
                        log.debug('soTotalWeight', soTotalWeight);
                        if(existingInvoiceData == null)
                        {
                          //  invRec.setValue({fieldId: 'shippingcost', value: createdFromRecType.shippingcost});
                         //   invRec.setValue({fieldId: 'shippingtax1rate', value: shippingtax1rate});
                        }
                    }   
                }
               if(existingInvoiceData.billedTotal == 0)
                        {
                            invRec.setValue({fieldId: 'shippingcost', value: createdFromRecType.shippingcost});
                            invRec.setValue({fieldId: 'shippingtax1rate', value: shippingtax1rate});
                        }
              else
                {
                  invRec.setValue({fieldId: 'shippingcost', value: 0});
                            invRec.setValue({fieldId: 'shippingtax1rate', value: 0});
                }
              
            }
          

            var invRecId = invRec.save();
            log.debug('invRec generated', invRecId);

            // Update Shipment
            record.submitFields({
                type: scriptContext.newRecord.type,
                id: scriptContext.newRecord.id,
                values: {
                    'custbody_hb_related_invoice': invRecId
                }
            });
            log.debug('ff updated: ' + scriptContext.newRecord.id, invRecId);

            // Fix Tax Line based on sales order total
            if (isFinalInvoice) {
                var invRec = record.load({
                    type: record.Type.INVOICE,
                    id: invRecId
                });
        
                var invTotal = invRec.getValue({fieldId:'total'});
                log.debug('final invoice:' + invRec.getValue({fieldId: 'tranid'}), 'invTotal:' + invTotal + ' ;' + existingInvoiceData.billedTotal + ' ;' + createdFromRecType.total);
                
                var diff = createdFromRecType.total - invTotal - existingInvoiceData.billedTotal;
                log.debug('final invoice diff', diff.toFixed(2));

                if (Math.abs(diff.toFixed(2)) >= 0.01) {
                    var lineCount = invRec.getLineCount({
                        sublistId: 'item'
                    });
        
                    invRec.setSublistValue({
                        sublistId: 'item',
                        fieldId: 'item',
                        value: 11627,
                        line: lineCount 
                    });
        
                    invRec.setSublistValue({
                        sublistId: 'item',
                        fieldId: 'amount',
                        value: diff.toFixed(2),
                        line: lineCount
                    });
                }
    
                invRec.save();
            }

            // Fix Tax Line based on amount remaining
          
            /*
            if (isFinalInvoice) {
                var invRec = record.load({
                    type: record.Type.INVOICE,
                    id: invRecId
                });
        
                var amountDue = invRec.getValue({fieldId:'amountremaining'});
                log.debug('final invoice:' + invRec.getValue({fieldId: 'tranid'}), 'amt due:' + amountDue);
        
                if(amountDue > 0.00 && amountDue <= 0.05) {
                    var lineCount = invRec.getLineCount({
                        sublistId: 'item'
                    });
        
                    invRec.setSublistValue({
                        sublistId: 'item',
                        fieldId: 'item',
                        value: 11627,
                        line: lineCount 
                    });
        
                    invRec.setSublistValue({
                        sublistId: 'item',
                        fieldId: 'amount',
                        value: amountDue,
                        line: lineCount
                    });
                }
    
                invRec.save();
            }
            */
          
          
          //Gift Card Distribution Starts here if GiftCardAmount > 0 in Sales Order

          if(GiftCardAmount != 0)
            {
              var invRec = record.load({
                  type: record.Type.INVOICE,
                  id: invRecId
              });

              var invTotal = invRec.getValue({fieldId:'total'});
              log.debug("invTotal",invTotal);
              var lineCount = invRec.getLineCount({
                  sublistId: 'item'
              });

              var ExistingInvcGiftAmount = CheckForExistingInvoiceGiftAmount(createdFrom)||0;

              if(ExistingInvcGiftAmount < GiftCardAmount)
              {
                var DifferenceAmount = GiftCardAmount - ExistingInvcGiftAmount;
                log.debug("DifferenceAmount",DifferenceAmount);

                if(DifferenceAmount <= invTotal)
                {

                  invRec.setSublistValue({
                      sublistId: 'item',
                      fieldId: 'item',
                      value: '428301',
                      line: lineCount
                  });
                  invRec.setSublistValue({
                      sublistId: 'item',
                      fieldId: 'amount',
                      value: DifferenceAmount * -1,
                      line: lineCount
                  });
                }
                else {
                  invRec.setSublistValue({
                      sublistId: 'item',
                      fieldId: 'item',
                      value: '428301',
                      line: lineCount
                  });
                  invRec.setSublistValue({
                      sublistId: 'item',
                      fieldId: 'amount',
                      value: invTotal * -1,
                      line: lineCount
                  });

                }
              }
            invRec.save();
            }

          //Gift Card Distribution Ends
        } catch (e) {
            log.error('e', e.message);
        }
    }

    // Helper
    function calcTranTotalWeight(tranRec) {
        var totalWeight = 0;

        var WEIGHT_MAPPING = {
            'oz': 0.035274,
            'lb': 0.0022046,
            'kg': 0.001,
            'g': 1
        }

        for (var k = 0; k < tranRec.getLineCount({sublistId: 'item'}); k++) {
            var itemWeight = tranRec.getSublistValue({sublistId: 'item', fieldId: 'custcol_hb_item_weight', line: k});
            var itemWeightUnit = tranRec.getSublistValue({sublistId: 'item', fieldId: 'custcol_hb_item_weight_unit', line: k});
            var quantity = tranRec.getSublistValue({sublistId: 'item', fieldId: 'quantity', line: k});

            if (itemWeight && itemWeightUnit) {
                totalWeight += parseFloat(itemWeight * quantity / WEIGHT_MAPPING[itemWeightUnit]);
            }
        }

        return totalWeight;
    }

    function getExistingInvoiceInfo(soId) {
        var billedShippingCost = 0, billedTotal = 0;

        var relatedTransactionSearch = search.create({
            type: 'invoice',
            columns: [
                'tranid',
                'shippingcost',
                'total'
            ],
            filters: [{
                name: 'createdfrom',
                operator: 'anyof',
                values: [soId]
            },
            {
                name: 'mainline',
                operator: 'is',
                values: ['T']
            }]
        });

        var resultSet = relatedTransactionSearch.run();

        var relatedTransactionSearchResults = resultSet.getRange({
            start: 0,
            end: 1000
        });

        if (relatedTransactionSearchResults && relatedTransactionSearchResults.length > 0) {
            log.debug('related invoice results', relatedTransactionSearchResults.length);  
            for (var k = 0; k < relatedTransactionSearchResults.length; k++) {
                // log.debug('prev invoice: ' + relatedTransactionSearchResults[k].getValue('tranid'), relatedTransactionSearchResults[k].getValue('shippingcost'));
                billedShippingCost += parseFloat(relatedTransactionSearchResults[k].getValue('shippingcost') || 0);
                billedTotal += parseFloat(relatedTransactionSearchResults[k].getValue('total') || 0);
            }
        }

        return {
            billedShippingCost: billedShippingCost,
            billedTotal: billedTotal
        };
    }
  
  function CheckForExistingInvoiceGiftAmount(createdFrom)
    {
      var invoiceSearchObj = search.create({type: "invoice",filters:[["type","anyof","CustInvc"], "AND", ["mainline","is","F"], "AND", ["createdfrom","anyof",createdFrom], "AND", ["item","anyof","428301"]],
      columns:[search.createColumn({name: "amount", label: "Amount"})]});

      var InvoiceresultSet = invoiceSearchObj.run();

      var InvoiceSearchResults = InvoiceresultSet.getRange({
          start: 0,
          end: 1000
      });

      var TotalGiftAmount = 0;
      for(var InvcCnt = 0; InvcCnt<InvoiceSearchResults.length; InvcCnt++)
      {
        var GiftAmount = InvoiceSearchResults[InvcCnt].getValue("amount");
        log.debug("GiftAmount",GiftAmount);

        GiftAmount = GiftAmount * -1;
        //Updated 10-2-2023 Chris Audie to fix rounding
        TotalGiftAmount += Math.round(parseInt(GiftAmount)* 100/100);
        //TotalGiftAmount += parseInt(GiftAmount);
      }//InvcCnt
      log.debug("InvoiceresultSet in Function ",TotalGiftAmount);
      return TotalGiftAmount;
    }
  function itemFulfillmentFromSalesOrderExists(salesOrderId) {
            var itemFulfillmentSearch = search.create({
                type: search.Type.ITEM_FULFILLMENT,
                filters: [
                    ['createdfrom', 'is', salesOrderId]
                ],
                columns: [
                    'internalid'
                ]
            });

            var resultCount = itemFulfillmentSearch.runPaged().count;
            return resultCount > 0;
        }

    return {
        afterSubmit: afterSubmitFF
    };
});
