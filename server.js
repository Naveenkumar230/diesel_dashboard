/**
 * DG Monitoring – ultra-robust Modbus reader
 * Focus: DG1 & DG2 electrical parameters with MANY fallbacks + last-good caching.
 * Notes:
 *  - Uses candidate address arrays per parameter
 *  - Remembers the last good address (per DG, per param) to read fast next time
 *  - Validates values, smooths obvious glitches, and skips 0/NaN for Active Power
 *  - Your diesel level registers are left untouched
 */

require('dotenv').config();
const ModbusRTU = require('modbus-serial');
const express = require('express');
const path = require('path');
const mongoose = require('mongoose');
const cors = require('cors');
const nodemailer = require('nodemailer');
const compression = require('compression');

// -------------------- Config --------------------
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/dieselDB';
const MAX_RETRY_ATTEMPTS = 3;
const port = process.env.PLC_PORT || '/dev/ttyUSB0';
const plcSlaveID = parseInt(process.env.PLC_SLAVE_ID) || 1;
const READ_DELAY = 100;
const RETRY_ATTEMPTS = 2;

const ALERT_COOLDOWN = parseInt(process.env.ALERT_COOLDOWN) || 3600000;
const ELECTRICAL_ALERT_COOLDOWN = parseInt(process.env.ELECTRICAL_ALERT_COOLDOWN) || 300000;
const STARTUP_ALERT_COOLDOWN = parseInt(process.env.STARTUP_ALERT_COOLDOWN) || 600000;
const CRITICAL_LEVEL = parseInt(process.env.CRITICAL_DIESEL_LEVEL) || 50;
const ALERT_RECIPIENTS = process.env.ALERT_RECIPIENTS || 'your_email@example.com';
const DG_RUNNING_THRESHOLD = 5; // kW

const ELECTRICAL_THRESHOLDS = {
  voltageMin: 200,
  voltageMax: 250,
  currentMax: 500,
  frequencyMin: 48,
  frequencyMax: 52,
  powerFactorMin: 0.7,
  temperatureMax: 120
};

// -------------------- PLC --------------------
const plcSettings = {
  baudRate: parseInt(process.env.PLC_BAUD_RATE) || 9600,
  parity: process.env.PLC_PARITY || 'none',
  dataBits: parseInt(process.env.PLC_DATA_BITS) || 8,
  stopBits: parseInt(process.env.PLC_STOP_BITS) || 1
};
const client = new ModbusRTU();
let isPlcConnected = false;

// -------------------- State --------------------
let isMongoConnected = false;
let connectionAttempts = 0;

let systemData = {
  dg1: 0, dg2: 0, dg3: 0, total: 0, lastUpdate: null,
  electrical: { dg1: {}, dg2: {}, dg3: {}, dg4: {} }
};

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

// remembers last good register per param to try first next time
const lastGoodRegister = {
  dg1: {}, dg2: {}, dg3: {}, dg4: {}
};

// for /api/registers
let workingRegisters = {};

// -------------------- REGISTER MAPS --------------------
// Diesel (confirmed working)
const dgRegisters = {
  dg1: { primary: 4104, fallback: [4105, 4106], name: 'DG-1 Diesel (D108)' },
  dg2: { primary: 4100, fallback: [4101, 4102], name: 'DG-2 Diesel (D104)' },
  dg3: { primary: 4102, fallback: [4103, 4107], name: 'DG-3 Diesel (D106)' }
};

// helper to build candidate objects
const C = (addr, scaling = 0.1) => ({ addr, scaling });

// Based on your working sets + extra breadth.
// NOTE: Active Power has many candidates including your noted D116/D136/D156/D120 → 4212/4232/4252/4216.
const electricalCandidates = {
  dg1: {
    voltageR: [C(4196), C(4197), C(4200)],
    voltageY: [C(4198), C(4201), C(4202)],
    voltageB: [C(4200), C(4203), C(4204)],
    currentR: [C(4202), C(4205), C(4206)],
    currentY: [C(4204), C(4207), C(4208)],
    currentB: [C(4206), C(4209), C(4210)],
    frequency: [C(4208, 0.01), C(4211, 0.01), C(4212, 0.01)],
    powerFactor: [C(4210, 0.01), C(4213, 0.01), C(4214, 0.01)],
    // Active Power – primary special (5625 / D1529), plus your notes (4212/4232/4252/4216) and near-by addresses
    activePower: [
      C(5625, 0.1), C(4212, 0.1), C(4232, 0.1), C(4252, 0.1), C(4216, 0.1),
      C(4214, 0.1), C(4213, 0.1)
    ],
    reactivePower: [C(4214), C(4215), C(4216)],
    energyMeter: [C(4216, 1), C(4217, 1), C(4218, 1)],
    runningHours: [C(4218, 1), C(4219, 1), C(4220, 1)],
    windingTemp: [C(4232, 1), C(4233, 1), C(4234, 1)]
  },
  dg2: {
    voltageR: [C(4236), C(4237), C(4240)],
    voltageY: [C(4238), C(4241), C(4242)],
    voltageB: [C(4240), C(4243), C(4244)],
    currentR: [C(4242), C(4245), C(4246)],
    currentY: [C(4244), C(4247), C(4248)],
    currentB: [C(4246), C(4249), C(4250)],
    frequency: [C(4248, 0.01), C(4251, 0.01), C(4252, 0.01)],
    powerFactor: [C(4250, 0.01), C(4253, 0.01), C(4254, 0.01)],
    // Active Power – primary special (5665 / D1569), plus mirrors of DG1 fallbacks (4252/4232/4212/4216) and nearby
    activePower: [
      C(5665, 0.1), C(4252, 0.1), C(4232, 0.1), C(4212, 0.1), C(4216, 0.1),
      C(4250, 0.1), C(4248, 0.1)
    ],
    reactivePower: [C(4254), C(4255), C(4256)],
    energyMeter: [C(4256, 1), C(4257, 1), C(4258, 1)],
    runningHours: [C(4258, 1), C(4259, 1), C(4260, 1)],
    windingTemp: [C(4272, 1), C(4273, 1), C(4274, 1)]
  },
  // DG3 & DG4 kept same (already working)
  dg3: {
    voltageR: [C(4276)], voltageY: [C(4278)], voltageB: [C(4280)],
    currentR: [C(4282)], currentY: [C(4284)], currentB: [C(4286)],
    frequency: [C(4288, 0.01)], powerFactor: [C(4290, 0.01)],
    activePower: [C(4292)], reactivePower: [C(4294)],
    energyMeter: [C(4296, 1)], runningHours: [C(4298, 1)], windingTemp: [C(4312, 1)]
  },
  dg4: {
    voltageR: [C(4316)], voltageY: [C(4318)], voltageB: [C(4320)],
    currentR: [C(4322)], currentY: [C(4324)], currentB: [C(4326)],
    frequency: [C(4328, 0.01)], powerFactor: [C(4330, 0.01)],
    activePower: [C(4332)], reactivePower: [C(4334)],
    energyMeter: [C(4336, 1)], runningHours: [C(4338, 1)], windingTemp: [C(4352, 1)]
  }
};

// -------------------- Mongo --------------------
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
    if (connectionAttempts < MAX_RETRY_ATTEMPTS) setTimeout(connectMongoDB, 5000);
    else console.log('MongoDB unavailable after multiple attempts. Running without persistence.');
    isMongoConnected = false;
  }
}
mongoose.connection.on('connected', () => { isMongoConnected = true; console.log('MongoDB connection established'); });
mongoose.connection.on('disconnected', () => { isMongoConnected = false; console.log('MongoDB disconnected, attempting reconnection...'); setTimeout(connectMongoDB, 5000); });
mongoose.connection.on('error', (err) => { isMongoConnected = false; console.error('MongoDB error:', err); });
connectMongoDB();

// Schema
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

// -------------------- Email --------------------
let emailTransporter = null;
let emailEnabled = false;
try {
  if (process.env.EMAIL_USER && process.env.EMAIL_APP_PASSWORD) {
    emailTransporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_APP_PASSWORD }
    });
    emailEnabled = true;
    console.log('Email alerts enabled');
  } else {
    console.log('Email configuration missing - alerts disabled');
  }
} catch (err) {
  console.error('Email setup error:', err);
  emailEnabled = false;
}

// -------------------- Utils --------------------
const toSignedInt16 = (v) => (v > 32767 ? v - 65536 : v);
function isValidReading(value) {
  const s = toSignedInt16(value);
  if (value === 65535 || value === 65534 || s === -1) return false;
  return s >= 0 && s <= 600;
}
function isValidElectricalReading(value, min = -9999, max = 9999) {
  if (value === 65535 || value === 65534 || value < 0) return false;
  return value >= min && value <= max;
}
const calculateChange = (cur, prev) => (prev ? cur - prev : 0);
const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function readWithRetry(fn, retries = RETRY_ATTEMPTS) {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); }
    catch (e) { if (i === retries - 1) throw e; await wait(READ_DELAY); }
  }
}

// -------------------- Diesel Readers (unchanged) --------------------
async function readSingleRegister(registerConfig, dataKey) {
  const addresses = [registerConfig.primary, ...(registerConfig.fallback || [])];
  for (let i = 0; i < addresses.length; i++) {
    const address = addresses[i];
    try {
      const data = await readWithRetry(() => client.readHoldingRegisters(address, 1));
      const rawValue = data?.data?.[0];
      if (rawValue === undefined || !isValidReading(rawValue)) continue;

      const signed = toSignedInt16(rawValue);
      let value = Math.max(0, signed);

      const prev = previousDieselData[dataKey] || 0;
      const maxChangePercent = 30;
      const changePercent = Math.abs((value - prev) / (prev || 1) * 100);

      if (changePercent > maxChangePercent && value < prev) value = prev;
      previousDieselData[dataKey] = value;
      systemData[dataKey] = value;
      return value;
    } catch (_) {
      if (i === addresses.length - 1) console.log(`[ERROR] All attempts failed for ${registerConfig.name}`);
    }
  }
  return systemData[dataKey] || 0;
}

// -------------------- Electrical Readers (NEW robust logic) --------------------
/**
 * Reads a parameter using:
 * 1) last good register (if any)
 * 2) full candidate list
 * Caches the first success and returns { value, registerInfo }
 */
async function readParam(dgKey, param) {
  const candidates = electricalCandidates[dgKey][param];
  if (!candidates || candidates.length === 0) return { value: 0, registerInfo: null };

  // Build try-order: last good first, then the rest (unique)
  const tried = new Set();
  const order = [];
  const last = lastGoodRegister[dgKey][param];
  if (last) { order.push(last); tried.add(last.addr); }
  for (const c of candidates) if (!tried.has(c.addr)) order.push(c);

  for (let i = 0; i < order.length; i++) {
    const { addr, scaling } = order[i];
    try {
      const data = await readWithRetry(() => client.readHoldingRegisters(addr, 1));
      const raw = data?.data?.[0];
      if (raw === undefined || !isValidElectricalReading(raw)) continue;

      const scaled = Math.round(raw * (scaling ?? 0.1) * 100) / 100;

      // For Active Power, skip NaN or zero/near-zero, try other candidates
      if (param === 'activePower' && (!isFinite(scaled) || scaled === 0)) {
        // console.log(`[INFO] ${dgKey}.${param} ${addr} returned ${scaled}, trying next...`);
        continue;
      }

      // success → cache last good
      lastGoodRegister[dgKey][param] = { addr, scaling };
      const info = {
        address: addr,
        type: i === 0 ? 'CACHED' : (addr === candidates[0].addr ? 'PRIMARY' : 'FALLBACK'),
        value: scaled,
        registerName: `D${addr - 4096}`,
        decimalAddress: addr,
        hexAddress: `0x${addr.toString(16).toUpperCase()}`
      };
      return { value: scaled, registerInfo: info };
    } catch (_) {
      // try next
    }
  }
  return { value: 0, registerInfo: null };
}

async function readAllElectrical(dgKey) {
    const regs = electricalCandidates[dgKey];
    const prevValues = systemData.electrical[dgKey] || {};
    const newValues = {};
    const registerMap = {};
    
    // Determine if DG is running from previous cycle value (sticky logic anchor)
    const wasRunning = prevValues.activePower > DG_RUNNING_THRESHOLD;

    for (const param of Object.keys(regs)) {
        const { value, registerInfo } = await readParam(dgKey, param);

        // Apply Sticky Freeze Logic ONLY for DG-1 & DG-2
        if ((dgKey === "dg1" || dgKey === "dg2")) {
            
            // If param has no valid value OR is misleading zero → freeze last good value
            if (!isFinite(value) || value <= 0) {
                // Keep sticky previous value if exists
                newValues[param] = prevValues[param] ?? 0;
            }
            else {
                // We have a good and valid update ✅
                newValues[param] = value;
            }
        }
        else {
            // DG3 & DG4 unchanged logic
            newValues[param] = value;
        }

        if (registerInfo) registerMap[param] = registerInfo;
        await wait(READ_DELAY);
    }

    // Detect current running state (after Freeze filtering)
    const isRunning = newValues.activePower > DG_RUNNING_THRESHOLD;

    // If DG turned OFF → keep ALL last values (full freeze)
    if ((dgKey === "dg1" || dgKey === "dg2") && !isRunning && wasRunning) {
        console.log(`⏸️ ${dgKey.toUpperCase()} STOPPED → Freezing last values`);
        return { values: { ...prevValues }, registerMap };
    }

    return { values: newValues, registerMap };
}


// -------------------- Alerts (unchanged logic) --------------------
function getEmailTemplate(alertType, data, criticalDGs) {
  const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'long' });
  const dashboardUrl = `http://${process.env.PI_IP_ADDRESS || 'localhost'}:${webServerPort}`;
  return {
    subject: `⚠️ CRITICAL ALERT: Low Diesel Levels Detected`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;border:1px solid #e5e7eb;border-radius:8px;">
        <div style="background:linear-gradient(135deg,#ef4444,#dc2626);color:#fff;padding:20px;border-radius:8px 8px 0 0;">
          <h1 style="margin:0;">⚠️ CRITICAL DIESEL ALERT</h1>
        </div>
        <div style="padding:20px;background:#f9fafb;color:#333;">
          <p style="font-weight:bold;color:#ef4444;">URGENT: Low diesel levels detected in ${criticalDGs.join(', ')}</p>
          <ul style="list-style:none;padding:0;">
            <li style="padding:8px;border-bottom:1px solid #eee;">DG-1: <b style="color:${data.dg1 <= CRITICAL_LEVEL ? '#ef4444' : '#10b981'}">${data.dg1} L</b></li>
            <li style="padding:8px;border-bottom:1px solid #eee;">DG-2: <b style="color:${data.dg2 <= CRITICAL_LEVEL ? '#ef4444' : '#10b981'}">${data.dg2} L</b></li>
            <li style="padding:8px;border-bottom:1px solid #eee;">DG-3: <b style="color:${data.dg3 <= CRITICAL_LEVEL ? '#ef4444' : '#10b981'}">${data.dg3} L</b></li>
          </ul>
          <p style="font-size:14px;margin-top:20px;">Alert Time: ${timestamp}</p>
          <a href="${dashboardUrl}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 20px;border-radius:5px;text-decoration:none;margin-top:15px;">View Dashboard</a>
        </div>
      </div>`
  };
}

function getElectricalAlertTemplate(dgName, changes, alerts, currentValues, registerMap) {
  const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'long' });
  const dashboardUrl = `http://${process.env.PI_IP_ADDRESS || 'localhost'}:${webServerPort}`;
  return {
    subject: `⚡ ${dgName} Electrical Parameters Alert`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:900px;margin:0 auto;padding:20px;border:1px solid #e5e7eb;border-radius:8px;">
        <div style="background:linear-gradient(135deg,#2563eb,#1d4ed8);color:#fff;padding:20px;border-radius:8px 8px 0 0;">
          <h1 style="margin:0;">⚡ Electrical Parameters Alert - ${dgName}</h1>
        </div>
        <div style="padding:20px;background:#f9fafb;color:#333;">
          ${alerts.length ? `
          <h3>🚨 THRESHOLD VIOLATIONS</h3>
          <table style="width:100%;border-collapse:collapse;margin-bottom:15px;">
            <tr style="background:#fee2e2;"><th>Parameter</th><th>Current Value</th><th>Threshold</th><th>Severity</th></tr>
            ${alerts.map(a => `
              <tr>
                <td style="border:1px solid #fecaca;padding:8px;">${a.parameter}</td>
                <td style="border:1px solid #fecaca;padding:8px;font-weight:bold;color:#dc2626;">${a.value}</td>
                <td style="border:1px solid #fecaca;padding:8px;">${a.threshold}</td>
                <td style="border:1px solid #fecaca;padding:8px;">
                  <span style="background:${a.severity === 'critical' ? '#dc2626' : '#f59e0b'};color:#fff;padding:4px 8px;border-radius:4px;font-size:12px;">${a.severity.toUpperCase()}</span>
                </td>
              </tr>`).join('')}
          </table>` : ''}
          <h3 style="margin-top:20px;">📍 Working Register Map</h3>
          <table style="width:100%;border-collapse:collapse;background:#fff;">
            <tr style="background:#dbeafe;"><th>Parameter</th><th>D Register</th><th>Decimal Addr</th><th>Value</th><th>Type</th></tr>
            ${Object.entries(registerMap).map(([p, info]) => `
              <tr>
                <td style="border:1px solid #93c5fd;padding:8px;font-weight:bold;">${p}</td>
                <td style="border:1px solid #93c5fd;padding:8px;">${info.registerName}</td>
                <td style="border:1px solid #93c5fd;padding:8px;">${info.decimalAddress}</td>
                <td style="border:1px solid #93c5fd;padding:8px;">${info.value}</td>
                <td style="border:1px solid #93c5fd;padding:8px;color:${info.type === 'PRIMARY' || info.type === 'CACHED' ? '#10b981' : '#f59e0b'};font-weight:bold;">${info.type}</td>
              </tr>`).join('')}
          </table>
          <p style="margin-top:20px;">Alert Time: ${timestamp}</p>
          <a href="${dashboardUrl}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 20px;border-radius:5px;text-decoration:none;margin-top:15px;">View Dashboard</a>
        </div>
      </div>`
  };
}

function getStartupEmailTemplate(dgName, values) {
  const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', timeStyle: 'long' });
  const dashboardUrl = `http://${process.env.PI_IP_ADDRESS || 'localhost'}:${webServerPort}`;
  return {
    subject: `🟢 NOTIFICATION: ${dgName} Has Started Running`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;border:1px solid #e5e7eb;border-radius:8px;">
        <div style="background:linear-gradient(135deg,#10b981,#34d399);color:#fff;padding:20px;border-radius:8px 8px 0 0;">
          <h1 style="margin:0;">🟢 DG STARTUP NOTIFICATION</h1>
        </div>
        <div style="padding:20px;background:#f9fafb;color:#333;">
          <ul style="list-style:none;padding:0;">
            <li style="padding:8px;border-bottom:1px solid #eee;">Active Power: <b>${values.activePower?.toFixed(1) || '0.0'} kW</b></li>
            <li style="padding:8px;border-bottom:1px solid #eee;">Voltage R: <b>${values.voltageR?.toFixed(1) || '0.0'} V</b></li>
            <li style="padding:8px;">Frequency: <b>${values.frequency?.toFixed(1) || '0.0'} Hz</b></li>
          </ul>
          <p style="font-size:14px;margin-top:20px;">Event Time: ${timestamp}</p>
          <a href="${dashboardUrl}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 20px;border-radius:5px;text-decoration:none;margin-top:15px;">View Live Dashboard</a>
        </div>
      </div>`
  };
}

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
  const alerts = [];
  const IS_DG_RUNNING = newValues.activePower > DG_RUNNING_THRESHOLD;
  const T = ELECTRICAL_THRESHOLDS;

  for (const param in newValues) {
    const v = newValues[param];
    if (!IS_DG_RUNNING && (param.includes('voltage') || param === 'frequency' || param === 'powerFactor')) {
      if (v < 1) continue; // ignore floating zeros when OFF
    }
    if (param.includes('voltage') && (v < T.voltageMin || v > T.voltageMax)) alerts.push({ parameter: param, value: v, threshold: `${T.voltageMin}-${T.voltageMax}V`, severity: 'critical' });
    else if (param.includes('current') && v > T.currentMax) alerts.push({ parameter: param, value: v, threshold: `Max ${T.currentMax}A`, severity: 'warning' });
    else if (param === 'frequency' && (v < T.frequencyMin || v > T.frequencyMax)) alerts.push({ parameter: param, value: v, threshold: `${T.frequencyMin}-${T.frequencyMax}Hz`, severity: 'critical' });
    else if (param === 'powerFactor' && v < T.powerFactorMin) alerts.push({ parameter: param, value: v, threshold: `Min ${T.powerFactorMin}`, severity: 'warning' });
    else if (param === 'windingTemp' && v > T.temperatureMax) alerts.push({ parameter: param, value: v, threshold: `Max ${T.temperatureMax}°C`, severity: 'critical' });
  }

  alertState.lastElectricalValues[lastKey] = { ...newValues };
  if (alerts.length > 0) sendElectricalAlert(dgKey, [], alerts, newValues, registerMap);
}

function checkStartupAlert(dgKey, newValues) {
    if (!(dgKey === "dg1" || dgKey === "dg2")) return; // Only for DG1 & DG2

    const lastAlertTime = alertState.lastStartupAlerts[dgKey] || 0;
    const now = Date.now();
    
    const activePower = newValues.activePower || 0;
    const isRunning = activePower > DG_RUNNING_THRESHOLD;

    // Count valid non-zero electrical parameters
    let validCount = 0;
    for (const param in newValues) {
        const val = newValues[param];
        if (isFinite(val) && val > 0) validCount++;
    }

    // Require minimum 4 valid values to confirm DG has really started
    const MIN_REQUIRED_PARAMETERS = 4;
    const fullyRunning = isRunning && validCount >= MIN_REQUIRED_PARAMETERS;

    const lastValues = alertState.lastElectricalValues[`electrical_${dgKey}`] || {};
    const wasRunningBefore = (lastValues.activePower || 0) > DG_RUNNING_THRESHOLD;

    // Only send alert when transitioning from OFF ➜ ON with enough data
    if (fullyRunning && !wasRunningBefore && (now - lastAlertTime) > STARTUP_ALERT_COOLDOWN) {
        const dgName = dgKey.toUpperCase().replace("DG", "DG-");
        sendStartupEmail(dgName, newValues);
        alertState.lastStartupAlerts[dgKey] = now;

        console.log(`✅ Startup alert triggered for ${dgName} with ${validCount} valid parameters`);
    }
}


async function sendStartupEmail(dgName, values) {
  if (!emailEnabled || !ALERT_RECIPIENTS) return;
  const tpl = getStartupEmailTemplate(dgName, values);
  try {
    await emailTransporter.sendMail({ from: `"DG Monitoring System" <${process.env.EMAIL_USER}>`, to: ALERT_RECIPIENTS, subject: tpl.subject, html: tpl.html });
    console.log(`🟢 Startup alert email sent for ${dgName}`);
  } catch (err) { console.error('Startup Email sending error:', err.message); }
}

async function sendElectricalAlert(dgKey, changes, alerts, currentValues, registerMap) {
  if (!emailEnabled || !ALERT_RECIPIENTS) return;
  const key = `electrical_${dgKey}_${Math.floor(Date.now() / ELECTRICAL_ALERT_COOLDOWN)}`;
  if (alertState.currentAlerts.has(key)) return;
  const tpl = getElectricalAlertTemplate(dgKey.toUpperCase().replace('DG', 'DG-'), changes, alerts, currentValues, registerMap);
  try {
    await emailTransporter.sendMail({ from: `"DG Monitoring System" <${process.env.EMAIL_USER}>`, to: ALERT_RECIPIENTS, subject: tpl.subject, html: tpl.html });
    alertState.currentAlerts.add(key);
    setTimeout(() => alertState.currentAlerts.delete(key), ELECTRICAL_ALERT_COOLDOWN);
    console.log(`⚡ Electrical alert email sent for ${dgKey}`);
  } catch (err) { console.error('Electrical Email sending error:', err.message); }
}

async function sendEmailAlert(alertType, data, criticalDGs) {
  if (!emailEnabled || !ALERT_RECIPIENTS) return;
  const key = `${alertType}_${Math.floor(Date.now() / ALERT_COOLDOWN)}`;
  if (alertState.currentAlerts.has(key)) return;
  const tpl = getEmailTemplate(alertType, data, criticalDGs);
  try {
    await emailTransporter.sendMail({ from: `"DG Monitoring System" <${process.env.EMAIL_USER}>`, to: ALERT_RECIPIENTS, subject: tpl.subject, html: tpl.html });
    alertState.currentAlerts.add(key);
    setTimeout(() => alertState.currentAlerts.delete(key), ALERT_COOLDOWN);
    console.log(`⚠️ Diesel alert email sent for ${criticalDGs.join(', ')}`);
  } catch (err) { console.error('Diesel Email sending error:', err.message); }
}

// -------------------- Main Loop --------------------
async function readAllSystemData() {
  if (!isPlcConnected) return;
  try {
    // Diesel (unchanged)
    await readSingleRegister(dgRegisters.dg1, 'dg1'); await wait(READ_DELAY);
    await readSingleRegister(dgRegisters.dg2, 'dg2'); await wait(READ_DELAY);
    await readSingleRegister(dgRegisters.dg3, 'dg3'); await wait(READ_DELAY);
    systemData.total = (systemData.dg1 || 0) + (systemData.dg2 || 0) + (systemData.dg3 || 0);

    // Electrical DG1..DG4 (DG1 & DG2 have extended fallbacks + caching)
    for (const dgKey of ['dg1', 'dg2', 'dg3', 'dg4']) {
      const result = await readAllElectrical(dgKey);
      systemData.electrical[dgKey] = result.values;
      workingRegisters[dgKey] = result.registerMap;

      if (dgKey === 'dg1' || dgKey === 'dg2') {
        console.log(`[${dgKey.toUpperCase()}] Active Power = ${result.values.activePower} kW (${result.registerMap.activePower?.registerName || 'n/a'})`);
        checkElectricalChanges(dgKey, result.values, result.registerMap);
        checkStartupAlert(dgKey, result.values);
      }
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

// -------------------- PLC + Web --------------------
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
app.use((req, res, next) => { if (/\.(css|js|png|jpg|jpeg|gif|ico|svg)$/.test(req.url)) res.setHeader('Cache-Control', 'public, max-age=86400'); next(); });

// API
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/api/data', (req, res) => res.json({ ...systemData }));
app.get('/api/registers', (req, res) => res.json({ workingRegisters, lastGoodRegister, message: 'Current working register mappings & caches' }));

// Shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down gracefully...');
  try { client.close(); await mongoose.connection.close(); console.log('Connections closed'); process.exit(0); }
  catch (err) { console.error('Error during shutdown:', err); process.exit(1); }
});
process.on('SIGTERM', async () => {
  console.log('\nReceived SIGTERM, shutting down...');
  try { client.close(); await mongoose.connection.close(); console.log('Connections closed'); process.exit(0); }
  catch (err) { console.error('Error during shutdown:', err); process.exit(1); }
});

// Start
app.listen(webServerPort, () => {
  console.log(`\n===========================================`);
  console.log(`DG Monitoring System Server Started`);
  console.log(`Web Server: http://localhost:${webServerPort}`);
  console.log(`PLC Port: ${port}`);
  console.log(`Email Alerts: ${emailEnabled ? 'Enabled' : 'Disabled'}`);
  console.log(`DG Startup Alert: Enabled (Cooldown: ${STARTUP_ALERT_COOLDOWN / 60000} minutes)`);
  console.log(`\n📍 Electrical fallbacks tuned for DG-1 & DG-2 (with last-good caching).`);
  console.log(`   ActivePower candidates include D116/D136/D156/D120 etc.`);
  console.log(`===========================================`);
  connectToPLC();
});
