require('dotenv').config();
const ModbusRTU = require("modbus-serial");
const express = require('express');
const path = require('path');
const mongoose = require('mongoose');
const cors = require('cors');
const nodemailer = require('nodemailer');
const compression = require('compression');

// ===== MongoDB Setup =====
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/dieselDB";
const mongooseOptions = {
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 45000,
    connectTimeoutMS: 10000,
    maxPoolSize: 10,
    minPoolSize: 2,
    retryWrites: true,
    retryReads: true,
    bufferCommands: false,
    autoIndex: true
};
let isMongoConnected = false;
let connectionAttempts = 0;
const MAX_RETRY_ATTEMPTS = 3;
async function connectMongoDB() {
    connectionAttempts++;
    try {
        console.log(`MongoDB connection attempt ${connectionAttempts}/${MAX_RETRY_ATTEMPTS}...`);
        await mongoose.connect(MONGODB_URI, mongooseOptions);
        console.log('MongoDB Connected');
        isMongoConnected = true;
        connectionAttempts = 0;
    } catch (err) {
        console.error('MongoDB Connection Error:', err.message);
        if (connectionAttempts < MAX_RETRY_ATTEMPTS) {
            setTimeout(connectMongoDB, 5000);
        } else {
            console.log('MongoDB unavailable - running without persistence.');
        }
        isMongoConnected = false;
    }
}
mongoose.connection.on('connected', () => { isMongoConnected = true; });
mongoose.connection.on('disconnected', () => { isMongoConnected = false; setTimeout(connectMongoDB, 5000); });
mongoose.connection.on('error', () => { isMongoConnected = false; });
connectMongoDB();

// ===== Email Setup =====
let emailTransporter = null;
let emailEnabled = false;
try {
    if (process.env.EMAIL_USER && process.env.EMAIL_APP_PASSWORD) {
        emailTransporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_APP_PASSWORD
            }
        });
        emailEnabled = true;
        console.log('Email alerts enabled');
    }
} catch (_) { emailEnabled = false; }
const ALERT_RECIPIENTS = process.env.ALERT_RECIPIENTS || '';
const ALERT_COOLDOWN = parseInt(process.env.ALERT_COOLDOWN) || 1800000; // 30 minutes for critical
const OPERATIONAL_EMAIL_INTERVAL = 180000; // 3 minutes operational snapshot
const CRITICAL_DIESEL_LEVEL = parseInt(process.env.CRITICAL_DIESEL_LEVEL) || 50;

// ===== DieselReading schema =====
const DieselReadingSchema = new mongoose.Schema({
    timestamp: { type: Date, default: Date.now, index: true },
    dg1: { type: Number, required: true },
    dg2: { type: Number, required: true },
    dg3: { type: Number, required: true },
    total: { type: Number, required: true },
    dg1_change: { type: Number, default: 0 },
    dg2_change: { type: Number, default: 0 },
    dg3_change: { type: Number, default: 0 },
    hour: { type: Number, index: true },
    date: { type: String, index: true },
    electrical: { type: Object, default: {} }
});
DieselReadingSchema.index({ date: 1, hour: 1 });
DieselReadingSchema.index({ timestamp: -1 });
const DieselReading = mongoose.model('DieselReading', DieselReadingSchema);

// ===== Modbus Setup =====
const client = new ModbusRTU();
const port = process.env.PLC_PORT || '/dev/ttyUSB0';
const plcSettings = {
    baudRate: parseInt(process.env.PLC_BAUD_RATE) || 9600,
    parity: process.env.PLC_PARITY || 'none',
    dataBits: parseInt(process.env.PLC_DATA_BITS) || 8,
    stopBits: parseInt(process.env.PLC_STOP_BITS) || 1
};
const plcSlaveID = parseInt(process.env.PLC_SLAVE_ID) || 1;

// Register addresses for diesel levels
const dgRegisters = {
    dg1: { address: 4104, name: "DG-1" },
    dg2: { address: 4100, name: "DG-2" },
    dg3: { address: 4102, name: "DG-3" }
};
// Register addresses for electrical parameters and scaling factors
const electricalRegisters = {
    dg1: {
        voltageR: { addr: 4196, scaling: 0.1 }, voltageY: { addr: 4198, scaling: 0.1 }, voltageB: { addr: 4200, scaling: 0.1 },
        currentR: { addr: 4202, scaling: 0.1 }, currentY: { addr: 4204, scaling: 0.1 }, currentB: { addr: 4206, scaling: 0.1 },
        frequency: { addr: 4208, scaling: 0.1 }, powerFactor: { addr: 4210, scaling: 0.01 },
        activePower: { addr: 4212, scaling: 0.1 }, reactivePower: { addr: 4214, scaling: 0.1 },
        energyMeter: { addr: 4216, scaling: 1 }, runningHours: { addr: 4218, scaling: 1 }, windingTemp: { addr: 4232, scaling: 1 }
    },
    dg2: {
        voltageR: { addr: 4236, scaling: 0.1 }, voltageY: { addr: 4238, scaling: 0.1 }, voltageB: { addr: 4240, scaling: 0.1 },
        currentR: { addr: 4242, scaling: 0.1 }, currentY: { addr: 4244, scaling: 0.1 }, currentB: { addr: 4246, scaling: 0.1 },
        frequency: { addr: 4248, scaling: 0.1 }, powerFactor: { addr: 4250, scaling: 0.01 },
        activePower: { addr: 4252, scaling: 0.1 }, reactivePower: { addr: 4254, scaling: 0.1 },
        energyMeter: { addr: 4256, scaling: 1 }, runningHours: { addr: 4258, scaling: 1 }, windingTemp: { addr: 4272, scaling: 1 }
    },
    dg3: {
        voltageR: { addr: 4276, scaling: 0.1 }, voltageY: { addr: 4278, scaling: 0.1 }, voltageB: { addr: 4280, scaling: 0.1 },
        currentR: { addr: 4282, scaling: 0.1 }, currentY: { addr: 4284, scaling: 0.1 }, currentB: { addr: 4286, scaling: 0.1 },
        frequency: { addr: 4288, scaling: 0.1 }, powerFactor: { addr: 4290, scaling: 0.01 },
        activePower: { addr: 4292, scaling: 0.1 }, reactivePower: { addr: 4294, scaling: 0.1 },
        energyMeter: { addr: 4296, scaling: 1 }, runningHours: { addr: 4298, scaling: 1 }, windingTemp: { addr: 4312, scaling: 1 }
    }
};

// DG ON status register addresses (replace with your actual addresses)
const dgStatusRegisters = {
    dg1: 4000, // example address for DG1 ON/OFF status register
    dg2: 4001,
    dg3: 4002
};

// System state
let systemData = {
    dg1: 0, dg2: 0, dg3: 0,
    total: 0,
    electrical: { dg1: {}, dg2: {}, dg3: {} },
    dg1_is_on: false,
    dg2_is_on: false,
    dg3_is_on: false,
    lastUpdate: null
};

let lastSavedHour = -1;
let alertState = { currentAlerts: new Set() };
let lastOperationalEmailSent = 0;

// Utility functions
function toSignedInt16(value) { return value > 32767 ? value - 65536 : value; }
function isValidReading(value) {
    const val = toSignedInt16(value);
    return !(value === 65535 || value === 65534 || val === -1) && (val >= 0 && val <= 600);
}
function smoothValue(newVal, oldVal, maxChangePercent = 50) {
    if (!oldVal) return newVal;
    const change = Math.abs((newVal - oldVal) / oldVal * 100);
    return change > maxChangePercent ? oldVal : newVal;
}

// Email sending helper
async function sendEmail(subject, html) {
    if (!emailEnabled || !ALERT_RECIPIENTS) return false;
    try {
        await emailTransporter.sendMail({
            from: `"DG Monitoring System" <${process.env.EMAIL_USER}>`,
            to: ALERT_RECIPIENTS,
            subject,
            html
        });
        console.log("Email sent:", subject);
        return true;
    } catch (e) {
        console.error("Email error:", e.message);
        return false;
    }
}

// Read a single register
async function readHoldingRegister(addr) {
    try {
        const data = await client.readHoldingRegisters(addr, 1);
        if (!data || !data.data || data.data.length === 0) return null;
        return data.data[0];
    } catch (e) {
        console.error("Modbus error reading register", addr, e.message);
        return null;
    }
}

// Poll DG status and detect ON edge
async function pollDGStatus() {
    for (const dg of ["dg1", "dg2", "dg3"]) {
        const reg = dgStatusRegisters[dg];
        const val = await readHoldingRegister(reg);
        const isOn = val === 1;
        if (isOn && !systemData[`${dg}_is_on`]) {
            systemData[`${dg}_is_on`] = true;
            console.log(`${dg.toUpperCase()} turned ON`);
            await sendEmail(`${dg.toUpperCase()} Started`, `<p>DG ${dg.toUpperCase()} is started at ${new Date().toLocaleString()}.</p>`);
        } else if (!isOn && systemData[`${dg}_is_on`]) {
            systemData[`${dg}_is_on`] = false;
            console.log(`${dg.toUpperCase()} turned OFF`);
        }
    }
}

// Read diesel registers with smoothing
async function readDiesel() {
    for (const dg of ["dg1", "dg2", "dg3"]) {
        const reg = dgRegisters[dg].address;
        let val = await readHoldingRegister(reg);
        if (val === null || !isValidReading(val)) val = systemData[dg];
        else val = toSignedInt16(val);
        val = Math.max(0, val);
        val = smoothValue(val, systemData[dg], 30);
        systemData[dg] = val;
    }
    systemData.total = systemData.dg1 + systemData.dg2 + systemData.dg3;
}

// Read electrical parameters for a DG
async function readElectricalParams(dg) {
    const params = electricalRegisters[dg];
    const result = {};
    for (const [key, { addr, scaling }] of Object.entries(params)) {
        let val = await readHoldingRegister(addr);
        if (val === null) val = 0;
        val = val * scaling;
        val = Math.round(val * 100) / 100;
        result[key] = val;
    }
    systemData.electrical[dg] = result;
}

// Read all data (status, diesel, electrical)
async function readAllData() {
    await pollDGStatus();
    await readDiesel();
    await Promise.all(["dg1", "dg2", "dg3"].map(readElectricalParams));
    systemData.lastUpdate = new Date().toISOString();
    await saveHourlyData();
    sendOperationalEmail();
}

// Save hourly data to MongoDB
async function saveHourlyData() {
    if (mongoose.connection.readyState !== 1) return;
    const now = new Date();
    const currentHour = now.getHours();
    if (currentHour === lastSavedHour) return; // Save only once per hour
    const changes = {
        dg1_change: systemData.dg1 - (previousReading?.dg1 || 0),
        dg2_change: systemData.dg2 - (previousReading?.dg2 || 0),
        dg3_change: systemData.dg3 - (previousReading?.dg3 || 0)
    };
    const reading = new DieselReading({
        timestamp: now,
        dg1: systemData.dg1, dg2: systemData.dg2, dg3: systemData.dg3,
        total: systemData.total,
        hour: currentHour,
        date: now.toISOString().slice(0, 10),
        dg1_change: changes.dg1_change,
        dg2_change: changes.dg2_change,
        dg3_change: changes.dg3_change,
        electrical: systemData.electrical
    });
    await reading.save();
    lastSavedHour = currentHour;
    previousReading = {...systemData};
    console.log("Saved hourly data");
}

// Send operational email every 3 minutes
const lastOperationalMailSentAt = { time: 0 };
async function sendOperationalEmail() {
    const now = Date.now();
    if (now - lastOperationalMailSentAt.time < OPERATIONAL_EMAIL_INTERVAL) return;
    lastOperationalMailSentAt.time = now;
    const subject = "DG Monitoring - Latest Data Snapshot";
    const dieselHtml = `
        <h3>Diesel Levels</h3>
        <ul>
            <li>DG1: ${systemData.dg1}L</li>
            <li>DG2: ${systemData.dg2}L</li>
            <li>DG3: ${systemData.dg3}L</li>
            <li>Total: ${systemData.total}L</li>
        </ul>
    `;
    let electricalHtml = "<h3>Electrical Parameters</h3>";
    for (const dg of ["dg1", "dg2", "dg3"]) {
        electricalHtml += `<h4>${dg.toUpperCase()}</h4><ul>`;
        for (const [param, val] of Object.entries(systemData.electrical[dg] || {})) {
            electricalHtml += `<li>${param}: ${val}</li>`;
        }
        electricalHtml += "</ul>";
    }
    await sendEmail(subject, dieselHtml + electricalHtml);
}

// PLC connect and start polling loop
function connectToPLC() {
    client.connectRTU(port, plcSettings)
        .then(() => {
            console.log(`Connected to PLC at ${port}`);
            client.setID(plcSlaveID);
            client.setTimeout(3000);
            readAllData();
            setInterval(readAllData, 2000);
        })
        .catch(e => {
            console.error("PLC Connection error:", e.message);
            client.close();
            setTimeout(connectToPLC, 5000);
        });
}

// Express and API setup
const app = express();
const webServerPort = parseInt(process.env.PORT) || 3000;

app.use(compression());
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(__dirname, { maxAge: "1d", etag: true, lastModified: true }));

app.get("/", (req, res) => {
res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/api/data", (req, res) => {
    res.json(systemData);
});

app.get("/api/health", (req, res) => {
    res.json({
        success: true,
        mongodb: isMongoConnected ? "connected" : "disconnected",
        lastUpdate: systemData.lastUpdate,
        dgStatus: {
            dg1: systemData.dg1_is_on,
            dg2: systemData.dg2_is_on,
            dg3: systemData.dg3_is_on
        }
    });
});

process.on("SIGINT", async () => {
    console.log("Shutting down...");
    client.close();
    await mongoose.connection.close();
    process.exit(0);
});
process.on("SIGTERM", async () => {
    console.log("Shutting down...");
    client.close();
    await mongoose.connection.close();
    process.exit(0);
});

app.listen(webServerPort, () => {
    console.log(`Server running on port ${webServerPort}`);
    connectToPLC();
});
