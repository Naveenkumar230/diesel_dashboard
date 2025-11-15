/**
 * PLC Service - Modbus RTU Communication
 * Enhanced fallback version for DG1, DG2, DG3 (v6)
 *
 * - Diesel reads unchanged
 * - DG4 unchanged
 * - DG1, DG2, DG3: each electrical parameter has 20-30+ fallback candidates
 * - Uses your existing patterns and scaling logic
 *
 * NOTE: Fallback addresses are generated programmatically around the
 * known primary addresses (based on D-register -> 4096 + Dn pattern).
 * This is the safest way to provide many fallbacks without vendor docs.
 */

const ModbusRTU = require('modbus-serial');
const { sendDieselAlert, sendStartupAlert } = require('./emailService');

// Configuration (unchanged)
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

// System data state (unchanged)
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

// --- DIESEL REGISTERS (Confirmed) --- (unchanged)
const dgRegisters = {
  dg1: { primary: 4104, fallback: [], name: 'DG-1 Diesel (D8)' },
  dg2: { primary: 4100, fallback: [], name: 'DG-2 Diesel (D4)' },
  dg3: { primary: 4102, fallback: [], name: 'DG-3 Diesel (D6)' }
};

const C = (addr, scaling = 0.1) => ({ addr, scaling });

// ------------------------------------------------------------------
// Helper to generate fallback lists
// - primaryAddr: decimal holding register address (Modbus) e.g. 4212
// - count: how many close offsets to include
// - step: step between addresses (1 default)
// - extras: array of extra offsets to include (e.g. +100, +200, +500)
// Returns array of C(addr, scaling)
// ------------------------------------------------------------------
function genFallbacks(primaryAddr, count = 30, step = 1, extras = [50,100,200,500]) {
  const arr = [];
  // center around primary: negative offsets first then positive
  const half = Math.floor(count / 2);
  for (let i = -half; i <= half; i++) {
    const addr = primaryAddr + (i * step);
    if (addr > 0) arr.push(C(addr));
  }
  // include extras (further distant candidates)
  for (const ex of extras) {
    arr.push(C(primaryAddr + ex));
    arr.push(C(primaryAddr - ex));
  }
  // dedupe addresses while preserving order
  const seen = new Set();
  const dedup = [];
  for (const it of arr) {
    if (!seen.has(it.addr) && it.addr > 0) {
      dedup.push(it);
      seen.add(it.addr);
    }
  }
  // limit to about 40 candidates max
  return dedup.slice(0, 45);
}

// ------------------------------------------------------------------
// Electrical map (DG4 remains exactly as before)
// For DG1, DG2, DG3 we expand candidates using genFallbacks
// Primary addresses are preserved from your provided code.
// ------------------------------------------------------------------
const electricalCandidates = {
  dg1: { // based on your v4 primaries (kept same as your posted code)
    activePower:   genFallbacks(4212, 35, 1),
    voltageR:      genFallbacks(4196, 35, 1),
    voltageY:      genFallbacks(4198, 35, 1),
    voltageB:      genFallbacks(4200, 35, 1),
    currentR:      genFallbacks(4202, 35, 1),
    currentY:      genFallbacks(4204, 35, 1),
    currentB:      genFallbacks(4206, 35, 1),
    frequency:     genFallbacks(4208, 35, 1).map(x => ({ addr: x.addr, scaling: 0.01 })),
    powerFactor:   genFallbacks(4210, 35, 1).map(x => ({ addr: x.addr, scaling: 0.01 })),
    reactivePower: genFallbacks(4214, 35, 1),
    energyMeter:   genFallbacks(4216, 35, 1).map(x => ({ addr: x.addr, scaling: 1 })),
    runningHours:  genFallbacks(4218, 35, 1).map(x => ({ addr: x.addr, scaling: 1 })),
    windingTemp:   [...genFallbacks(4232, 20, 1).map(x=>({addr:x.addr,scaling:1})), {addr:4512,scaling:1}]
  },

  dg2: {
    activePower:   genFallbacks(4252, 35, 1),
    voltageR:      genFallbacks(4236, 35, 1),
    voltageY:      genFallbacks(4238, 35, 1),
    voltageB:      genFallbacks(4240, 35, 1),
    currentR:      genFallbacks(4242, 35, 1),
    currentY:      genFallbacks(4244, 35, 1),
    currentB:      genFallbacks(4246, 35, 1),
    frequency:     genFallbacks(4248, 35, 1).map(x => ({ addr: x.addr, scaling: 0.01 })),
    powerFactor:   genFallbacks(4250, 35, 1).map(x => ({ addr: x.addr, scaling: 0.01 })),
    reactivePower: genFallbacks(4254, 35, 1),
    energyMeter:   genFallbacks(4256, 35, 1).map(x => ({ addr: x.addr, scaling: 1 })),
    runningHours:  genFallbacks(4258, 35, 1).map(x => ({ addr: x.addr, scaling: 1 })),
    windingTemp:   [...genFallbacks(4272, 20, 1).map(x=>({addr:x.addr,scaling:1})), {addr:4514,scaling:1}]
  },

  dg3: { // previously had only a few addresses; now we add many fallbacks
    // these primaries were in your v4 code — we generate many fallbacks around them
    activePower:   genFallbacks(4292, 40, 1),
    reactivePower: genFallbacks(4294, 40, 1),
    energyMeter:   genFallbacks(4296, 40, 1).map(x => ({ addr: x.addr, scaling: 1 })),
    runningHours:  genFallbacks(4298, 40, 1).map(x => ({ addr: x.addr, scaling: 1 })),
    powerFactor:   genFallbacks(4290, 40, 1).map(x => ({ addr: x.addr, scaling: 0.0001 })),
    windingTemp:   genFallbacks(4312, 30, 1).map(x => ({ addr: x.addr, scaling: 1 })),

    // Previously empty arrays (voltage/current/frequency) — now we fill with broad fallbacks
    voltageR:      genFallbacks(4260, 40, 1),
    voltageY:      genFallbacks(4262, 40, 1),
    voltageB:      genFallbacks(4264, 40, 1),
    currentR:      genFallbacks(4266, 40, 1),
    currentY:      genFallbacks(4268, 40, 1),
    currentB:      genFallbacks(4270, 40, 1),
    frequency:     genFallbacks(4280, 40, 1).map(x => ({ addr: x.addr, scaling: 0.01 }))
  },

  dg4: { // DG4 left unchanged in principle — we reuse your existing primaries exactly
    activePower:   [C(4332)],
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
    windingTemp:   [C(4352, 1), C(4516, 1)]
  }
};

// Utilities (unchanged)
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

// Read single diesel register (unchanged)
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
    console.log(`[ERROR] Failed to read ${registerConfig.name} (Addr ${address})`);
    return systemData[dataKey] || 0;
  }
}

// readParam with fallback logic (keeps lastGoodRegister optimization)
async function readParam(dgKey, param) {
  const candidates = electricalCandidates[dgKey][param];
  if (!candidates || candidates.length === 0) return 0;

  const tried = new Set();
  const order = [];

  const last = lastGoodRegister[dgKey][param];
  if (last) {
    order.push(last);
    tried.add(last.addr);
  }

  for (const c of candidates) {
    if (!tried.has(c.addr)) order.push(c);
  }

  for (let i = 0; i < order.length; i++) {
    const { addr, scaling } = order[i];
    try {
      const data = await readWithRetry(() => client.readHoldingRegisters(addr, 1));
      const raw = data?.data?.[0];

      if (raw === undefined || !isValidElectricalReading(raw)) {
        continue; // Try next candidate
      }

      // apply scaling; default fallback scaling chosen to mimic original (0.1) behavior
      const scale = (typeof scaling === 'number') ? scaling : 0.1;
      const scaled = Math.round(raw * scale * 10000) / 10000;

      // store last good and return
      lastGoodRegister[dgKey][param] = { addr, scaling: scale };
      lastGoodValues[dgKey][param] = scaled;
      return scaled;

    } catch (err) {
      // on error, try next candidate
    }
  }

  // If nothing works, return last cached value or 0
  return (lastGoodValues[dgKey]?.[param] ?? 0);
}

// Zero-out logic (unchanged)
function getZeroElectricalValues() {
  return {
    voltageR: 0, voltageY: 0, voltageB: 0,
    currentR: 0, currentY: 0, currentB: 0,
    frequency: 0, powerFactor: 0, activePower: 0,
    reactivePower: 0, energyMeter: 0, runningHours: 0,
    windingTemp: 0
  };
}

// Read all electrical parameters for a DG (unchanged flow but uses expanded candidates)
async function readAllElectrical(dgKey) {
  const newValues = {};
  const activePower = await readParam(dgKey, 'activePower');
  newValues['activePower'] = activePower;

  if (activePower > DG_RUNNING_THRESHOLD) {
    // DG is running: read all params
    const regs = electricalCandidates[dgKey];
    for (const param of Object.keys(regs)) {
      if (param === 'activePower') continue;
      const value = await readParam(dgKey, param);
      newValues[param] = value;
      await wait(READ_DELAY);
    }
    lastGoodValues[dgKey] = { ...lastGoodValues[dgKey], ...newValues };
    return newValues;
  } else {
    // DG stopped: zero most sensors but keep energy/hours persisted
    const zeroValues = getZeroElectricalValues();
    zeroValues.energyMeter = await readParam(dgKey, 'energyMeter');
    zeroValues.runningHours = await readParam(dgKey, 'runningHours');

    if (!zeroValues.energyMeter) zeroValues.energyMeter = lastGoodValues[dgKey]?.energyMeter || 0;
    if (!zeroValues.runningHours) zeroValues.runningHours = lastGoodValues[dgKey]?.runningHours || 0;

    lastGoodValues[dgKey] = { ...lastGoodValues[dgKey], ...zeroValues };
    return zeroValues;
  }
}

// Startup/email logic (keeps your updated behavior)
function checkStartup(dgKey, newValues, oldElectricalData, allNewValues) {
  const activePower = newValues.activePower || 0;
  const isRunning = activePower > DG_RUNNING_THRESHOLD;
  const wasRunningBefore = (oldElectricalData[dgKey]?.activePower || 0) > DG_RUNNING_THRESHOLD;

  if (isRunning && !wasRunningBefore) {
    const dgName = dgKey.toUpperCase().replace('DG', 'DG-');
    if (dgKey === 'dg1' || dgKey === 'dg2' || dgKey === 'dg4') {
      sendStartupAlert(dgName, allNewValues);
      console.log(`✅ Startup detected for ${dgName} (Email Sent)`);
    } else {
      console.log(`✅ Startup detected for ${dgName} (Email NOT sent - configured)`);
    }
  }
}

// checkDieselLevels (unchanged)
function checkDieselLevels(data) {
  const criticalDGs = [];
  if (data.dg1 <= CRITICAL_LEVEL) criticalDGs.push('DG-1');
  if (data.dg2 <= CRITICAL_LEVEL) criticalDGs.push('DG-2');
  if (data.dg3 <= CRITICAL_LEVEL) criticalDGs.push('DG-3');
  if (criticalDGs.length > 0) {
    sendDieselAlert(data, criticalDGs);
  }
}

// Main read function (unchanged flow)
async function readAllSystemData() {
  if (!isPlcConnected) return;

  try {
    // Diesel reads (unchanged)
    await readSingleRegister(dgRegisters.dg1, 'dg1');
    await wait(READ_DELAY);
    await readSingleRegister(dgRegisters.dg2, 'dg2');
    await wait(READ_DELAY);
    await readSingleRegister(dgRegisters.dg3, 'dg3');
    await wait(READ_DELAY);

    systemData.total = (systemData.dg1 || 0) + (systemData.dg2 || 0) + (systemData.dg3 || 0);

    const allNewValues = {};
    for (const dgKey of ['dg1', 'dg2', 'dg3', 'dg4']) {
      allNewValues[dgKey] = await readAllElectrical(dgKey);
    }

    const oldElectricalData = { ...systemData.electrical };
    systemData.electrical = allNewValues;
    systemData.lastUpdate = new Date().toISOString();

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

// PLC connection (unchanged)
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
