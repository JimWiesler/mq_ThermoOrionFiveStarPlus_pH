'use strict';
//*******************************************************
// Opens and polls a Thermo Scientific Orion 5 Star Plus pH/ORP/Cond meter
//*******************************************************
//Load required modules
// const repl = require('repl');
const SerialPort = require('serialport');
const Readline = require('@serialport/parser-readline');
const EventEmitter = require('events');

//*******************************************
// Meter class
//*******************************************
class OrionFiveStarPlus extends EventEmitter {
    constructor(cfg) {
        super();
        this.state = 'Closed'; // See State Machine: Closed, Opening, Offline, Initializing, Online, Busy, Closing
        this.cfg = cfg;
        this.dateFormat = cfg.dateFormat || 'MDY';
        this.port = null;
        this.readParser = null;
        this.meterConfig = {
            'Make': 'Thermo Scientific',
            'Model': '5-Star Plus BENCHTOP MULTI with ISE',
            'SerialNumber': 'Uninitiated',
            'FirmwareRev': 'Uninitiated',
            'Configuration': { 'Method': 'Uninitiated' },
        };
        this.lastCommand = { name: 'Pause', cmd: '', timeout: 0, responseRequired: false, pauseAfterResponse: 0 };
        this.initializePending = true;
        this.lastError = {error: '', lastCommand: '', ts: 0};
        this.lastMeasure = {status: 'Offline', ts: 0, sampleID: 'Uninitiated', meterTimestamp: 'Uninitiated', values: {
            temperature: {value: NaN, engUnit: ''},
            pH: {value: NaN, engUnit: ''},
            mV: {value: NaN, engUnit: ''},
            slope: {value: NaN, engUnit: ''},
            pHCalibrationIndex: -1,
            conductivity: {value: NaN, engUnit: ''},
            conductance: {value: NaN, engUnit: ''},
            tempCoefficient: -9999,
            tempReference: {value: NaN, engUnit: ''},
            cellConstant: {value: NaN, engUnit: ''},
            condCalibrationIndex: -1,
        }};
        this.sampleRequest = null;
        this.sampleRequestTimeout = null;
        this.getMeasTimeout = cfg.sampleRequestMS || 5000; // timeout for receiving a new measurement.
        this.lastPHCal = {};
        this.lastCondCal = {};
        this.commandQueue = [];
        this.commandTimeout = null;
        this.measPollMS = cfg.measPollMS || 10000; // how often to grab a measurement
        this.measPollTimeout = null;
        this.alivePollMS = cfg.alivePollMS || 5000; // how often to recheck if link is alive
        this.alivePollInterval = null;
        this.cmds = {
            Pause: { name: 'Pause', cmd: '', timeout: 500, responseRequired: false, pauseAfterResponse: 0 },
            Poll: { name: 'Poll', cmd: 'GETCAL ORP\r', timeout: 2000, responseRequired: true, pauseAfterResponse: 500 },
            GetData: { name: 'GetData', cmd: 'GETMEAS\r', timeout: this.getMeasTimeout, responseRequired: true, pauseAfterResponse: 500 },
            GetMethod: { name: 'GetMethod', cmd: 'GETMEAS\r', timeout: 3000, responseRequired: true, pauseAfterResponse: 500 },
            GetPHCal: { name: 'GetPHCal', cmd: 'GETCAL PH\r', timeout: 3000, responseRequired: true, pauseAfterResponse: 500 },
            GetCondCal: { name: 'GetCondCal', cmd: 'GETCAL COND\r', timeout: 3000, responseRequired: true, pauseAfterResponse: 500 },
            GetConfig: { name: 'GetConfig', cmd: 'GETMENU 0000,6,62\r', timeout: 3000, responseRequired: true, pauseAfterResponse: 500 },
            SetEchoOff: { name: 'SetEchoOff', cmd: 'ECHO OFF\r', timeout: 500, responseRequired: false, pauseAfterResponse: 0 },
            Flash: { name: 'Flash', cmd: 'KEY WWWWWWWWWWWW\r', timeout: 1000, responseRequired: false, pauseAfterResponse: 0 },
            Blip: { name: 'Blip', cmd: 'KEY WW\r', timeout: 1000, responseRequired: false, pauseAfterResponse: 0 },
            Reset: { name: 'Reset', cmd: 'KEY X\r', timeout: 500, responseRequired: false, pauseAfterResponse: 0 },
            SetDataDisplay: { name: 'SetDataDisplay',
                cmd: 'SETMENU 0000,MENU_MEAS,1,1,0\r',
                timeout: 2000, responseRequired: false, pauseAfterResponse: 0 },
            SetNoAutoShutoff: { name: 'SetNoAutoShutoff',
                cmd: 'SETMENU 0000,45,0\r',
                timeout: 2000, responseRequired: false, pauseAfterResponse: 0 },
            SetAutoShutoff: { name: 'SetAutoShutoff',
                cmd: 'SETMENU 0000,45,1\r',
                timeout: 2000, responseRequired: false, pauseAfterResponse: 0 },
            SetHours: { name: 'SetHours',
                cmd: 'SETMENU 0000,48,REPLACE1\r',
                timeout: 2000, responseRequired: false, pauseAfterResponse: 0 },
            SetMinutes: { name: 'SetMinutes',
                cmd: 'SETMENU 0000,49,REPLACE1\r',
                timeout: 2000, responseRequired: false, pauseAfterResponse: 0 },
            SetYear: { name: 'SetYear',
                cmd: 'SETMENU 0000,51,REPLACE1\r',
                timeout: 2000, responseRequired: false, pauseAfterResponse: 0 },
            SetMonth: { name: 'SetMonth',
                cmd: 'SETMENU 0000,52,REPLACE1\r',
                timeout: 2000, responseRequired: false, pauseAfterResponse: 0 },
            SetDay: { name: 'SetDay',
                cmd: 'SETMENU 0000,53,REPLACE1\r',
                timeout: 2000, responseRequired: false, pauseAfterResponse: 0 },
            SetDMYFormat: { name: 'SetDMYFormat',
                cmd: 'SETMENU 0000,50,'+(this.dateFormat == 'MDY' ? '0' : '1')+'\r',
                timeout: 2000, responseRequired: false, pauseAfterResponse: 0 },
            Set232Format: { name: 'Set232Format',
                cmd: 'SETMENU 0000,55,1\r',
                timeout: 4000, responseRequired: false, pauseAfterResponse: 0 },
        };
        // Start Polling - this.state has to be correct for port to be accessed
        this.measurePoll();
        this.alivePoll();
        this.cmdLoop("Timeout");
    }

    // Measure Request Poll Cycle
    measurePoll() {
        let me = this;
        if (this.state.includes('Online')) {
            this.write(this.cmds.GetData);
        }
        this.measPollTimeout = setTimeout(me.measurePoll.bind(me), this.measPollMS);
    }

    // Alive Poll Cycle
    alivePoll() {
        let me = this;
        if (this.state === 'Offline' || this.state === "Online Busy") {
            this.write(this.cmds.Reset); // Don't know if this will help, but after a few hours meter drops characters in send.
            this.write(this.cmds.Poll);
        }
        this.alivePollInterval = setTimeout(me.alivePoll.bind(me), this.alivePollMS);
    }

    // Open port
    open() {
        const me = this;
        try {
            this.port = new SerialPort(this.cfg.tty, {
                baudRate: this.cfg.baudrate,
                dataBits: 8,
                stopBits: 1,
                parity: 'none',
              });
            this.readParser = this.port.pipe(new Readline({ delimiter: '\r' }));
            this.readParser.on('data', function (data) {
                me.read(data);
            });
            this.port.on('error', function(error) {
                me.emit('error', { utc: utc(), payload: 'Port Error: '+ error });
                me.close();
            });
            this.port.on('close', function(res) {
                me.setState('Closed');
            });
            this.setState('Offline');
        } catch (error) {
            this.emit('error', { utc: utc(), payload: 'Port Failed to open: ', error });
            this.setState('Closed');
        }
    }

    // Close port
    close() {
        this.setState('Closing');
        if (this.port.isOpen) {
            this.port.close(); // Note - Close event handler will manage the state change to Closed
        } else {
            this.setState('Closed');
        }
    }

    // Write Commands to command queue
    write(c, r1, r2) {
        let command = {...c} // get shallow copy
        r1 = r1 || '';
        r2 = r2 || '';
        command.cmd = command.cmd.replace('REPLACE1', r1).replace('REPLACE2', r2); // Replace placeholders in command
        this.commandQueue.push(command);
    }

    // State management
    setState(newState) {
        this.commandQueue = [];
        this.state = newState;
        this.lastCommand = {...this.cmds.Pause};
        this.emit("state", { utc: utc(), payload: this.state} );
    }

    // Main Poll loop - this loop (and the commandTimeout) should never stop
    cmdLoop(caller) {
        let me = this;

        // Check if state should change
        if (this.lastCommand.responseRequired) { // only change state if a response was required but not received
            if (this.state === 'Offline' && caller === 'ResponseReceived' && this.lastCommand.name === 'Poll') {
                if (this.initializePending) {
                    this.setState("Initializing");
                    this.configMeter();
                } else {
                    this.setState("Online");
                }
            } else if (this.state === 'Initializing' && caller === 'ResponseReceived' && this.lastCommand.name === 'GetData') {
                this.setState("Online"); // All is good - start collecting data
            } else if (this.state === 'Initializing' && caller === 'Timeout' && this.lastCommand.name === 'GetData') {
                this.setState("Offline"); // Go back to Polling
            } else if (this.state === 'Online' && caller === 'Timeout') {
                this.setState("Offline"); // Go back to polling
            }
        }

        // Determine next command (or 'pause' command)
        let cmd = {...this.cmds.Pause};
        if (this.lastCommand.responseRequired && this.lastCommand.pauseAfterResponse > 0) { // Send last command's pause
            cmd.timeout = this.lastCommand.pauseAfterResponse;
        } else if (this.commandQueue.length > 0) { // get new command from queue
            let c = this.commandQueue.shift();
            cmd = {...c};
        }

        // Send command
        this.lastCommand = cmd;
        if (cmd.cmd && cmd.cmd.length > 0){
            this.port.write(cmd.cmd);
            this.emit('tx', { utc: utc(), payload: cmd.cmd.replace('\n','').replace('\r','') });
        }

        // Set timeout so this polling function is always active in the event loop
        this.commandTimeout = killTimeout(this.commandTimeout); // Cancel previous timeout if not fired
        this.commandTimeout = setTimeout(()=>{
            me.cmdLoop('Timeout');
        }, cmd.timeout);
    }

    // All read handling
    read(inp) {
        // If prompt string is in result, this is an Echo and should be discarded
        let responseToCommand = false;
        if (inp.startsWith('> ')) {
            return;
        }

        // Clean up the input by trimming and deleting any CR LF or ESC characters
        inp = inp.replace('\n','').replace('\r','').replace('\x1B', '').trim(); // LF, CR, ESC, white space
        if (inp.length === 0) return; // Ignore blank lines

        // Send event that new input received
        this.emit('rx', { utc: utc(), payload: inp });

        // Determine what type of input it is and handle it
        const csv = inp.split(',');
        if (inp.includes('Thermo Scientific (c) 2007')) { // Start up message
            this.initializePending = true;
            console.log("Power on");
        } else if (inp.match( /^E\-3\w\w\w$/ )) { // Error Message
            this.lastError = {error: inp, lastCommand: this.lastCommand.name, ts: Date.now()};
            responseToCommand = true;
        } else if (csv.length === 1 && this.lastCommand.name === 'GetMethod') {
            this.updateMethod(csv);
            responseToCommand = true;
        } else if (csv.length === 4) { // Probably startup ID like 119,B15164,2.39,8
            this.updateMeterConfig(csv);
        } else if (csv.length === 9 && this.lastCommand.name === 'Poll' && csv[6] === 'ORP') {
            this.updateORPCal(csv);
            responseToCommand = true;
        } else if (csv.length === 19 && this.lastCommand.name === 'GetPHCal' && csv[6] === 'PH') {
            this.updatePHCal1Point(csv);
            responseToCommand = true;
        } else if (csv.length === 19 && this.lastCommand.name === 'GetCondCal' && csv[6] === 'COND') {
            this.updateCondCal1Point(csv);
            responseToCommand = true;
        } else if (csv.length === 26 && csv[6] === 'pH' && csv[10] === 'C' && csv[15] === 'uS/cm') { // data matches Line1: pH Line2: Conductivity Line3: off
            // respond based on whether this is a polled response or intitiated remotely or from the instrument 'Measure save/print' button
            let sampleID = 'Polled';
            if (this.sampleRequest) {
                this.sampleRequestTimeout = killTimeout(this.sampleRequestTimeout);
                sampleID = this.sampleRequest;
                this.sampleRequest = null;
            } else if (this.lastCommand.name !== 'GetData') {
                sampleID = 'Manual';
            }
            this.updatePhMeasurement(csv, sampleID);
            if (this.lastCommand.name === 'GetData') {
                responseToCommand = true;
            }
            if (sampleID !== 'Polled') this.write(this.cmds.Flash);
        } else if (csv.length === 62 && this.lastCommand.name === 'GetConfig') {
            this.updateMeterConfigConfiguration(csv);
        } else {
            console.log(csv, csv.length, " TODO");
        }

        // If this read line is in response to a request, continue the poll
        if (responseToCommand) {
            this.cmdLoop('ResponseReceived');
        }
    }

    // ****************************************************************************
    // Command sending routines
    // ****************************************************************************
    // Generic Send command in case you want to try other commands ad hoc
    send(cmd) {
        if (Object.keys(this.cmds).includes(cmd)) {
            this.write(this.cmds[cmd]);
        } else{
            let c = { name: 'Custom', cmd: cmd, timeout: 1000, responseRequired: false, pauseAfterResponse: 0 };
            this.write(c);
        }
    }

    // Configure critical parts of meter: time, output format, date format
    configMeter() {
        this.initializePending = false;
        const now = new Date();
        // SetDataDisplay (MENU_MEAS) sets which measurement is on which line of the meter, and also WHAT IS PRINTED.  VERY IMPORTANT!
        //    If the config des not match the expecation there is no way in the CSV stream to know for sure what is being printed.
        //    You can get the config vis last element of SYSTEM command, but that locks up easurement for 30-60 seconds.
        //    Example SYSTEM command: 19,B15164,2.39,8,07-03-2020 17:53:44,000000,00000,110<cr> - 110 is Line1|Line2|Line3 as below:
        //    Line1: 0:Off, 1:pH, 2:MV, 3:RmV (ORP), 4:ISE, 5:ATC Temp
        //    Line2: 0:Off, 1:Conductivity, 2:TDS, 3:Salinity, 4:Resistivity, 5:ATC Temp
        //    Line3: 0:Off, 1:%Saturation, 2:Concentration, 3:Barometer, 4:Solution Temp, 5:MembraneTemp
        this.write(this.cmds.SetDataDisplay);
        // this.write(this.cmds.SetNoAutoShutoff);
        this.write(this.cmds.SetAutoShutoff); // Meter serial stream becomes corrupt after ~ 2 days, need to allow the meter to shut off to ensure integrity
        this.write(this.cmds.SetHours, (now.getHours()).toString());
        this.write(this.cmds.SetMinutes, (now.getMinutes()).toString());
        this.write(this.cmds.SetYear, (now.getFullYear()-2000).toString());
        this.write(this.cmds.SetMonth, (now.getMonth()+1).toString());
        this.write(this.cmds.SetDay, (now.getDate()).toString());
        this.write(this.cmds.SetDMYFormat);
        this.write(this.cmds.Set232Format); // Set serial output to CSV
        this.write(this.cmds.GetConfig);
        this.write(this.cmds.GetMethod);
        this.write(this.cmds.GetPHCal);
        this.write(this.cmds.GetCondCal);
        this.write(this.cmds.Blip);
        this.write(this.cmds.GetData); // Last command - will trigger transition to Online state
    }

    // Request current measurement, optionally with a sampleID
    // This is for a non-polled sample request, usually from outside the class
    // Format of the response is dependent on LINE1/LINE2/LINE3 setup.
    getCurrentMeasurement(sampleRequest) {
        const me = this;
        me.sampleRequestTimeout = killTimeout(me.sampleRequestTimeout);
        if (sampleRequest) {
            this.sampleRequest = sampleRequest; // attach a sample ID to result if requested
            this.sampleRequestTimeout = setTimeout(() => {
                me.emit('error', { utc: utc(), payload: 'Sample Request Timeout: ' + me.sampleRequest });
                me.sampleRequest = null;
                me.sampleRequestTimeout = killTimeout(me.sampleRequestTimeout);
            }, this.measPollMS+3000);
        }
        // No need to run this as it is Online and polling for data - this.write(this.cmds.GetData);
    }

    //*********************************************************
    // All the data update methods follow this
    //*********************************************************
    // Update the last measurement - always fire event
    updatePhMeasurement(params, sampleID) {
        this.lastMeasure.status = 'Good';
        this.lastMeasure.ts = (new Date()).toISOString();
        // handle if this is a requested sample
        this.lastMeasure.sampleID = sampleID;
        this.lastMeasure.meterTimestamp = params[4];
        this.lastMeasure.values = {};
        try {
            this.lastMeasure.values = {
                temperature: {value: parseFloat(params[9]), engUnit: params[10]},
                pH: {value: parseFloat(params[5]), engUnit: params[6]},
                mV: {value: parseFloat(params[7]), engUnit: params[8]},
                slope: {value: parseFloat(params[11]), engUnit: params[12]},
                pHCalibrationIndex: parseInt(params[13]),
                conductivity: {value: parseFloat(params[14]), engUnit: params[15]},
                conductance: {value: parseFloat(params[16]), engUnit: params[17]},
                tempCoefficient: params[20],
                tempReference: {value: parseFloat(params[21]), engUnit: params[22]},
                cellConstant: {value: parseFloat(params[23]), engUnit: params[24]},
                condCalibrationIndex: parseInt(params[25]),
            };
            // Request latest calibration values f measurement's cal indices do not match last collected values
            if (this.lastMeasure.values.pHCalibrationIndex !== this.lastPHCal.pHCalibrationIndex) {
                this.write(this.cmds.GetPHCal);
            }
            if (this.lastMeasure.values.condCalibrationIndex !== this.lastCondCal.condCalibrationIndex) {
                this.write(this.cmds.GetCondCal);
            }
            this.emit('result', { utc: utc(), payload: this.lastMeasure });
        } catch (error) {
            this.emit('error', { utc: utc(), payload: 'Error '+error+' parsing sample results: '+params });
        }
        // Check the S/N and FW
        this.updateMeterConfig(params);
    }

    // Update the method
    updateMethod(params) {
        let method = this.meterConfig.Configuration['Method'];
        this.meterConfig.Configuration['Method'] = params[3];
        if (method !== this.meterConfig.Configuration['Method']) {
            this.emit('configuration', { utc: utc(), payload: this.meterConfig });
        }
    }

    // Update the meterConfig structure - serial number and firmware 119,B15164,2.39,8 (skip 8 - method)
    updateMeterConfig(params) {
        if (params[0] !== '119') {
            console.log("Invalid meter type: ", params);
            return;
        }
        let sn = this.meterConfig['SerialNumber']
        let fw = this.meterConfig['FirmwareRev']
        this.meterConfig['SerialNumber'] = params[1];
        this.meterConfig['FirmwareRev'] = params[2];
        if (sn !== this.meterConfig['SerialNumber'] || fw !== this.meterConfig['FirmwareRev']) {
            this.emit('configuration', { utc: utc(), payload: this.meterConfig });
        }
    }

    // Update the pH Calibration info - only good for 1 point calibration right now
    updatePHCal1Point(params) {
        const oldvals = { ...this.lastPHCal };
        this.lastPHCal.meterTimestamp = params[4];
        try {
            this.lastPHCal = {
                pHCalibrationIndex: parseInt(params[5]),
                meterTimestamp: params[4],
                point1: { value: parseFloat(params[8]), engUnit: params[9], mv: parseFloat(params[10]),
                    temperature: parseFloat(params[12]), temperatureUnits: params[13], calType: params[14] },
                    slope1: {value: parseFloat(params[15]), engUnit: params[16]},
                    Eo1: {value: parseFloat(params[17]), engUnit: params[18]},
                };
            } catch (error) {
                console.log("Error in updatePHCal:", error, params);
            }

        // Compare old and new, if different fire event
        if (!deepEqual(oldvals, this.lastPHCal)) {
            this.emit('calibration', { utc: utc(), payload: {type: 'pH', data: this.lastPHCal } });
        }
        // Check the S/N and FW
        this.updateMeterConfig(params);
    }

    // Update the Conductivity Calibration info - only good for 1 point calibration right now
    updateCondCal1Point(params) {
        const oldvals = { ...this.lastCondCal };
        this.lastCondCal.meterTimestamp = params[4];
        try {
            this.lastCondCal = {
                condCalibrationIndex: parseInt(params[5]),
                meterTimestamp: params[4],
                point1: { value: parseFloat(params[8]), engUnit: params[9], conductanceValue: parseFloat(params[10]), conductanceUnits: params[11],
                    temperature: parseFloat(params[12]), temperatureUnits: params[13], calType: params[14] },
                    K1: {value: parseFloat(params[15]), engUnit: params[16]},
                    offset1: {value: parseFloat(params[17]), engUnit: params[18]},
                };
            } catch (error) {
                console.log("Error in updateCondCal1Point:", error, params);
            }

        // Compare old and new, if different fire event
        if (!deepEqual(oldvals, this.lastCondCal)) {
            this.emit('calibration', { utc: utc(), payload: {type: 'Conductivity', data: this.lastCondCal } });
        }
        // Check the S/N and FW
        this.updateMeterConfig(params);
    }

    // Update the ORP Calibration info - used mostly for hearbeat
    updateORPCal(params) {
        // Check the S/N and FW
        this.updateMeterConfig(params);
    }

    // Update the meterConfig structure
    updateMeterConfigConfiguration(params) {
        const oldvals = { ...this.meterConfig.Configuration };
        for (let i = 0; i < params.length; i++) {
            const menuNum = (i+6).toString();
            if (menuConfigLookup[menuNum].save) {
                if (menuConfigLookup[menuNum].type === 'Lookup') {
                    this.meterConfig.Configuration[menuConfigLookup[menuNum].name] = menuConfigLookup[menuNum].values[params[i]];
                } else {
                    this.meterConfig.Configuration[menuConfigLookup[menuNum].name] = params[i];
                }
            }
        }
        // Compare old and new, if different fire event
        if (!deepEqual(oldvals, this.meterConfig.Configuration)) {
            this.emit('configuration', { utc: utc(), payload: this.meterConfig }); // Meter info has been updated
        }
    }
}

// Utility functions
function utc() { // Generate ISO string of current date/time in UTC
    return (new Date().toISOString());
}

function killTimeout(to) {
    if (to) {
        clearTimeout(to);
    }
    return null;
}
function killInterval(it) {
    if (it) {
        clearInterval(it);
    }
    return null;
}

function deepEqual(object1, object2) {
    const keys1 = Object.keys(object1);
    const keys2 = Object.keys(object2);

    if (keys1.length !== keys2.length) {
      return false;
    }

    for (const key of keys1) {
      const val1 = object1[key];
      const val2 = object2[key];
      const areObjects = isObject(val1) && isObject(val2);
      if (
        areObjects && !deepEqual(val1, val2) ||
        !areObjects && val1 !== val2
      ) {
        return false;
      }
    }

    return true;
}

function isObject(object) {
    return object != null && typeof object === 'object';
}

// Thermo Orion 5 Star Plus Menu Config Lookup
const menuConfigLookup = {
    '6': {'name': 'Displayed pH Resolution', 'save': true, 'type': 'Lookup', 'values': {'0': '0.1', '1': '0.01', '2': '0.001'} },
    '7': {'name': 'pH Buffer Set Queenston', 'save': false, 'type': 'Lookup', 'values': {'0': 'USA', '1': 'Euro'} },
    '8': {'name': 'pH Buffer Set', 'save': true, 'type': 'Lookup', 'values': {'0': 'USA', '1': 'Euro'} },
    '9': {'name': 'pH Smart Probe', 'save': false, 'type': 'Readonly', 'values': 'Read Only' },
    '10': {'name': 'ISE Resolution', 'save': true, 'type': 'Lookup', 'values': {'0': '1', '1': '2', '2': '3'} },
    '11': {'name': 'ISE Units', 'save': true, 'type': 'Lookup', 'values': {'0': 'M', '1': 'mg/L', '2': '%', '3': 'ppb', '4': 'None'} },
    '12': {'name': 'ISE Calibration Standard Concentration Range', 'save': true, 'type': 'Lookup', 'values': {'0': 'Low', '1': 'High'} },
    '13': {'name': 'ISE Auto-Blank Correction', 'save': true, 'type': 'Lookup', 'values': {'0': 'Auto', '1': 'Off'} },
    '14': {'name': 'ISE Smart Probe', 'save': false, 'type': 'Readonly', 'values': 'Read Only' },
    '15': {'name': 'Conductivity Temperature Compensation Selection', 'save': true, 'type': 'Lookup', 'values': {'0': 'Off', '1': 'Linear', '2': 'unLf'} },
    '16': {'name': 'Conductivity Linear Temp Comp Coefficient Setting VWR', 'save': false, 'type': 'Range', 'values': {'Min': '0.0', 'Max': '10.0'} },
    '17': {'name': 'Conductivity Linear Temp Comp Coefficient Setting', 'save': true, 'type': 'Range', 'values': {'Min': '0.0', 'Max': '10.0'} },
    '18': {'name': 'Conductivity TDS Factor Setting', 'save': true, 'type': 'Range', 'values': {'Min': '0.00', 'Max': '10.00'} },
    '19': {'name': 'Conductivity Auto-Cal Default Cell Constant', 'save': true, 'type': 'Range', 'values': {'Min': '0.001', 'Max': '199.9'} },
    '20': {'name': 'Conductivity Temperature Reference Selection VWR', 'save': false, 'type': 'Lookup', 'values': {'0': '15', '1': '20', '2': '25'} },
    '21': {'name': 'Conductivity Cell Type & Manual Ranging Selection VWR', 'save': false, 'type': 'Lookup', 'values': {'0': 'Planar', '1': 'Standard', '2': 'Range 1', '3': 'Range 2', '4': 'Range 3', '5': 'Range 4', '6': 'Range 5', '7': 'Range 6', '8': 'Range 7'} },
    '22': {'name': 'Conductivity Temperature Reference Selection', 'save': true, 'type': 'Lookup', 'values': {'0': '15', '1': '20', '2': '25', '3': '5', '4': '10'} },
    '23': {'name': 'Conductivity Cell Type & Manual Ranging Selection', 'save': true, 'type': 'Lookup', 'values': {'0': 'USP', '1': 'Standard', '2': 'Range 1', '3': 'Range 2', '4': 'Range 3', '5': 'Range 4', '6': 'Range 5', '7': 'Range 6', '8': 'Range 7'} },
    '24': {'name': 'Conductivity Smart Probe', 'save': false, 'type': 'Readonly', 'values': 'Read Only' },
    '25': {'name': 'Dissolved Oxygen %Saturation Resolution', 'save': true, 'type': 'Lookup', 'values': {'0': '1', '1': '0.1'} },
    '26': {'name': 'Dissolved Oxygen Concentration Resolution', 'save': true, 'type': 'Lookup', 'values': {'0': '0.1', '1': '0.01'} },
    '27': {'name': 'Dissolved Oxygen Barometric Press. Comp.', 'save': true, 'type': 'Lookup', 'values': {'0': 'Auto', '1': 'Manual'} },
    '28': {'name': 'Dissolved Oxygen Manual Barometric Pressure', 'save': true, 'type': 'Range', 'values': {'Min': '450.0', 'Max': '850.0'} },
    '29': {'name': 'Dissolved Oxygen Salinity Correction Selection', 'save': true, 'type': 'Lookup', 'values': {'0': 'Auto', '1': 'Manual'} },
    '30': {'name': 'Dissolved Oxygen Manual Salinity Correction Factor', 'save': true, 'type': 'Range', 'values': {'Min': '0', 'Max': '45'} },
    '31': {'name': 'Dissolved Oxygen Calibration Type Selection', 'save': true, 'type': 'Lookup', 'values': {'0': 'Air', '1': 'Water', '2': 'Manual', '3': 'Zero'} },
    '32': {'name': 'DO Smart Probe', 'save': false, 'type': 'Readonly', 'values': 'Read Only' },
    '33': {'name': 'pH Calibration Alarm Setting', 'save': false, 'type': 'Range', 'values': {'Min': '0000', 'Max': '9999'} },
    '34': {'name': 'ORP Calibration Alarm Setting', 'save': false, 'type': 'Range', 'values': {'Min': '0000', 'Max': '9999'} },
    '35': {'name': 'ISE Calibration Alarm Setting', 'save': false, 'type': 'Range', 'values': {'Min': '0000', 'Max': '9999'} },
    '36': {'name': 'Conductivity Calibration Alarm Setting', 'save': false, 'type': 'Range', 'values': {'Min': '0000', 'Max': '9999'} },
    '37': {'name': 'Dissolved Oxygen Calibration Alarm Setting', 'save': false, 'type': 'Range', 'values': {'Min': '0000', 'Max': '9999'} },
    '38': {'name': 'Continuous, Timed, or Auto-Read Measurement Selection', 'save': true, 'type': 'Lookup', 'values': {'0': 'Continuous', '1': 'AutoRead', '2': 'Timed Readings'} },
    '39': {'name': 'Timed Reading Setting', 'save': true, 'type': 'Range', 'values': {'Min': '00.30', 'Max': '99.59'} },
    '40': {'name': 'Data Log Roll Over or Delete on Download Option Selection', 'save': false, 'type': 'Lookup', 'values': {'0': 'No', '1': 'Yes'} },
    '41': {'name': 'Auto Log Feature', 'save': false, 'type': 'Lookup', 'values': {'0': 'OFF', '1': 'ON'} },
    '42': {'name': 'Manual Temperature Compensation Setting', 'save': true, 'type': 'Range', 'values': {'Min': '0.0', 'Max': '105.0'} },
    '43': {'name': 'Stirrer Speed Setting', 'save': false, 'type': 'Lookup', 'values': {'0': 'Off', '1': 'Speed 1', '2': 'Speed 2', '3': 'Speed 3', '4': 'Speed 4', '5': 'Speed 5', '6': 'Speed 6', '7': 'Speed 7'} },
    '44': {'name': 'Instrument Password', 'save': false, 'type': 'Range', 'values': {'Min': '0000', 'Max': '9999'} },
    '45': {'name': 'Auto-Shut Off Selection', 'save': false, 'type': 'Lookup', 'values': {'0': 'Off', '1': 'On'} },
    '46': {'name': 'Methods Setting', 'save': false, 'type': 'Lookup', 'values': {'0': 'Off', '1': 'On'} },
    '47': {'name': 'Instrument Password VWR', 'save': false, 'type': 'Range', 'values': {'Min': '0000', 'Max': '9999'} },
    '48': {'name': 'Time: Hour Setting', 'save': false, 'type': 'Range', 'values': {'Min': '0', 'Max': '23'} },
    '49': {'name': 'Time: Minute Setting', 'save': false, 'type': 'Range', 'values': {'Min': '0', 'Max': '59'} },
    '50': {'name': 'Date Format', 'save': false, 'type': 'Lookup', 'values': {'0': 'MDY', '1': 'DMY'} },
    '51': {'name': 'Date: Year Setting', 'save': false, 'type': 'Range', 'values': {'Min': '00', 'Max': '99'} },
    '52': {'name': 'Date: Month Setting', 'save': false, 'type': 'Range', 'values': {'Min': '1', 'Max': '12'} },
    '53': {'name': 'Date: Day of the Month Setting', 'save': false, 'type': 'Range', 'values': {'Min': '1', 'Max': '31'} },
    '54': {'name': 'RS-232 Baud Rate Selection', 'save': false, 'type': 'Lookup', 'values': {'0': '1200', '1': '2400', '2': '4800', '3': '9600'} },
    '55': {'name': 'Printout Format', 'save': false, 'type': 'Lookup', 'values': {'0': 'Printer', '1': 'Computer'} },
    '56': {'name': 'Autosampler Operation', 'save': false, 'type': 'Lookup', 'values': {'0': 'OFF', '1': 'ON'} },
    '57': {'name': 'Tray type', 'save': false, 'type': 'Lookup', 'values': {'0': '28', '1': '48'} },
    '58': {'name': 'Number rinse beakers to use', 'save': false, 'type': 'Lookup', 'values': {'0': '1', '1': '2', '2': '3', '3': '4', '4': '5'} },
    '59': {'name': 'Beaker rinse time.', 'save': false, 'type': 'Range', 'values': {'Min': '5', 'Max': '60'} },
    '60': {'name': 'Auto CAL pH', 'save': true, 'type': 'Lookup', 'values': {'0': '0 (no CAL)', '1': '1', '2': '2', '3': '3'} },
    '61': {'name': 'Auto CAL ORP', 'save': true, 'type': 'Lookup', 'values': {'0': 'No', '1': 'Yes'} },
    '62': {'name': 'Auto CAL ISE', 'save': true, 'type': 'Lookup', 'values': {'0': '0 (no CAL)', '1': '2', '2': '3'} },
    '63': {'name': 'ISE CAL point # 1', 'save': true, 'type': 'Range', 'values': {'Min': '0.0001', 'Max': '19999'} },
    '64': {'name': 'ISE CAL point # 2', 'save': true, 'type': 'Range', 'values': {'Min': '0.0001', 'Max': '19999'} },
    '65': {'name': 'ISE CAL point # 3', 'save': true, 'type': 'Range', 'values': {'Min': '0.0001', 'Max': '19999'} },
    '66': {'name': 'Auto CAL Conductivity', 'save': true, 'type': 'Lookup', 'values': {'0': '0 (no CAL)', '1': '1', '2': '2', '3': '3'} },
    '67': {'name': 'Number of samples to test', 'save': false, 'type': 'Range', 'values': {'Min': '1', 'Max': '47'} },
}

module.exports.OrionFiveStarPlus = OrionFiveStarPlus;

// Leaving this in as comments
// const r = new OrionFiveStarPlus({ tty: '/dev/ttyUSB0', baudrate: 9600, dateFormat: 'DMY' });
// r.on('error', (res) => console.log('Event->error:', res));
// r.on('state', (res) => console.log('Event->state:', res));
// r.on('tx', (res) => console.log('Event->tx:', res));
// r.on('rx', (res) => console.log('Event->rx:', res));
// r.on('result', (res) => console.log('Event->result:', res.sampleID, res.values.pH.value));
// r.on('configuration', (res) => console.log('Event->configuration:', JSON.stringify(res)));
// r.on('calibration', (res) => console.log('Event->calibration for '+res+':'));
// repl.start('> ').context.r = r;
