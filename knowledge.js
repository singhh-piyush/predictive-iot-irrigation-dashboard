// What the assistant knows about the project, beyond the live numbers it is sent
const KNOWLEDGE = `
The project: predictive soil moisture estimation for proactive irrigation, a final year
engineering project. Ordinary automatic irrigation is reactive. It waters once the soil has
already dropped below a fixed level, and it can water just before rain that would have done
the job anyway. This system forecasts how the soil moisture will change over the next 24
hours, so it can water before the soil gets too dry and hold off when rain is coming.

The hardware: an ESP32-S3 node in a potted plant. It has a capacitive soil moisture probe,
a DS18B20 soil temperature probe, a DHT11 for air temperature and humidity, a rain plate, a
light sensor and a valve on a relay. It reads soil, rain and light every second and the two
temperatures every five seconds, and talks to an MQTT broker (HiveMQ Cloud) over WiFi. With
no WiFi it can be plugged into a laptop and the dashboard carries its data over USB. It
keeps working with no network at all, because the models run on the node itself.

Soil moisture is shown as relative saturation, 0 % at the probe's dry reading and 100 % at
its wet reading: (raw - dry) / (wet - dry). Absolute water content does not carry over
between sensors and soils, relative saturation does, which is what lets models trained on
research stations work with a cheap probe.

The models: five gradient boosted tree models, one for each horizon, 2, 4, 8, 16 and 24
hours ahead. Each predicts the change in soil moisture from now, not the level, because
over a few hours the level is mostly just its current value and predicting it would look
good while learning nothing. Joining the five predictions gives the 24 hour trajectory on
the dashboard. The models were trained with a quantile loss at 0.3, which makes them lean
towards predicting drier soil, so the node waters a little early rather than late. They
were converted to plain C and run on the ESP32 in about 44 ms for all five.

Inputs: the 2 hour model reads 44 numbers and the 24 hour model 64. They are the soil
moisture now with its values 1 to 24 hours back and how much it changed over 1, 2, 3, 6 and
24 hours; the weather so far (temperature, humidity, wind, sunlight, rain over the last 3,
6, 24 and 72 hours); the forecast ahead for each horizon (rain, sunlight, temperature,
humidity, wind); and the time of day and season as sine and cosine.

Training data: twelve NOAA USCRN soil moisture stations across the United States, with
weather from Open-Meteo's historical forecast archive, which stores forecasts as they were
issued so the model learned with the same forecast uncertainty it faces live. The node uses
Open-Meteo too, so the inputs have the same source and units. Splits were chronological,
tested on each station's final year.

Skill: the models are scored against persistence, which assumes the soil stays as it is.
Skill = 1 - model error / no-change error, with errors squared. 1 is perfect, 0 is no
better than no change, below 0 is worse. Pooled training skill is about 0.05 at 2 h, 0.08 at
4 h, 0.13 at 8 h and 0.20 at 16 and 24 h. Short horizons are hard to beat because the soil
barely moves in two hours. The node also checks every live forecast against what the probe
later measured, and keeps a daily scorecard.

Site and clock: the plant is in Durban, South Africa. The models learned time of day and
season at US stations, where the sun peaks at 18:00 UTC and July is summer. So the node
moves the clock the models see on by 8 hours and 182 days, putting Durban's midday sun and
season where training saw them. Weather lookups use the real time.

Watering: the node finds when the forecast trajectory first falls to the watering level
(threshold). If that is within the lead time (2 hours by default) the decision is "water",
otherwise "hold". With automatic watering on, the node opens the valve for a short pulse,
at most once an hour. The valve can also be opened from the dashboard, the button on the
node, or this chat. Any opening counts as a watering.

Watering check: after every opening the node watches the soil. If the moisture rises by the
needed amount (3 % by default) the water arrived. If it has not risen within the wait (120 s
by default) the check fails, which means the tank is empty, the pump failed, a tube came off
or the emitter is blocked. Both numbers are in Settings.

The demo is indoors, so the rain plate and the forecast rain do not reach the pot. The
probe calibration is provisional until it is measured in the pot.
`;
