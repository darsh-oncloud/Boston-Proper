/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/search', 'N/record', 'N/format'], (search, record, format) => {

    const SALES_ORDER_SEARCH_ID = 'customsearch_bp_sales_order_deposite_2';
    const COLLECTIVES_FIELD = 'custbody_bp_collectives_order';

    function getInputData() {
        return search.load({ id: SALES_ORDER_SEARCH_ID });
    }

    function map(context) {
        try {
            const result = JSON.parse(context.value);
            const groupedId = result.values['GROUP(internalid)'];
            const regularId = result.values.internalid;
            const salesOrderId = getValue(groupedId || regularId);

            if (salesOrderId) context.write({ key: String(salesOrderId), value: '1' });
            else log.error({ title: 'Missing Sales Order ID', details: context.value });

        } catch (e) {
            log.error({ title: 'Map Error', details: getError(e) });
        }
    }

    function reduce(context) {
        const salesOrderId = context.key;

        try {
            const soData = search.lookupFields({
                type: search.Type.SALES_ORDER,
                id: salesOrderId,
                columns: ['entity', 'total', 'trandate']
            });

            const customerId = getSelectValue(soData.entity);
            const soTotal = toNumber(soData.total);
            const soTranDate = soData.trandate || '';

            log.audit({ title: '1. Sales Order Lookup', details: JSON.stringify({ salesOrderId, customerId, soTotal, soTranDate }) });

            if (!customerId) {
                log.error({ title: 'Missing Customer', details: 'Sales Order ID: ' + salesOrderId });
                return;
            }

            const deposit = findCustomerDeposit(salesOrderId);

            if (!deposit) {
                log.audit({ title: '2. Deposit Search', details: JSON.stringify({ salesOrderId, depositFound: false }) });
                createCustomerDeposit(salesOrderId, customerId, soTotal, soTranDate);
                return;
            }

            const paymentMatches = amountsMatch(soTotal, deposit.payment);
            const paymentNeedsUpdate = !paymentMatches;
            const checkboxNeedsUpdate = !deposit.collectivesOrder;

            log.audit({ title: '2. Deposit Search', details: JSON.stringify({ salesOrderId, depositFound: true, depositId: deposit.id, depositPayment: deposit.payment, collectivesOrder: deposit.collectivesOrder }) });
            log.audit({ title: '3. Comparison', details: JSON.stringify({ salesOrderId, depositId: deposit.id, soTotal, depositPayment: deposit.payment, paymentMatches, paymentNeedsUpdate, checkboxNeedsUpdate }) });

            if (!paymentNeedsUpdate && !checkboxNeedsUpdate) {
                log.audit({ title: '4. No Update Required', details: JSON.stringify({ salesOrderId, depositId: deposit.id }) });
                return;
            }

            if (!paymentNeedsUpdate && checkboxNeedsUpdate) {
                record.submitFields({
                    type: record.Type.CUSTOMER_DEPOSIT,
                    id: deposit.id,
                    values: { [COLLECTIVES_FIELD]: true },
                    options: { enableSourcing: false, ignoreMandatoryFields: true }
                });

                log.audit({ title: '4. Deposit Checkbox Updated', details: JSON.stringify({ salesOrderId, depositId: deposit.id, collectivesOrder: true, recordLoaded: false }) });
                return;
            }

            const depositRecord = record.load({
                type: record.Type.CUSTOMER_DEPOSIT,
                id: deposit.id,
                isDynamic: false
            });

            depositRecord.setValue({ fieldId: 'payment', value: soTotal });
            if (checkboxNeedsUpdate) depositRecord.setValue({ fieldId: COLLECTIVES_FIELD, value: true });

            const updatedDepositId = depositRecord.save({
                enableSourcing: true,
                ignoreMandatoryFields: false
            });

            log.audit({ title: '4. Customer Deposit Updated', details: JSON.stringify({ salesOrderId, depositId: updatedDepositId, oldPayment: deposit.payment, newPayment: soTotal, collectivesOrder: true, recordLoaded: true }) });

        } catch (e) {
            log.error({ title: 'Reduce Error - Sales Order ID: ' + salesOrderId, details: getError(e) });
        }
    }

    function findCustomerDeposit(salesOrderId) {
        const results = search.create({
            type: search.Type.CUSTOMER_DEPOSIT,
            filters: [
                ['mainline', 'is', 'T'],
                'AND',
                ['salesorder', 'anyof', salesOrderId]
            ],
            columns: [
                search.createColumn({ name: 'internalid', sort: search.Sort.ASC })
            ]
        }).run().getRange({ start: 0, end: 1 });

        if (!results || !results.length) return null;

        const depositId = results[0].getValue({ name: 'internalid' });

        const depositData = search.lookupFields({
            type: search.Type.CUSTOMER_DEPOSIT,
            id: depositId,
            columns: ['payment', COLLECTIVES_FIELD]
        });

        return {
            id: depositId,
            payment: toNumber(depositData.payment),
            collectivesOrder: isChecked(depositData[COLLECTIVES_FIELD])
        };
    }

    function createCustomerDeposit(salesOrderId, customerId, soTotal, soTranDate) {
        const deposit = record.create({
            type: record.Type.CUSTOMER_DEPOSIT,
            isDynamic: false
        });

        deposit.setValue({ fieldId: 'customer', value: customerId });
        deposit.setValue({ fieldId: 'salesorder', value: salesOrderId });
        deposit.setValue({ fieldId: 'payment', value: soTotal });
        deposit.setValue({ fieldId: 'undepfunds', value: true });
        deposit.setValue({ fieldId: COLLECTIVES_FIELD, value: true });

        if (soTranDate) {
            deposit.setValue({
                fieldId: 'trandate',
                value: format.parse({ value: soTranDate, type: format.Type.DATE })
            });
        }

        const depositId = deposit.save({
            enableSourcing: true,
            ignoreMandatoryFields: false
        });

        log.audit({ title: '3. Customer Deposit Created', details: JSON.stringify({ salesOrderId, depositId, customerId, payment: soTotal, collectivesOrder: true }) });
    }

    function getValue(value) {
        if (value && typeof value === 'object' && value.value !== undefined) return value.value;
        return value || '';
    }

    function getSelectValue(value) {
        if (Array.isArray(value) && value.length) return value[0].value || '';
        if (value && typeof value === 'object') return value.value || '';
        return value || '';
    }

    function toNumber(value) {
        const number = parseFloat(String(value || 0).replace(/,/g, ''));
        return Number.isFinite(number) ? number : 0;
    }

    function isChecked(value) {
        return value === true || value === 'T' || String(value).toLowerCase() === 'true';
    }

    function amountsMatch(first, second) {
        return Math.round(toNumber(first) * 100) === Math.round(toNumber(second) * 100);
    }

    function getError(error) {
        return JSON.stringify({ name: error.name || '', message: error.message || String(error), stack: error.stack || '' });
    }

    function summarize(summary) {
        if (summary.inputSummary.error) log.error({ title: 'Input Error', details: summary.inputSummary.error });

        summary.mapSummary.errors.iterator().each((key, error) => {
            log.error({ title: 'Map Error - Key: ' + key, details: error });
            return true;
        });

        summary.reduceSummary.errors.iterator().each((key, error) => {
            log.error({ title: 'Reduce Error - Sales Order: ' + key, details: error });
            return true;
        });

        log.audit({ title: 'Map/Reduce Summary', details: JSON.stringify({ usage: summary.usage, concurrency: summary.concurrency, yields: summary.yields, seconds: summary.seconds }) });
    }

    return { getInputData, map, reduce, summarize };
});