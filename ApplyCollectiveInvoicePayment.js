/**
 * @NApiVersion 2.x
 * @NScriptType MapReduceScript
 */
define(['N/search', 'N/record', 'N/log'], function(search, record, log) {

    function getInputData() {
        return search.create({
            type: search.Type.INVOICE,
            filters: [
                ['type', 'anyof', 'CustInvc'],
                'AND',
                ['createdfrom.custbody_bp_collectives_order', 'is', 'T'],
                'AND',
                ['status', 'anyof', 'CustInvc:A'],
                'AND',
                ['trandate', 'onorafter', '2/2/2025'],
                'AND',
                ['item.custitem_bp_collective_flag', 'is', 'T'],
            ],
            columns: [search.createColumn({ name: 'internalid', summary: 'GROUP' })]
        });
    }

    function map(context) {
        var result = JSON.parse(context.value);
        var invoiceId = result.values["GROUP(internalid)"].value;

        try {
            log.debug('Creating payment for Invoice', invoiceId);

        // Load the invoice to get the transaction date
        var invoice = record.load({
            type: record.Type.INVOICE,
            id: invoiceId
        });

        var invoiceDate = invoice.getValue({ fieldId: 'trandate' });

        // Transform the invoice into a customer payment
        var payment = record.transform({
            fromType: record.Type.INVOICE,
            fromId: invoiceId,
            toType: record.Type.CUSTOMER_PAYMENT,
            isDynamic: true
        });

        payment.setValue({
            fieldId: 'account',
            value: 1040 //Collectives Expense
        });

        // Set payment date to match invoice date
        payment.setValue({
            fieldId: 'trandate',
            value: invoiceDate
        });

        var paymentId = payment.save();
        log.audit('Customer Payment Created', 'Invoice ID:' + invoiceId, 'Payment ID:' + paymentId);

        } catch (e) {
            log.error({
                title: 'Error on Invoice:' + invoiceId,
                details: e.message
            });
        }
    }

    return {
        getInputData: getInputData,
        map: map
    };
});
