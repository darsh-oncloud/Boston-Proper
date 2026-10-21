/**
 * @NApiVersion 2.0
 * @NScriptType MapReduceScript
 */
define(['N/search', 'N/record'], function(search, record) {

    function getInputData() {
        return search.create({
            type: 'salesorder', // Change to your record type
            filters: [
                ['item.custitem_bp_collective_flag', 'is', 'T'],
                'AND',
                ['type', 'anyof', 'SalesOrd'],
                'AND',
                ['status', 'anyof', 'SalesOrd:B', 'SalesOrd:D', 'SalesOrd:E', 'SalesOrd:F'],
                'AND',
                ['custbody_bp_collectives_order', 'is', 'F'],
            ],
            columns: ['internalid']
        });
    }

    function map(context) {
        var result = JSON.parse(context.value);
        var internalId = result.id;

        context.write({
            key: internalId,
            value: internalId
        });
    }

    function reduce(context) {
        var internalId = context.key;

        try {
            var rec = record.load({
                type: 'salesorder', // Change to your record type
                id: internalId
            });

            rec.setValue({
                fieldId: 'custbody_bp_collectives_order', // Change to your checkbox field
                value: true
            });

            rec.save();
        } catch (e) {
            log.error({
                title: 'Error updating record ID ' + internalId,
                details: e
            });
        }
    }

    return {
        getInputData: getInputData,
        map: map,
        reduce: reduce
    };
});
