# screen -X -S "pH" stuff $'\003' - Need to find a way to kill a running scren session

# Environment variables
export METER_TTY='/dev/ttyUSB0'
export METER_DATE_FORMAT='DMY'
export METER_POLL_MS=5000

export MQTT_HOST_IP="mqtt://192.168.1.110/"
export MQTT_TOPIC_ROOT="Instruments/Kinsale"
export MQTT_EDGE_NODE_ID="TEST001"
export MQTT_DEVICE_ID="AT9999X"
export MQTT_HOST_USERNAME=""
export MQTT_HOST_PASSWORD=""

export SPARKPLUG_GROUP_ID="Kinsale"

# Launch in a screen session
cd ~/edge/nodeOrionFiveStar
screen -d -m -S pH npm start