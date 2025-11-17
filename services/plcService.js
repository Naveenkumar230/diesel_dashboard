/**
 * PLC Service - Modbus RTU Communication
 * FINAL "STICKY" VERSION (v7)
 *
 * Updates:
 * 1. STICKY VALUES: If a read fails, it returns the LAST KNOWN VALUE (not 0).
 * 2. DIESEL STICKY: Diesel levels persist on error.
 * 3. Increased READ_DELAY to 200ms for stability.
 * 4. Massive Fallback Map (20+ addresses) included.
 */

const ModbusRTU = require('modbus-serial');
const { sendDieselAlert, sendStartupAlert } = require('./emailService');

// Configuration
const port = process.env.PLC_PORT || '/dev/ttyUSB0';
const plcSlaveID = parseInt(process.env.PLC_SLAVE_ID) || 1;
// UPDATED: Increased delay to prevent "Device Busy" errors with so many fallbacks
const READ_DELAY = 200; 
const RETRY_ATTEMPTS = 3;
const MAX_ERRORS = 20; // More tolerant of errors
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

// Initialize Last Good Values (To make them sticky)
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

// --- MASSIVE FALLBACK MAP ---
const electricalCandidates = {
  dg1: { 
    activePower:   [C(5625), C(4212), C(4232), C(4252), C(4216), C(4214), C(4213), C(4512), C(4514), C(4516)],
    voltageR:      [C(4196), C(4197), C(4512), C(4232), C(4236), C(4276), C(4316), C(4198), C(4200), C(4202), C(4204), C(4206)],
    voltageY:      [C(4198), C(4199), C(4514), C(4238), C(4278), C(4318), C(4196), C(4200), C(4202), C(4204), C(4206)],
    voltageB:      [C(4200), C(4201), C(4516), C(4240), C(4280), C(4320), C(4196), C(4198), C(4202), C(4204), C(4206)],
    currentR:      [C(4202), C(4203), C(4232), C(4242), C(4282), C(4322), C(4196), C(4198), C(4200), C(4204), C(4206)],
    currentY:      [C(4204), C(4205), C(4234), C(4244), C(4284), C(4324), C(4196), C(4198), C(4200), C(4202), C(4206)],
    currentB:      [C(4206), C(4207), C(4236), C(4246), C(4286), C(4326), C(4196), C(4198), C(4200), C(4202), C(4204)],
    frequency:     [C(4208, 0.01), C(4209, 0.01), C(4248, 0.01), C(4288, 0.01), C(4328, 0.01)],
    powerFactor:   [C(4210, 0.01), C(4211, 0.01), C(4250, 0.01), C(4290, 0.01), C(4330, 0.01)],
    reactivePower: [C(4214), C(4215), C(4254), C(4294), C(4334)],
    energyMeter:   [C(4216, 1), C(4217, 1), C(4256, 1), C(4296, 1), C(4336, 1)],
    runningHours:  [C(4218, 1), C(4219, 1), C(4258, 1), C(4298, 1), C(4338, 1)],
    windingTemp:   [C(4232, 1), C(4512, 1), C(4272, 1), C(4312, 1), C(4352, 1)] 
  },
  dg2: { 
    activePower:   [C(5665), C(4252), C(4232), C(4212), C(4216), C(4250), C(4248), C(4512), C(4514), C(4516)],
    voltageR:      [C(4236), C(4237), C(4514), C(4196), C(4276), C(4316), C(4238), C(4240), C(4242), C(4244), C(4246)],
    voltageY:      [C(4238), C(4239), C(4198), C(4278), C(4318), C(4236), C(4240), C(4242), C(4244), C(4246)],
    voltageB:      [C(4240), C(4241), C(4200), C(4280), C(4320), C(4236), C(4238), C(4242), C(4244), C(4246)],
    currentR:      [C(4242), C(4243), C(4202), C(4282), C(4322), C(4236), C(4238), C(4240), C(4244), C(4246)],
    currentY:      [C(4244), C(4245), C(4204), C(4284), C(4324), C(4236), C(4238), C(4240), C(4242), C(4246)],
    currentB:      [C(4246), C(4247), C(4206), C(4286), C(4326), C(4236), C(4238), C(4240), C(4242), C(4244)],
    frequency:     [C(4248, 0.01), C(4249, 0.01), C(4208, 0.01), C(4288, 0.01), C(4328, 0.01)],
    powerFactor:   [C(4250, 0.01), C(4251, 0.01), C(4210, 0.01), C(4290, 0.01), C(4330, 0.01)],
    reactivePower: [C(4254), C(4255), C(4214), C(4294), C(4334)],
    energyMeter:   [C(4256, 1), C(4257, 1), C(4216, 1), C(4296, 1), C(4336, 1)],
    runningHours:  [C(4258, 1), C(4259, 1), C(4218, 1), C(4298, 1), C(4338, 1)],
    windingTemp:   [C(4272, 1), C(4514, 1), C(4232, 1), C(4312, 1), C(4352, 1)]
  },
  dg3: { 
    // Optimized for DG3 based on tests
    activePower:   [C(4292)],
    reactivePower: [C(4294)],
    energyMeter:   [C(4296, 1)],
    runningHours:  [C(4298, 1)],
    powerFactor:   [C(4290, 0.0001)],
    windingTemp:   [C(4312, 1)],
    // Empty arrays for missing params to force 0
    voltageR: [], voltageY: [], voltageB: [],
    currentR: [], currentY: [], currentB: [], frequency: []
  },
  dg4: { 
    activePower:   [C(4332), C(4516), C(5625), C(5665), C(4212), C(4252), C(4292)],
    voltageR:      [C(4316), C(4317), C(4196), C(4236), C(4276), C(4318), C(4320), C(4322), C(4324), C(4326)],
    voltageY:      [C(4318), C(4319), C(4198), C(4238), C(4278), C(4316), C(4320), C(4322), C(4324), C(4326)],
    voltageB:      [C(4320), C(4321), C(4200), C(4240), C(4280), C(4316), C(4318), C(4322), C(4324), C(4326)],
    currentR:      [C(4322), C(4323), C(4202), C(4242), C(4282), C(4316), C(4318), C(4320), C(4324), C(4326)],
    currentY:      [C(4324), C(4325), C(4204), C(4244), C(4284), C(4316), C(4318), C(4320), C(4322), C(4326)],
    currentB:      [C(4326), C(4327), C(4206), C(4246), C(4286), C(4316), C(4318), C(4320), C(4322), C(4324)],
    frequency:     [C(4328, 0.01), C(4329, 0.01), C(4208, 0.01), C(4248, 0.01), C(4288, 0.01)],
    powerFactor:   [C(4330, 0.01), C(4331, 0.01), C(4210, 0.01), C(4250, 0.01), C(4290, 0.01)],
    reactivePower: [C(4334), C(4335), C(4214), C(4254), C(4294)],
    energyMeter:   [C(4336, 1), C(4337, 1), C(4216, 1), C(4256, 1), C(4296, 1)],
    runningHours:  [C(4338, 1), C(4339, 1), C(4218, 1), C(4258, 1), C(4298, 1)],
    windingTemp:   [C(4352, 1), C(4516, 1), C(4232, 1), C(4272, 1), C(4312, 1)]
  }
};

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

// Read single diesel register with STICKY logic
async function readSingleRegister(registerConfig, dataKey) {
  const address = registerConfig.primary;
  try {
    const data = await readWithRetry(() => client.readHoldingRegisters(address, 1));
    const rawValue = data?.data?.[0];
    if (rawValue === undefined || !isValidDieselReading(rawValue)) {
      // READ FAILED: Return last known good value (Sticky)
      return systemData[dataKey] || 0;
    }
    const value = Math.max(0, toSignedInt16(rawValue));
    systemData[dataKey] = value;
    return value;
  } catch (err) {
    // READ FAILED: Return last known good value (Sticky)
    return systemData[dataKey] || 0;
  }
}

// Smart readParam with STICKY logic and Fallbacks
async function readParam(dgKey, param) {
  const candidates = electricalCandidates[dgKey][param];
  if (!candidates || candidates.length === 0) return 0;
  
  const tried = new Set();
  const order = [];
  
  // 1. Try last known good address
  const last = lastGoodRegister[dgKey][param];
  if (last) {
    order.push(last);
    tried.add(last.addr);
  }
  
  // 2. Add remaining candidates
  for (const c of candidates) {
    if (!tried.has(c.addr)) order.push(c);
  }

  for (let i = 0; i < order.length; i++) {
    const { addr, scaling } = order[i];
    try {
      const data = await readWithRetry(() => client.readHoldingRegisters(addr, 1));
      const raw = data?.data?.[0];
      
      if (raw === undefined || !isValidElectricalReading(raw)) {
        continue;
      }

      const scaled = Math.round(raw * (scaling ?? 0.1) * 10000) / 10000;
      lastGoodRegister[dgKey][param] = { addr, scaling };
      
      // Update last known good value
      if (!lastGoodValues[dgKey]) lastGoodValues[dgKey] = {};
      lastGoodValues[dgKey][param] = scaled;

      return scaled;
    } catch (_) {}
  }
  
  // ALL FAILED: Return last known good value (Sticky)
  return lastGoodValues[dgKey]?.[param] || 0;
}

function getZeroElectricalValues() {
  return {
    voltageR: 0, voltageY: 0, voltageB: 0,
    currentR: 0, currentY: 0, currentB: 0,
    frequency: 0, powerFactor: 0, activePower: 0,
    reactivePower: 0, energyMeter: 0, runningHours: 0,
    windingTemp: 0
  };
}

async function readAllElectrical(dgKey) {
  const newValues = {};
  
  // 1. Read Active Power first
  const activePower = await readParam(dgKey, 'activePower');
  newValues['activePower'] = activePower;

  if (activePower > DG_RUNNING_THRESHOLD) {
    // --- RUNNING ---
    const regs = electricalCandidates[dgKey];
    for (const param of Object.keys(regs)) {
      if (param === 'activePower') continue;
      newValues[param] = await readParam(dgKey, param);
      await wait(READ_DELAY);
    }
    // Update sticky values
    lastGoodValues[dgKey] = { ...newValues };
    return newValues;
  } else {
    // --- STOPPED ---
    const zeroValues = getZeroElectricalValues();
    
    // Update sticky Energy and RunHours (always read these)
    zeroValues.energyMeter = await readParam(dgKey, 'energyMeter');
    zeroValues.runningHours = await readParam(dgKey, 'runningHours');

    // Fallback to last good if read failed
    if (zeroValues.energyMeter === 0) zeroValues.energyMeter = lastGoodValues[dgKey]?.energyMeter || 0;
    if (zeroValues.runningHours === 0) zeroValues.runningHours = lastGoodValues[dgKey]?.runningHours || 0;

    lastGoodValues[dgKey] = { ...zeroValues };
    return zeroValues;
  }
}

function checkStartup(dgKey, newValues, oldElectricalData, allNewValues) {
  const activePower = newValues.activePower || 0;
  const isRunning = activePower > DG_RUNNING_THRESHOLD;
  const wasRunningBefore = (oldElectricalData[dgKey]?.activePower || 0) > DG_RUNNING_THRESHOLD;

  if (isRunning && !wasRunningBefore) {
    const dgName = dgKey.toUpperCase().replace('DG', 'DG-');
    // Email alert logic: Only for DG1, DG2, DG4
    if (dgKey === 'dg1' || dgKey === 'dg2' || dgKey === 'dg4') {
      sendStartupAlert(dgName, allNewValues); 
      console.log(`✅ Startup detected for ${dgName} (Email Sent)`);
    } else {
      console.log(`✅ Startup detected for ${dgName} (Email NOT sent - as per config)`);
    }
  }
}

function checkDieselLevels(data) {
  const criticalDGs = [];
  if (data.dg1 <= CRITICAL_LEVEL) criticalDGs.push('DG-1');
  if (data.dg2 <= CRITICAL_LEVEL) criticalDGs.push('DG-2');
  if (data.dg3 <= CRITICAL_LEVEL) criticalDGs.push('DG-3');
  if (criticalDGs.length > 0) {
    sendDieselAlert(data, criticalDGs);
  }
}

async function readAllSystemData() {
  if (!isPlcConnected) return;

  try {
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
      isPlcConnected = false;
      errorCount = 0;
      client.close();
      setTimeout(connectToPLC, 5000);
    }
  }
}

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