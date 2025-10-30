require('dotenv').config();
const ModbusRTU = require("modbus-serial");
const express = require('express');
const path = require('path');
const mongoose = require('mongoose');
const cors = require('cors');
const nodemailer = require('nodemailer');
const compression = require('compression');

// Utility function for deep comparison of electrical data
function deepEqual(obj1, obj2) {
    if (obj1 === obj2) return true;
    if (typeof obj1 !== 'object' || obj1 === null || typeof obj2 !== 'object' || obj2 === null) return false;

    const keys1 = Object.keys(obj1);
    const keys2 = Object.keys(obj2);

    if (keys1.length !== keys2.length) return false;

    for (const key of keys1) {
        if (!keys2.includes(key) || !deepEqual(obj1[key], obj2[key])) return false;
    }

    return true;
}

// ====== MongoDB Setup and Error Handling ======
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
        console.log('MongoDB Connected Successfully');
        isMongoConnected = true;
        connectionAttempts = 0;
    } catch (err) {
        console.error('MongoDB Connection Error:', err.message);
        if (connectionAttempts < MAX_RETRY_ATTEMPTS) {
            setTimeout(connectMongoDB, 5000);
        } else {
            console.log('MongoDB unavailable after multiple attempts. Running without persistence.');
        }
        isMongoConnected = false;
    }
}
mongoose.connection.on('connected', () => { isMongoConnected = true; });
mongoose.connection.on('disconnected', () => { isMongoConnected = false; setTimeout(connectMongoDB, 5000); });
mongoose.connection.on('error', () => { isMongoConnected = false; });
connectMongoDB();

// ====== Email Setup ======
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

const alertState = { lastAlertTime: {}, currentAlerts: new Set() };
const ALERT_COOLDOWN = parseInt(process.env.ALERT_COOLDOWN) || 1800000; // 30 minutes for Critical
const CRITICAL_LEVEL = parseInt(process.env.CRITICAL_DIESEL_LEVEL) || 50;
const ALERT_RECIPIENTS = process.env.ALERT_RECIPIENTS || '';

// *** IMPORTANT: Operational alert sent only on data change, but max once every 5 minutes (flood prevention) ***
const OPERATIONAL_CONFIRM_COOLDOWN = 300000; 

// ====== DieselReading Schema and Caching ======
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
    date: { type: String, index: true }
});
DieselReadingSchema.index({ date: 1, hour: 1 });
DieselReadingSchema.index({ timestamp: -1 });
const DieselReading = mongoose.model('DieselReading', DieselReadingSchema);

let dataCache = {
    hourly: null,
    daily: null,
    lastUpdate: null,
    cacheDuration: 5 * 60 * 1000
};

// ====== PLC Register Mapping (Remains the same) ======
const port = process.env.PLC_PORT || '/dev/ttyUSB0';
const plcSettings = {
    baudRate: parseInt(process.env.PLC_BAUD_RATE) || 9600,
    parity: process.env.PLC_PARITY || 'none',
    dataBits: parseInt(process.env.PLC_DATA_BITS) || 8,
    stopBits: parseInt(process.env.PLC_STOP_BITS) || 1
};
const plcSlaveID = parseInt(process.env.PLC_SLAVE_ID) || 1;

const dgRegisters = {
    dg1: { address: 4104, name: "DG-1" },
    dg2: { address: 4100, name: "DG-2" },
    dg3: { address: 4102, name: "DG-3" }
};

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

// ====== System Data State ======
let systemData = {
    dg1: 0, dg2: 0, dg3: 0, total: 0, lastUpdate: null,
    electrical: { dg1: {}, dg2: {}, dg3: {} }
};
// *** NEW STATE VARIABLE to track the electrical data sent in the last operational email ***
let lastConfirmedElectricalData = { dg1: {}, dg2: {}, dg3: {} }; 

let previousReading = null;
let previousDieselData = { dg1: 0, dg2: 0, dg3: 0 };
let lastSavedHour = -1;

// PLC client
const client = new ModbusRTU();
const app = express();
const webServerPort = parseInt(process.env.PORT) || 3000;
const piIpAddress = process.env.PI_IP_ADDRESS || '192.168.30.156';

// ... (Middleware Setup and Conversion Functions remain the same)
function toSignedInt16(value) { if (value > 32767) return value - 65536; return value; }
function isValidReading(value) {
    const signedValue = toSignedInt16(value);
    if (value === 65535 || value === 65534 || signedValue === -1) return false;
    return signedValue >= 0 && signedValue <= 600;
}
function smoothValue(currentValue, previousValue, maxChangePercent = 50) {
    if (previousValue === 0 || previousValue === null) return currentValue;
    const changePercent = Math.abs((currentValue - previousValue) / previousValue * 100);
    if (changePercent > maxChangePercent) return previousValue;
    return currentValue;
}

// Read Diesel One Register
async function readSingleRegister(address, name, dataKey) {
    try {
        const data = await client.readHoldingRegisters(address, 1);
        if (!data || !data.data || data.data.length < 1) return systemData[dataKey] || 0;
        const rawValue = data.data[0];
        if (!isValidReading(rawValue)) return systemData[dataKey] || 0;
        const signedValue = toSignedInt16(rawValue);
        let value = Math.max(0, signedValue);
        const previousValue = previousDieselData[dataKey] || 0;
        value = smoothValue(value, previousValue, 30);
        previousDieselData[dataKey] = value;
        systemData[dataKey] = value;
        return value;
    } catch (_) { return systemData[dataKey] || 0; }
}

// Read Electrical Register
async function readElectricalRegister(address, scaling, defaultValue = 0) {
    try {
        const data = await client.readHoldingRegisters(address, 1);
        if (!data || !data.data || data.data.length < 1) return defaultValue;
        const raw = data.data[0];
        if (raw === 65535 || raw === 65534 || raw < 0) return defaultValue;
        return Math.round(raw * scaling * 100) / 100;
    } catch (_) { return defaultValue; }
}
async function readAllElectrical(dgKey) {
    let result = {};
    const regs = electricalRegisters[dgKey];
    for (const key in regs) {
        const reg = regs[key];
        await new Promise(resolve => setTimeout(resolve, 50)); 
        result[key] = await readElectricalRegister(reg.addr, reg.scaling);
    }
    return result;
}

// Main System Data Polling
async function readAllSystemData() {
    try {
        // 1. Diesel Readings
        await readSingleRegister(dgRegisters.dg1.address, dgRegisters.dg1.name, 'dg1');
        await readSingleRegister(dgRegisters.dg2.address, dgRegisters.dg2.name, 'dg2');
        await readSingleRegister(dgRegisters.dg3.address, dgRegisters.dg3.name, 'dg3');
        systemData.total = (systemData.dg1 || 0) + (systemData.dg2 || 0) + (systemData.dg3 || 0);

        // 2. Electrical Readings
        systemData.electrical.dg1 = await readAllElectrical('dg1');
        systemData.electrical.dg2 = await readAllElectrical('dg2');
        systemData.electrical.dg3 = await readAllElectrical('dg3');

        // Update timestamp and trigger alerts/saving
        systemData.lastUpdate = new Date().toISOString();
        
        checkDieselLevels(systemData);
        await saveToDatabase(systemData);

        // 3. Operational Confirmation: Only send if data changed AND cooldown permits
        sendDataFetchedConfirmation(systemData);

    } catch (e) {
        console.error('Error reading system data:', e.message);
        client.close();
        setTimeout(connectToPLC, 5000);
    }
}

// ==== Diesel Change Calculation and DB Saving (Remains the same) ====
function calculateChange(current, previous) { if (!previous) return 0; return current - previous; }
async function saveToDatabase(data) {
    if (mongoose.connection.readyState !== 1) return;
    try {
        const now = new Date();
        const currentHour = now.getHours();
        if (currentHour === lastSavedHour) return;
        const dateString = now.toISOString().split('T')[0];
        const changes = {
            dg1_change: calculateChange(data.dg1, previousReading?.dg1),
            dg2_change: calculateChange(data.dg2, previousReading?.dg2),
            dg3_change: calculateChange(data.dg3, previousReading?.dg3)
        };
        const reading = new DieselReading({
            timestamp: now,
            dg1: data.dg1,
            dg2: data.dg2,
            dg3: data.dg3,
            total: data.total,
            hour: currentHour,
            date: dateString,
            ...changes
        });
        await reading.save();
        lastSavedHour = currentHour;
        previousReading = data;
        dataCache.hourly = null;
        dataCache.daily = null;
    } catch (e) { console.error('Error saving to DB:', e.message); }
}

// ===== Email Alerting and Diesel Check =====
function checkDieselLevels(data) {
    if (data.dg1 <= CRITICAL_LEVEL || data.dg2 <= CRITICAL_LEVEL || data.dg3 <= CRITICAL_LEVEL) {
        sendEmailAlert('critical', data, ALERT_COOLDOWN);
    }
}

// Helper to create the detailed electrical parameter list HTML
function getElectricalDetailsHtml(data) {
    let html = '';
    const electricalParamNames = {
        voltageR: 'Voltage R (V)', voltageY: 'Voltage Y (V)', voltageB: 'Voltage B (V)',
        currentR: 'Current R (A)', currentY: 'Current Y (A)', currentB: 'Current B (A)',
        frequency: 'Frequency (Hz)', powerFactor: 'Power Factor',
        activePower: 'Active Power (kW)', reactivePower: 'Reactive Power (kVAR)',
        energyMeter: 'Energy Meter (kWh)', runningHours: 'Running Hours (Hrs)',
        windingTemp: 'Winding Temp (°C)'
    };

    ['dg1', 'dg2', 'dg3'].forEach(dgKey => {
        const dgName = dgKey.toUpperCase();
        const totalParams = Object.keys(electricalRegisters[dgKey]).length;
        html += `<h3 style="margin-top: 15px;">${dgName} Status (${totalParams} Parameters)</h3><ul style="list-style-type: none; padding-left: 15px;">`;
        const regs = electricalRegisters[dgKey];
        for (const key in regs) {
            const name = electricalParamNames[key] || key;
            const value = data.electrical[dgKey][key] !== undefined ? data.electrical[dgKey][key] : 'N/A';
            html += `<li style="margin-bottom: 3px;">**${name}:** <b>${value}</b></li>`;
        }
        html += `</ul>`;
    });
    return html;
}

function getEmailTemplate(alertType, data) {
    const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    const dashboardUrl = `http://${process.env.PI_IP_ADDRESS || '192.168.30.156'}:${process.env.PORT || 3000}`;
    
    if (alertType === 'critical') {
        // ... (Critical Alert Template remains the same)
        return {
            subject: 'CRITICAL: Diesel Level Alert',
            html: `<div>... (Critical HTML) ...</div>`
        };
    } else if (alertType === 'data_fetched') {
        const electricalHtml = getElectricalDetailsHtml(data);
        
        return {
            subject: `NEW DATA: Electrical Parameters Updated (${timestamp})`,
            html: `
                <div style="font-family: Arial, sans-serif; border: 1px solid #ccc; padding: 15px;">
                    <h1 style="color: #1a73e8;">New Electrical Data Confirmation</h1>
                    <p>A change in one or more electrical parameters has been detected and confirmed.</p>
                    
                    <h2 style="color: #34a853;">Diesel Levels (Liters)</h2>
                    <ul style="list-style-type: disc; padding-left: 20px;">
                        <li>DG-1 Level: <b>${data.dg1} L</b></li>
                        <li>DG-2 Level: <b>${data.dg2} L</b></li>
                        <li>DG-3 Level: <b>${data.dg3} L</b></li>
                    </ul>
                    
                    <h2 style="color: #f7a200;">Updated Electrical Parameters (3 DGs)</h2>
                    ${electricalHtml}

                    <p style="margin-top: 20px;">View the live dashboard: <a href="${dashboardUrl}">${dashboardUrl}</a></p>
                    <p style="font-size: 12px; color: #888; margin-top: 10px;">This email is sent only when electrical data changes, subject to a 5-minute flood prevention cooldown.</p>
                </div>
            `
        };
    }
    return { subject: 'Unknown Alert', html: 'Unknown alert triggered.' };
}

async function sendEmailAlert(alertType, data, cooldown) {
    if (!emailEnabled || !ALERT_RECIPIENTS) return;
    
    // Apply cooldown check for both alert types
    const alertKey = `${alertType}_${Math.floor(Date.now() / cooldown)}`; 
    if (alertState.currentAlerts.has(alertKey)) return;
    
    // Set the cooldown timer
    alertState.currentAlerts.add(alertKey);
    setTimeout(() => alertState.currentAlerts.delete(alertKey), cooldown);

    try {
        const template = getEmailTemplate(alertType, data);
        await emailTransporter.sendMail({
            from: `"DG Monitoring System" <${process.env.EMAIL_USER}>`,
            to: ALERT_RECIPIENTS,
            subject: template.subject,
            html: template.html
        });

        // *** CRITICAL STEP: Update last confirmed data ONLY if the mail was successfully sent ***
        if (alertType === 'data_fetched') {
            // Deep copy the current electrical data
            lastConfirmedElectricalData = JSON.parse(JSON.stringify(data.electrical)); 
        }

        console.log(`Email alert sent: ${template.subject}`);
    } catch (e) { 
        // If mail sending failed, remove the alert key so it can be retried on the next data change
        alertState.currentAlerts.delete(alertKey);
        console.error(`Error sending email (${alertType}):`, e.message); 
    }
}

// Function for operational confirmation (only sends if electrical data has changed)
function sendDataFetchedConfirmation(data) {
    // 1. Check if the current electrical data is different from the last time we sent an email
    const electricalChanged = !deepEqual(data.electrical, lastConfirmedElectricalData);

    if (electricalChanged) {
        // 2. Send the mail (cooldown check is handled inside sendEmailAlert)
        sendEmailAlert('data_fetched', data, OPERATIONAL_CONFIRM_COOLDOWN);
    }
}

// ===== PLC Connection Logic (Remains the same) =====
function connectToPLC() {
    client.connectRTU(port, plcSettings)
        .then(() => {
            console.log(`Connected to PLC on port ${port}`);
            client.setID(plcSlaveID);
            client.setTimeout(3000);
            setTimeout(() => {
                readAllSystemData();
                setInterval(readAllSystemData, 2000); 
            }, 1000);
        })
        .catch((e) => { 
            console.error('Failed to connect to PLC:', e.message);
            client.close(); 
            setTimeout(connectToPLC, 5000); 
        });
}

// ===== Express.js Endpoints and Graceful Shutdown (Remain the same) =====
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname, { maxAge: '1d', etag: true, lastModified: true }));
app.use((req, res, next) => {
    if (req.url.match(/\.(css|js|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$/)) {
        res.setHeader('Cache-Control', 'public, max-age=86400');
    }
    next();
});

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });
app.get('/api/data', (req, res) => {
    res.json({
        timestamp: systemData.lastUpdate || new Date().toISOString(),
        dg1: systemData.dg1,
        dg2: systemData.dg2,
        dg3: systemData.dg3,
        total: systemData.total,
        electrical: systemData.electrical
    });
});
app.get('/api/health', (req, res) => {
    res.json({
        success: true,
        status: 'running',
        timestamp: new Date().toISOString(),
        mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
        lastDataUpdate: systemData.lastUpdate,
        systemStatus: { totalDiesel: systemData.total, dg1: systemData.dg1, dg2: systemData.dg2, dg3: systemData.dg3 },
        electrical: systemData.electrical
    });
});

process.on('SIGINT', async () => {
    try { 
        console.log('\nShutting down gracefully...');
        client.close(); 
        await mongoose.connection.close(); 
        process.exit(0); 
    } catch (_) { process.exit(1); }
});
process.on('SIGTERM', async () => {
    try { 
        console.log('\nShutting down gracefully...');
        client.close(); 
        await mongoose.connection.close(); 
        process.exit(0); 
    } catch (_) { process.exit(1); }
});

// Start server and initial PLC connection
app.listen(webServerPort, () => { 
    console.log(`Web server listening on port ${webServerPort}`);
    connectToPLC(); 
});