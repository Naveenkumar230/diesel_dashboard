/**
 * PLC Service - Modbus RTU Communication
 */

const ModbusRTU = require('modbus-serial');
const { sendDieselAlert, sendStartupAlert } = require('./emailService');

// Configuration
const port = process.env.PLC_PORT || '/dev/ttyUSB0';
const plcSlaveID = parseInt(process.env.PLC_SLAVE_ID) || 1;
const READ_DELAY = 100;
const RETRY_ATTEMPTS = 2;
const MAX_ERRORS = 10;
const DG_RUNNING_THRESHOLD = 5;
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

let previousDieselData = { dg1: 0, dg2: 0, dg3: 0 };
let lastGoodRegister = { dg1: {}, dg2: {}, dg3: {}, dg4: {} };
let workingRegisters = {};

// Register maps
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
    voltageR: [C(4276)],
    voltageY: [C(4278)],
    voltageB: [C(4280)],
    currentR: [C(4282)],
    currentY: [C(4284)],
    currentB: [C(4286)],
    frequency: [C(4288, 0.01)],
    powerFactor: [C(4290, 0.01)],
    activePower: [C(4292)],
    reactivePower: [C(4294)],
    energyMeter: [C(4296, 1)],
    runningHours: [C(4298, 1)],
    windingTemp: [C(4312, 1)]
  },
  dg4: {
    voltageR: [C(4316)],
    voltageY: [C(4318)],
    voltageB: [C(4320)],
    currentR: [C(4322)],
    currentY: [C(4324)],
    currentB: [C(4326)],
    frequency: [C(4328, 0.01)],
    powerFactor: [C(4330, 0.01)],
    activePower: [C(4332)],
    reactivePower: [C(4334)],
    energyMeter: [C(4336, 1)],
    runningHours: [C(4338, 1)],
    windingTemp: [C(4352, 1)]
  }
};

// Utilities
const toSignedInt16 = (v) => (v > 32767 ? v - 65536 : v);
const wait = (ms) => new Promise(r => setTimeout(r, ms));

function isValidReading(value) {
  const s = toSignedInt16(value);
  if (value === 65535 || value === 65534 || s === -1) return false;
  return s >= 0 && s <= 600;
}

function isValidElectricalReading(value, min = -9999, max = 9999) {
  if (value === 65535 || value === 65534 || value < 0) return false;
  return value >= min && value <= max;
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

      if (changePercent > maxChangePercent && value < prev) {
        value = prev;
      }
      
      previousDieselData[dataKey] = value;
      systemData[dataKey] = value;
      return value;
    } catch (_) {
      if (i === addresses.length - 1) {
        console.log(`[ERROR] All attempts failed for ${registerConfig.name}`);
      }
    }
  }
  
  return systemData[dataKey] || 0;
}

// Read electrical parameter with fallback
async function readParam(dgKey, param) {
  const candidates = electricalCandidates[dgKey][param];
  if (!candidates || candidates.length === 0) return { value: 0, registerInfo: null };

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
      
      if (raw === undefined || !isValidElectricalReading(raw)) continue;

      const scaled = Math.round(raw * (scaling ?? 0.1) * 100) / 100;

      if (param === 'activePower' && (!isFinite(scaled) || scaled === 0)) {
        continue;
      }

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

// Read all electrical parameters for a DG
async function readAllElectrical(dgKey) {
  const regs = electricalCandidates[dgKey];
  const prevValues = systemData.electrical[dgKey] || {};
  const newValues = {};
  const registerMap = {};

  const wasRunning = prevValues.activePower > DG_RUNNING_THRESHOLD;

  for (const param of Object.keys(regs)) {
    const { value, registerInfo } = await readParam(dgKey, param);

    if ((dgKey === 'dg1' || dgKey === 'dg2')) {
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

  if ((dgKey === 'dg1' || dgKey === 'dg2') && !isRunning && wasRunning) {
    console.log(`⏸️ ${dgKey.toUpperCase()} STOPPED → Freezing last values`);
    return { values: { ...prevValues }, registerMap };
  }

  return { values: newValues, registerMap };
}

// Check for startup and send alert
function checkStartup(dgKey, newValues) {
  if (!(dgKey === 'dg1' || dgKey === 'dg2')) return;

  const activePower = newValues.activePower || 0;
  const isRunning = activePower > DG_RUNNING_THRESHOLD;

  let validCount = 0;
  for (const param in newValues) {
    const val = newValues[param];
    if (isFinite(val) && val > 0) validCount++;
  }

  const MIN_REQUIRED_PARAMETERS = 4;
  const fullyRunning = isRunning && validCount >= MIN_REQUIRED_PARAMETERS;

  const prevValues = systemData.electrical[dgKey] || {};
  const wasRunningBefore = (prevValues.activePower || 0) > DG_RUNNING_THRESHOLD;

  if (fullyRunning && !wasRunningBefore) {
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
      const result = await readAllElectrical(dgKey);
      systemData.electrical[dgKey] = result.values;
      workingRegisters[dgKey] = result.registerMap;

      if (dgKey === 'dg1' || dgKey === 'dg2') {
        checkStartup(dgKey, result.values);
      }
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