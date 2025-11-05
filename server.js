// server.js
require('dotenv').config();

const ModbusRTU   = require('modbus-serial');
const express     = require('express');
const path        = require('path');
const mongoose    = require('mongoose');
const cors        = require('cors');
const nodemailer  = require('nodemailer');
const compression = require('compression');

/* ================================
   CONFIG
==================================*/
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/dieselDB";
const MAX_RETRY_ATTEMPTS = 3;

const port         = process.env.PLC_PORT || '/dev/ttyUSB0';
const plcSlaveID   = parseInt(process.env.PLC_SLAVE_ID || '1', 10);
const READ_DELAY   = 100; // ms between sequential reads
const RETRY_ATTEMPTS = 2;

const ALERT_COOLDOWN            = parseInt(process.env.ALERT_COOLDOWN || '3600000', 10); // 1h
const ELECTRICAL_ALERT_COOLDOWN = parseInt(process.env.ELECTRICAL_ALERT_COOLDOWN || '300000', 10); // 5m
const STARTUP_ALERT_COOLDOWN    = parseInt(process.env.STARTUP_ALERT_COOLDOWN || '600000', 10); // 10m

const CRITICAL_LEVEL     = parseInt(process.env.CRITICAL_DIESEL_LEVEL || '50', 10);
const ALERT_RECIPIENTS   = process.env.ALERT_RECIPIENTS || '';
const DG_RUNNING_THRESHOLD = 5; // kW

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

// Modbus/RTU port settings
const plcSettings = {
  baudRate: parseInt(process.env.PLC_BAUD_RATE || '9600', 10),
  parity: process.env.PLC_PARITY || 'none',
  dataBits: parseInt(process.env.PLC_DATA_BITS || '8', 10),
  stopBits: parseInt(process.env.PLC_STOP_BITS || '1', 10)
};

const client = new ModbusRTU();
let isPlcConnected = false;

/* ================================
   STATE
==================================*/
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

let workingRegisters = {}; // e.g. { dg1: { voltageR: {address, value, ...}, ... }, ... }

/* ================================
   REGISTERS
   Diesel (confirmed by you)
==================================*/
const dgRegisters = {
  dg1: { primary: 4104, fallback: [4105, 4106], name: "DG-1 Diesel (D108)" },
  dg2: { primary: 4100, fallback: [4101, 4102], name: "DG-2 Diesel (D104)" },
  dg3: { primary: 4102, fallback: [4103, 4107], name: "DG-3 Diesel (D106)" }
};

/* ================================
   ELECTRICAL REGISTERS (FINAL)
   Scaling:
     V/A/kW/kVAR   -> 0.1
     Frequency     -> 0.01
     Power Factor  -> 0.01
     kWh / Hours / Temp -> 1
   Notes:
     - Active Power uses known *fallback* registers (D1529/D1569/D1609/D1649)
     - Everything else follows the verified mapping (DG3 confirmed; +40 group offsets)
==================================*/
const electricalRegisters = {
  dg1: {
    voltageR:     { primary: 4196, fallback: [4197], scaling: 0.1,  name: "DG1 Voltage R", unit: "V"   }, // D100
    voltageY:     { primary: 4198, fallback: [4199], scaling: 0.1,  name: "DG1 Voltage Y", unit: "V"   }, // D102
    voltageB:     { primary: 4200, fallback: [4201], scaling: 0.1,  name: "DG1 Voltage B", unit: "V"   }, // D104
    currentR:     { primary: 4202, fallback: [4203], scaling: 0.1,  name: "DG1 Current R", unit: "A"   }, // D106
    currentY:     { primary: 4204, fallback: [4205], scaling: 0.1,  name: "DG1 Current Y", unit: "A"   }, // D108
    currentB:     { primary: 4206, fallback: [4207], scaling: 0.1,  name: "DG1 Current B", unit: "A"   }, // D110
    frequency:    { primary: 4208, fallback: [4209], scaling: 0.01, name: "DG1 Frequency", unit: "Hz"  }, // D112
    powerFactor:  { primary: 4210, fallback: [4211], scaling: 0.01, name: "DG1 Power Factor", unit: "" }, // D114
    // Active power from special bank (as observed on DG3)
    activePower:  { primary: 0,    fallback: [1529 + 4096], scaling: 0.1, name: "DG1 Active Power", unit: "kW" }, // D1529 -> 5625
    reactivePower:{ primary: 4214, fallback: [4215], scaling: 0.1,  name: "DG1 Reactive Power", unit: "kVAR" },   // D118
    energyMeter:  { primary: 4216, fallback: [4217], scaling: 1,    name: "DG1 Energy Meter", unit: "kWh"  },     // D120
    runningHours: { primary: 4218, fallback: [4219], scaling: 1,    name: "DG1 Running Hours", unit: "hrs" },     // D122
    windingTemp:  { primary: 4232, fallback: [4233], scaling: 1,    name: "DG1 Winding Temperature", unit: "°C" } // D136
  },
  dg2: {
    voltageR:     { primary: 4236, fallback: [4237], scaling: 0.1,  name: "DG2 Voltage R", unit: "V"   }, // D140
    voltageY:     { primary: 4238, fallback: [4239], scaling: 0.1,  name: "DG2 Voltage Y", unit: "V"   }, // D142
    voltageB:     { primary: 4240, fallback: [4241], scaling: 0.1,  name: "DG2 Voltage B", unit: "V"   }, // D144
    currentR:     { primary: 4242, fallback: [4243], scaling: 0.1,  name: "DG2 Current R", unit: "A"   }, // D146
    currentY:     { primary: 4244, fallback: [4245], scaling: 0.1,  name: "DG2 Current Y", unit: "A"   }, // D148
    currentB:     { primary: 4246, fallback: [4247], scaling: 0.1,  name: "DG2 Current B", unit: "A"   }, // D150
    frequency:    { primary: 4248, fallback: [4249], scaling: 0.01, name: "DG2 Frequency", unit: "Hz"  }, // D152
    powerFactor:  { primary: 4250, fallback: [4251], scaling: 0.01, name: "DG2 Power Factor", unit: "" }, // D154
    activePower:  { primary: 0,    fallback: [1569 + 4096], scaling: 0.1, name: "DG2 Active Power", unit: "kW" }, // D1569 -> 5665
    reactivePower:{ primary: 4254, fallback: [4255], scaling: 0.1,  name: "DG2 Reactive Power", unit: "kVAR" },   // D158
    energyMeter:  { primary: 4256, fallback: [4257], scaling: 1,    name: "DG2 Energy Meter", unit: "kWh"  },     // D160
    runningHours: { primary: 4258, fallback: [4259], scaling: 1,    name: "DG2 Running Hours", unit: "hrs" },     // D162
    windingTemp:  { primary: 4272, fallback: [4273], scaling: 1,    name: "DG2 Winding Temperature", unit: "°C" } // D176
  },
  dg3: {
    voltageR:     { primary: 4276, fallback: [4277], scaling: 0.1,  name: "DG3 Voltage R", unit: "V"   }, // D180
    voltageY:     { primary: 4278, fallback: [4279], scaling: 0.1,  name: "DG3 Voltage Y", unit: "V"   }, // D182
    voltageB:     { primary: 4280, fallback: [4281], scaling: 0.1,  name: "DG3 Voltage B", unit: "V"   }, // D184
    currentR:     { primary: 4282, fallback: [4283], scaling: 0.1,  name: "DG3 Current R", unit: "A"   }, // D186
    currentY:     { primary: 4284, fallback: [4285], scaling: 0.1,  name: "DG3 Current Y", unit: "A"   }, // D188
    currentB:     { primary: 4286, fallback: [4287], scaling: 0.1,  name: "DG3 Current B", unit: "A"   }, // D190
    frequency:    { primary: 4288, fallback: [4289], scaling: 0.01, name: "DG3 Frequency", unit: "Hz"  }, // D192
    powerFactor:  { primary: 4290, fallback: [4291], scaling: 0.01, name: "DG3 Power Factor", unit: "" }, // D194
    // Known working fallback for DG3
    activePower:  { primary: 0,    fallback: [1609 + 4096], scaling: 0.1, name: "DG3 Active Power", unit: "kW" }, // D1609 -> 5705
    reactivePower:{ primary: 4294, fallback: [4295], scaling: 0.1,  name: "DG3 Reactive Power", unit: "kVAR" },   // D198
    energyMeter:  { primary: 4296, fallback: [4297], scaling: 1,    name: "DG3 Energy Meter", unit: "kWh"  },     // D200
    runningHours: { primary: 4298, fallback: [4299], scaling: 1,    name: "DG3 Running Hours", unit: "hrs" },     // D202
    windingTemp:  { primary: 4312, fallback: [4313], scaling: 1,    name: "DG3 Winding Temperature", unit: "°C" } // D216
  },
  dg4: {
    voltageR:     { primary: 4316, fallback: [4317], scaling: 0.1,  name: "DG4 Voltage R", unit: "V"   }, // D220
    voltageY:     { primary: 4318, fallback: [4319], scaling: 0.1,  name: "DG4 Voltage Y", unit: "V"   }, // D222
    voltageB:     { primary: 4320, fallback: [4321], scaling: 0.1,  name: "DG4 Voltage B", unit: "V"   }, // D224
    currentR:     { primary: 4322, fallback: [4323], scaling: 0.1,  name: "DG4 Current R", unit: "A"   }, // D226
    currentY:     { primary: 4324, fallback: [4325], scaling: 0.1,  name: "DG4 Current Y", unit: "A"   }, // D228
    currentB:     { primary: 4326, fallback: [4327], scaling: 0.1,  name: "DG4 Current B", unit: "A"   }, // D230
    frequency:    { primary: 4328, fallback: [4329], scaling: 0.01, name: "DG4 Frequency", unit: "Hz"  }, // D232
    powerFactor:  { primary: 4330, fallback: [4331], scaling: 0.01, name: "DG4 Power Factor", unit: "" }, // D234
    activePower:  { primary: 0,    fallback: [1649 + 4096], scaling: 0.1, name: "DG4 Active Power", unit: "kW" }, // D1649 -> 5745
    reactivePower:{ primary: 4334, fallback: [4335], scaling: 0.1,  name: "DG4 Reactive Power", unit: "kVAR" },   // D238
    energyMeter:  { primary: 4336, fallback: [4337], scaling: 1,    name: "DG4 Energy Meter", unit: "kWh"  },     // D240
    runningHours: { primary: 4338, fallback: [4339], scaling: 1,    name: "DG4 Running Hours", unit: "hrs" },     // D242
    windingTemp:  { primary: 4352, fallback: [4353], scaling: 1,    name: "DG4 Winding Temperature", unit: "°C" } // D256
  }
};

/* ================================
   MONGODB (optional)
==================================*/
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

const DieselReadingSchema = new mongoose.Schema({
  timestamp:   { type: Date, default: Date.now, index: true },
  dg1:         { type: Number, required: true },
  dg2:         { type: Number, required: true },
  dg3:         { type: Number, required: true },
  total:       { type: Number, required: true },
  dg1_change:  { type: Number, default: 0 },
  dg2_change:  { type: Number, default: 0 },
  dg3_change:  { type: Number, default: 0 },
  hour:        { type: Number, index: true },
  date:        { type: String, index: true }
});
const DieselReading = mongoose.model('DieselReading', DieselReadingSchema);

/* ================================
   EMAIL (optional)
==================================*/
let emailTransporter = null;
let emailEnabled = false;

try {
  if (process.env.EMAIL_USER && process.env.EMAIL_APP_PASSWORD && ALERT_RECIPIENTS) {
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

/* ================================
   HELPERS
==================================*/
function toSignedInt16(value) {
  return (value > 32767) ? value - 65536 : value;
}
function isValidReading(value) {
  const signedValue = toSignedInt16(value);
  if (value === 65535 || value === 65534 || signedValue === -1) return false;
  return signedValue >= 0 && signedValue <= 600;
}
function isValidElectricalReading(value, min = -9999, max = 9999) {
  if (value === 65535 || value === 65534 || value < 0) return false;
  return value >= min && value <= max;
}
function calculateChange(current, previous) {
  return previous ? current - previous : 0;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ================================
   MODBUS READERS
==================================*/
async function readWithRetry(readFunc, retries = RETRY_ATTEMPTS) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await readFunc();
    } catch (err) {
      if (attempt === retries - 1) throw err;
      await sleep(READ_DELAY);
    }
  }
}

async function readSingleRegister(registerConfig, dataKey) {
  const addresses = [registerConfig.primary, ...(registerConfig.fallback || [])].filter(Boolean);
  for (let i = 0; i < addresses.length; i++) {
    const address = addresses[i];
    try {
      const data = await readWithRetry(() => client.readHoldingRegisters(address, 1));
      const rawValue = data?.data?.[0];
      if (rawValue === undefined || !isValidReading(rawValue)) continue;

      const signedValue = toSignedInt16(rawValue);
      let value = Math.max(0, signedValue);

      // smoothing sudden drops
      const previousValue = previousDieselData[dataKey] || 0;
      const maxChangePercent = 30;
      const changePercent = Math.abs((value - previousValue) / (previousValue || 1) * 100);
      if (changePercent > maxChangePercent && value < previousValue) value = previousValue;

      previousDieselData[dataKey] = value;
      systemData[dataKey] = value;
      return value;
    } catch (err) {
      if (i === addresses.length - 1) console.log(`[ERROR] Diesel read failed for ${registerConfig.name}`);
    }
  }
  return systemData[dataKey] || 0;
}

async function readElectricalRegister(regConfig) {
  // Try primary then fallbacks; if no primary (like activePower) we only have fallback bank
  const addresses = [];
  if (regConfig.primary) addresses.push(regConfig.primary);
  if (Array.isArray(regConfig.fallback)) addresses.push(...regConfig.fallback);

  for (let i = 0; i < addresses.length; i++) {
    const address = addresses[i];
    try {
      const data = await readWithRetry(() => client.readHoldingRegisters(address, 1));
      const raw = data?.data?.[0];
      if (raw === undefined || !isValidElectricalReading(raw)) continue;

      const value = Math.round(raw * regConfig.scaling * 100) / 100;

      const registerInfo = {
        address,
        type: (i === 0 && regConfig.primary) ? 'PRIMARY' : `FALLBACK-${i}`,
        value,
        registerName: `D${address - 4096}`,
        decimalAddress: address,
        hexAddress: `0x${address.toString(16).toUpperCase()}`
      };
      return { value, registerInfo };
    } catch (err) {
      if (i === addresses.length - 1) console.log(`[ERROR] Electrical read failed for ${regConfig.name}`);
    }
  }
  return { value: 0, registerInfo: null };
}

async function readAllElectrical(dgKey) {
  const result = {};
  const registerMap = {};
  const regs = electricalRegisters[dgKey];

  for (const key of Object.keys(regs)) {
    const { value, registerInfo } = await readElectricalRegister(regs[key]);
    result[key] = value;
    if (registerInfo) registerMap[key] = registerInfo;
    await sleep(READ_DELAY);
  }
  return { values: result, registerMap };
}

/* ================================
   EMAIL TEMPLATES
==================================*/
function getEmailTemplate(alertType, data, criticalDGs, webServerPort) {
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
            <li style="padding: 8px; border-bottom: 1px solid #eee;">DG-1: <span style="font-weight: bold;">${data.dg1} L</span></li>
            <li style="padding: 8px; border-bottom: 1px solid #eee;">DG-2: <span style="font-weight: bold;">${data.dg2} L</span></li>
            <li style="padding: 8px; border-bottom: 1px solid #eee;">DG-3: <span style="font-weight: bold;">${data.dg3} L</span></li>
          </ul>
          <p style="font-size: 14px; margin-top: 20px;">Action Required. Alert Time: ${timestamp}</p>
          <a href="${dashboardUrl}" style="display: inline-block; background: #2563eb; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; margin-top: 15px;">View Live Dashboard</a>
        </div>
      </div>`
  };
}

function getElectricalAlertTemplate(dgName, alerts, currentValues, registerMap, webServerPort) {
  const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'long' });
  const dashboardUrl = `http://${process.env.PI_IP_ADDRESS || 'localhost'}:${webServerPort}`;

  const alertsHtml = (alerts.length > 0) ? `
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
        </tr>`).join('')}
    </table>` : '';

  return {
    subject: `⚡ ${dgName} Electrical Parameters Alert`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 900px; margin: 0 auto; padding: 20px; border: 1px solid #e5e7eb; border-radius: 8px;">
        <div style="background: linear-gradient(135deg, #2563eb, #1d4ed8); color: white; padding: 20px; border-radius: 8px 8px 0 0;">
          <h1 style="margin:0;">⚡ Electrical Parameters Alert - ${dgName}</h1>
        </div>
        <div style="padding: 20px; background: #f9fafb; color: #333;">
          ${alertsHtml}
          <h3 style="margin-top: 20px;">📍 Working Register Map</h3>
          <table style="width:100%; border-collapse: collapse; background: white;">
            <tr style="background:#dbeafe;"><th>Parameter</th><th>D Reg</th><th>Decimal</th><th>Value</th><th>Type</th></tr>
            ${Object.entries(registerMap).map(([param, info]) => `
              <tr>
                <td style="border:1px solid #93c5fd; padding:8px; font-weight: bold;">${param}</td>
                <td style="border:1px solid #93c5fd; padding:8px;">${info.registerName}</td>
                <td style="border:1px solid #93c5fd; padding:8px;">${info.decimalAddress}</td>
                <td style="border:1px solid #93c5fd; padding:8px;">${info.value}</td>
                <td style="border:1px solid #93c5fd; padding:8px; color: ${info.type.startsWith('PRIMARY') ? '#10b981' : '#f59e0b'}; font-weight:bold;">${info.type}</td>
              </tr>`).join('')}
          </table>
          <p style="margin-top: 20px;">Alert Time: ${timestamp}</p>
          <a href="${dashboardUrl}" style="display: inline-block; background: #2563eb; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; margin-top: 15px;">View Live Dashboard</a>
        </div>
      </div>`
  };
}

/* ================================
   ALERT LOGIC
==================================*/
function checkDieselLevels(data, webServerPort) {
  const criticalDGs = [];
  if (data.dg1 <= CRITICAL_LEVEL) criticalDGs.push('DG-1');
  if (data.dg2 <= CRITICAL_LEVEL) criticalDGs.push('DG-2');
  if (data.dg3 <= CRITICAL_LEVEL) criticalDGs.push('DG-3');

  if (criticalDGs.length > 0) sendEmailAlert('critical', data, criticalDGs, webServerPort);
}

function checkElectricalChanges(dgKey, newValues, registerMap, webServerPort) {
  const lastKey = `electrical_${dgKey}`;
  const previousValues = alertState.lastElectricalValues[lastKey] || {};
  const alerts = [];
  const thresholds = ELECTRICAL_THRESHOLDS;

  const IS_DG_RUNNING = (newValues.activePower || 0) > DG_RUNNING_THRESHOLD;

  for (const param of Object.keys(newValues)) {
    const val = newValues[param];
    if (!IS_DG_RUNNING && (param.includes('voltage') || param === 'frequency' || param === 'powerFactor')) {
      if (val < 1) continue;
    }
    if (param.includes('voltage') && (val < thresholds.voltageMin || val > thresholds.voltageMax)) {
      alerts.push({ parameter: param, value: val, threshold: `${thresholds.voltageMin}-${thresholds.voltageMax}V`, severity: 'critical' });
    } else if (param.includes('current') && val > thresholds.currentMax) {
      alerts.push({ parameter: param, value: val, threshold: `Max ${thresholds.currentMax}A`, severity: 'warning' });
    } else if (param === 'frequency' && (val < thresholds.frequencyMin || val > thresholds.frequencyMax)) {
      alerts.push({ parameter: param, value: val, threshold: `${thresholds.frequencyMin}-${thresholds.frequencyMax}Hz`, severity: 'critical' });
    } else if (param === 'powerFactor' && val < thresholds.powerFactorMin) {
      alerts.push({ parameter: param, value: val, threshold: `Min ${thresholds.powerFactorMin}`, severity: 'warning' });
    } else if (param === 'windingTemp' && val > thresholds.temperatureMax) {
      alerts.push({ parameter: param, value: val, threshold: `Max ${thresholds.temperatureMax}°C`, severity: 'critical' });
    }
  }

  alertState.lastElectricalValues[lastKey] = { ...newValues };

  if (alerts.length > 0) {
    sendElectricalAlert(dgKey, alerts, newValues, registerMap, webServerPort);
  }
}

function checkStartupAlert(dgKey, newValues, webServerPort) {
  const lastAlertTime = alertState.lastStartupAlerts[dgKey] || 0;
  const now = Date.now();
  const IS_DG_RUNNING = (newValues.activePower || 0) > DG_RUNNING_THRESHOLD;

  if (IS_DG_RUNNING && (now - lastAlertTime) > STARTUP_ALERT_COOLDOWN) {
    const prev = alertState.lastElectricalValues[`electrical_${dgKey}`] || {};
    const WAS_DG_RUNNING = (prev.activePower || 0) > DG_RUNNING_THRESHOLD;
    if (!WAS_DG_RUNNING) {
      const dgName = dgKey.toUpperCase().replace('DG', 'DG-');
      sendStartupEmail(dgName, newValues, webServerPort);
      alertState.lastStartupAlerts[dgKey] = now;
    }
  }
}

async function sendStartupEmail(dgName, values, webServerPort) {
  if (!emailEnabled || !ALERT_RECIPIENTS) return;
  const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', timeStyle: 'long' });
  const dashboardUrl = `http://${process.env.PI_IP_ADDRESS || 'localhost'}:${webServerPort}`;
  const subject = `🟢 NOTIFICATION: ${dgName} Has Started Running`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e5e7eb; border-radius: 8px;">
      <div style="background: linear-gradient(135deg, #10b981, #34d399); color: white; padding: 20px; border-radius: 8px 8px 0 0;">
        <h1 style="margin:0;">🟢 DG STARTUP NOTIFICATION</h1>
      </div>
      <div style="padding: 20px; background: #f9fafb; color: #333;">
        <ul style="list-style:none; padding:0;">
          <li>Active Power: <b>${(values.activePower ?? 0).toFixed(1)} kW</b></li>
          <li>Voltage R: <b>${(values.voltageR ?? 0).toFixed(1)} V</b></li>
          <li>Frequency: <b>${(values.frequency ?? 0).toFixed(2)} Hz</b></li>
        </ul>
        <p>Event Time: ${timestamp}</p>
        <a href="${dashboardUrl}" style="display:inline-block; background:#2563eb; color:#fff; padding:10px 20px; border-radius:6px; text-decoration:none;">View Dashboard</a>
      </div>
    </div>`;
  try {
    await emailTransporter.sendMail({ from: `"DG Monitoring System" <${process.env.EMAIL_USER}>`, to: ALERT_RECIPIENTS, subject, html });
    console.log(`🟢 Startup alert email sent for ${dgName}`);
  } catch (err) {
    console.error('Startup Email sending error:', err.message);
  }
}

async function sendElectricalAlert(dgKey, alerts, currentValues, registerMap, webServerPort) {
  if (!emailEnabled || !ALERT_RECIPIENTS) return;
  const alertKey = `electrical_${dgKey}_${Math.floor(Date.now() / ELECTRICAL_ALERT_COOLDOWN)}`;
  if (alertState.currentAlerts.has(alertKey)) return;

  const dgName = dgKey.toUpperCase().replace('DG', 'DG-');
  const { subject, html } = getElectricalAlertTemplate(dgName, alerts, currentValues, registerMap, webServerPort);
  try {
    await emailTransporter.sendMail({ from: `"DG Monitoring System" <${process.env.EMAIL_USER}>`, to: ALERT_RECIPIENTS, subject, html });
    alertState.currentAlerts.add(alertKey);
    setTimeout(() => alertState.currentAlerts.delete(alertKey), ELECTRICAL_ALERT_COOLDOWN);
  } catch (err) {
    console.error('Electrical Email sending error:', err.message);
  }
}

async function sendEmailAlert(alertType, data, criticalDGs, webServerPort) {
  if (!emailEnabled || !ALERT_RECIPIENTS) return;
  const alertKey = `${alertType}_${Math.floor(Date.now() / ALERT_COOLDOWN)}`;
  if (alertState.currentAlerts.has(alertKey)) return;

  const { subject, html } = getEmailTemplate(alertType, data, criticalDGs, webServerPort);
  try {
    await emailTransporter.sendMail({ from: `"DG Monitoring System" <${process.env.EMAIL_USER}>`, to: ALERT_RECIPIENTS, subject, html });
    alertState.currentAlerts.add(alertKey);
    setTimeout(() => alertState.currentAlerts.delete(alertKey), ALERT_COOLDOWN);
  } catch (err) {
    console.error('Diesel Email sending error:', err.message);
  }
}

/* ================================
   MAIN POLL LOOP
==================================*/
async function readAllSystemData(webServerPort) {
  if (!isPlcConnected) return;

  try {
    // Diesel levels
    await readSingleRegister(dgRegisters.dg1, 'dg1'); await sleep(READ_DELAY);
    await readSingleRegister(dgRegisters.dg2, 'dg2'); await sleep(READ_DELAY);
    await readSingleRegister(dgRegisters.dg3, 'dg3'); await sleep(READ_DELAY);
    systemData.total = (systemData.dg1 || 0) + (systemData.dg2 || 0) + (systemData.dg3 || 0);

    // Electrical (DG1..DG4)
    for (const dgKey of ['dg1', 'dg2', 'dg3', 'dg4']) {
      const { values, registerMap } = await readAllElectrical(dgKey);
      systemData.electrical[dgKey] = values;
      workingRegisters[dgKey] = registerMap;

      checkElectricalChanges(dgKey, values, registerMap, webServerPort);
      checkStartupAlert(dgKey, values, webServerPort);
    }

    systemData.lastUpdate = new Date().toISOString();
    checkDieselLevels(systemData, webServerPort);
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
      setTimeout(() => connectToPLC(webServerPort), 5000);
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

/* ================================
   PLC CONNECT & SERVER
==================================*/
function connectToPLC(webServerPort) {
  console.log(`Attempting to connect to PLC on ${port}...`);
  client.connectRTU(port, plcSettings)
    .then(() => {
      client.setID(plcSlaveID);
      client.setTimeout(5000);
      isPlcConnected = true;
      errorCount = 0;
      console.log('✓ PLC connected successfully');
      setTimeout(() => { readAllSystemData(webServerPort); setInterval(() => readAllSystemData(webServerPort), 5000); }, 2000);
    })
    .catch((err) => {
      console.error('PLC connection error:', err.message);
      isPlcConnected = false;
      client.close();
      setTimeout(() => connectToPLC(webServerPort), 10000);
    });
}

/* ================================
   WEB SERVER (API)
==================================*/
const app = express();
const webServerPort = parseInt(process.env.PORT || '3000', 10);

app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname, { maxAge: '1d', etag: true, lastModified: true }));
app.use((req, res, next) => {
  if (req.url.match(/\.(css|js|png|jpg|jpeg|gif|ico|svg)$/)) {
    res.setHeader('Cache-Control', 'public, max-age=86400');
  }
  next();
});

// API
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/api/data', (req, res) => res.json({ ...systemData }));
app.get('/api/registers', (req, res) => res.json({ workingRegisters, electricalRegisters }));

// Graceful shutdown
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

// Start
app.listen(webServerPort, () => {
  console.log(`\n===========================================`);
  console.log(`DG Monitoring System Server Started`);
  console.log(`Web Server: http://localhost:${webServerPort}`);
  console.log(`PLC Port: ${port}`);
  console.log(`Email Alerts: ${emailEnabled ? 'Enabled' : 'Disabled'}`);
  console.log(`DG Startup Alert: Enabled (Cooldown: ${STARTUP_ALERT_COOLDOWN / 60000} minutes)`);
  console.log(`===========================================`);
  connectToPLC(webServerPort);
});