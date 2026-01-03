/**
 * PLC Service - INDUSTRIAL ACCUMULATOR VERSION
 * * COMBINES:
 * 1. Full Electrical Data (Voltage, Amps, Freq).
 * 2. Fallback Logic (Tries multiple registers).
 * 3. SAFETY LOGIC (Dead sensor reset + Sticky values).
 * 4. TEST SUPPORT.
 * 5. NEW: Fuel Accumulator Logic (Ratchet & Bucket).
 * 6. NEW: Start/Stop Consumption Logging (DG1).
 */

const ModbusRTU = require('modbus-serial');
const { sendDieselAlert, sendStartupAlert } = require('./emailService');
const fuelAccumulator = require('./fuelAccumulator'); 
const { processDg1Data } = require('./dgMonitor'); // Import our new logic
const Log = require('../models/Log'); // Ensure you have your Log model imported

// --- CONFIGURATION ---
const port = process.env.PLC_PORT || '/dev/ttyUSB0';
const plcSlaveID = parseInt(process.env.PLC_SLAVE_ID) || 1;
const READ_DELAY = 200;
const RETRY_ATTEMPTS = 3;
const MAX_ERRORS = 20;
const DG_RUNNING_THRESHOLD = 5; // 5 kW (Used for Alerts)
const CRITICAL_LEVEL = parseInt(process.env.CRITICAL_DIESEL_LEVEL) || 50;
const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 Minutes Safety Timeout

const plcSettings = {
  baudRate: parseInt(process.env.PLC_BAUD_RATE) || 9600,
  parity: process.env.PLC_PARITY || 'none',
  dataBits: parseInt(process.env.PLC_DATA_BITS) || 8,
  stopBits: parseInt(process.env.PLC_STOP_BITS) || 1
};

const client = new ModbusRTU();
let isPlcConnected = false;
let errorCount = 0;

// --- STATE MANAGEMENT ---
let systemData = {
  dg1: 0,
  dg2: 0,
  dg3: 0,
  total: 0,
  lastUpdate: null,
  electrical: { dg1: {}, dg2: {}, dg3: {}, dg4: {} },
  dataQuality: {
    dg1_stale: false,
    dg2_stale: false,
    dg3_stale: false,
    lastSuccessfulRead: null
  }
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

// ✅ FIXED: Active Power scaling changed to 0.01 to fix "2535kW" bug
const electricalCandidates = {
  // === DG-1 ===
  dg1: {
    voltageR:      [C(4728)],       // d632 → 632+4096=4728 ✅
    voltageY:      [C(4730)],       // d634 → 634+4096=4730 ✅
    voltageB:      [C(4732)],       // d636 → 636+4096=4732 ✅
    currentR:      [C(4704)],       // d608 → 608+4096=4704 ✅
    currentY:      [C(4706)],       // d610 → 610+4096=4706 ✅
    currentB:      [C(4708)],       // d612 → 612+4096=4708 ✅
    activePower:   [C(4696, 0.01)], // d600 → 600+4096=4696 ✅ (FIXED SCALING)
    frequency:     [C(4752, 0.01)], // d656 → 656+4096=4752 ✅
  },
  // === DG-2 ===
  dg2: {
    voltageR:      [C(4734)],       // d638 → 638+4096=4734 ✅
    voltageY:      [C(4736)],       // d640 → 640+4096=4736 ✅
    voltageB:      [C(4738)],       // d642 → 642+4096=4738 ✅
    currentR:      [C(4710)],       // d614 → 614+4096=4710 ✅
    currentY:      [C(4712)],       // d616 → 616+4096=4712 ✅
    currentB:      [C(4714)],       // d618 → 618+4096=4714 ✅
    activePower:   [C(4716, 0.01)], // d620 → 620+4096=4716 ✅ (FIXED SCALING)
    frequency:     [C(4754, 0.01)], // d658 → 658+4096=4754 ✅
  },
  // === DG-3 ===
  dg3: {
    voltageR:      [C(4740)],       // d644 → 644+4096=4740 ✅
    voltageY:      [C(4742)],       // d646 → 646+4096=4742 ✅
    voltageB:      [C(4744)],       // d648 → 648+4096=4744 ✅
    currentR:      [C(4716)],       // d620 → 620+4096=4716 ✅
    currentY:      [C(4718)],       // d622 → 622+4096=4718 ✅
    currentB:      [C(4720)],       // d624 → 624+4096=4720 ✅
    activePower:   [C(4700, 0.01)], // d604 → 604+4096=4700 ✅ (FIXED SCALING)
    frequency:     [C(4756, 0.01)], // d660 → 660+4096=4756 ✅
  },
  // === DG-4 ===
  dg4: {
    voltageR:      [C(4746)],       // d650 → 650+4096=4746 ✅
    voltageY:      [C(4748)],       // d652 → 652+4096=4748 ✅
    voltageB:      [C(4750)],       // d654 → 654+4096=4750 ✅
    currentR:      [C(4722)],       // d626 → 626+4096=4722 ✅
    currentY:      [C(4724)],       // d628 → 628+4096=4724 ✅
    currentB:      [C(4726)],       // d630 → 630+4096=4726 ✅
    activePower:   [C(4702, 0.01)], // d606 → 606+4096=4702 ✅ (FIXED SCALING)
    frequency:     [C(4758, 0.01)], // d662 → 662+4096=4758 ✅
  }
};

// --- UTILITIES ---
const toSignedInt16 = (v) => (v > 32767 ? v - 65536 : v);
const wait = (ms) => new Promise(r => setTimeout(r, ms));

// ✅ FIXED: Lowered limit to 1 Liter to allow Sloshing (Was 5)
function isValidDieselReading(value) {
  const s = toSignedInt16(value);
  // Filter out Error codes (65535) AND values < 1 Liter
  if (value === 65535 || value === 65534 || s === -1) return false;
  // NEW LOGIC: Must be at least 1 Liter to be valid
  return s >= 1 && s <= 2000; 
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

// ✅ UPDATED: Handles the < 1L error by holding the previous level
async function readSingleRegister(registerConfig, dataKey) {
  const address = registerConfig.primary;
  
  try {
    const data = await readWithRetry(() => client.readHoldingRegisters(address, 1));
    const rawValue = data?.data?.[0];
    
    // 1. Check validity (Uses the new 1L check above)
    if (rawValue === undefined || !isValidDieselReading(rawValue)) {
      throw new Error(`Invalid Reading (Raw: ${rawValue})`);
    }
    
    // 2. SUCCESS: Update Value
    const value = Math.max(0, toSignedInt16(rawValue));
    
    // Update Quality Flags
    systemData.dataQuality[dataKey + '_stale'] = false;
    systemData.dataQuality.lastSuccessfulRead = new Date().toISOString();
    
    return value;

  } catch (err) {
    // 3. FAILURE OR LOW READING (< 1L)
    systemData.dataQuality[dataKey + '_stale'] = true;
    
    const lastReadTime = systemData.dataQuality.lastSuccessfulRead 
      ? new Date(systemData.dataQuality.lastSuccessfulRead).getTime() 
      : 0;
      
    const timeSinceLastGoodRead = Date.now() - lastReadTime;

    if (timeSinceLastGoodRead > STALE_THRESHOLD_MS) {
      // ⚠️ CRITICAL: Dead sensor (> 5 mins) -> RESET TO 0
      console.error(`🚨 ${dataKey.toUpperCase()} sensor dead > 5 mins. Resetting to 0.`);
      return 0;
    } else {
      // 🛡️ GHOST PROTECTION:
      const lastKnownLevel = fuelAccumulator.getDisplayLevel(dataKey);
      // ✅ IMPROVED LOGGING: Show exact error reason
      console.warn(`⚠️ ${dataKey.toUpperCase()} invalid reading. Holding level at ${lastKnownLevel}L. Reason: ${err.message}`);
      return lastKnownLevel || 0;
    }
  }
}

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
        continue;
      }

      const scaled = Math.round(raw * (scaling ?? 0.1) * 10000) / 10000;
      lastGoodRegister[dgKey][param] = { addr, scaling };
      
      if (!lastGoodValues[dgKey]) lastGoodValues[dgKey] = {};
      lastGoodValues[dgKey][param] = scaled;

      return scaled;
    } catch (err) {
       // Silent fail
    }
  }
  
  return lastGoodValues[dgKey]?.[param] || 0;
}

function getZeroElectricalValues() {
  return {
    voltageR: 0, voltageY: 0, voltageB: 0,
    currentR: 0, currentY: 0, currentB: 0,
    frequency: 0, activePower: 0
  };
}

// --- UPDATED: ALWAYS READ ALL PARAMETERS (No Skipping) ---
async function readAllElectrical(dgKey) {
  const result = {
    activePower: 0,
    voltageR: 0, voltageY: 0, voltageB: 0,
    currentR: 0, currentY: 0, currentB: 0,
    frequency: 0
  };

  try {
    result.activePower = await readParam(dgKey, 'activePower');
    
    result.voltageR = await readParam(dgKey, 'voltageR');
    await wait(20);
    result.voltageY = await readParam(dgKey, 'voltageY');
    await wait(20);
    result.voltageB = await readParam(dgKey, 'voltageB');

    result.currentR = await readParam(dgKey, 'currentR');
    await wait(20);
    result.currentY = await readParam(dgKey, 'currentY');
    await wait(20);
    result.currentB = await readParam(dgKey, 'currentB');
    result.frequency = await readParam(dgKey, 'frequency');

    lastGoodValues[dgKey] = { ...result };
    return result;

  } catch (error) {
    console.warn(`⚠️ Partial Read Fail for ${dgKey}:`, error.message);
    return lastGoodValues[dgKey] || result;
  }
}

function checkStartup(dgKey, newValues, oldElectricalData, allNewValues) {
  const activePower = newValues.activePower || 0;
  const isRunning = activePower > DG_RUNNING_THRESHOLD;
  const wasRunningBefore = (oldElectricalData[dgKey]?.activePower || 0) > DG_RUNNING_THRESHOLD;

  if (isRunning && !wasRunningBefore) {
    const dgName = dgKey.toUpperCase().replace('DG', 'DG-');
    if (dgKey === 'dg1' || dgKey === 'dg2' || dgKey === 'dg4') {
      sendStartupAlert(dgName, allNewValues);
      console.log(`✅ Startup detected for ${dgName} (Email Sent)`);
    }
  }
}

// --- MAIN LOOP (THE IMPORTANT PART) ---
async function readAllSystemData() {
  if (!isPlcConnected) return;

  try {
    const allNewValues = {};
    const dgList = ['dg1', 'dg2', 'dg3', 'dg4'];

    for (const dgKey of dgList) {
        // 1. Read Electrical Data (Full Params)
        const electricalData = await readAllElectrical(dgKey);
        allNewValues[dgKey] = electricalData;

        // 2. CHECK VOLTAGE > 100V to determine if Running
        const isRunning = (electricalData.voltageR > 100);

        // 3. Read Raw Fuel Level (Only if configured)
        if (dgRegisters[dgKey]) {
            const rawLevel = await readSingleRegister(dgRegisters[dgKey], dgKey);

            // 4. FEED TO ACCUMULATOR
            await fuelAccumulator.processReading(dgKey, rawLevel, isRunning);

            // 5. UPDATE SYSTEM DATA FOR DISPLAY
            systemData[dgKey] = fuelAccumulator.getDisplayLevel(dgKey);

            // ===============================================
            // 6. NEW: DG1 CONSUMPTION LOGIC (Strict Latch)
            // ===============================================
            if (dgKey === 'dg1') {
                // Calculate estimated RPM from Frequency (50Hz = 1500RPM)
                // If Freq is 0, RPM is 0.
                const estimatedRpm = electricalData.frequency * 30; 
                
                // Call the logic Service
                const runResult = processDg1Data(estimatedRpm, rawLevel);

                // If STOPPED, save to MongoDB
                if (runResult) {
                    console.log("📝 DG1 Run Finished. Saving to DB...");
                    const newLog = new Log({
                        timestamp: new Date(),
                        event: "DG_STOPPED",
                        startLevel: runResult.startLevel,
                        endLevel: runResult.endLevel,
                        consumption: runResult.consumption,
                        duration: 0 
                    });
                    newLog.save().then(() => console.log("✅ Fuel Log Saved to MongoDB"));
                }
            }
            // ===============================================
        }
    }

    // Update Totals
    systemData.total = (systemData.dg1 || 0) + (systemData.dg2 || 0) + (systemData.dg3 || 0);
    
    const oldElectricalData = { ...systemData.electrical };
    systemData.electrical = allNewValues;
    systemData.lastUpdate = new Date().toISOString();

    // Check Startups (Email Alerts)
    for (const dgKey of dgList) {
      checkStartup(dgKey, allNewValues[dgKey], oldElectricalData, allNewValues);
    }

    // Check Low Fuel (Email Alerts)
    checkDieselLevels(systemData);
    errorCount = 0;

  } catch (err) {
    errorCount++;
    console.error(`Error reading system data (${errorCount}/${MAX_ERRORS}):`, err.message);
    if (errorCount >= MAX_ERRORS) {
      isPlcConnected = false;
      client.close();
      setTimeout(connectToPLC, 5000);
    }
  }
}

function checkDieselLevels(data) {
  const criticalDGs = [];
  if (data.dg1 <= CRITICAL_LEVEL) criticalDGs.push('DG-1');
  if (data.dg2 <= CRITICAL_LEVEL) criticalDGs.push('DG-2');
  if (criticalDGs.length > 0) {
    sendDieselAlert(data, criticalDGs);
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
        setInterval(readAllSystemData, 1000); // 1-Second Loop
      }, 2000);
    })
    .catch((err) => {
      console.error('PLC connection error:', err.message);
      setTimeout(connectToPLC, 10000);
    });
}

function closePLC() {
  try { client.close(); } catch (_) {}
}

function getSystemData() {
  return { ...systemData };
}

function isConnected() { return isPlcConnected; }

module.exports = {
  connectToPLC,
  closePLC,
  readAllSystemData,
  getSystemData,
  isConnected,
  isValidDieselReading,
  _test_systemData: systemData,
  _test_setConnectionState: (state) => { isPlcConnected = state; }
};