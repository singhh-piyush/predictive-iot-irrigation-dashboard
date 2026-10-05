# Irrigation node dashboard

A single web page that shows a soil moisture node live. It connects straight to the MQTT
broker from the browser over a secure WebSocket, so there is no server in between.

Open the page, enter the broker password once, and the readings appear. Dashboard shows the
sensors, the soil forecast and the valve. History shows any past day the node has logged.
Model runs the on-board models on a chosen soil history and keeps score of past forecasts.
Settings holds the watering rules.

## USB link

When the node has no WiFi it can still reach the broker through a computer. Plug it in by
USB, open Settings and press "Connect the node by USB", then pick the port. The node writes
what it would have published on its serial port, and `usb.js` publishes it with a broker
connection of its own and sends the node's commands back down the cable. Every other open
dashboard, a phone included, stays live.

- Works in Chrome and Edge on Windows, macOS, Linux and ChromeOS. Firefox and Safari have no
  Web Serial.
- The tab has to stay open. Closing it marks the node offline through a last will.
- A port chosen once is reopened on its own after a reload or a replug. Press Disconnect
  before flashing, or the upload finds the port busy.
- On Linux the user needs to be in the group that owns the port, `uucp` on Arch and
  `dialout` on Debian and Ubuntu.
- If the node is on WiFi it keeps its own connection and the link stands by.

Five files, no build step: `index.html`, `style.css`, `app.js`, `charts.js`, `usb.js`.
