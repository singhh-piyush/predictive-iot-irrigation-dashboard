# Irrigation node dashboard

Live readings from the ESP32 field node, served as a static page. The page
connects straight to the MQTT broker over a secure WebSocket, so nothing runs
between the browser and the node.

Open the page, enter the broker password once, and it is remembered in that
browser. The valve switch publishes to the node's relay topic and the switch
settles once the node reports the new state back.

Soil moisture is shown as a percentage between the bench endpoints of the
resistive fork, dry in air and wet in a glass of water, matching how the model
treats moisture as relative saturation rather than an absolute value.
