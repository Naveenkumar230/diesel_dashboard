/**
 * PLC Service - INDUSTRIAL ACCUMULATOR VERSION
 * * COMBINES:
 * 1. Full Electrical Data (Voltage, Amps, Freq).
 * 2. Fallback Logic (Tries multiple registers).
 * 3. SAFETY LOGIC (Dead sensor reset + Sticky values).
 * 4. TEST SUPPORT.
 * 5. NEW: Fuel Accumulator Logic (Ratchet & Bucket).
 * 6. NEW: Start/Stop Consumption Logging (DG1).
 * 7. NEW: Calculated Cost & Fuel Rate (Server Side).
 * * UPDATED: Recursive Loop for Stability (No Crashes).
 */

const ModbusRTU = require('modbus-serial');
const { sendDieselAlert, sendStartupAlert } = require('./emailService');
const fuelAccumulator = require('./fuelAccumulator'); 
const { processDg1Data } = require('./dgMonitor'); 
const Log = require('../models/Log'); 

// --- CONFIGURATION ---
const port = process.env.PLC_PORT || '/dev/ttyUSB0';
const plcSlaveID = parseInt(process.env.PLC_SLAVE_ID) || 1;
const READ_DELAY = 100; 
const RETRY_ATTEMPTS = 2; 
const MAX_ERRORS = 20;
const DG_RUNNING_THRESHOLD = 5; 
const CRITICAL_LEVEL = parseInt(process.env.CRITICAL_DIESEL_LEVEL) || 50;
const STALE_THRESHOLD_MS = 5 * 60 * 1000; 
const LOOP_DELAY = 2000; 

// ✅ ANALYTICS CONSTANTS
const DIESEL_PRICE = 97.00; 
const MAX_AMPS_125KVA = 175;

const plcSettings = {
  baudRate: parseInt(process.env.PLC_BAUD_RATE) || 9600,
  parity: process.env.PLC_PARITY || 'none',
  dataBits: parseInt(process.env.PLC_DATA_BITS) || 8,
  stopBits: parseInt(process.env.PLC_STOP_BITS) || 1
};

const client = new ModbusRTU();
let isPlcConnected = false;
let errorCount = 0;
let isLoopRunning = false; 

// --- STATE MANAGEMENT ---
let systemData = {
  dg1: 0, dg2: 0, dg3: 0, total: 0,
  lastUpdate: null,
  electrical: { dg1: {}, dg2: {}, dg3: {}, dg4: {} },
  dataQuality: {
    dg1_stale: false, dg2_stale: false, dg3_stale: false, lastSuccessfulRead: null
  }
};

// Initialize Sticky Values
let lastGoodRegister = { dg1: {}, dg2: {}, dg3: {}, dg4: {} };
let lastGoodValues = {
    dg1: getZeroElectricalValues(),
    dg2: getZeroElectricalValues(),
    dg3: getZeroElectricalValues(),
    dg4: getZeroElectricalValues()
};

// --- DIESEL REGISTERS ---
const dgRegisters = {
  dg1: { primary: 4104, fallback: [], name: 'DG-1 Diesel (D8)' },
  dg2: { primary: 4100, fallback: [], name: 'DG-2 Diesel (D4)' },
  dg3: { primary: 4102, fallback: [], name: 'DG-3 Diesel (D6)' }
};

const C = (addr, scaling = 0.1) => ({ addr, scaling });

const electricalCandidates = {
  dg1: {
    voltageR: [C(4728)], voltageY: [C(4730)], voltageB: [C(4732)],
    currentR: [C(4704)], currentY: [C(4706)], currentB: [C(4708)],
    activePower: [C(4696, 0.01)], frequency: [C(4752, 0.01)],
    powerFactor: [C(4760, 0.01)], runningHours: [C(4518, 1)],
  },
  dg2: {
    voltageR: [C(4734)], voltageY: [C(4736)], voltageB: [C(4738)],
    currentR: [C(4710)], currentY: [C(4712)], currentB: [C(4714)],
    activePower: [C(4716, 0.01)], frequency: [C(4754, 0.01)],
    powerFactor: [C(4762, 0.01)], runningHours: [C(4516, 1)],
  },
  dg3: {
    voltageR: [C(4740)], voltageY: [C(4742)], voltageB: [C(4744)],
    currentR: [C(4716)], currentY: [C(4718)], currentB: [C(4720)],
    activePower: [C(4700, 0.01)], frequency: [C(4756, 0.01)],
    powerFactor: [C(4764, 0.01)], runningHours: [C(4512, 1)],
  },
  dg4: {
    voltageR: [C(4746)], voltageY: [C(4748)], voltageB: [C(4750)],
    currentR: [C(4722)], currentY: [C(4724)], currentB: [C(4726)],
    activePower: [C(4702, 0.01)], frequency: [C(4758, 0.01)],
    powerFactor: [C(4766, 0.01)], runningHours: [C(4514, 1)],
  }
};

const toSignedInt16 = (v) => (v > 32767 ? v - 65536 : v);
const wait = (ms) => new Promise(r => setTimeout(r, ms));

// ✅ NEW: ANALYTICS CALCULATOR
function calculateAnalytics(currentR, currentY, currentB) {
    const avgAmps = (currentR + currentY + currentB) / 3 || 0;
    
    if (avgAmps < 5) {
        return { fuelRate: 0, estCost: 0, loadPct: 0 };
    }

    let loadPct = avgAmps / MAX_AMPS_125KVA;
    if (loadPct > 1) loadPct = 1;

    const fuelRate = 4.5 + ((18 - 4.5) * loadPct);
    const estCost = fuelRate * DIESEL_PRICE;

    return {
        fuelRate: parseFloat(fuelRate.toFixed(2)),
        estCost: Math.round(estCost),
        loadPct: Math.round(loadPct * 100)
    };
}

function isValidDieselReading(value) {
  const s = toSignedInt16(value);
  if (value === 65535 || value === 65534 || s === -1) return false;
  return s >= 1 && s <= 2000; 
}

function isValidElectricalReading(value) {
  if (value === 65535 || value === 65534) return false;
  return true;
}

async function readWithRetry(fn, retries = RETRY_ATTEMPTS) {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); } 
    catch (e) { if (i === retries - 1) throw e; await wait(READ_DELAY); }
  }
}

async function readSingleRegister(registerConfig, dataKey) {
  const address = registerConfig.primary;
  try {
    const data = await readWithRetry(() => client.readHoldingRegisters(address, 1));
    const rawValue = data?.data?.[0];
    if (rawValue === undefined || !isValidDieselReading(rawValue)) throw new Error(`Invalid Reading`);
    const value = Math.max(0, toSignedInt16(rawValue));
    systemData.dataQuality[dataKey + '_stale'] = false;
    systemData.dataQuality.lastSuccessfulRead = new Date().toISOString();
    return value;
  } catch (err) {
    systemData.dataQuality[dataKey + '_stale'] = true;
    const lastReadTime = systemData.dataQuality.lastSuccessfulRead ? new Date(systemData.dataQuality.lastSuccessfulRead).getTime() : 0;
    if (Date.now() - lastReadTime > STALE_THRESHOLD_MS) return 0;
    return fuelAccumulator.getDisplayLevel(dataKey) || 0;
  }
}

async function readParam(dgKey, param) {
  const candidates = electricalCandidates[dgKey][param];
  if (!candidates || candidates.length === 0) return 0;
  const tried = new Set();
  const order = [];
  const last = lastGoodRegister[dgKey][param];
  if (last) { order.push(last); tried.add(last.addr); }
  for (const c of candidates) { if (!tried.has(c.addr)) order.push(c); }

  for (let i = 0; i < order.length; i++) {
    const { addr, scaling } = order[i];
    try {
      const data = await readWithRetry(() => client.readHoldingRegisters(addr, 1));
      const raw = data?.data?.[0];
      if (raw === undefined || !isValidElectricalReading(raw)) continue;
      const scaled = Math.round(raw * (scaling ?? 0.1) * 10000) / 10000;
      lastGoodRegister[dgKey][param] = { addr, scaling };
      if (!lastGoodValues[dgKey]) lastGoodValues[dgKey] = {};
      lastGoodValues[dgKey][param] = scaled;
      return scaled;
    } catch (err) {}
  }
  return lastGoodValues[dgKey]?.[param] || 0;
}

function getZeroElectricalValues() {
  return {
    voltageR: 0, voltageY: 0, voltageB: 0,
    currentR: 0, currentY: 0, currentB: 0,
    frequency: 0, activePower: 0, powerFactor: 0, runningHours: 0
  };
}

async function readAllElectrical(dgKey) {
  const result = {
    activePower: 0,
    voltageR: 0, voltageY: 0, voltageB: 0,
    currentR: 0, currentY: 0, currentB: 0,
    frequency: 0, powerFactor: 0, runningHours: 0
  };

  try {
    result.activePower = await readParam(dgKey, 'activePower');
    result.voltageR = await readParam(dgKey, 'voltageR'); await wait(20);
    result.voltageY = await readParam(dgKey, 'voltageY'); await wait(20);
    result.voltageB = await readParam(dgKey, 'voltageB');
    result.currentR = await readParam(dgKey, 'currentR'); await wait(20);
    result.currentY = await readParam(dgKey, 'currentY'); await wait(20);
    result.currentB = await readParam(dgKey, 'currentB');
    result.frequency = await readParam(dgKey, 'frequency');
    result.powerFactor = await readParam(dgKey, 'powerFactor');
    result.runningHours = await readParam(dgKey, 'runningHours');
    lastGoodValues[dgKey] = { ...result };
    return result;
  } catch (error) {
    return lastGoodValues[dgKey] || result;
  }
}

function checkStartup(dgKey, newValues, oldElectricalData, allNewValues) {
  const activePower = newValues.activePower || 0;
  const isRunning = activePower > DG_RUNNING_THRESHOLD;
  const wasRunningBefore = (oldElectricalData[dgKey]?.activePower || 0) > DG_RUNNING_THRESHOLD;
  if (isRunning && !wasRunningBefore) {
    if (process.uptime() < 20) return;
    const dgName = dgKey.toUpperCase().replace('DG', 'DG-');
    if (dgKey === 'dg1' || dgKey === 'dg2' || dgKey === 'dg4') {
      sendStartupAlert(dgName, allNewValues);
    }
  }
}

// --- MAIN LOOP ---
async function readAllSystemData() {
  if (!isPlcConnected) return;

  try {
    const allNewValues = {};
    const dgList = ['dg1', 'dg2', 'dg3', 'dg4'];

    for (const dgKey of dgList) {
        // 1. Read Raw Electrical Data
        const electricalData = await readAllElectrical(dgKey);

        // ✅ 2. CALCULATE ANALYTICS (Cost, Fuel, Load%)
        const analytics = calculateAnalytics(electricalData.currentR, electricalData.currentY, electricalData.currentB);
        
        // Merge analytics into the electrical object
        // This ensures that when schedulerService saves this object, 
        // it saves the cost/fuel too!
        Object.assign(electricalData, analytics); 

        allNewValues[dgKey] = electricalData;

        // 3. Logic for Diesel Level & Running Status
        const isRunning = (electricalData.voltageR > 100);
        if (dgRegisters[dgKey]) {
            const rawLevel = await readSingleRegister(dgRegisters[dgKey], dgKey);
            await fuelAccumulator.processReading(dgKey, rawLevel, isRunning);
            systemData[dgKey] = fuelAccumulator.getDisplayLevel(dgKey);

            if (dgKey === 'dg1') {
                const estimatedRpm = electricalData.frequency * 30; 
                const runResult = processDg1Data(estimatedRpm, rawLevel);
                if (runResult) {
                    const newLog = new Log({
                        timestamp: new Date(),
                        event: "DG_STOPPED",
                        startLevel: runResult.startLevel,
                        endLevel: runResult.endLevel,
                        consumption: runResult.consumption,
                        duration: 0 
                    });
                    newLog.save();
                }
            }
        }
    }

    systemData.total = (systemData.dg1 || 0) + (systemData.dg2 || 0) + (systemData.dg3 || 0);
    const oldElectricalData = { ...systemData.electrical };
    systemData.electrical = allNewValues;
    systemData.lastUpdate = new Date().toISOString();

    for (const dgKey of dgList) {
      checkStartup(dgKey, allNewValues[dgKey], oldElectricalData, allNewValues);
    }
    checkDieselLevels(systemData);
    errorCount = 0;

  } catch (err) {
    errorCount++;
    if (errorCount >= MAX_ERRORS) {
      isPlcConnected = false;
      client.close();
      setTimeout(connectToPLC, 5000);
      return;
    }
  }

  if (isPlcConnected) {
      setTimeout(readAllSystemData, LOOP_DELAY);
  }
}

function checkDieselLevels(data) {
  const criticalDGs = [];
  if (data.dg1 <= CRITICAL_LEVEL) criticalDGs.push('DG-1');
  if (data.dg2 <= CRITICAL_LEVEL) criticalDGs.push('DG-2');
  if (criticalDGs.length > 0) sendDieselAlert(data, criticalDGs);
}

function connectToPLC() {
  if (isLoopRunning) return; 
  console.log(`Attempting to connect to PLC on ${port}...`);
  client.connectRTU(port, plcSettings)
    .then(() => {
      client.setID(plcSlaveID);
      client.setTimeout(4000); 
      isPlcConnected = true;
      isLoopRunning = true;
      errorCount = 0;
      console.log('✓ PLC connected successfully');
      readAllSystemData();
    })
    .catch((err) => {
      isLoopRunning = false;
      setTimeout(connectToPLC, 10000);
    });
}

function closePLC() { try { client.close(); } catch (_) {} }
function getSystemData() { return { ...systemData }; }
function isConnected() { return isPlcConnected; }

module.exports = {
  connectToPLC,
  closePLC,
  readAllSystemData,
  getSystemData,
  isConnected,
  isValidDieselReading,
  _test_systemData: systemData
};