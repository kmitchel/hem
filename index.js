//Spawn rrdtool child process. Update RRD files.
let spawn = require("child_process").spawn
let child = spawn("rrdtool", ["-"])

child.stdout.on("data", function (data) {
    if (data.toString().indexOf("OK") !== 0) {
        console.log(data.toString())
    }
})

child.stderr.on("data", function (data) {
    console.error(data.toString())
})

//Webserver
let express = require("express")
let compression = require("compression")
let app = express()
let server = require("http").Server(app)
server.listen(8080)

app.use(compression())

require("./rrd-graphs").register(app, {
    root: __dirname, spawn, SunCalc: require("suncalc")
})

let lastPulseTime = {};

function updateHistogram(db, topic, value) {
    let bucket = Math.floor(value / 10) * 10;
    let key = "hist-" + topic + "-" + bucket;
    db.get(key, function (error, data) {
        if (error) {
            db.put(key, 1);
        } else {
            db.put(key, Number(data) + 1);
        }
    });
}

let leveldb = require("level")("./hemdb", {
    valueEncoding: "json"
})

const { createMeasurements, registry } = require("./measurements")
const measurements = createMeasurements()
require("./data-api").registerDataRoutes(app, leveldb)
app.get("/api/sensors", function (req, res) {
    res.setHeader("Cache-Control", "no-store")
    res.json(measurements.snapshot())
})

app.get("/dump/:collection", function (req, res) {
    let out = []
    leveldb.createReadStream({ gt: req.params.collection + "-", lt: req.params.collection + "." })
        .on("data", function (data) {
            out.push([data.key, data.value])
        })
        .on("end", function () {
            res.json(out)
        })
})

app.get("/histogram", function (req, res) {
    let out = []
    leveldb.createReadStream({ gt: "power-W-00-", lt: "power-W-00." })
        .on("data", function (data) {
            out.push(data.value)
        })
        .on("end", function () {
            res.json([{ type: "histogram", baseSeries: 1, binsNumber: 50 }, { visible: false, data: out }])
        })
})

app.use(express.static(__dirname + "/public"))

let mqtt = require("mqtt")
let client = mqtt.connect("mqtt://localhost", {
    clientId: "raspberrypi" + Math.random().toString(16).substr(2, 8)
})

client.on("connect", function () {
    client.subscribe([
        ...registry.entries.map(entry => entry.topic),
        "hvac/state", "hvac/tempSource",
        ...Object.keys(registry.roomLabels).flatMap(room =>
            ["status", "ip", "rssi", "espnow"].map(field => "sensor/" + room + "/" + field))
    ])
})

let outsideTemp = null
let lastControlTempUpdate = 0

client.on("message", function (topic, message, packet = {}) {
    const accepted = measurements.receive(topic, message, Date.now(), packet)
    if (topic !== "hvac/state" && !accepted) return
    if (topic === "hvac/state" && packet.retain) return
    switch (topic) {
        case "power/W":
            child.stdin.write("update " + __dirname + "/hem-w.rrd N:" + Number(message.toString()) + "\n")
            break
        case "water/GPM":
            child.stdin.write("update " + __dirname + "/hem-gpm.rrd N:" + Number(message.toString()) + "\n")
            break
        case "hvac/controlTempF": {
            let ctrlTemp = Number(message.toString())
            if (Number.isFinite(ctrlTemp)) {
                lastControlTempUpdate = Date.now()
                child.stdin.write("update " + __dirname + "/hem-in.rrd N:" + ctrlTemp + "\n")
            }
            break
        }
        case "temp/room1/tempF": {
            if (Date.now() - lastControlTempUpdate > 45000) {
                let r1Temp = Number(message.toString())
                if (Number.isFinite(r1Temp)) {
                    child.stdin.write("update " + __dirname + "/hem-in.rrd N:" + r1Temp + "\n")
                }
            }
            break
        }
        case "temp/room1/dewF":
            child.stdin.write("update " + __dirname + "/hem-dew.rrd N:" + Number(message.toString()) + "\n")
            break
        case "temp/room1/rh":
            child.stdin.write("update " + __dirname + "/hem-rh.rrd N:" + Number(message.toString()) + "\n")
            break
        case "temp/284a046d4c2001a3":
            let newTemp = Number(message.toString())
            if (!Number.isFinite(newTemp)) {
                console.error("Invalid outside temperature:", message.toString())
                break
            }

            if (Number.isFinite(outsideTemp)) {
                outsideTemp = outsideTemp * 0.99375 + newTemp * 0.00625
            } else {
                outsideTemp = newTemp
            }

            child.stdin.write("update " + __dirname + "/hem-out.rrd N:" + outsideTemp + "\n")
//              child.stdin.write("update " + __dirname + "/hem-out.rrd N:" + Number(message.toString()) + "\n")
            break
        case "temp/2809853f030000a7":
            child.stdin.write("update " + __dirname + "/hem-upper.rrd N:" + Number(message.toString()) + "\n")
            break
        case "temp/2813513f03000072":
            child.stdin.write("update " + __dirname + "/hem-lower.rrd N:" + Number(message.toString()) + "\n")
            break
        case "temp/289fa756b5013c68":
            child.stdin.write("update " + __dirname + "/hem-achigh.rrd N:" + Number(message.toString()) + "\n")
            break
        case "temp/2874913c46200105":
            child.stdin.write("update " + __dirname + "/hem-aclow.rrd N:" + Number(message.toString()) + "\n")
            break
        case "hvac/state":
            if (message.toString() == "Heating" || message.toString() == "HeatOn") {
                child.stdin.write("update " + __dirname + "/hem-heat.rrd N:100\n")
            } else {
                child.stdin.write("update " + __dirname + "/hem-heat.rrd N:0\n")
            }
            if (message.toString() == "Cooling" || message.toString() == "CoolOn") {
                child.stdin.write("update " + __dirname + "/hem-cool.rrd N:100\n")
            } else {
                child.stdin.write("update " + __dirname + "/hem-cool.rrd N:0\n")
            }
            break
    }

    const collection = accepted ? accepted.entry.collection : null
    if (accepted && accepted.entry.archive !== false) {
        insertNow(leveldb, collection, accepted.value)
        insertAvg(leveldb, collection, accepted.value)
    }

    if (topic === "hvac/state") {
        if (message.toString() === "Cooling" || message.toString() === "CoolOn") {
            updateCnt(leveldb, "hvac-cool", 0.25)
        } else if (message.toString() === "Heating" || message.toString() === "HeatOn") {
            updateCnt(leveldb, "hvac-heat", 0.25)
        }
        for (const mode of ["cool", "heat"]) {
            leveldb.get("hvac-" + mode + "-28-" + getMonthBucket(), function (error, data) {
                if (!error && typeof data === "number" && Number.isFinite(data)) {
                    client.publish("hvac/" + mode + "Time", data.toFixed(2))
                }
            })
        }
    } else if (accepted.entry.kind === "power") {
        const now = performance.timeOrigin + performance.now()
        if (lastPulseTime[collection]) {
            updateHistogram(leveldb, collection + "-delta", now - lastPulseTime[collection])
        }
        lastPulseTime[collection] = now
        updateCnt(leveldb, "power-kWh", 0.001)
        leveldb.get("power-kWh-28-" + getMonthBucket(), function (error, data) {
            if (!error && typeof data === "number" && Number.isFinite(data)) {
                client.publish("power/kWh", data.toFixed(3))
            }
        })
    } else if (accepted.entry.kind === "water") {
        updateCnt(leveldb, "water-Gal", 0.25)
        leveldb.get("water-Gal-28-" + getMonthBucket(), function (error, data) {
            if (!error && typeof data === "number" && Number.isFinite(data)) {
                client.publish("water/Gal", data.toFixed(2))
            }
        })
    }
})

function getMonthBucket() {
    let month
    if (new Date().getDate() > 6) {
        month = new Date().getMonth()
    } else {
        month = new Date().getMonth() - 1
    }
    return new Date(new Date().getFullYear(), month, 7).getTime()
}

function insertNow(db, topic, message) {
    let key = topic + "-00-" + (performance.timeOrigin + performance.now()).toFixed(3)
    db.put(key, Number(message))
}

function insertAvg(db, topic, message) {
    let buckets = [
        ["01", Math.floor(Date.now() / (1 * 60 * 1000)) * 1 * 60 * 1000],
        ["05", Math.floor(Date.now() / (5 * 60 * 1000)) * 5 * 60 * 1000],
        [15, Math.floor(Date.now() / (15 * 60 * 1000)) * 15 * 60 * 1000],
        [60, Math.floor(Date.now() / (60 * 60 * 1000)) * 60 * 60 * 1000],
        [24, new Date().setHours(0, 0, 0, 0)],
        [28, getMonthBucket()]
    ]

    buckets.forEach(function (currentValue) {
        let key = topic + "-" + currentValue[0] + "-" + currentValue[1]
        db.get(key, function (error, data) {
            if (error) {
                db.put(key, [
                    1,
                    Number(message),
                    Number(message),
                    Number(message)
                ])
            } else {
                data[0] += 1
                data[1] += Number(message)
                data[2] = Math.min(data[2], Number(message))
                data[3] = Math.max(data[3], Number(message))
                db.put(key, data)
            }
        })
    })
}

function updateCnt(db, topic, incValue) {
    let buckets = [
        ["01", Math.floor(Date.now() / (1 * 60 * 1000)) * 1 * 60 * 1000],
        ["05", Math.floor(Date.now() / (5 * 60 * 1000)) * 5 * 60 * 1000],
        [15, Math.floor(Date.now() / (15 * 60 * 1000)) * 15 * 60 * 1000],
        [60, Math.floor(Date.now() / (60 * 60 * 1000)) * 60 * 60 * 1000],
        [24, new Date().setHours(0, 0, 0, 0)],
        [28, getMonthBucket()]
    ]

    buckets.forEach(function (currentValue) {
        let key = topic + "-" + currentValue[0] + "-" + currentValue[1]
        db.get(key, function (error, data) {
            if (error) {
                db.put(key, incValue)
            } else {
                db.put(key, Number(Number(data + incValue).toFixed(3)))
            }
        })
    })
}

// Run at startup and every 30 minutes; see retention.js for the policy.
const intervalObj = require("./retention").startRetention(leveldb)
