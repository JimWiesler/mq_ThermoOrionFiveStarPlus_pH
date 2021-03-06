'use strict';
const os = require('os');
const mqtt = require('mqtt');
const sparkplug = require('sparkplug-client');
const repl = require('repl');
const OrionFiveStarPlus = require('./OrionFiveStarPlus').OrionFiveStarPlus;


const hostname = os.hostname();
//*****************************
// Environment variables
// TTY: '/dev/ttyUSB0'
// METER_DATE_FORMAT: 'DMY' could also be 'MDY'
// METER_POLL_MS: 5000 range 5000-15000
// MQTT_EDGE_NODE_ID: hostname
// MQTT_DEVICE_ID: 'AT9999X'
// MQTT_HOST_IP: 'mqtt://127.0.0.1/'
// MQTT_HOST_USERNAME: ''
// MQTT_HOST_PASSWORD: ''
// MQTT_TOPIC_ROOT: 'unassigned'
// SPARKPLUG_GROUP_ID: 'unassigned'

// Set values
let edgeNodeId = process.env.MQTT_EDGE_NODE_ID || hostname;
let deviceId = process.env.MQTT_DEVICE_ID || 'AT9999X';
let mqtt_host_ip = process.env.MQTT_HOST_IP || 'mqtt://127.0.0.1/';
let mqtt_username = process.env.MQTT_HOST_USERNAME || '';
let mqtt_password = process.env.MQTT_HOST_PASSWORD || '';
let mqtt_topic_root = (process.env.MQTT_TOPIC_ROOT || 'unassigned') +'/'+edgeNodeId+'/'+deviceId;
let sparkplug_group_id = process.env.SPARKPLUG_GROUP_ID || 'unassigned';
let spkplgClient = null;

// Set up the pH meter object
const phMeter = new OrionFiveStarPlus({
    tty: (process.env.TTY || '/dev/ttyUSB0'),
    baudrate: 9600,
    dateFormat: (process.env.METER_DATE_FORMAT || 'DMY'),
    sampleRequestMS: 4000,
    measPollMS: constrainInt(process.env.METER_POLL_MS, 5000, 5000, 15000),
    alivePollMS: 5000,
});

// set up sparkplug values
let spkplg = {
    node: 'Offline',
    device: 'Offline',
    nMetrics: { Make: '', Model: '', SerialNumber: '', FirmwareRev: '' },
    dMetrics: { pH: NaN, temperature: NaN, conductivity: NaN },
};

// Set up MQTT client and connect to serve
let mqttClient = mqtt.connect(mqtt_host_ip, {
    username: mqtt_username,
    password: mqtt_password,
    will: {topic: mqtt_topic_root+'/edgeState', payload: 'Offline', retain: true },
});

mqttClient.on('connect', () => {
    console.error('==== MQTT connected ====');
    mqttClient.publish(mqtt_topic_root+'/edgeState', 'Online', { retain: true });
    mqttSendBuffered(); // send any messages buffered locally while MQTT was not connected
    mqttClient.subscribe(mqtt_topic_root+'/requestSample');
});

mqttClient.on('message', (topic, message) => {
    console.log('Subscribed MQTT Message Received: ', topic, message);
    if (topic === mqtt_topic_root+'/requestSample') {
        phMeter.getCurrentMeasurement(message.toString());
        console.log('Request Sample received: ', message.toString());
    }
});

mqttClient.on('close', () => {
    console.error('==== MQTT closed ====');
});

mqttClient.on('error', (error) => {
    console.error('==== MQTT error ' + error + ' ====');
});

mqttClient.on('offline', () => {
    console.error('==== MQTT offline ====');
});

mqttClient.on('reconnect', () => {
    mqttClient.publish(mqtt_topic_root+'/edgeState', 'Online', { retain: true });
    console.error('==== MQTT reconnect ====');
});


// Set up MQTT publishing
const mqttConfig = {
    error: { topic: mqtt_topic_root+'/comm/error', retain: false, buffer: [],  limit: 100 },
    state: { topic: mqtt_topic_root+'/comm/state', retain: true, buffer: [],  limit: 1 },
    tx: { topic: mqtt_topic_root+'/comm/tx', retain: false, buffer: [],  limit: 20 },
    rx: { topic: mqtt_topic_root+'/comm/rx', retain: false, buffer: [],  limit: 20 },
    result: { topic: mqtt_topic_root+'/result', retain: true, buffer: [],  limit: 500 },
    requestedSample: { topic: mqtt_topic_root+'/sample', retain: true, buffer: [],  limit: 500 },
    configuration: { topic: mqtt_topic_root+'/configuration', retain: true, buffer: [],  limit: 1 },
    pHCalibration: { topic: mqtt_topic_root+'/pHCalibration', retain: true, buffer: [],  limit: 1 },
    conductivityCalibration: { topic: mqtt_topic_root+'/conductivityCalibration', retain: true, buffer: [],  limit: 1 },
};

function mqttSend(type, message) {
    const messageJSON = JSON.stringify(message);
    if (mqttClient.connected) {
        mqttClient.publish(mqttConfig[type].topic, messageJSON, { retain: mqttConfig[type].retain });
    } else {
        mqttConfig[type].buffer.push(messageJSON)
        while (mqttConfig[type].buffer.length > mqttConfig[type].limit) {
            mqttConfig[type].buffer.shift();
        }
    }
}

// Send the first item in each buffer, then call again in 250 ms if any buffer still not empty
function mqttSendBuffered() {
    let bufferDrained = true;
    if (mqttClient.connected) {
        Object.keys(mqttConfig).forEach(key => {
            let msg = mqttConfig[key].buffer.shift();
            if (msg) mqttClient.publish(mqttConfig[key].topic, msg, { retain: mqttConfig[key].retain });
            if (mqttConfig[key].buffer.length > 0) bufferDrained = false;
        });
        if (!bufferDrained) setTimeout(mqttSendBuffered, 250);
    }
}

// Publish to appropriate topic when event received from meter
phMeter.on('error', (res) => mqttSend('error', res));
phMeter.on('state', (res) => {
    mqttSend('state', res);
    // sparkplug
    if (phMeter.state === 'Online' && spkplg.device !== 'Online') { // Publish DBIRTH
        const dbirth = {
            'timestamp' :  Date.now(),
            'metrics' : [
                { 'name' : 'pH', 'value' : phMeter.lastMeasure.values.pH.value, 'type' : 'Float', 'engUnit' : phMeter.lastMeasure.values.pH.engUnit },
                { 'name' : 'conductivity', 'value' : phMeter.lastMeasure.values.conductivity.value, 'type' : 'Float', 'engUnit' : phMeter.lastMeasure.values.conductivity.engUnit },
                { 'name' : 'temperature', 'value' : phMeter.lastMeasure.values.temperature.value, 'type' : 'Float', 'engUnit' : phMeter.lastMeasure.values.temperature.engUnit },
            ]
        };
        spkplgClient.publishDeviceBirth(deviceId, dbirth);
        spkplg.dMetrics = { // save values to compare later
            pH: phMeter.lastMeasure.values.pH.value,
            conductivity: phMeter.lastMeasure.values.conductivity.value,
            temperature: phMeter.lastMeasure.values.temperature.value,
        };
    } else if (phMeter.state !== 'Online' && spkplg.device === 'Online') { // Publish DDEATH
        spkplgClient.publishDeviceDeath(deviceId, { 'timestamp' : Date.now() });
    }
    spkplg.device = phMeter.state;
});
phMeter.on('tx', (res) => mqttSend('tx', res));
phMeter.on('rx', (res) => mqttSend('rx', res));
phMeter.on('result', (res) => {
    mqttSend('result', res);
    try {
        if (res.payload.sampleID !== 'Polled') mqttSend('requestedSample', res);
    } catch (error) {
        console.error(error);
    }
    // sparkplug
    if (phMeter.state === 'Online') { // Publish DDATA
        let metrics = [];
        if (phMeter.lastMeasure.values.pH.value !== spkplg.dMetrics.pH) {
            metrics.push({ name: 'pH', type: 'Float', value: phMeter.lastMeasure.values.pH.value });
        }
        if (phMeter.lastMeasure.values.conductivity.value !== spkplg.dMetrics.conductivity) {
            metrics.push({ name: 'conductivity', type: 'Float', value: phMeter.lastMeasure.values.conductivity.value });
        }
        if (phMeter.lastMeasure.values.temperature.value !== spkplg.dMetrics.temperature) {
            metrics.push({ name: 'temperature', type: 'Float', value: phMeter.lastMeasure.values.temperature.value });
        }
        if (metrics.length > 0) {
            spkplgClient.publishDeviceData(deviceId, { timestamp: Date.now(), metrics });
            spkplg.dMetrics = { // save values to compare later
                pH: phMeter.lastMeasure.values.pH.value,
                conductivity: phMeter.lastMeasure.values.conductivity.value,
                temperature: phMeter.lastMeasure.values.temperature.value,
            };
        }
    }
});

phMeter.on('configuration', (res) => {
    mqttSend('configuration', res);
    if (spkplg.node === 'Offline') { // Send NBIRTH
        // Setup Sparkplug B client
        const spkplgClientConfig = {
            'username' : mqtt_username,
            'serverUrl' : mqtt_host_ip,
            'password' : mqtt_password,
            'groupId' : sparkplug_group_id,
            'edgeNode' : edgeNodeId,
            'clientId' : 'SparkplugClient_'+edgeNodeId+ '_' + Math.random().toString(16).substr(2, 8),
            'version' : 'spBv1.0'
        };
        spkplgClient = sparkplug.newClient(spkplgClientConfig);
        spkplg.node === 'opening';

        spkplgClient.on('connect', () => {
            //Birth Certificate (NBIRTH)
            const nbirth = {
                'timestamp' : Date.now(),
                'metrics' : [
                    { name: 'Make', type: 'String', value: phMeter.meterConfig.Make },
                    { name: 'Model', type: 'String', value: phMeter.meterConfig.Model },
                    { name: 'SerialNumber', type: 'String', value: phMeter.meterConfig.SerialNumber },
                    { name: 'FirmwareRev', type: 'String', value: phMeter.meterConfig.FirmwareRev },
                ]
            };
            spkplgClient.publishNodeBirth(nbirth);
            spkplg.nMetrics = { // save values to compare later
                Make: phMeter.meterConfig.Make,
                Model: phMeter.meterConfig.Model,
                SerialNumber: phMeter.meterConfig.SerialNumber,
                FirmwareRev: phMeter.meterConfig.FirmwareRev,
            };
            spkplg.node = 'Online';
        });


    } else if (spkplg.node === 'Online') { // send NDATA if anythignhas changed
        let metrics = [];
        if (phMeter.meterConfig.Make !== spkplg.nMetrics.Make) metrics.push({ name: 'Make', type: 'String', value: phMeter.meterConfig.Make });
        if (phMeter.meterConfig.Model !== spkplg.nMetrics.Model) metrics.push({ name: 'Model', type: 'String', value: phMeter.meterConfig.Model });
        if (phMeter.meterConfig.SerialNumber !== spkplg.nMetrics.SerialNumber) metrics.push({ name: 'SerialNumber', type: 'String', value: phMeter.meterConfig.SerialNumber });
        if (phMeter.meterConfig.FirmwareRev !== spkplg.nMetrics.FirmwareRev) metrics.push({ name: 'FirmwareRev', type: 'String', value: phMeter.meterConfig.FirmwareRev });
        if (metrics.length > 0) {
            spkplgClient.publishNodeData({ timestamp: Date.now(), metrics });
            spkplg.nMetrics = { // save values to compare later
                Make: phMeter.meterConfig.Make,
                Model: phMeter.meterConfig.Model,
                SerialNumber: phMeter.meterConfig.SerialNumber,
                FirmwareRev: phMeter.meterConfig.FirmwareRev,
            };
        }
    }
});

phMeter.on('calibration', (res) => {
    try {
        if (res.payload.type === 'pH') {
            mqttSend('pHCalibration', res);
        } else if (res.payload.type === 'Conductivity') {
            mqttSend('conductivityCalibration', res);
        }
    } catch (error) {
        console.error(error);
    }
});

// Helper functions
function constrainInt(value, defValue, min, max) {
    value = (value || defValue);
    try {
        value = parseInt(value);
        value = Math.max(Math.min(value, max), min);
    } catch (error) {
        value = defValue;
    }
    return value;
}


// Start instrument communication
phMeter.open();

const r = repl.start('> ');
Object.assign(r.context, {phMeter, mqttClient, mqttConfig, spkplg});