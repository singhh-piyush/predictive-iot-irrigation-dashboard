# Irrigation node dashboard

A single web page that shows a soil moisture node live. It connects straight to the MQTT
broker from the browser over a secure WebSocket, so there is no server in between.

Open the page, enter the broker password once, and the readings appear. Dashboard shows the
sensors, the soil forecast, the weather the models read and the valve. History shows any past
day the node has logged. Model shows every input the node gave its models and what each one
predicted, runs the on-board models on a chosen soil history and keeps score of past
forecasts. Settings holds the watering rules.

The node sends soil, rain and light once a second and the air and soil temperatures every
five seconds. Each message is added to the end of the charts as it arrives, so the lines
move with the pot. The forecast reruns within about five seconds of a move in the soil, and
the countdown box flashes when a new one comes in.

After every opening the node watches for the soil to rise. A notice at the top of every page
counts down while it waits, confirms when the water arrives and raises an alert when it does
not, which suggests checking the tank, the pump and the tubing. How long to wait and how
big a rise counts are under Settings, with a switch for a system notification as well.

## Assistant

The round button at the bottom right opens a chat. Ask it how the plant is doing, what the
forecast means or how the model works, or tell it to water, close the valve or change a
setting. Answers come with cards in the same style as the page: readings, the forecast
chart, the weather, the model's inputs, how past forecasts did, a past day, and for a
watering a countdown with a switch to stop it and the result of the watering check. It also
posts on its own when a watering fails, when the forecast turns to water, when the node
goes offline and when rain is on the way.

It runs on gpt-oss-120b through Fireworks, called straight from the browser. Paste a
Fireworks API key under Settings, Chat. The key is kept in that browser only and is never
part of this repository. `chat.js` holds the panel, tools and cards, `knowledge.js` the
project summary the model is given.

## Weather

The models read Open-Meteo's hourly forecast for Durban, the same feed they were trained on.
The node fetches it every hour on WiFi and publishes the day behind and the day ahead on
`irrigation/node1/weather`, which the weather card draws.

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
- While the page carries the link it also fetches the node's weather every hour and sends
  it down the cable, since the node cannot download it without WiFi.

Seven files, no build step: `index.html`, `style.css`, `app.js`, `charts.js`, `usb.js`,
`chat.js`, `knowledge.js`.
