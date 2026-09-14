# Irrigation node dashboard

A single web page that shows a soil moisture node live. It connects straight to the MQTT
broker from the browser over a secure WebSocket, so there is no server in between.

Open the page, enter the broker password once, and the readings appear. Dashboard shows the
sensors, the soil forecast and the valve. Model runs the on-board models on a chosen soil
history and keeps score of past forecasts. Settings holds the watering rules.

Four files, no build step: `index.html`, `style.css`, `app.js`, `charts.js`.
