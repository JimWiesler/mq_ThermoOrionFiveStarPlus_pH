"use strict";
const mqtt = require('mqtt');
const os = require("os");
const repl = require("repl");
const OrionFiveStarPlus = require('./OrionFiveStarPlus').OrionFiveStarPlus;

const hostname = os.hostname();

// Set values
let mqtt_host_ip = process.env.MQTT_HOST_IP || 'mqtt://127.0.0.1/';
let mqtt_topic_root = process.env.MQTT_TOPIC_ROOT || 'decommissioned/'+hostname+'/OrionFiveStarPlus';

// Set up the pH meter object
const phMeter = new OrionFiveStarPlus({
    tty: '/dev/ttyUSB0',
    baudrate: 9600,
    dateFormat: 'DMY',
    sampleRequestMS: 5000,
    measPollMS: 10000,
    alivePollMS: 5000,
});
let attribution = { name: 'No Attribution' , utc: '1970-01-01T00:00:00.000Z'};

// Set up MQTT client and connect to serve
let mqttClient = mqtt.connect(mqtt_host_ip);

mqttClient.on('connect', () => {
    console.error('==== MQTT connected ====');
    mqttSendBuffered(); // send any messages buffered locally while MQTT was not connected
    mqttClient.subscribe(mqtt_topic_root+'/requestSample');
    mqttClient.subscribe(mqtt_topic_root+'/attribution');
});

mqttClient.on('message', (topic, message) => {
    console.log("Subscribed MQTT Message Received: ", topic, message);
    if (topic === mqtt_topic_root+'/requestSample') {
        phMeter.getCurrentMeasurement(message.toString());
        console.log("Request Sample received: ", message.toString());
    } else if (topic === mqtt_topic_root+'/attribution') {
        attribution.name = message.toString();
        attribution.utc = utc();
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
phMeter.on('state', (res) => mqttSend('state', res));
phMeter.on('tx', (res) => mqttSend('tx', res));
phMeter.on('rx', (res) => mqttSend('rx', res));
phMeter.on('result', (res) => {
    mqttSend('result', res);
    try {
        if (res.payload.sampleID !== 'Polled') mqttSend('requestedSample', res);
    } catch (error) {
        console.error(error);
    }
});
phMeter.on('configuration', (res) => mqttSend('configuration', res));
phMeter.on('calibration', (res) => {
    try {
        if (res.payload.type !== 'pH') {
            mqttSend('pHCalibration', res);
        } else if (res.payload.type !== 'Conductivity') {
            mqttSend('conductivityCalibration', res);
        }
    } catch (error) {
        console.error(error);
    }
});

// Start instrument communication
phMeter.open();

const r = repl.start('> ');
Object.assign(r.context, {phMeter, mqttClient, mqttConfig, attribution});