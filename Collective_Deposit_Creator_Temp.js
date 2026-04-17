/**
 * @NApiVersion 2.x
 * @NScriptType MapReduceScript
 */
define(['N/record', 'N/log'], function(record, log) {

    // List of sales order internal IDs
    /*var salesOrderIds = [
        25333038
        // Add more internal IDs as needed
    ];*/

    var salesOrderIds = [
      43354214
        // Add more internal IDs as needed
    ];

    function getInputData() {
        return salesOrderIds;
    }

    function map(context) {
        var salesOrderId = context.value;
        context.write({
            key: salesOrderId,
            value: salesOrderId
        });
    }

    function reduce(context) {
        var salesOrderId = context.key;

        try {
            var salesOrder = record.load({
                type: record.Type.SALES_ORDER,
                id: salesOrderId
            });

            var customerDeposit = record.create({
                type: record.Type.CUSTOMER_DEPOSIT,
                isDynamic: true
            });

            customerDeposit.setValue({
                fieldId: 'customer',
                value: salesOrder.getValue('entity')
            });

            customerDeposit.setValue({
                fieldId: 'salesorder',
                value: salesOrderId
            });

            customerDeposit.setValue({
                fieldId: 'payment',
                value: salesOrder.getValue('total') // Assuming total amount as payment
            });

            customerDeposit.setValue({
                fieldId: 'undepfunds',
                value: 'T'
            });

            var depositId = customerDeposit.save();
            log.audit({
                title: 'Customer Deposit Created',
                details: 'Customer Deposit ID: ' + depositId + ' for Sales Order ID: ' + salesOrderId
            });
        } catch (e) {
            log.error({
                title: 'Error processing Sales Order ID: ' + salesOrderId,
                details: e
            });
        }
    }

    function summarize(summary) {
        summary.output.iterator().each(function(key, value) {
            log.audit({
                title: 'Processed Sales Order',
                details: 'Sales Order ID: ' + key
            });
            return true;
        });

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
