/**
 * DG Monitoring System - Enhanced Server
 * Features: Multi-page dashboard, analytics, Excel exports
 */

require('dotenv').config();
const ModbusRTU = require('modbus-serial');
const express = require('express');
const path = require('path');
const mongoose = require('mongoose');
const cors = require('cors');
const nodemailer = require('nodemailer');
const compression = require('compression');
const ExcelJS = require('exceljs');

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
const DG_RUNNING_THRESHOLD = 5;

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

const lastGoodRegister = {
  dg1: {}, dg2: {}, dg3: {}, dg4: {}
};

let workingRegisters = {};

// -------------------- REGISTER MAPS --------------------
const dgRegisters = {
  dg1: { primary: 4104, fallback: [4105, 4106], name: 'DG-1 Diesel (D108)' },
  dg2: { primary: 4100, fallback: [4101, 4102], name: 'DG-2 Diesel (D104)' },
  dg3: { primary: 4102, fallback: [4103, 4107], name: 'DG-3 Diesel (D106)' }
};

const C = (addr, scaling = 0.1) => ({ addr, scaling });

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
    activePower: [
      C(5665, 0.1), C(4252, 0.1), C(4232, 0.1), C(4212, 0.1), C(4216, 0.1),
      C(4250, 0.1), C(4248, 0.1)
    ],
    reactivePower: [C(4254), C(4255), C(4256)],
    energyMeter: [C(4256, 1), C(4257, 1), C(4258, 1)],
    runningHours: [C(4258, 1), C(4259, 1), C(4260, 1)],
    windingTemp: [C(4272, 1), C(4273, 1), C(4274, 1)]
  },
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
    else console.log('MongoDB unavailable. Running without persistence.');
    isMongoConnected = false;
  }
}

mongoose.connection.on('connected', () => { isMongoConnected = true; console.log('MongoDB established'); });
mongoose.connection.on('disconnected', () => { isMongoConnected = false; console.log('MongoDB disconnected'); setTimeout(connectMongoDB, 5000); });
mongoose.connection.on('error', (err) => { isMongoConnected = false; console.error('MongoDB error:', err); });

// Schemas
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

const ElectricalLogSchema = new mongoose.Schema({
  timestamp: { type: Date, default: Date.now, index: true },
  dg: { type: String, required: true, index: true },
  voltageR: Number,
  voltageY: Number,
  voltageB: Number,
  currentR: Number,
  currentY: Number,
  currentB: Number,
  frequency: Number,
  powerFactor: Number,
  activePower: Number,
  reactivePower: Number,
  energyMeter: Number,
  runningHours: Number,
  windingTemp: Number,
  isRunning: Boolean
});

const DieselReading = mongoose.model('DieselReading', DieselReadingSchema);
const ElectricalLog = mongoose.model('ElectricalLog', ElectricalLogSchema);

connectMongoDB();

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

// -------------------- Diesel Readers --------------------
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

// -------------------- Electrical Readers --------------------
async function readParam(dgKey, param) {
  const candidates = electricalCandidates[dgKey][param];
  if (!candidates || candidates.length === 0) return { value: 0, registerInfo: null };

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

      if (param === 'activePower' && (!isFinite(scaled) || scaled === 0)) continue;

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
    } catch (_) {}
  }
  return { value: 0, registerInfo: null };
}

async function readAllElectrical(dgKey) {
  const regs = electricalCandidates[dgKey];
  const prevValues = systemData.electrical[dgKey] || {};
  const newValues = {};
  const registerMap = {};
  
  const wasRunning = prevValues.activePower > DG_RUNNING_THRESHOLD;

  for (const param of Object.keys(regs)) {
    const { value, registerInfo } = await readParam(dgKey, param);

    if ((dgKey === "dg1" || dgKey === "dg2")) {
      if (!isFinite(value) || value <= 0) {
        newValues[param] = prevValues[param] ?? 0;
      } else {
        newValues[param] = value;
      }
    } else {
      newValues[param] = value;
    }

    if (registerInfo) registerMap[param] = registerInfo;
    await wait(READ_DELAY);
  }

  const isRunning = newValues.activePower > DG_RUNNING_THRESHOLD;

  if ((dgKey === "dg1" || dgKey === "dg2") && !isRunning && wasRunning) {
    console.log(`⏸️ ${dgKey.toUpperCase()} STOPPED → Freezing last values`);
    return { values: { ...prevValues }, registerMap };
  }

  return { values: newValues, registerMap };
}

// -------------------- Alerts --------------------
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
      if (v < 1) continue;
    }
    if (param.includes('voltage') && (v < T.voltageMin || v > T.voltageMax)) 
      alerts.push({ parameter: param, value: v, threshold: `${T.voltageMin}-${T.voltageMax}V`, severity: 'critical' });
    else if (param.includes('current') && v > T.currentMax) 
      alerts.push({ parameter: param, value: v, threshold: `Max ${T.currentMax}A`, severity: 'warning' });
    else if (param === 'frequency' && (v < T.frequencyMin || v > T.frequencyMax)) 
      alerts.push({ parameter: param, value: v, threshold: `${T.frequencyMin}-${T.frequencyMax}Hz`, severity: 'critical' });
    else if (param === 'powerFactor' && v < T.powerFactorMin) 
      alerts.push({ parameter: param, value: v, threshold: `Min ${T.powerFactorMin}`, severity: 'warning' });
    else if (param === 'windingTemp' && v > T.temperatureMax) 
      alerts.push({ parameter: param, value: v, threshold: `Max ${T.temperatureMax}°C`, severity: 'critical' });
  }

  alertState.lastElectricalValues[lastKey] = { ...newValues };
  if (alerts.length > 0 && emailEnabled) sendElectricalAlert(dgKey, [], alerts, newValues, registerMap);
}

function checkStartupAlert(dgKey, newValues) {
  if (!(dgKey === "dg1" || dgKey === "dg2")) return;

  const lastAlertTime = alertState.lastStartupAlerts[dgKey] || 0;
  const now = Date.now();
  
  const activePower = newValues.activePower || 0;
  const isRunning = activePower > DG_RUNNING_THRESHOLD;

  let validCount = 0;
  for (const param in newValues) {
    const val = newValues[param];
    if (isFinite(val) && val > 0) validCount++;
  }

  const MIN_REQUIRED_PARAMETERS = 4;
  const fullyRunning = isRunning && validCount >= MIN_REQUIRED_PARAMETERS;

  const lastValues = alertState.lastElectricalValues[`electrical_${dgKey}`] || {};
  const wasRunningBefore = (lastValues.activePower || 0) > DG_RUNNING_THRESHOLD;

  if (fullyRunning && !wasRunningBefore && (now - lastAlertTime) > STARTUP_ALERT_COOLDOWN) {
    const dgName = dgKey.toUpperCase().replace("DG", "DG-");
    if (emailEnabled) sendStartupEmail(dgName, newValues);
    alertState.lastStartupAlerts[dgKey] = now;
    console.log(`✅ Startup alert for ${dgName}`);
  }
}

async function sendStartupEmail(dgName, values) {
  if (!emailEnabled) return;
  // Email template code omitted for brevity
}

async function sendElectricalAlert(dgKey, changes, alerts, currentValues, registerMap) {
  if (!emailEnabled) return;
  // Email template code omitted for brevity
}

async function sendEmailAlert(alertType, data, criticalDGs) {
  if (!emailEnabled) return;
  // Email template code omitted for brevity
}

// -------------------- Main Loop --------------------
async function readAllSystemData() {
  if (!isPlcConnected) return;
  try {
    await readSingleRegister(dgRegisters.dg1, 'dg1'); await wait(READ_DELAY);
    await readSingleRegister(dgRegisters.dg2, 'dg2'); await wait(READ_DELAY);
    await readSingleRegister(dgRegisters.dg3, 'dg3'); await wait(READ_DELAY);
    systemData.total = (systemData.dg1 || 0) + (systemData.dg2 || 0) + (systemData.dg3 || 0);

    for (const dgKey of ['dg1', 'dg2', 'dg3', 'dg4']) {
      const result = await readAllElectrical(dgKey);
      systemData.electrical[dgKey] = result.values;
      workingRegisters[dgKey] = result.registerMap;

      if (dgKey === 'dg1' || dgKey === 'dg2') {
        console.log(`[${dgKey.toUpperCase()}] Active Power = ${result.values.activePower} kW`);
        checkElectricalChanges(dgKey, result.values, result.registerMap);
        checkStartupAlert(dgKey, result.values);
      }

      // Save electrical logs when running
      if (result.values.activePower > DG_RUNNING_THRESHOLD) {
        await saveElectricalLog(dgKey, result.values);
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

async function saveElectricalLog(dgKey, values) {
  if (!isMongoConnected) return;
  try {
    const log = new ElectricalLog({
      dg: dgKey,
      ...values,
      isRunning: values.activePower > DG_RUNNING_THRESHOLD
    });
    await log.save();
  } catch (err) {
    console.error('Electrical log save error:', err.message);
  }
}

// -------------------- PLC + Web --------------------
function connectToPLC() {
  console.log(`Connecting to PLC on ${port}...`);
  client.connectRTU(port, plcSettings)
    .then(() => {
      client.setID(plcSlaveID);
      client.setTimeout(5000);
      isPlcConnected = true;
      errorCount = 0;
      console.log('✓ PLC connected');
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

// API Routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/diesel', (req, res) => res.sendFile(path.join(__dirname, 'diesel.html')));
app.get('/electrical', (req, res) => res.sendFile(path.join(__dirname, 'electrical.html')));
app.get('/api/data', (req, res) => res.json({ ...systemData }));
app.get('/api/registers', (req, res) => res.json({ workingRegisters, lastGoodRegister }));

// Analytics API
app.get('/api/diesel/history', async (req, res) => {
  try {
    const { days = 7 } = req.query;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(days));
    
    const data = await DieselReading.find({
      timestamp: { $gte: startDate }
    }).sort({ timestamp: 1 }).lean();
    
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/electrical/history', async (req, res) => {
  try {
    const { dg, days = 7 } = req.query;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(days));
    
    const query = { timestamp: { $gte: startDate }, isRunning: true };
    if (dg) query.dg = dg;
    
    const data = await ElectricalLog.find(query).sort({ timestamp: 1 }).lean();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Excel Export Routes
app.get('/api/export/diesel', async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(days));
    
    const data = await DieselReading.find({
      timestamp: { $gte: startDate }
    }).sort({ timestamp: 1 }).lean();

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Diesel Consumption');
    
    sheet.columns = [
      { header: 'Timestamp', key: 'timestamp', width: 20 },
      { header: 'DG-1 Level (L)', key: 'dg1', width: 15 },
      { header: 'DG-2 Level (L)', key: 'dg2', width: 15 },
      { header: 'DG-3 Level (L)', key: 'dg3', width: 15 },
      { header: 'Total (L)', key: 'total', width: 15 },
      { header: 'DG-1 Change', key: 'dg1_change', width: 15 },
      { header: 'DG-2 Change', key: 'dg2_change', width: 15 },
      { header: 'DG-3 Change', key: 'dg3_change', width: 15 }
    ];

    data.forEach(row => {
      sheet.addRow({
        timestamp: new Date(row.timestamp).toLocaleString('en-IN'),
        dg1: row.dg1,
        dg2: row.dg2,
        dg3: row.dg3,
        total: row.total,
        dg1_change: row.dg1_change,
        dg2_change: row.dg2_change,
        dg3_change: row.dg3_change
      });
    });

    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
    sheet.getRow(1).font = { color: { argb: 'FFFFFFFF' }, bold: true };

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=DG_Diesel_Report_${new Date().toISOString().split('T')[0]}.xlsx`);
    
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/export/electrical', async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(days));
    
    const data = await ElectricalLog.find({
      timestamp: { $gte: startDate },
      isRunning: true
    }).sort({ timestamp: 1 }).lean();

    const workbook = new ExcelJS.Workbook();
    
    ['dg1', 'dg2', 'dg3', 'dg4'].forEach(dg => {
      const dgData = data.filter(d => d.dg === dg);
      if (dgData.length === 0) return;
      
      const sheet = workbook.addWorksheet(dg.toUpperCase());
      
      sheet.columns = [
        { header: 'Timestamp', key: 'timestamp', width: 20 },
        { header: 'Voltage R (V)', key: 'voltageR', width: 15 },
        { header: 'Voltage Y (V)', key: 'voltageY', width: 15 },
        { header: 'Voltage B (V)', key: 'voltageB', width: 15 },
        { header: 'Current R (A)', key: 'currentR', width: 15 },
        { header: 'Current Y (A)', key: 'currentY', width: 15 },
        { header: 'Current B (A)', key: 'currentB', width: 15 },
        { header: 'Frequency (Hz)', key: 'frequency', width: 15 },
        { header: 'Power Factor', key: 'powerFactor', width: 15 },
        { header: 'Active Power (kW)', key: 'activePower', width: 18 },
        { header: 'Reactive Power (kVAR)', key: 'reactivePower', width: 20 },
        { header: 'Energy Meter', key: 'energyMeter', width: 15 },
        { header: 'Running Hours', key: 'runningHours', width: 15 },
        { header: 'Winding Temp (°C)', key: 'windingTemp', width: 18 }
      ];

      dgData.forEach(row => {
        sheet.addRow({
          timestamp: new Date(row.timestamp).toLocaleString('en-IN'),
          voltageR: row.voltageR?.toFixed(1),
          voltageY: row.voltageY?.toFixed(1),
          voltageB: row.voltageB?.toFixed(1),
          currentR: row.currentR?.toFixed(1),
          currentY: row.currentY?.toFixed(1),
          currentB: row.currentB?.toFixed(1),
          frequency: row.frequency?.toFixed(2),
          powerFactor: row.powerFactor?.toFixed(2),
          activePower: row.activePower?.toFixed(1),
          reactivePower: row.reactivePower?.toFixed(1),
          energyMeter: row.energyMeter,
          runningHours: row.runningHours,
          windingTemp: row.windingTemp
        });
      });

      sheet.getRow(1).font = { bold: true };
      sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF10B981' } };
      sheet.getRow(1).font = { color: { argb: 'FFFFFFFF' }, bold: true };
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=DG_Electrical_Report_${new Date().toISOString().split('T')[0]}.xlsx`);
    
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Shutdown
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
  console.log('\nReceived SIGTERM...');
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
  console.log(`DG Monitoring System - Enhanced Server`);
  console.log(`Web Server: http://localhost:${webServerPort}`);
  console.log(`PLC Port: ${port}`);
  console.log(`Email Alerts: ${emailEnabled ? 'Enabled' : 'Disabled'}`);
  console.log(`Features: Multi-page dashboard, Analytics, Excel Export`);
  console.log(`===========================================`);
  connectToPLC();
});