function customizeGlImpact(transactionRecord, standardLines, customLines, book) {
    try {

        // Only run for your specific deposits
        var isCollective = transactionRecord.getFieldValue('custbody_bp_collectives_order');

        if (isCollective != 'T') {
            return;
        }

        var amount = transactionRecord.getFieldValue('payment');
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

        nlapiLogExecution('AUDIT', 'Custom GL Applied', 'Collective Deposit GL Updated');

    } catch (e) {
        nlapiLogExecution('ERROR', 'Custom GL Error', e.toString());
    }
}
