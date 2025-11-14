/**
 * PLC Service - Modbus RTU Communication
 * FINAL, ROBUST VERSION (v4)
 *
 * This version includes:
 * 1. A REBUILT register map based on your handwritten notes and test logs.
 * 2. Implemented fallbacks for DG1, DG2, and DG4 using your notes (D416, D418, etc.).
 * 3. A new experimental map for DG3 to find the missing '0' values.
 * 4. Corrected scaling for DG3's Power Factor.
 * 5. 'Zero-Out' logic (if kW is 0, all else is 0).
 * 6. Startup check that sends all 4 DG parameters in the email.
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

let lastGoodRegister = { dg1: {}, dg2: {}, dg3: {}, dg4: {} };
let lastGoodValues = { dg1: {}, dg2: {}, dg3: {}, dg4: {} };

// --- DIESEL REGISTERS (Confirmed) ---
const dgRegisters = {
  dg1: { primary: 4104, fallback: [], name: 'DG-1 Diesel (D8)' },
  dg2: { primary: 4100, fallback: [], name: 'DG-2 Diesel (D4)' },
  dg3: { primary: 4102, fallback: [], name: 'DG-3 Diesel (D6)' }
};

const C = (addr, scaling = 0.1) => ({ addr, scaling });

// ---
//
// --- THE FINAL CORRECTED ELECTRICAL MAP (v4) ---
// Based on all vendor documents, notes, and test logs.
//
// ---
const electricalCandidates = {
  dg1: { // DG1: Based on D100 block (4196) + Your Notes as Fallbacks
    activePower:   [C(4212), C(5625)],        // D116=4212 (from note) is PRIMARY
    voltageR:      [C(4196), C(4197)],
    voltageY:      [C(4198), C(4199)],
    voltageB:      [C(4200), C(4201)],
    currentR:      [C(4202), C(4203)],
    currentY:      [C(4204), C(4205)],
    currentB:      [C(4206), C(4207)],
    frequency:     [C(4208, 0.01), C(4209, 0.01)],
    powerFactor:   [C(4210, 0.01), C(4211, 0.01)],
    reactivePower: [C(4214), C(4215)],
    energyMeter:   [C(4216, 1), C(4217, 1)],
    runningHours:  [C(4218, 1), C(4219, 1)],
    windingTemp:   [C(4232, 1), C(4512, 1)] // D136=4232 (note) PRIMARY, D416=4512 (note) FALLBACK
  },
  dg2: { // DG2: Based on D140 block (4236) + Your Notes as Fallbacks
    activePower:   [C(4252), C(5665)],        // D156=4252 (from note) is PRIMARY
    voltageR:      [C(4236), C(4237)],
    voltageY:      [C(4238), C(4239)],
    voltageB:      [C(4240), C(4241)],
    currentR:      [C(4242), C(4243)],
    currentY:      [C(4244), C(4245)],
    currentB:      [C(4246), C(4247)],
    frequency:     [C(4248, 0.01), C(4249, 0.01)],
    powerFactor:   [C(4250, 0.01), C(4251, 0.01)],
    reactivePower: [C(4254), C(4255)],
    energyMeter:   [C(4256, 1), C(4257, 1)],
    runningHours:  [C(4258, 1), C(4259, 1)],
    windingTemp:   [C(4272, 1), C(4514, 1)] // D418=4514 (from note) is FALLBACK
  },
  dg3: { // DG3: Your test showed D180 block (4276) is WRONG for V/I/Hz.
         // We KNOW Active Power is 4292.
         // We will GUESS the other params are in the *same D180 block* but shifted.
    activePower:   [C(4292)],              // D196 - This is 100% CORRECT
    reactivePower: [C(4294)],              // D197 - This is LIKELY (showed 399.10)
    energyMeter:   [C(4296, 1)],           // D198 - This is LIKELY (showed 16.00)
    runningHours:  [C(4298, 1)],           // D199 - This is LIKELY (showed 30.00)
    powerFactor:   [C(4290, 0.0001)],      // D195 - SCALING FIXED (31.73 -> 0.3173)

    // --- NEW GUESSES for the "0" values ---
    // The old map was wrong. Let's try the addresses *right before* Active Power.
    voltageR:      [C(4282), C(4276)], // Trying D186 first
    voltageY:      [C(4284), C(4278)], // Trying D187 first
    voltageB:      [C(4286), C(4280)], // Trying D188 first
    currentR:      [C(4276), C(4282)], // Trying D180 first
    currentY:      [C(4278), C(4284)], // Trying D181 first
    currentB:      [C(4280), C(4286)], // Trying D182 first
    frequency:     [C(4288, 0.01)],     // D194 - This is still the most likely
    windingTemp:   [C(4312, 1)],
  },
  dg4: { // DG4: Based on D220 block (4316) + Your Notes as Fallbacks
    activePower:   [C(4332)],              // D236 - PRIMARY
    voltageR:      [C(4316), C(4317)],
    voltageY:      [C(4318), C(4319)],
    voltageB:      [C(4320), C(4321)],
    currentR:      [C(4322), C(4323)],
    currentY:      [C(4324), C(4325)],
    currentB:      [C(4326), C(4327)],
    frequency:     [C(4328, 0.01), C(4329, 0.01)],
    powerFactor:   [C(4330, 0.01), C(4331, 0.01)],
    reactivePower: [C(4334), C(4335)],
    energyMeter:   [C(4336, 1), C(4337, 1)],
    runningHours:  [C(4338, 1), C(4339, 1)],
    windingTemp:   [C(4352, 1), C(4516, 1)] // D420=4516 (from note) is FALLBACK
  }
};
// --- END OF MAP ---


// Utilities
const toSignedInt16 = (v) => (v > 32767 ? v - 65536 : v);
const wait = (ms) => new Promise(r => setTimeout(r, ms));

function isValidDieselReading(value) {
  const s = toSignedInt16(value);
  if (value === 65535 || value === 65534 || s === -1) return false;
  return s >= 0 && s <= 600;
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

// Smart readParam function with fallback logic
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

      const scaled = Math.round(raw * (scaling ?? 0.1) * 10000) / 10000; // Increased precision

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

// 'Zero-Out' logic
function getZeroElectricalValues() {
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
  const activePower = await readParam(dgKey, 'activePower');
  newValues['activePower'] = activePower;

  if (activePower > DG_RUNNING_THRESHOLD) {
    // --- DG IS RUNNING ---
    const regs = electricalCandidates[dgKey];
    for (const param of Object.keys(regs)) {
      if (param === 'activePower') continue;
      const value = await readParam(dgKey, param);
      newValues[param] = value;
      await wait(READ_DELAY);
    }
    lastGoodValues[dgKey] = { ...newValues }; // Save this as the last known *running* state
    return newValues;
  } else {
    // --- DG IS STOPPED ---
    const zeroValues = getZeroElectricalValues();
    
    // We must preserve the last known Energy and Running Hours
    zeroValues.energyMeter = await readParam(dgKey, 'energyMeter');
    zeroValues.runningHours = await readParam(dgKey, 'runningHours');

    if (zeroValues.energyMeter === 0) {
      zeroValues.energyMeter = lastGoodValues[dgKey]?.energyMeter || 0;
    }
    if (zeroValues.runningHours === 0) {
      zeroValues.runningHours = lastGoodValues[dgKey]?.runningHours || 0;
    }

    lastGoodValues[dgKey] = { ...zeroValues }; // Save the "off" state
    return zeroValues;
  }
}

// Check for startup and send alert
function checkStartup(dgKey, newValues, oldElectricalData, allNewValues) {
  const activePower = newValues.activePower || 0;
  const isRunning = activePower > DG_RUNNING_THRESHOLD;
  const wasRunningBefore = (oldElectricalData[dgKey]?.activePower || 0) > DG_RUNNING_THRESHOLD;

  if (isRunning && !wasRunningBefore) {
    const dgName = dgKey.toUpperCase().replace('DG', 'DG-');
    sendStartupAlert(dgName, allNewValues); 
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

    // 1. Read all new electrical data
    const allNewValues = {};
    for (const dgKey of ['dg1', 'dg2', 'dg3', 'dg4']) {
      allNewValues[dgKey] = await readAllElectrical(dgKey);
    }
    
    // 2. Store the *old* state
    const oldElectricalData = { ...systemData.electrical }; 
    
    // 3. Save new values to systemData
    systemData.electrical = allNewValues; 
    systemData.lastUpdate = new Date().toISOString();

    // 4. Check for startups, comparing new vs. old
    for (const dgKey of ['dg1', 'dg2', 'dg3', 'dg4']) {
      checkStartup(dgKey, allNewValues[dgKey], oldElectricalData, allNewValues); 
    }

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
        setInterval(readAllSystemData, 5000);
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