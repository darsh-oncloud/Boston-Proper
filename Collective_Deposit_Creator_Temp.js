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

            var soData = search.lookupFields({
                type: search.Type.SALES_ORDER,
                id: salesOrderId,
                columns: ['entity', 'total', 'trandate']
            });

            var customerId = '';
            var soTotal = 0;
            var soTranDate = '';

            if (soData.entity && soData.entity.length > 0) {
                customerId = soData.entity[0].value;
            }

            if (soData.total) {
                soTotal = parseFloat(soData.total) || 0;
            }

            if (soData.trandate) {
                soTranDate = soData.trandate;
            }

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

            // customerDeposit.setValue({
            //     fieldId: 'account',
            //     value: 1035
            // });

            if (soTranDate) {
                customerDeposit.setValue({
                    fieldId: 'trandate',
                    value: format.parse({
                        value: soTranDate,
                        type: format.Type.DATE
                    })
                });
            }

            var depositId = customerDeposit.save({
                enableSourcing: true,
                ignoreMandatoryFields: false
            });

            log.audit({
                title: 'Customer Deposit Created',
                details: 'Sales Order ID: ' + salesOrderId + ' | Deposit ID: ' + depositId
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