'use strict';
document.addEventListener('DOMContentLoaded', () => {
    if (typeof mqtt === 'undefined') return;

            const host = window.location.hostname;
            const client = mqtt.connect(`${location.protocol === "https:" ? "wss" : "ws"}://${host}:9001`);
            let flowTimer;
//console.log(client)

            client.on("error", (err) => {
                console.error("MQTT Error:", err);
                client.end();
            });

            client.on("connect", () => {
                console.log("Connected to MQTT broker");
                client.subscribe("#");
            });

            client.on("message", (topic, message) => {
                const msgStr = message.toString();
                const updateHTML = (id, val) => {
                    const el = document.getElementById(id);
                    if (el) {
                        const lines = String(val).split('<br>');
                        el.replaceChildren(...lines.flatMap((line, i) => i ? [document.createElement('br'), document.createTextNode(line)] : [document.createTextNode(line)]));
                    }
                };

                switch (topic) {
                    case "hvac/state": updateHTML("state", msgStr); break;
                    case "power/W": updateHTML("power", `Current Power: ${msgStr}W`); break;
                    case "temp/284a046d4c2001a3": updateHTML("out", `Outside Temp: ${msgStr}F`); break;
                    case "temp/2809853f030000a7": updateHTML("upper", `Upper WH Temp: ${msgStr}F`); break;
                    case "temp/2813513f03000072": updateHTML("lower", `Lower WH Temp: ${msgStr}F`); break;
                    case "temp/289fa756b5013c68": updateHTML("achigh", `High AC Temp: ${msgStr}F`); break;
                    case "temp/2874913c46200105": updateHTML("aclow", `Low AC Temp: ${msgStr}F`); break;
                    case "water/Gal": updateHTML("gal", `Gallons: ${msgStr}`); break;
                    case "water/GPM":
                        updateHTML("gpm", `${msgStr} GPM`);
                        clearTimeout(flowTimer);
                        flowTimer = setTimeout(() => updateHTML("gpm", '0 GPM (no flow)'), 60000);
                        break;
                    case "hvac/controlTempF": updateHTML("t", `Controller temperature: ${parseFloat(msgStr).toFixed(1)}F`); break;
                    case "temp/room1/rh": updateHTML("rh", `RH: ${msgStr}%`); break;
                    case "temp/room1/dewF": updateHTML("dew", `DEW: ${msgStr}F`); break;
                    case "hvac/coolTime": updateHTML("cool", `Cool Runtime: ${msgStr} Min`); break;
                    case "hvac/heatTime": updateHTML("heat", `Heat Runtime: ${msgStr} Min`); break;

                    case "power/kWh":
                        const kwh = Number(msgStr);
                        let cost = 25;
                        if (kwh > 500) {
                            cost += (500 * 0.123131) + ((kwh - 500) * 0.104397);
                        } else {
                            cost += kwh * 0.123131;
                        }
                        cost += (kwh * 0.021983) + (kwh * 0.000390);
                        cost *= 1.07;

                        const now = new Date();
                        const month = now.getDate() > 6 ? now.getMonth() : now.getMonth() - 1;
                        const startOfCycle = new Date(now.getFullYear(), month, 7).getTime();
                        const endOfCycle = new Date(now.getFullYear(), month + 1, 7).getTime();

                        const projectedkWh = kwh / (now.getTime() - startOfCycle) * (endOfCycle - startOfCycle);
                        let projectedCost = 25;
                        if (projectedkWh > 500) {
                            projectedCost += (500 * 0.123131) + ((projectedkWh - 500) * 0.104397);
                        } else {
                            projectedCost += projectedkWh * 0.123131;
                        }
                        projectedCost += (projectedkWh * 0.021983) + (projectedkWh * 0.000390);
                        projectedCost *= 1.07;

                        updateHTML("kWh", `${msgStr} kWh @ $${cost.toFixed(2)}<br>Projected Monthly Cost: ${projectedkWh.toFixed(2)}kWh @ $${projectedCost.toFixed(2)}`);
                        break;
                }
            });
        });
