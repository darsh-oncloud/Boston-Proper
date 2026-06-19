function customizeGlImpact(transactionRecord, standardLines, customLines, book) {
    try {

        // Only run for your specific deposits
        var isCollective = transactionRecord.getFieldValue('custbody_bp_collectives_order');

        if (isCollective != 'T') {
            return;
        }

        // Get Sales Order from Customer Deposit
        var salesOrderId = transactionRecord.getFieldValue('salesorder');

        if (!salesOrderId) {
            nlapiLogExecution('AUDIT', 'Custom GL Skipped', 'No Sales Order found on transaction');
            return;
        }

        // Instead of payment amount, get collective item amount from SO
        var amount = getCollectiveItemAmount(salesOrderId);

        var entityId = transactionRecord.getFieldValue('customer');

        if (!amount || parseFloat(amount) <= 0) {
            return;
        }

        amount = parseFloat(amount);

        // Account IDs
        var COLLECTIVE_ACCOUNT = 1035; // 1135 Collective Undeposited Funds
        var UNDEPOSITED_FUNDS = 5;     // 1140 Undeposited Funds

        // Debit → Custom account (1135)
        var debitLine = customLines.addNewLine();
        debitLine.setDebitAmount(amount);
        debitLine.setAccountId(COLLECTIVE_ACCOUNT);
        debitLine.setMemo('Collective Deposit Adjustment');

        if (entityId) {
            debitLine.setEntityId(parseInt(entityId, 10));
        }

        // Credit → Standard Undeposited Funds (1140)
        var creditLine = customLines.addNewLine();
        creditLine.setCreditAmount(amount);
        creditLine.setAccountId(UNDEPOSITED_FUNDS);
        creditLine.setMemo('Reverse Undeposited Funds');

        if (entityId) {
            creditLine.setEntityId(parseInt(entityId, 10));
        }

        nlapiLogExecution(
            'AUDIT',
            'Custom GL Applied',
            'Collective Deposit GL Updated. SO: ' + salesOrderId + ', Amount: ' + amount
        );

    } catch (e) {
        nlapiLogExecution('ERROR', 'Custom GL Error', e.toString());
    }
}


function getCollectiveItemAmount(salesOrderId) {
    var totalAmount = 0;

    var filters = [
        new nlobjSearchFilter('type', null, 'anyof', 'SalesOrd'),
        new nlobjSearchFilter('mainline', null, 'is', 'F'),
        new nlobjSearchFilter('taxline', null, 'is', 'F'),
        new nlobjSearchFilter('cogs', null, 'is', 'F'),
        new nlobjSearchFilter('shipping', null, 'is', 'F'),
        new nlobjSearchFilter('internalid', null, 'anyof', salesOrderId),
        new nlobjSearchFilter('custitem_bp_collective_flag', 'item', 'is', 'T')
    ];

    var columns = [
        new nlobjSearchColumn('item'),
        new nlobjSearchColumn('amount')
    ];

    var results = nlapiSearchRecord('salesorder', null, filters, columns);

    if (!results || results.length === 0) {
        nlapiLogExecution('AUDIT', 'No Collective Items Found', 'Sales Order ID: ' + salesOrderId);
        return 0;
    }

    for (var i = 0; i < results.length; i++) {
        var lineAmount = results[i].getValue('amount');

        if (lineAmount) {
            lineAmount = String(lineAmount).replace(/,/g, '');
            totalAmount += parseFloat(lineAmount) || 0;
        }
    }

    nlapiLogExecution(
        'AUDIT',
        'Collective Item Amount Calculated',
        'Sales Order ID: ' + salesOrderId + ', Total Amount: ' + totalAmount
    );

    return totalAmount;
}