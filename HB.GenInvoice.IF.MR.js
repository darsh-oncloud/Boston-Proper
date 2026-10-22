/**
 * @NApiVersion 2.x
 * @NScriptType MapReduceScript
 * @NModuleScope SameAccount
 */

define(['N/search', 'N/record', 'N/log', 'N/error', 'N/config'],
/**
 * @param {file} file
 * @param {search} search
 */
function(search, record, log, error, config) {

    /**
     * Marks the beginning of the Map/Reduce process and generates input data.
     *
     * @typedef {Object} ObjectRef
     * @property {number} id - Internal ID of the record instance
     * @property {string} type - Record type id
     *
     * @return {Array|Object|Search|RecordRef} inputSummary
     * @since 2015.1
     */
    
    function getInputData() {
        var pendingIFSearch = search.load({id: 'customsearch_hb_if_to_bill'}); // 1872
        var results = getAllResults(pendingIFSearch);

        var inputArr = [];

        for (var i = 0; i < results.length; i++) {
            inputArr.push({
                id: results[i].id,
                docNum: results[i].getValue('tranid')
            });

            // if (i > 3)
            //     break;
        }

        log.debug({
            title: 'item fulfillment arr',
            details: JSON.stringify(inputArr)
        });

        return inputArr;
    }

    /**
     * Executes when the map entry point is triggered and applies to each
     * key/value pair.
     * 
     * @param {MapSummary}
     *            context - Data collection containing the key/value pairs to
     *            process through the map stage
     * @since 2015.1
     */
    function map(context) {
        context.write({ key: JSON.parse(context.value).id, value: JSON.parse(context.value) });
    }

    /**
     * Executes when the reduce entry point is triggered and applies to each group.
     *
     * @param {ReduceSummary} context - Data collection containing the groups to process through the reduce stage
     * @since 2015.1
     */
    function reduce(context) {
        try {
            log.debug('reduce: ' + context.key, context.values[0]);

            var ffInfo = JSON.parse(context.values[0]);

            // Load item shipment and order
            var ffRec = record.load({
                type: 'itemfulfillment',
                id: context.key
            });
            log.debug('start', ffRec.getValue({fieldId: 'tranid'}));

            var createdFrom = ffRec.getValue({fieldId: 'createdfrom'});
            
            // Generate an Invoice
            var isFinalInvoice = true;

            var soRec = record.load({
                type: record.Type.SALES_ORDER,
                id: createdFrom,
                isDynamic: true
            });

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
                log.debug('line start: ' + isNonInvt, itemSku);

                if (isNonInvt == 'F') {
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
                        invRec.removeLine({sublistId: 'item', line: i});

                        isFinalInvoice = false;
                        log.debug('item sku - not final', itemSku);
                    }
                }
            }

            invRec.setValue({fieldId: 'location', value: ffRec.getSublistValue({sublistId: 'item', fieldId: 'location', line: 0})});

            var existingInvoiceData = getExistingInvoiceInfo(createdFrom);

            var createdFrom = ffRec.getValue({fieldId: 'createdfrom'});
            var createdFromRecType = search.lookupFields({
                type: 'transaction',
                id: createdFrom,
                columns: ['recordtype', 'shippingcost', 'total']
            });

            if (createdFromRecType.shippingcost > 0) {
                if (isFinalInvoice) {
                    var billedShippingCost = existingInvoiceData.billedShippingCost;
                    log.debug('billedShippingCost', billedShippingCost);

                    invRec.setValue({fieldId: 'shippingcost', value: createdFromRecType.shippingcost - billedShippingCost});
                    log.debug('finalinvoice shipcost: ' + createdFromRecType.shippingcost, createdFromRecType.shippingcost - billedShippingCost);
                } else {
                    var soTotalWeight = calcTranTotalWeight(soRec);

                    if (soTotalWeight > 0) {
                        var ffTotalWeight = calcTranTotalWeight(ffRec);

                        var invShippingCost = createdFromRecType.shippingcost / soTotalWeight * ffTotalWeight;
                        invRec.setValue({fieldId: 'shippingcost', value: invShippingCost.toFixed(2)});
                        log.debug('invShippingCost: ' + invShippingCost, 'so-' + soTotalWeight + 'g;ff-' + ffTotalWeight + 'g');
                    } else {
                        log.debug('soTotalWeight', soTotalWeight);
                        invRec.setValue({fieldId: 'shippingcost', value: createdFromRecType.shippingcost});
                    }   
                }
            }

            var invRecId = invRec.save();
            log.debug('invRec generated', invRecId);

            // Update Shipment
            // record.submitFields({
            //     type: 'itemfulfillment',
            //     id: context.key,
            //     values: {
            //         'custbody_hb_related_invoice': invRecId
            //     }
            // });
            log.debug('ff updated: ' + context.key, invRecId);

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
            
            context.write({
                key: ffInfo,
                value: 'success'
            });
        } catch (e) {
            log.error('e: ' + context.key, JSON.stringify(e));
        } // end: try catch
    }

    /**
     * Executes when the summarize entry point is triggered and applies to the result set.
     *
     * @param {Summary} summary - Holds statistics regarding the execution of a map/reduce script
     * @since 2015.1
     */
    function summarize(summary) {
    }

    // Helpers
    function getAllResults(searchObj) {
        var results = [];
        var resultSet = searchObj.run();
        if (resultSet) {
            var tempResults = resultSet.getRange({
                start: results.length,
                end: results.length + 1000
            });
            while (tempResults && tempResults.length > 0) {
                results = results.concat(tempResults);
                tempResults = resultSet.getRange({
                    start: results.length,
                    end: results.length + 1000
                });
            }
        }
        return results;
    }

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

    return {
        getInputData: getInputData,
        map: map,
        reduce: reduce,
        summarize: summarize
    };
    
});
 