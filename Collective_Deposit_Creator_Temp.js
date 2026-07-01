/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/search', 'N/record', 'N/log', 'N/format'], (search, record, log, format) => {

    var SALES_ORDER_SEARCH_ID = 'customsearch_bp_sales_order_deposite';

    function getInputData() {
        return search.load({
            id: SALES_ORDER_SEARCH_ID
        });
    }

    function map(context) {
        try {
            var result = JSON.parse(context.value);
            var salesOrderId = '';

            if (result.values['GROUP(internalid)']) {
                salesOrderId = result.values['GROUP(internalid)'].value;
            } else if (result.values.internalid && result.values.internalid.value) {
                salesOrderId = result.values.internalid.value;
            }

            if (salesOrderId) {
                context.write({
                    key: salesOrderId,
                    value: salesOrderId
                });
            }

        } catch (e) {
            log.error({
                title: 'Map Error',
                details: e
            });
        }
    }

    function reduce(context) {
        var salesOrderId = context.key;

        try {
            var depositExists = checkCustomerDeposit(salesOrderId);

            if (depositExists) {
                log.audit({
                    title: 'Skipped - Deposit Exists',
                    details: 'Sales Order ID: ' + salesOrderId
                });
                return;
            }

            var customerId = '';
            var soTotal = 0;
            var soTranDate = '';

            var salesOrder = record.load({
                type: record.Type.SALES_ORDER,
                id: salesOrderId,
                isDynamic: false
            });

            customerId = salesOrder.getValue({
                fieldId: 'entity'
            });

            soTotal = parseFloat(salesOrder.getValue({
                fieldId: 'total'
            })) || 0;

            soTranDate = salesOrder.getValue({
                fieldId: 'trandate'
            });

            log.audit({
                title: 'SO Loaded Total Used For Deposit',
                details: {
                    salesOrderId: salesOrderId,
                    customerId: customerId,
                    soTotal: soTotal,
                    soTranDate: soTranDate
                }
            });

            if (!customerId) {
                log.error({
                    title: 'Missing Customer',
                    details: 'No customer found for Sales Order ID: ' + salesOrderId
                });
                return;
            }

            var customerDeposit = record.create({
                type: record.Type.CUSTOMER_DEPOSIT,
                isDynamic: true
            });

            customerDeposit.setValue({
                fieldId: 'customer',
                value: customerId
            });

            customerDeposit.setValue({
                fieldId: 'salesorder',
                value: salesOrderId
            });

            customerDeposit.setValue({
                fieldId: 'payment',
                value: soTotal
            });

            customerDeposit.setValue({
                fieldId: 'undepfunds',
                value: 'T'
            });
          
            customerDeposit.setValue({
                fieldId: 'custbody_bp_collectives_order',
                value: true
            });

            if (soTranDate) {
                customerDeposit.setValue({
                    fieldId: 'trandate',
                    value: soTranDate
                });
            }

            var depositId = customerDeposit.save({
                enableSourcing: true,
                ignoreMandatoryFields: false
            });

            log.audit({
                title: 'Customer Deposit Created',
                details: 'Sales Order ID: ' + salesOrderId + ' | Deposit ID: ' + depositId + ' | Amount: ' + soTotal
            });

        } catch (e) {
            log.error({
                title: 'Reduce Error - Sales Order ID: ' + salesOrderId,
                details: e
            });
        }
    }

    function checkCustomerDeposit(salesOrderId) {
        var customerdepositSearchObj = search.create({
            type: "customerdeposit",
            settings: [{ name: "consolidationtype", value: "ACCTTYPE" }],
            filters: [
                ["type", "anyof", "CustDep"],
                "AND",
                ["mainline", "is", "T"],
                "AND",
                ["salesorder", "anyof", salesOrderId]
            ],
            columns: [
                search.createColumn({
                    name: "internalid",
                    label: "Internal ID"
                })
            ]
        });

        var results = customerdepositSearchObj.run().getRange({
            start: 0,
            end: 1
        });

        return results && results.length > 0;
    }

    function summarize(summary) {
        if (summary.inputSummary.error) {
            log.error({
                title: 'Input Error',
                details: summary.inputSummary.error
            });
        }

        summary.mapSummary.errors.iterator().each(function(key, error) {
            log.error({
                title: 'Map Error for key: ' + key,
                details: error
            });
            return true;
        });

        summary.reduceSummary.errors.iterator().each(function(key, error) {
            log.error({
                title: 'Reduce Error for key: ' + key,
                details: error
            });
            return true;
        });
    }

    return {
        getInputData: getInputData,
        map: map,
        reduce: reduce,
        summarize: summarize
    };
});