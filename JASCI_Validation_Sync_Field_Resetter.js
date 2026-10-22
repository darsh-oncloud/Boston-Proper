/**
 *@NApiVersion 2.0
 *@NScriptType UserEventScript
 */
define(
    [
        
    ],
    function () {
        function beforeSubmit(context) {
            try{
				log.debug("Changing status to Ready to Download");
               // reset fields
                var newRecord = context.newRecord;
                newRecord.setValue({
                    fieldId: "custbody_jasci_status",
                    value: 1
                });
            }catch(e){
                log.error("Error: ", e);
                return true;
            }
        }
        return {
            beforeSubmit: beforeSubmit
        };
});