/**
 * @NApiVersion 2.x
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 */

define(['N/record', 'N/log', 'N/search'],

function(record, log, search) {

    function afterSubmit_ShopifyOrder(scriptContext) {
        try {
            var newRec = scriptContext.newRecord;

            // Check if Shopify
            if (!newRec.getValue({fieldId: 'custbody_celigo_etail_order_id'}) || !newRec.getValue({fieldId: 'custbody_hb_org_order_lines'})) {
                log.audit('skip - non etail order or empty org lines', newRec.getValue({fieldId: 'tranid'}));
                return;
            } else {
                log.audit('start - etail order', newRec.getValue({fieldId: 'tranid'}));
            }

            // Get Current Line Arr
            var curLines = {};
            for (var i = 0; i < newRec.getLineCount({sublistId: 'item'}); i++) {
                var lineObj = {
                    EtailOrdLineID: newRec.getSublistValue({sublistId: 'item', fieldId: 'custcol_celigo_etail_order_line_id', line: i}),
                    SKU: newRec.getSublistText({sublistId: 'item', fieldId: 'item', line: i}),
                    Qty: newRec.getSublistValue({sublistId: 'item', fieldId: 'quantity', line: i})
                };

                curLines[lineObj.EtailOrdLineID] = lineObj;
            }
            log.audit('cur lines', JSON.stringify(curLines));

            // Get Org Lines
            var orgLines = JSON.parse(newRec.getValue({fieldId: 'custbody_hb_org_order_lines'}));
            log.audit('orgLines', newRec.getValue({fieldId: 'custbody_hb_org_order_lines'}));

            // Detect New/Modified Lines
            var linesToUpdate = {};
            orgLines.forEach(function (orgLine) {
                if (curLines[orgLine.EtailOrdLineID] && curLines[orgLine.EtailOrdLineID].Qty != orgLine.Qty) {
                    // Modified By Update
                    linesToUpdate[orgLine.EtailOrdLineID] = 1;
                } else if (!curLines[orgLine.EtailOrdLineID]) {
                    // Deleted
                    linesToUpdate[orgLine.EtailOrdLineID] = 2;
                }
            });
            log.audit('linesToUpdate', JSON.stringify(linesToUpdate));

            if (Object.keys(linesToUpdate).length > 0) {
                var soRec = record.load({
                    type: 'salesorder',
                    id: newRec.id,
                    isDynamic: true
                });

                for (var etailOrdLineId in linesToUpdate) {
                    if (linesToUpdate[etailOrdLineId] == 1) {
                        var lineIndex = soRec.findSublistLineWithValue({
                            sublistId: 'item',
                            fieldId: 'custcol_celigo_etail_order_line_id',
                            value: etailOrdLineId
                        });

                        soRec.selectLine({
                            sublistId: 'item',
                            line: lineIndex
                        });

                        soRec.setCurrentSublistValue({
                            sublistId: 'item',
                            fieldId: 'custcol_hb_modified_by_update',
                            value: true
                        });

                        soRec.commitLine({
                            sublistId: 'item'
                        });
                    } else {
                        soRec.selectNewLine({
                            sublistId: 'item'
                        });

                        var orgLinesFiltered = orgLines.filter(function (element) {
                            if (String(element.EtailOrdLineID) == String(etailOrdLineId))
                                return true;
                            return false;
                        });
                        
                        var itemInternalId = searchItem(orgLinesFiltered[0].SKU);

                        if (!itemInternalId) {
                            log.error('item not found', orgLinesFiltered[0].SKU);
                            continue;
                        }

                        soRec.setCurrentSublistValue({
                            sublistId: 'item',
                            fieldId: 'item',
                            value: itemInternalId
                        });

                        soRec.setCurrentSublistValue({
                            sublistId: 'item',
                            fieldId: 'quantity',
                            value: orgLinesFiltered[0].Qty
                        });

                        soRec.setCurrentSublistValue({
                            sublistId: 'item',
                            fieldId: 'isclosed',
                            value: true
                        });

                        soRec.setCurrentSublistValue({
                            sublistId: 'item',
                            fieldId: 'custcol_celigo_etail_order_line_id',
                            value: etailOrdLineId
                        });

                        soRec.commitLine({
                            sublistId: 'item'
                        });
                    }
                }

                var soRecId = soRec.save();
                log.audit('soRecId', soRecId);
            }
        } catch (e) {
            log.error('e', e.message);
        }
    }

    // Helper
    function searchItem(sku) {
        var skuSearch = search.create({
            type: 'item',
            columns: [
                'itemid', 
                'displayname'
            ],
            filters: [
                {
                    name: 'isinactive',
                    operator: 'is',
                    values: ['F']
                },
                {
                    name: 'itemid',
                    operator: 'is',
                    values: sku
                }
            ]
        });

        var skuSearchResultSet = skuSearch.run();
    
        var results = skuSearchResultSet.getRange({
            start: 0,
            end: 1000
        });
        
        var response = [];

        if (results && results.length > 0) {
            for (var i = 0; i < results.length; i++) {
                response.push({
                    internalid: results[i].id,
                    sku: results[i].getValue({name: 'itemid'}),
                    name: results[i].getValue({name: 'displayname'})
                });
            }

            return response[0].internalid;
        }

        return null;
    }
    
    return {
        afterSubmit: afterSubmit_ShopifyOrder
    };
});
 