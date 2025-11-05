require('dotenv').config();
const ModbusRTU = require("modbus-serial");
const express = require('express');
const path = require('path');
const mongoose = require('mongoose');
const cors = require('cors');
const nodemailer = require('nodemailer');
const compression = require('compression');

// --- Configuration Constants ---
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/dieselDB";
const MAX_RETRY_ATTEMPTS = 3;
const port = process.env.PLC_PORT || '/dev/ttyUSB0';
const plcSlaveID = parseInt(process.env.PLC_SLAVE_ID) || 1;
const READ_DELAY = 100; // ms between reads
const RETRY_ATTEMPTS = 2;
const ALERT_COOLDOWN = parseInt(process.env.ALERT_COOLDOWN) || 3600000; // 1 hour
const ELECTRICAL_ALERT_COOLDOWN = parseInt(process.env.ELECTRICAL_ALERT_COOLDOWN) || 300000; // 5 minutes
const STARTUP_ALERT_COOLDOWN = parseInt(process.env.STARTUP_ALERT_COOLDOWN) || 600000; // 10 minutes
const CRITICAL_LEVEL = parseInt(process.env.CRITICAL_DIESEL_LEVEL) || 50;
const ALERT_RECIPIENTS = process.env.ALERT_RECIPIENTS || 'your_email@example.com';
const DG_RUNNING_THRESHOLD = 5; // kW - Active power threshold to consider DG "ON"

// Electrical parameter thresholds for alerts
const ELECTRICAL_THRESHOLDS = {
    voltageMin: 200,
    voltageMax: 250,
    currentMax: 500,
    frequencyMin: 48,
    frequencyMax: 52,
    powerFactorMin: 0.7,
    temperatureMax: 120
};

// --- Modbus Connection Setup ---
const plcSettings = {
    baudRate: parseInt(process.env.PLC_BAUD_RATE) || 9600,
    parity: process.env.PLC_PARITY || 'none',
    dataBits: parseInt(process.env.PLC_DATA_BITS) || 8,
    stopBits: parseInt(process.env.PLC_STOP_BITS) || 1
};
const client = new ModbusRTU();
let isPlcConnected = false;

// --- State Variables ---
let isMongoConnected = false;
let connectionAttempts = 0;
let systemData = { dg1: 0, dg2: 0, dg3: 0, total: 0, lastUpdate: null, electrical: { dg1: {}, dg2: {}, dg3: {}, dg4: {} } };
let previousReading = null;
let previousDieselData = { dg1: 0, dg2: 0, dg3: 0 };
let lastSavedHour = -1;
let errorCount = 0;
const MAX_ERRORS = 10;
const alertState = {
    currentAlerts: new Set(),
    lastElectricalValues: {},
    lastStartupAlerts: {}
};
let workingRegisters = {}; // Track which registers are working

// --- REGISTER MAPPINGS ---

// Diesel Registers (User confirmed these addresses work - KEEP AS IS)
const dgRegisters = {
    dg1: { primary: 4104, fallback: [4105, 4106], name: "DG-1 Diesel (D108)" },
    dg2: { primary: 4100, fallback: [4101, 4102], name: "DG-2 Diesel (D104)" },
    dg3: { primary: 4102, fallback: [4103, 4107], name: "DG-3 Diesel (D106)" },
};

// NEW DG1 Electrical Registers (with extended fallbacks)
const electricalRegisters = {
    dg1: {
        voltageR: { primary: 4196, fallback: [4197, 4200], scaling: 0.1, name: "DG1 Voltage R", unit: "V" },
        voltageY: { primary: 4198, fallback: [4201, 4202], scaling: 0.1, name: "DG1 Voltage Y", unit: "V" },
        voltageB: { primary: 4200, fallback: [4203, 4204], scaling: 0.1, name: "DG1 Voltage B", unit: "V" },
        currentR: { primary: 4202, fallback: [4205, 4206], scaling: 0.1, name: "DG1 Current R", unit: "A" },
        currentY: { primary: 4204, fallback: [4207, 4208], scaling: 0.1, name: "DG1 Current Y", unit: "A" },
        currentB: { primary: 4206, fallback: [4209, 4210], scaling: 0.1, name: "DG1 Current B", unit: "A" },
        frequency: { primary: 4208, fallback: [4211, 4212], scaling: 0.01, name: "DG1 Frequency", unit: "Hz" },
        powerFactor: { primary: 4210, fallback: [4213, 4214], scaling: 0.01, name: "DG1 Power Factor", unit: "" },
        // PRIORITY: Try special fallback 5625 FIRST, then try primary addresses
        activePower: { primary: 5625, fallback: [4212, 4214], scaling: 0.1, name: "DG1 Active Power", unit: "kW" },
        reactivePower: { primary: 4214, fallback: [4215, 4216], scaling: 0.1, name: "DG1 Reactive Power", unit: "kVAR" },
        energyMeter: { primary: 4216, fallback: [4217, 4218], scaling: 1, name: "DG1 Energy Meter", unit: "kWh" },
        runningHours: { primary: 4218, fallback: [4219, 4220], scaling: 1, name: "DG1 Running Hours", unit: "hrs" },
        windingTemp: { primary: 4232, fallback: [4233, 4234], scaling: 1, name: "DG1 Winding Temperature", unit: "°C" }
    },
    
    // NEW DG2 Electrical Registers (with extended fallbacks)
    dg2: {
        voltageR: { primary: 4236, fallback: [4237, 4240], scaling: 0.1, name: "DG2 Voltage R", unit: "V" },
        voltageY: { primary: 4238, fallback: [4241, 4242], scaling: 0.1, name: "DG2 Voltage Y", unit: "V" },
        voltageB: { primary: 4240, fallback: [4243, 4244], scaling: 0.1, name: "DG2 Voltage B", unit: "V" },
        currentR: { primary: 4242, fallback: [4245, 4246], scaling: 0.1, name: "DG2 Current R", unit: "A" },
        currentY: { primary: 4244, fallback: [4247, 4248], scaling: 0.1, name: "DG2 Current Y", unit: "A" },
        currentB: { primary: 4246, fallback: [4249, 4250], scaling: 0.1, name: "DG2 Current B", unit: "A" },
        frequency: { primary: 4248, fallback: [4251, 4252], scaling: 0.01, name: "DG2 Frequency", unit: "Hz" },
        powerFactor: { primary: 4250, fallback: [4253, 4254], scaling: 0.01, name: "DG2 Power Factor", unit: "" },
        // PRIORITY: Try special fallback 5665 FIRST, then try primary and other fallbacks
        activePower: { primary: 5665, fallback: [4248, 4250], scaling: 0.1, name: "DG2 Active Power", unit: "kW" },
        reactivePower: { primary: 4254, fallback: [4255, 4256], scaling: 0.1, name: "DG2 Reactive Power", unit: "kVAR" },
        energyMeter: { primary: 4256, fallback: [4257, 4258], scaling: 1, name: "DG2 Energy Meter", unit: "kWh" },
        runningHours: { primary: 4258, fallback: [4259, 4260], scaling: 1, name: "DG2 Running Hours", unit: "hrs" },
        windingTemp: { primary: 4272, fallback: [4273, 4274], scaling: 1, name: "DG2 Winding Temperature", unit: "°C" }
    },

    // DG3 Electrical Parameters (KEEP AS IS - WORKING)
    dg3: {
        voltageR: { primary: 4276, fallback: [4277, 4278], scaling: 0.1, name: "DG3 Voltage R", unit: "V" },
        voltageY: { primary: 4278, fallback: [4279, 4280], scaling: 0.1, name: "DG3 Voltage Y", unit: "V" },
        voltageB: { primary: 4280, fallback: [4281, 4282], scaling: 0.1, name: "DG3 Voltage B", unit: "V" },
        currentR: { primary: 4282, fallback: [4283, 4284], scaling: 0.1, name: "DG3 Current R", unit: "A" },
        currentY: { primary: 4284, fallback: [4285, 4286], scaling: 0.1, name: "DG3 Current Y", unit: "A" },
        currentB: { primary: 4286, fallback: [4287, 4288], scaling: 0.1, name: "DG3 Current B", unit: "A" },
        frequency: { primary: 4288, fallback: [4289, 4290], scaling: 0.01, name: "DG3 Frequency", unit: "Hz" },
        powerFactor: { primary: 4290, fallback: [4291, 4292], scaling: 0.01, name: "DG3 Power Factor", unit: "" },
        activePower: { primary: 4292, fallback: [4293, 4294], scaling: 0.1, name: "DG3 Active Power", unit: "kW" },
        reactivePower: { primary: 4294, fallback: [4295, 4296], scaling: 0.1, name: "DG3 Reactive Power", unit: "kVAR" },
        energyMeter: { primary: 4296, fallback: [4297, 4298], scaling: 1, name: "DG3 Energy Meter", unit: "kWh" },
        runningHours: { primary: 4298, fallback: [4299, 4300], scaling: 1, name: "DG3 Running Hours", unit: "hrs" },
        windingTemp: { primary: 4312, fallback: [4313, 4314], scaling: 1, name: "DG3 Winding Temperature", unit: "°C" }
    },
    
    // DG4 Electrical Parameters (KEEP AS IS - WORKING)
    dg4: {
        voltageR: { primary: 4316, fallback: [4317, 4318], scaling: 0.1, name: "DG4 Voltage R", unit: "V" },
        voltageY: { primary: 4318, fallback: [4319, 4320], scaling: 0.1, name: "DG4 Voltage Y", unit: "V" },
        voltageB: { primary: 4320, fallback: [4321, 4322], scaling: 0.1, name: "DG4 Voltage B", unit: "V" },
        currentR: { primary: 4322, fallback: [4323, 4324], scaling: 0.1, name: "DG4 Current R", unit: "A" },
        currentY: { primary: 4324, fallback: [4325, 4326], scaling: 0.1, name: "DG4 Current Y", unit: "A" },
        currentB: { primary: 4326, fallback: [4327, 4328], scaling: 0.1, name: "DG4 Current B", unit: "A" },
        frequency: { primary: 4328, fallback: [4329, 4330], scaling: 0.01, name: "DG4 Frequency", unit: "Hz" },
        powerFactor: { primary: 4330, fallback: [4331, 4332], scaling: 0.01, name: "DG4 Power Factor", unit: "" },
        activePower: { primary: 4332, fallback: [4333, 4334], scaling: 0.1, name: "DG4 Active Power", unit: "kW" },
        reactivePower: { primary: 4334, fallback: [4335, 4336], scaling: 0.1, name: "DG4 Reactive Power", unit: "kVAR" },
        energyMeter: { primary: 4336, fallback: [4337, 4338], scaling: 1, name: "DG4 Energy Meter", unit: "kWh" },
        runningHours: { primary: 4338, fallback: [4339, 4340], scaling: 1, name: "DG4 Running Hours", unit: "hrs" },
        windingTemp: { primary: 4352, fallback: [4353, 4354], scaling: 1, name: "DG4 Winding Temperature", unit: "°C" }
    }
};

// --- MongoDB Setup and Connection ---

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
mongoose.connection.on('connected', () => { isMongoConnected = true; console.log('MongoDB connection established'); });
mongoose.connection.on('disconnected', () => { isMongoConnected = false; console.log('MongoDB disconnected, attempting reconnection...'); setTimeout(connectMongoDB, 5000); });
mongoose.connection.on('error', (err) => { isMongoConnected = false; console.error('MongoDB error:', err); });
connectMongoDB();

// --- Mongoose Schema ---
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
const DieselReading = mongoose.model('DieselReading', DieselReadingSchema);

// --- Email Setup ---
let emailTransporter = null;
let emailEnabled = false;
try {
    if (process.env.EMAIL_USER && process.env.EMAIL_APP_PASSWORD) {
        emailTransporter = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_APP_PASSWORD } });
        emailEnabled = true;
        console.log('Email alerts enabled');
    } else {
        console.log('Email configuration missing - alerts disabled');
    }
} catch (err) {
    console.error('Email setup error:', err);
    emailEnabled = false;
}

// --- Utility Functions ---
function toSignedInt16(value) { return (value > 32767) ? value - 65536 : value; }
function isValidReading(value) {
    const signedValue = toSignedInt16(value);
    if (value === 65535 || value === 65534 || signedValue === -1) return false;
    return signedValue >= 0 && signedValue <= 600;
}
function isValidElectricalReading(value, min = -9999, max = 9999) {
    if (value === 65535 || value === 65534 || value < 0) return false;
    return value >= min && value <= max;
}
function calculateChange(current, previous) { return (previous) ? current - previous : 0; }

// --- Modbus Reading Functions ---

async function readWithRetry(readFunc, retries = RETRY_ATTEMPTS) {
    for (let attempt = 0; attempt < retries; attempt++) {
        try { return await readFunc(); } 
        catch (err) {
            if (attempt === retries - 1) throw err;
            await new Promise(resolve => setTimeout(resolve, READ_DELAY));
        }
    }
}

async function readSingleRegister(registerConfig, dataKey) {
    const addresses = [registerConfig.primary, ...(registerConfig.fallback || [])];
    for (let i = 0; i < addresses.length; i++) {
        const address = addresses[i];
        try {
            const data = await readWithRetry(() => client.readHoldingRegisters(address, 1));
            const rawValue = data?.data?.[0];
            if (rawValue === undefined || !isValidReading(rawValue)) continue;
            
            const signedValue = toSignedInt16(rawValue);
            let value = Math.max(0, signedValue);
            
            const previousValue = previousDieselData[dataKey] || 0;
            const maxChangePercent = 30;
            const changePercent = Math.abs((value - previousValue) / (previousValue || 1) * 100);
            
            if (changePercent > maxChangePercent && value < previousValue) {
                value = previousValue; // Apply smoothing for sudden drops
            } 
            
            previousDieselData[dataKey] = value;
            systemData[dataKey] = value;
            return value;
        } catch (err) {
            if (i === addresses.length - 1) console.log(`[ERROR] All attempts failed for ${registerConfig.name}`);
        }
    }
    return systemData[dataKey] || 0;
}

async function readElectricalRegister(regConfig, defaultValue = 0) {
    const addresses = [regConfig.primary, ...(regConfig.fallback || [])];
    for (let i = 0; i < addresses.length; i++) {
        const address = addresses[i];
        try {
            const data = await readWithRetry(() => client.readHoldingRegisters(address, 1));
            const raw = data?.data?.[0];
            if (raw === undefined || !isValidElectricalReading(raw)) continue;
            
            const value = Math.round(raw * regConfig.scaling * 100) / 100;
            
            // Skip NaN or zero values for Active Power and try next fallback
            if (regConfig.name.includes("Active Power") && (isNaN(value) || value === 0)) {
                console.log(`[INFO] ${regConfig.name} returned ${value} at address ${address}, trying fallback...`);
                continue;
            }
            
            const registerInfo = {
                address,
                type: i === 0 ? 'PRIMARY' : `FALLBACK-${i}`,
                value,
                registerName: `D${address - 4096}`,
                decimalAddress: address,
                hexAddress: `0x${address.toString(16).toUpperCase()}`
            };
            return { value, registerInfo };
        } catch (err) {
            if (i === addresses.length - 1) console.log(`[ERROR] All attempts failed for ${regConfig.name}`);
        }
    }
    return { value: defaultValue, registerInfo: null };
}

async function readAllElectrical(dgKey) {
    const result = {};
    const registerMap = {};
    const regs = electricalRegisters[dgKey];
    
    for (const key in regs) {
        const { value, registerInfo } = await readElectricalRegister(regs[key]);
        result[key] = value;
        if (registerInfo) registerMap[key] = registerInfo;
        await new Promise(resolve => setTimeout(resolve, READ_DELAY));
    }
    return { values: result, registerMap };
}

// --- Email Alert Templates ---

function getEmailTemplate(alertType, data, criticalDGs) {
    const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'long' });
    const dashboardUrl = `http://${process.env.PI_IP_ADDRESS || 'localhost'}:${webServerPort}`;
    
    return {
        subject: `⚠️ CRITICAL ALERT: Low Diesel Levels Detected`,
        html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e5e7eb; border-radius: 8px;">
                <div style="background: linear-gradient(135deg, #ef4444, #dc2626); color: white; padding: 20px; border-radius: 8px 8px 0 0;">
                    <h1 style="margin:0;">⚠️ CRITICAL DIESEL ALERT</h1>
                </div>
                <div style="padding: 20px; background: #f9fafb; color: #333;">
                    <p style="font-weight: bold; color: #ef4444;">URGENT: Low diesel levels detected in ${criticalDGs.join(', ')}</p>
                    <ul style="list-style: none; padding: 0;">
                        <li style="padding: 8px; border-bottom: 1px solid #eee;">DG-1: <span style="font-weight: bold; color: ${data.dg1 <= CRITICAL_LEVEL ? '#ef4444' : '#10b981'};">${data.dg1} Liters</span></li>
                        <li style="padding: 8px; border-bottom: 1px solid #eee;">DG-2: <span style="font-weight: bold; color: ${data.dg2 <= CRITICAL_LEVEL ? '#ef4444' : '#10b981'};">${data.dg2} Liters</span></li>
                        <li style="padding: 8px; border-bottom: 1px solid #eee;">DG-3: <span style="font-weight: bold; color: ${data.dg3 <= CRITICAL_LEVEL ? '#ef4444' : '#10b981'};">${data.dg3} Liters</span></li>
                    </ul>
                    <p style="font-size: 14px; margin-top: 20px;">**Action Required:** Please refuel immediately. (Alert Time: ${timestamp})</p>
                    <a href="${dashboardUrl}" style="display: inline-block; background: #2563eb; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; margin-top: 15px;">View Live Dashboard</a>
                </div>
            </div>
        `
    };
}

function getElectricalAlertTemplate(dgName, changes, alerts, currentValues, registerMap) {
    const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'long' });
    const dashboardUrl = `http://${process.env.PI_IP_ADDRESS || 'localhost'}:${webServerPort}`;

    let alertsHtml = (alerts.length > 0) ? `
        <h3>🚨 THRESHOLD VIOLATIONS</h3>
        <table style="width:100%; border-collapse: collapse; margin-bottom: 15px;">
            <tr style="background:#fee2e2;"><th>Parameter</th><th>Current Value</th><th>Threshold</th><th>Severity</th></tr>
            ${alerts.map(a => `
                <tr>
                    <td style="border:1px solid #fecaca; padding:8px;">${a.parameter}</td>
                    <td style="border:1px solid #fecaca; padding:8px; font-weight:bold; color:#dc2626;">${a.value}</td>
                    <td style="border:1px solid #fecaca; padding:8px;">${a.threshold}</td>
                    <td style="border:1px solid #fecaca; padding:8px;">
                        <span style="background:${a.severity === 'critical' ? '#dc2626' : '#f59e0b'}; color:white; padding:4px 8px; border-radius:4px; font-size:12px;">
                            ${a.severity.toUpperCase()}
                        </span>
                    </td>
                </tr>
            `).join('')}
        </table>
    ` : '';
    
    return {
        subject: `⚡ ${dgName} Electrical Parameters Alert`,
        html: `
            <div style="font-family: Arial, sans-serif; max-width: 900px; margin: 0 auto; padding: 20px; border: 1px solid #e5e7eb; border-radius: 8px;">
                <div style="background: linear-gradient(135deg, #2563eb, #1d4ed8); color: white; padding: 20px; border-radius: 8px 8px 0 0;">
                    <h1 style="margin:0;">⚡ Electrical Parameters Alert - ${dgName}</h1>
                </div>
                <div style="padding: 20px; background: #f9fafb; color: #333;">
                    ${alertsHtml}
                    ${(alerts.length > 0) ? '<p style="margin: 0; font-weight: bold; color: #92400e;">⚠️ Action Required: Check generator and verify electrical parameters.</p>' : ''}
                    <h3 style="margin-top: 20px;">📍 Working Register Map</h3>
                    <table style="width:100%; border-collapse: collapse; background: white;">
                        <tr style="background:#dbeafe;"><th>Parameter</th><th>D Register</th><th>Decimal Addr</th><th>Value</th><th>Type</th></tr>
                        ${Object.entries(registerMap).map(([param, info]) => `
                            <tr>
                                <td style="border:1px solid #93c5fd; padding:8px; font-weight: bold;">${param}</td>
                                <td style="border:1px solid #93c5fd; padding:8px;">${info.registerName}</td>
                                <td style="border:1px solid #93c5fd; padding:8px;">${info.decimalAddress}</td>
                                <td style="border:1px solid #93c5fd; padding:8px;">${info.value}</td>
                                <td style="border:1px solid #93c5fd; padding:8px; color: ${info.type === 'PRIMARY' ? '#10b981' : '#f59e0b'}; font-weight:bold;">${info.type}</td>
                            </tr>
                        `).join('')}
                    </table>
                    <p style="margin-top: 20px;">Alert Time: ${timestamp}</p>
                    <a href="${dashboardUrl}" style="display: inline-block; background: #2563eb; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; margin-top: 15px;">View Live Dashboard</a>
                </div>
            </div>
        `
    };
}

function getStartupEmailTemplate(dgName, values) {
    const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', timeStyle: 'long' });
    const dashboardUrl = `http://${process.env.PI_IP_ADDRESS || 'localhost'}:${webServerPort}`;

    return {
        subject: `🟢 NOTIFICATION: ${dgName} Has Started Running`,
        html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e5e7eb; border-radius: 8px;">
                <div style="background: linear-gradient(135deg, #10b981, #34d399); color: white; padding: 20px; border-radius: 8px 8px 0 0;">
                    <h1 style="margin:0;">🟢 DG STARTUP NOTIFICATION</h1>
                </div>
                <div style="padding: 20px; background: #f9fafb; color: #333;">
                    <p style="font-weight: bold; color: #10b981;">The **${dgName}** diesel generator has successfully started running.</p>
                    <ul style="list-style: none; padding: 0;">
                        <li style="padding: 8px; border-bottom: 1px solid #eee;">Active Power: <span style="font-weight: bold;">${values.activePower?.toFixed(1) || '0.0'} kW</span></li>
                        <li style="padding: 8px; border-bottom: 1px solid #eee;">Voltage R: <span style="font-weight: bold;">${values.voltageR?.toFixed(1) || '0.0'} V</span></li>
                        <li style="padding: 8px;">Frequency: <span style="font-weight: bold;">${values.frequency?.toFixed(1) || '0.0'} Hz</span></li>
                    </ul>
                    <p style="font-size: 14px; margin-top: 20px;">Event Time: ${timestamp}</p>
                    <a href="${dashboardUrl}" style="display: inline-block; background: #2563eb; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; margin-top: 15px;">View Live Dashboard</a>
                </div>
            </div>
        `
    };
}

// --- Alert Logic Functions ---
function checkDieselLevels(data) {
    const criticalDGs = [];
    if (data.dg1 <= CRITICAL_LEVEL) criticalDGs.push('DG-1');
    if (data.dg2 <= CRITICAL_LEVEL) criticalDGs.push('DG-2');
    if (data.dg3 <= CRITICAL_LEVEL) criticalDGs.push('DG-3');
    
    if (criticalDGs.length > 0) sendEmailAlert('critical', data, criticalDGs);
}

function checkElectricalChanges(dgKey, newValues, registerMap) {
    const lastKey = `electrical_${dgKey}`;
    const previousValues = alertState.lastElectricalValues[lastKey] || {};
    const changes = [];
    const alerts = [];
    const IS_DG_RUNNING = newValues.activePower > DG_RUNNING_THRESHOLD; 
    
    for (const param in newValues) {
        const newVal = newValues[param];
        const oldVal = previousValues[param];
        
        const regConfig = electricalRegisters[dgKey][param];
        const unit = regConfig ? regConfig.unit : '';
        const thresholds = ELECTRICAL_THRESHOLDS;

        // Check for threshold violations (Critical Alerts)
        if (!IS_DG_RUNNING && (param.includes('voltage') || param === 'frequency' || param === 'powerFactor')) {
             if (newVal < 1) continue; 
        }

        if (param.includes('voltage') && (newVal < thresholds.voltageMin || newVal > thresholds.voltageMax)) {
            alerts.push({ parameter: param, value: newVal, threshold: `${thresholds.voltageMin}-${thresholds.voltageMax}${unit}`, severity: 'critical' });
        } else if (param.includes('current') && newVal > thresholds.currentMax) {
            alerts.push({ parameter: param, value: newVal, threshold: `Max ${thresholds.currentMax}${unit}`, severity: 'warning' });
        } else if (param === 'frequency' && (newVal < thresholds.frequencyMin || newVal > thresholds.frequencyMax)) {
            alerts.push({ parameter: param, value: newVal, threshold: `${thresholds.frequencyMin}-${thresholds.frequencyMax}${unit}`, severity: 'critical' });
        } else if (param === 'powerFactor' && newVal < thresholds.powerFactorMin) {
            alerts.push({ parameter: param, value: newVal, threshold: `Min ${thresholds.powerFactorMin}`, severity: 'warning' });
        } else if (param === 'windingTemp' && newVal > thresholds.temperatureMax) {
            alerts.push({ parameter: param, value: newVal, threshold: `Max ${thresholds.temperatureMax}${unit}`, severity: 'critical' });
        }
    }

    alertState.lastElectricalValues[lastKey] = { ...newValues };
    if (alerts.length > 0) {
        sendElectricalAlert(dgKey, changes, alerts, newValues, registerMap);
    }
}

function checkStartupAlert(dgKey, newValues) {
    const lastAlertTime = alertState.lastStartupAlerts[dgKey] || 0;
    const now = Date.now();
    const IS_DG_RUNNING = newValues.activePower > DG_RUNNING_THRESHOLD;
    
    if (IS_DG_RUNNING && (now - lastAlertTime) > STARTUP_ALERT_COOLDOWN) {
        const previousValues = alertState.lastElectricalValues[`electrical_${dgKey}`] || {};
        const WAS_DG_RUNNING = previousValues.activePower > DG_RUNNING_THRESHOLD;

        if (!WAS_DG_RUNNING) {
            const dgName = dgKey.toUpperCase().replace('DG', 'DG-');
            sendStartupEmail(dgName, newValues);
            alertState.lastStartupAlerts[dgKey] = now;
        }
    }
}

async function sendStartupEmail(dgName, values) {
    if (!emailEnabled || !ALERT_RECIPIENTS) return;
    const template = getStartupEmailTemplate(dgName, values);
    try {
        await emailTransporter.sendMail({ from: `"DG Monitoring System" <${process.env.EMAIL_USER}>`, to: ALERT_RECIPIENTS, subject: template.subject, html: template.html });
        console.log(`🟢 Startup alert email sent for ${dgName}`);
    } catch (err) {
        console.error('Startup Email sending error:', err.message);
    }
}

async function sendElectricalAlert(dgKey, changes, alerts, currentValues, registerMap) {
    if (!emailEnabled || !ALERT_RECIPIENTS) return;
    const alertKey = `electrical_${dgKey}_${Math.floor(Date.now() / ELECTRICAL_ALERT_COOLDOWN)}`;
    if (alertState.currentAlerts.has(alertKey)) return;

    const dgName = dgKey.toUpperCase().replace('DG', 'DG-');
    const template = getElectricalAlertTemplate(dgName, changes, alerts, currentValues, registerMap);
    try {
        await emailTransporter.sendMail({ from: `"DG Monitoring System" <${process.env.EMAIL_USER}>`, to: ALERT_RECIPIENTS, subject: template.subject, html: template.html });
        alertState.currentAlerts.add(alertKey);
        setTimeout(() => alertState.currentAlerts.delete(alertKey), ELECTRICAL_ALERT_COOLDOWN);
        console.log(`⚡ Electrical alert email sent for ${dgName}`);
    } catch (err) {
        console.error('Electrical Email sending error:', err.message);
    }
}

async function sendEmailAlert(alertType, data, criticalDGs) {
    if (!emailEnabled || !ALERT_RECIPIENTS) return;
    const alertKey = `${alertType}_${Math.floor(Date.now() / ALERT_COOLDOWN)}`;
    if (alertState.currentAlerts.has(alertKey)) return;

    const template = getEmailTemplate(alertType, data, criticalDGs);
    try {
        await emailTransporter.sendMail({ from: `"DG Monitoring System" <${process.env.EMAIL_USER}>`, to: ALERT_RECIPIENTS, subject: template.subject, html: template.html });
        alertState.currentAlerts.add(alertKey);
        setTimeout(() => alertState.currentAlerts.delete(alertKey), ALERT_COOLDOWN);
        console.log(`⚠️ Diesel alert email sent for ${criticalDGs.join(', ')}`);
    } catch (err) {
        console.error('Diesel Email sending error:', err.message);
    }
}

// --- Main Data Reading Loop ---
async function readAllSystemData() {
    if (!isPlcConnected) return;

    try {
        // Read Diesel Levels (DG1-DG3) - KEEP AS IS (WORKING)
        await readSingleRegister(dgRegisters.dg1, 'dg1');
        await new Promise(resolve => setTimeout(resolve, READ_DELAY));
        await readSingleRegister(dgRegisters.dg2, 'dg2');
        await new Promise(resolve => setTimeout(resolve, READ_DELAY));
        await readSingleRegister(dgRegisters.dg3, 'dg3');
        await new Promise(resolve => setTimeout(resolve, READ_DELAY));
        systemData.total = (systemData.dg1 || 0) + (systemData.dg2 || 0) + (systemData.dg3 || 0);

        // Process DG1-DG4 Electrical (DG1 & DG2 with NEW mappings, DG3 & DG4 unchanged)
        for (const dgKey of ['dg1', 'dg2', 'dg3', 'dg4']) {
            const result = await readAllElectrical(dgKey);
            systemData.electrical[dgKey] = result.values;
            workingRegisters[dgKey] = result.registerMap;
            
            // Log Active Power readings for DG1 and DG2 for debugging
            if (dgKey === 'dg1' || dgKey === 'dg2') {
                console.log(`[${dgKey.toUpperCase()}] Active Power: ${result.values.activePower} kW (${result.registerMap.activePower?.type || 'N/A'})`);
            }
            
            checkElectricalChanges(dgKey, result.values, result.registerMap);
            checkStartupAlert(dgKey, result.values);
        }
        
        systemData.lastUpdate = new Date().toISOString();
        checkDieselLevels(systemData);
        await saveToDatabase(systemData);
        
        errorCount = 0;
    } catch (err) {
        errorCount++;
        console.error(`Error reading system data (${errorCount}/${MAX_ERRORS}):`, err.message);
        if (errorCount >= MAX_ERRORS) {
            console.log('Too many errors, reconnecting PLC...');
            isPlcConnected = false;
            errorCount = 0;
            client.close();
            setTimeout(connectToPLC, 5000);
        }
    }
}

async function saveToDatabase(data) {
    if (!isMongoConnected) return;
    try {
        const now = new Date();
        const currentHour = now.getHours();
        if (currentHour === lastSavedHour) return;
        const dateString = now.toISOString().split('T')[0];
        
        const reading = new DieselReading({
            timestamp: now,
            dg1: data.dg1, dg2: data.dg2, dg3: data.dg3,
            total: data.total,
            hour: currentHour, date: dateString,
            dg1_change: calculateChange(data.dg1, previousReading?.dg1),
            dg2_change: calculateChange(data.dg2, previousReading?.dg2),
            dg3_change: calculateChange(data.dg3, previousReading?.dg3)
        });
        
        await reading.save();
        console.log(`✓ Saved reading for ${dateString} ${currentHour}:00`);
        lastSavedHour = currentHour;
        previousReading = { dg1: data.dg1, dg2: data.dg2, dg3: data.dg3 };
    } catch (err) {
        console.error('Database save error:', err.message);
    }
}

// --- PLC Connection and Server Start ---
function connectToPLC() {
    console.log(`Attempting to connect to PLC on ${port}...`);
    client.connectRTU(port, plcSettings)
        .then(() => {
            client.setID(plcSlaveID);
            client.setTimeout(5000);
            isPlcConnected = true;
            errorCount = 0;
            console.log('✓ PLC connected successfully');
            setTimeout(() => { readAllSystemData(); setInterval(readAllSystemData, 5000); }, 2000);
        })
        .catch((err) => {
            console.error('PLC connection error:', err.message);
            isPlcConnected = false;
            client.close();
            setTimeout(connectToPLC, 10000);
        });
}

const app = express();
const webServerPort = parseInt(process.env.PORT) || 3000;
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname, { maxAge: '1d', etag: true, lastModified: true }));
app.use((req, res, next) => { if (req.url.match(/\.(css|js|png|jpg|jpeg|gif|ico|svg)$/)) { res.setHeader('Cache-Control', 'public, max-age=86400'); } next(); });

// API Endpoints
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });
app.get('/api/data', (req, res) => { res.json({ ...systemData }); });
app.get('/api/registers', (req, res) => { 
    res.json({ 
        workingRegisters,
        message: 'Current working register mappings for all DGs'
    }); 
});

// Graceful Shutdown
process.on('SIGINT', async () => {
    console.log('\nShutting down gracefully...');
    try {
        client.close();
        await mongoose.connection.close();
        console.log('Connections closed');
        process.exit(0);
    } catch (err) {
        console.error('Error during shutdown:', err);
        process.exit(1);
    }
});

process.on('SIGTERM', async () => {
    console.log('\nReceived SIGTERM, shutting down...');
    try {
        client.close();
        await mongoose.connection.close();
        console.log('Connections closed');
        process.exit(0);
    } catch (err) {
        console.error('Error during shutdown:', err);
        process.exit(1);
    }
});

// Start Server
app.listen(webServerPort, () => {
    console.log(`\n===========================================`);
    console.log(`DG Monitoring System Server Started`);
    console.log(`Web Server: http://localhost:${webServerPort}`);
    console.log(`PLC Port: ${port}`);
    console.log(`Email Alerts: ${emailEnabled ? 'Enabled' : 'Disabled'}`);
    console.log(`DG Startup Alert: Enabled (Cooldown: ${STARTUP_ALERT_COOLDOWN / 60000} minutes)`);
    console.log(`\n📍 Register Mappings:`);
    console.log(`  DG-1: NEW mapping with Active Power fallback to 5625 (D1529)`);
    console.log(`  DG-2: NEW mapping with Active Power fallback to 5665 (D1569)`);
    console.log(`  DG-3: ORIGINAL mapping (unchanged)`);
    console.log(`  DG-4: ORIGINAL mapping (unchanged)`);
    console.log(`  Diesel: ORIGINAL working addresses (unchanged)`);
    console.log(`===========================================`);
    connectToPLC();
});