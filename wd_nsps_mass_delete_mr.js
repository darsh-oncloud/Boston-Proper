/**
 * Copyright (c) 1998-2018 NetSuite, Inc.
 * 2955 Campus Drive, Suite 100, San Mateo, CA, USA 94403-2511
 * All Rights Reserved
 *
 * This software is the confidential and proprietary information of NetSuite, Inc. ("Confidential Information").
 * You shall not disclose such Confidential Information and shall use it only in accordance with the terms of the license
 * you entered into with NetSuite
 */

/**
 * @NApiVersion 2.x
 * @NScriptType MapReduceScript
 * @NModuleScope Public
 *
 * Script Description
 * Map Reduce Script that uses a Saved Search (stored as a Script Parameter), loads the saved search, iterates through
 * each result in the saved search and deletes the record/transaction. This is dependent on the "Delete" Script
 * Parameter boolean value. If errors are encountered, the Summarize function captures all errors and logs them
 * in the Script Record Execution Log.
 *
 * Version      Date            Author          Remarks
 * 1.0          17 Jul 2018     Daniel Lapp     Initial Version
 * 1.1          13 Dec 2018     Daniel Lapp     Added file.delete functionality and Intercompany Transactions Error logging
 */

define([
    'N/runtime',
    'N/search',
    'N/record',
    'N/task',
    'N/file'
],

    function (runtime, search, record, task, file) {

        function logError(error, stage) {
            var stLogTitle = 'ns_mr_mass_delete: handleErrorAndSendNotification';
            log.error({
                title: stLogTitle,
                details: 'Stage: ' + stage + ' | Error: ' + error
            });
        }

        function handleErrorIfAny(summary) {
            var inputSummary = summary.inputSummary;
            var mapSummary = summary.mapSummary;
            var reduceSummary = summary.reduceSummary;

            if (inputSummary.error) {
                logError('getInputData', inputSummary.error);
            }

            handleErrorInStage('map', mapSummary);
            handleErrorInStage('reduce', reduceSummary);
        }

        function handleErrorInStage(stage, summary) {
            var errorMsg = [];
            summary.errors.iterator().each(function (key, value) {
                var msg = 'Error was: ' + JSON.parse(value).message + '\n';
                errorMsg.push(msg);
                return true;
            });
            if (errorMsg.length > 0) {
                var error = error.create({
                    name: 'ERROR_IN_STAGE',
                    message: JSON.stringify(errorMsg)
                });
                logError(error, stage);
            }
        }

        /**
         * [isEmpty: Function that checks if string/object/array value is empty]
         * @param  {String/Object/Array} stValue  [Parameter is required to validate if empty]
         * @return {Boolean} [Returns true if string value is empty, otherwise, returns false]
         */
        function isEmpty(stValue) {
            // Check if string is empty
            return ((stValue === '' ||
                // Check if string is null
                stValue == null ||
                // Check if string is undefined
                stValue === undefined) ||
                // Check if Array is empty
                (stValue.constructor === Array && stValue.length === 0) ||
                // Check if Object does not contain key/values
                (stValue.constructor === Object && (function (v) {
                    for (var k in v) {
                        // If key/value is found, return false
                        return false;
                    }
                    // Otherwise, return true
                    return true;
                })(stValue))
            );
        }

        /**
         * [convertToBoolean: Function that converts a String Value of 'T' to true or 'F' to false boolean value]
         * @param  {String} stValue [Parameter is required to convert String Value to Boolean]
         * @return {Boolean} [Returns true if String Value = 'T' or True, false if String Value = 'F' or False]
         */
        function convertToBoolean(stValue) {
            if (stValue || stValue === 'T') {
                return true;
            } else if (!stValue || stValue === 'F') {
                return false;
            } else {
                return false;
            }
        }

        /**
         * Marks the beginning of the script’s execution. The purpose of the input stage is to generate the
         * input data. Executes when the getInputData entry point is triggered. This entry point is required.
         * @returns {Array | Object | search.Search | inputContext.ObjectRef | file.File Object}
         */
        function getInputData() {
            var stLogTitle = 'ns_mr_mass_delete: getInputData';
            var currentScript = runtime.getCurrentScript();

            // Define Script Parameter Field ID's
            var strSavedSearchParamId = 'custscript_ns_md_saved_search_id1';
            var strDeleteParamId = 'custscript_ns_md_delete1';

            log.audit({
                title: stLogTitle,
                details: '=== START: ' + new Date().getTime() + ' ==='
            });

            // Get Saved Search ID from Script Parameter
            var strSavedSearchId = currentScript.getParameter({ name: strSavedSearchParamId });
            var booDelete = convertToBoolean(currentScript.getParameter({ name: strDeleteParamId }));

            log.audit({
                title: stLogTitle,
                details: 'Saved Search ID: ' + strSavedSearchId + ' | Delete: ' + booDelete
            });

            // If Delete Script Parameter is set to true then load the Saved Search, else, exit script
            if (booDelete) {
                // Use Saved Search Id and Result Count values from Script Parameter and Load Search
                var objSearch = search.load({ id: strSavedSearchId });
                // log.debug({
                //     title: stLogTitle,
                //     details: 'Search Result Object: ' + JSON.stringify(objSearchResults)
                // });
                return objSearch.run().getRange({ start: 0, end: 1000 });
            } else {
                log.audit({
                    title: stLogTitle,
                    details: 'Delete Script Parameter set to false, Saved Search not loaded'
                });
            }
        }

        /**
         * Executes when the map entry point is triggered.
         * The logic in the map function is applied to each key/value pair that is provided by the
         * getInputData stage. One key/value pair is processed per function invocation, then the function is
         * invoked again for the next pair.
         *
         * The output of the map stage is another set of key/value pairs. During the shuffle stage that
         * always follows, these pairs are automatically grouped by key.
         * @param context
         */
        function map(context) {
            var stLogTitle = 'ns_mr_mass_delete: map';
            var stStage = 'Deleting Record: ';
            var obResult = JSON.parse(context.value);

            // If Result is not empty then delete Record
            if (!isEmpty(obResult)) {
                try {
                    var stID = obResult.id;
                    var stRecType = obResult.recordType;

                    log.debug({
                        title: stLogTitle,
                        details: stStage + 'ID: ' + stID + ' | Record Type: ' + stRecType
                    });

                    // If Type is File then delete file using File Module

                    if (stRecType == 'file') {
                        file.delete({
                            id: stID
                        });
                    } else {
                        if(stRecType == 'customrecord_is_asn'){deleteItems(stID);}
                        record.delete({
                            type: stRecType,
                            id: stID
                        });
                    }
                } catch (error) {
                    log.error({
                        title: stLogTitle,
                        details: 'ERROR: ' + error.toString()
                    })
                }
            } else {
                // Result is empty, exit map iteration
                log.audit({
                    title: stLogTitle,
                    details: stStage + 'Record not found'
                });
            }
        }
		function deleteItems(asn){
          //custrecord_is_asn_item_sublist_link
          //require(['N/search'], function(search) {
              var mySearch = search.create({
                  type: 'customrecord_is_asn_items',
                  columns: ['internalid'],
                  filters: ['custrecord_is_asn_item_sublist_link', 'anyof', asn]
              });

              var myResultSet = mySearch.run();

              var searchResult = myResultSet.getRange({
                  start: 0,
                  end: 200
              });

              for (var i = 0; i < searchResult.length; i++) {
                var recId = searchResult[i].getValue({
                    name: 'internalid'
                });
                var itemRec = record.delete({
                 type: 'customrecord_is_asn_items',
                 id: recId
                });
              } // end item delete loop
        }
        /**
         * Executes when the reduce entry point is triggered. The logic in your reduce function is applied
         * to each key, and its corresponding list of value. Only one key, with its corresponding values,
         * is processed per function invocation. The function is invoked again for the next key and
         * corresponding set of values. Data is provided to the reduce stage by one of the following:
         * - The getInputData stage — if your script has no map function.
         * - The shuffle stage — if your script uses a map function. The shuffle stage follows the map
         *   stage. Its purpose is to sort data from the map stage by key.
         */
        // function reduce(context) {
        // }

        /**
         * Executes when the summarize entry point is triggered.
         * When custom logic is added to this entry point function, that logic is applied to the result set.
         * @param summary
         */
        function summarize(summary) {
            var stLogTitle = 'ns_mr_mass_delete: summarize';
            var strSavedSearchParamId = 'custscript_ns_md_saved_search_id';
            var strMRInternalIdParamId = 'customscript_wd_nsps_del_scrp_map_red';
            var strDeleteParamId = 'custscript_ns_md_delete';

            var currentScript = runtime.getCurrentScript();


            // Call handleErrorIfAny function to log any errors that were encountered
            handleErrorIfAny(summary);

            // Log Script Execution Details
            log.audit({
                title: stLogTitle,
                details: 'Usage Units Consumed: ' + summary.usage
            });
            log.audit({
                title: stLogTitle,
                details: 'Concurrency: ' + summary.concurrency
            });
            log.audit({
                title: stLogTitle,
                details: 'Number of Yields: ' + summary.yields
            });
            var intMapCount = 0;
            summary.mapSummary.keys.iterator().each(function (key) {
                intMapCount++;
                return true;
            });
            log.audit({
                title: stLogTitle,
                details: 'Iteration Count: ' + intMapCount
            });

            var strSavedSearchId = currentScript.getParameter({ name: strSavedSearchParamId });
            var strMRInternalId = strMRInternalIdParamId;
            var booDelete = convertToBoolean(currentScript.getParameter({ name: strDeleteParamId }));

            var objSearch = search.load({ id: strSavedSearchId });
            // log.debug({
            //     title: stLogTitle,
            //     details: 'Search Result Object: ' + JSON.stringify(objSearchResults)
            // });

            var objSearchResults = objSearch.run().getRange({ start: 0, end: 1000 });
            // If there are still results in the Saved Search then call Map/Reduce Script again
            if (objSearchResults.length > 0 && booDelete) {
                log.audit({
                    title: stLogTitle,
                    details: 'Executing Map Reduce Script again'
                });
                var mrTask = task.create({ taskType: task.TaskType.MAP_REDUCE });
                mrTask.scriptId = strMRInternalId;
                mrTask.deploymentId = 1;
                mrTask.submit();
            }

            log.audit({
                title: stLogTitle,
                details: '=== FINISH: ' + new Date().getTime() + ' ==='
            });
        }

        return {
            getInputData: getInputData,
            map: map,
            // reduce: reduce,
            summarize: summarize
        }
    }
);