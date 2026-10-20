/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/log', 'N/search'], (log, search) => {
  const beforeSubmit = (context) => {
    if (![context.UserEventType.CREATE, context.UserEventType.EDIT, context.UserEventType.XEDIT].includes(context.type)) {
      return;
    }

    const itemRecord = context.newRecord;
    const newGoLiveDate = String(itemRecord.getValue({ fieldId: 'custitembp_golivedate' }) || '').trim();

    if (!newGoLiveDate || !/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(newGoLiveDate)) {
      return;
    }

    const dateParts = newGoLiveDate.split('/').map(Number);
    const validDate = new Date(dateParts[2], dateParts[0] - 1, dateParts[1]);

    if (
      validDate.getFullYear() !== dateParts[2] ||
      validDate.getMonth() !== dateParts[0] - 1 ||
      validDate.getDate() !== dateParts[1]
    ) {
      return;
    }

    if (context.type !== context.UserEventType.CREATE) {
      const oldGoLiveDate = String(context.oldRecord.getValue({ fieldId: 'custitembp_golivedate' }) || '').trim();

      if (oldGoLiveDate === newGoLiveDate) {
        return;
      }
    }

    const fiscalCalendarSearch = search.create({
      type: 'customrecord2478',
      filters: [
        ['isinactive', 'is', 'F'],
        'AND',
        ['custrecord161', 'onorbefore', newGoLiveDate],
        'AND',
        ['custrecord162', 'onorafter', newGoLiveDate]
      ],
      columns: [
        search.createColumn({
          name: 'internalid',
          sort: search.Sort.DESC,
          label: 'Internal ID'
        }),
        search.createColumn({
          name: 'custrecord160',
          label: 'custitem_bp_debut_month'
        }),
        search.createColumn({
          name: 'custrecord158',
          label: 'custitem_bp_debut_year'
        })
      ]
    });

    // Only use the most recent matching fiscal calendar row.
    const results = fiscalCalendarSearch.run().getRange({
      start: 0,
      end: 1
    });
    const fiscalResult = results && results.length ? results[0] : null;
    log.debug('fiscalResult', fiscalResult)

    if (!fiscalResult) {
      log.debug({
        title: 'No fiscal calendar result found',
        details: {
          itemId: itemRecord.id,
          goLiveDate: newGoLiveDate
        }
      });
      return;
    }

    fiscalResult.columns.forEach((column) => {
      const targetFieldId = column.label;

      if (targetFieldId && targetFieldId !== 'Internal ID') {
        itemRecord.setValue({
          fieldId: targetFieldId,
          value: fiscalResult.getValue(column)
        });
      }
    });
  };

  return {
    beforeSubmit
  };
});
