/**
 * PLC Service - Modbus RTU Communication
 * FINAL, ROBUST VERSION
 *
 * This version includes:
 * 1. Smart fallback logic with prioritized 'last known good' registers.
 * 2. 'Zero-Out' logic: If Active Power is 0, all other parameters are zeroed out.
 * 3. Prioritized Active Power registers based on vendor notes.
 */

const ModbusRTU = require('modbus-serial');
const { sendDieselAlert, sendStartupAlert } = require('./emailService');

// Configuration
const port = process.env.PLC_PORT || '/dev/ttyUSB0';
const plcSlaveID = parseInt(process.env.PLC_SLAVE_ID) || 1;
const READ_DELAY = 100;
const RETRY_ATTEMPTS = 3;
const MAX_ERRORS = 10;
const DG_RUNNING_THRESHOLD = 5; // 5 kW
const CRITICAL_LEVEL = parseInt(process.env.CRITICAL_DIESEL_LEVEL) || 50;

const plcSettings = {
  baudRate: parseInt(process.env.PLC_BAUD_RATE) || 9600,
  parity: process.env.PLC_PARITY || 'none',
  dataBits: parseInt(process.env.PLC_DATA_BITS) || 8,
  stopBits: parseInt(process.env.PLC_STOP_BITS) || 1
};

const client = new ModbusRTU();
let isPlcConnected = false;
let errorCount = 0;

// System data state
let systemData = {
  dg1: 0,
  dg2: 0,
  dg3: 0,
  total: 0,
  lastUpdate: null,
  electrical: { dg1: {}, dg2: {}, dg3: {}, dg4: {} }
};

// --- THIS IS THE NEW INTELLIGENCE ---
// 1. 'lastGoodRegister' stores the last address that worked.
// 2. 'workingRegisters' is for debugging (we can ignore for now).
// 3. 'lastGoodValues' stores the last *running* values to prevent false "0" readings.
let lastGoodRegister = { dg1: {}, dg2: {}, dg3: {}, dg4: {} };
let workingRegisters = {};
let lastGoodValues = { dg1: {}, dg2: {}, dg3: {}, dg4: {} };
// --- END NEW ---

// --- DIESEL REGISTERS (Confirmed) ---
const dgRegisters = {
  dg1: { primary: 4104, fallback: [], name: 'DG-1 Diesel (D8)' },
  dg2: { primary: 4100, fallback: [], name: 'DG-2 Diesel (D4)' },
  dg3: { primary: 4102, fallback: [], name: 'DG-3 Diesel (D6)' }
};

const C = (addr, scaling = 0.1) => ({ addr, scaling });

// --- UPDATED ELECTRICAL REGISTERS WITH FALLBACKS ---
// The *known* addresses from your notes are placed FIRST in the 'activePower' list.
const electricalCandidates = {
  dg1: { // DG1: We know Active Power is 4212 (D116)
    activePower:   [C(4212), C(5625), C(4232), C(4252), C(4216), C(4214), C(4213)],
    voltageR:      [C(4196), C(4197), C(4200)],
    voltageY:      [C(4198), C(4201), C(4202)],
    voltageB:      [C(4200), C(4203), C(4204)],
    currentR:      [C(4202), C(4205), C(4206)],
    currentY:      [C(4204), C(4207), C(4208)],
    currentB:      [C(4206), C(4209), C(4210)],
    frequency:     [C(4208, 0.01), C(4211, 0.01), C(4212, 0.01)],
    powerFactor:   [C(4210, 0.01), C(4213, 0.01), C(4214, 0.01)],
    reactivePower: [C(4214), C(4215), C(4216)],
    energyMeter:   [C(4216, 1), C(4217, 1), C(4218, 1)],
    runningHours:  [C(4218, 1), C(4219, 1), C(4220, 1)],
    windingTemp:   [C(4232, 1), C(4233, 1), C(4234, 1)] // Your note mentioned D416 (4232)
  },
  dg2: { // DG2: We know Active Power is 4252 (D156 or D136 in your note)
    activePower:   [C(4252), C(5665), C(4232), C(4212), C(4216), C(4250), C(4248)],
    voltageR:      [C(4236), C(4237), C(4240)],
    voltageY:      [C(4238), C(4241), C(4242)],
    voltageB:      [C(4240), C(4243), C(4244)],
    currentR:      [C(4242), C(4245), C(4246)],
    currentY:      [C(4244), C(4247), C(4248)],
    currentB:      [C(4246), C(4249), C(4250)],
    frequency:     [C(4248, 0.01), C(4251, 0.01), C(4252, 0.01)],
    powerFactor:   [C(4250, 0.01), C(4253, 0.01), C(4254, 0.01)],
    reactivePower: [C(4254), C(4255), C(4256)],
    energyMeter:   [C(4256, 1), C(4257, 1), C(4258, 1)],
    runningHours:  [C(4258, 1), C(4259, 1), C(4260, 1)],
    windingTemp:   [C(4272, 1), C(4273, 1), C(4274, 1)]
  },
  dg3: { // DG3: We know Active Power is 4292 (D196)
    activePower:   [C(4292)],
    voltageR:      [C(4276)],
    voltageY:      [C(4278)],
    voltageB:      [C(4280)],
    currentR:      [C(4282)],
    currentY:      [C(4284)],
    currentB:      [C(4286)],
    frequency:     [C(4288, 0.01)],
    powerFactor:   [C(4290, 0.01)],
    reactivePower: [C(4294)],
    energyMeter:   [C(4296, 1)],
    runningHours:  [C(4298, 1)],
    windingTemp:   [C(4312, 1)]
  },
  dg4: { // DG4: We know Active Power is 4332 (D236)
    activePower:   [C(4332)],
    voltageR:      [C(4316)],
    voltageY:      [C(4318)],
    voltageB:      [C(4320)],
    currentR:      [C(4322)],
    currentY:      [C(4324)],
    currentB:      [C(4326)],
    frequency:     [C(4328, 0.01)],
    powerFactor:   [C(4330, 0.01)],
    reactivePower: [C(4334)],
    energyMeter:   [C(4336, 1)],
    runningHours:  [C(4338, 1)],
    windingTemp:   [C(4352, 1)]
  }
};
// --- END OF UPDATED MAP ---

// Utilities
const toSignedInt16 = (v) => (v > 32767 ? v - 65536 : v);
const wait = (ms) => new Promise(r => setTimeout(r, ms));

function isValidDieselReading(value) {
  const s = toSignedInt16(value);
  if (value === 65535 || value === 65534 || s === -1) return false;
  return s >= 0 && s <= 600; // Assuming max 600L tank
}

function isValidElectricalReading(value) {
  if (value === 65535 || value === 65534) return false;
  return true;
}

async function readWithRetry(fn, retries = RETRY_ATTEMPTS) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === retries - 1) throw e;
      await wait(READ_DELAY);
    }
  }
}

// Read single diesel register
async function readSingleRegister(registerConfig, dataKey) {
  const address = registerConfig.primary;
  
  try {
    const data = await readWithRetry(() => client.readHoldingRegisters(address, 1));
    const rawValue = data?.data?.[0];
    
    if (rawValue === undefined || !isValidDieselReading(rawValue)) {
      return systemData[dataKey] || 0;
    }

    const value = Math.max(0, toSignedInt16(rawValue));
    systemData[dataKey] = value;
    return value;

  } catch (err) {
    console.log(`[ERROR] Failed to read ${registerConfig.name} (D${address-4096})`);
    return systemData[dataKey] || 0;
  }
}

// --- RESTORED: Smart readParam function with fallback logic ---
async function readParam(dgKey, param) {
  const candidates = electricalCandidates[dgKey][param];
  if (!candidates || candidates.length === 0) return 0;

  const tried = new Set();
  const order = [];
  
  // 1. Try the last known good address first
  const last = lastGoodRegister[dgKey][param];
  if (last) {
    order.push(last);
    tried.add(last.addr);
  }
  
  // 2. Add all other candidates
  for (const c of candidates) {
    if (!tried.has(c.addr)) order.push(c);
  }

  // 3. Try to read from the ordered list
  for (let i = 0; i < order.length; i++) {
    const { addr, scaling } = order[i];
    try {
      const data = await readWithRetry(() => client.readHoldingRegisters(addr, 1));
      const raw = data?.data?.[0];
      
      if (raw === undefined || !isValidElectricalReading(raw)) {
        continue; // Try next candidate
      }

      const scaled = Math.round(raw * (scaling ?? 0.1) * 100) / 100;

      // SUCCESS! Save this address as the 'last good' one for next time
      lastGoodRegister[dgKey][param] = { addr, scaling };
      
      return scaled;

    } catch (_) {
      // This address failed, try the next one in the loop
    }
  }
  
  // All candidates failed, return the last known good *value*
  return lastGoodValues[dgKey]?.[param] || 0;
}

// --- NEW 'ZERO-OUT' LOGIC ---
// This function creates an object full of zeros for a DG.
function getZeroElectricalValues() {
  // We must return all 12 keys so the dashboard doesn't show 'undefined'
  return {
    voltageR: 0, voltageY: 0, voltageB: 0,
    currentR: 0, currentY: 0, currentB: 0,
    frequency: 0, powerFactor: 0, activePower: 0,
    reactivePower: 0, energyMeter: 0, runningHours: 0,
    windingTemp: 0
  };
}

// Read all electrical parameters for a DG
async function readAllElectrical(dgKey) {
  const newValues = {};

  // 1. Read Active Power FIRST
  const activePower = await readParam(dgKey, 'activePower');
  newValues['activePower'] = activePower;

  // 2. Check if DG is running
  if (activePower > DG_RUNNING_THRESHOLD) {
    // --- DG IS RUNNING ---
    // Proceed to read all other 11 parameters
    const regs = electricalCandidates[dgKey];
    for (const param of Object.keys(regs)) {
      if (param === 'activePower') continue; // Already read
      
      const value = await readParam(dgKey, param);
      newValues[param] = value;
      await wait(READ_DELAY); // Wait between reads
    }
    
    // Store these values as the last known *good* set
    lastGoodValues[dgKey] = { ...newValues };
    return newValues;

  } else {
    // --- DG IS STOPPED ---
    // Return an object full of zeros for all parameters
    // We also preserve the last known Energy and Running Hours
    const zeroValues = getZeroElectricalValues();
    zeroValues.energyMeter = lastGoodValues[dgKey]?.energyMeter || 0;
    zeroValues.runningHours = lastGoodValues[dgKey]?.runningHours || 0;
    
    // Clear the last good *values* so we don't show stale data
    lastGoodValues[dgKey] = { ...zeroValues };
    return zeroValues;
  }
}
// --- END OF NEW LOGIC ---

// Check for startup and send alert
function checkStartup(dgKey, newValues) {
  const activePower = newValues.activePower || 0;
  const isRunning = activePower > DG_RUNNING_THRESHOLD;

  const prevValues = systemData.electrical[dgKey] || {};
  const wasRunningBefore = (prevValues.activePower || 0) > DG_RUNNING_THRESHOLD;

  if (isRunning && !wasRunningBefore) {
    const dgName = dgKey.toUpperCase().replace('DG', 'DG-');
    sendStartupAlert(dgName, newValues);
    console.log(`✅ Startup detected for ${dgName}`);
  }
}

// Check diesel levels and send alert
function checkDieselLevels(data) {
  const criticalDGs = [];
  if (data.dg1 <= CRITICAL_LEVEL) criticalDGs.push('DG-1');
  if (data.dg2 <= CRITICAL_LEVEL) criticalDGs.push('DG-2');
  if (data.dg3 <= CRITICAL_LEVEL) criticalDGs.push('DG-3');
  if (criticalDGs.length > 0) {
    sendDieselAlert(data, criticalDGs);
  }
}

// Main read function
async function readAllSystemData() {
  if (!isPlcConnected) return;

  try {
    // Read diesel levels
    await readSingleRegister(dgRegisters.dg1, 'dg1');
    await wait(READ_DELAY);
    await readSingleRegister(dgRegisters.dg2, 'dg2');
    await wait(READ_DELAY);
    await readSingleRegister(dgRegisters.dg3, 'dg3');
    await wait(READ_DELAY);

    systemData.total = (systemData.dg1 || 0) + (systemData.dg2 || 0) + (systemData.dg3 || 0);

    // Read electrical parameters
    for (const dgKey of ['dg1', 'dg2', 'dg3', 'dg4']) {
      const newValues = await readAllElectrical(dgKey);
      checkStartup(dgKey, newValues); // Check for startup
      systemData.electrical[dgKey] = newValues; // Save the new values
    }

    systemData.lastUpdate = new Date().toISOString();
    checkDieselLevels(systemData);
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

// PLC connection
function connectToPLC() {
  console.log(`Attempting to connect to PLC on ${port}...`);
  
  client.connectRTU(port, plcSettings)
    .then(() => {
      client.setID(plcSlaveID);
      client.setTimeout(5000);
      isPlcConnected = true;
      errorCount = 0;
      console.log('✓ PLC connected successfully');
      
      setTimeout(() => {
        readAllSystemData();
        setInterval(readAllSystemData, 5000); // Loop every 5 seconds
      }, 2000);
    })
    .catch((err) => {
      console.error('PLC connection error:', err.message);
      isPlcConnected = false;
      client.close();
      setTimeout(connectToPLC, 10000);
    });
}

function closePLC() {
  try {
    client.close();
    isPlcConnected = false;
    console.log('PLC connection closed');
  } catch (err) {
    console.error('Error closing PLC:', err);
  }
}

function getSystemData() {
  return { ...systemData };
}

function isConnected() {
  return isPlcConnected;
}

module.exports = {
  connectToPLC,
  closePLC,
  readAllSystemData,
  getSystemData,
  isConnected
};