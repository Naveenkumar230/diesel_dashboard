//
// --- test-addresses.js ---
//
// This script will test the *exact* register map and fallback logic
// from the final plcService.js file (v4).
//
// HOW TO USE:
// 1. Stop your main server: pm2 stop diesel_dashboard
// 2. Run this file:           node test-addresses.js
// 3. Turn on your DGs one by one and watch the values appear.
//

require('dotenv').config();
const ModbusRTU = require('modbus-serial');

// --- CONFIGURATION (Loaded from .env) ---
const port = process.env.PLC_PORT || '/dev/ttyUSB0';
const plcSlaveID = parseInt(process.env.PLC_SLAVE_ID) || 1;
const plcSettings = {
  baudRate: parseInt(process.env.PLC_BAUD_RATE) || 9600,
  parity: process.env.PLC_PARITY || 'none',
  dataBits: parseInt(process.env.PLC_DATA_BITS) || 8,
  stopBits: parseInt(process.env.PLC_STOP_BITS) || 1
};
const client = new ModbusRTU();

// This will store the last known good address to test the fallback logic
let lastGoodRegister = { dg1: {}, dg2: {}, dg3: {}, dg4: {} };

// ---
//
// --- THE FINAL CORRECTED ELECTRICAL MAP (v4) ---
// This is the *exact* same map from your new plcService.js
//
// ---
const C = (addr, scaling = 0.1) => ({ addr, scaling });
const electricalCandidates = {
  dg1: { // Based on D100 block (4196) and notes
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
  dg2: { // Based on D140 block (4236) and notes
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
  dg3: { // DG3: Corrected based on test logs
    activePower:   [C(4292)],              // D196 - This is 100% CORRECT
    reactivePower: [C(4294)],              // D197 - This is LIKELY (showed 399.10)
    energyMeter:   [C(4296, 1)],           // D198 - This is LIKELY (showed 16.00)
    runningHours:  [C(4298, 1)],           // D199 - This is LIKELY (showed 30.00)
    powerFactor:   [C(4290, 0.0001)],      // D195 - SCALING FIXED (31.73 -> 0.3173)

    // --- NEW GUESSES for the "0" values ---
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


// --- HELPER FUNCTIONS (copied from plcService) ---
const wait = (ms) => new Promise(r => setTimeout(r, ms));

function isValidElectricalReading(value) {
  if (value === 65535 || value === 65534) return false;
  return true;
}

async function readWithRetry(fn) {
  for (let i = 0; i < 2; i++) { // 2 retries
    try {
      return await fn();
    } catch (e) {
      if (i === 1) throw e;
      await wait(50);
    }
  }
}

/**
 * This function will test-read a parameter using the full fallback logic.
 * It tries the last known good address first, then all others.
 * It returns the value and which address worked.
 */
async function readParam(dgKey, param) {
  const candidates = electricalCandidates[dgKey][param];
  if (!candidates || candidates.length === 0) return { val: 0, adr: 'N/A' };

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

      const scaled = Math.round(raw * (scaling ?? 0.1) * 10000) / 10000;

      // SUCCESS! Save this address as the 'last good' one for next time
      lastGoodRegister[dgKey][param] = { addr, scaling };
      
      return { val: scaled, adr: addr }; // Success!

    } catch (_) {
      // This address failed, try the next one in the loop
    }
  }
  
  return { val: 0, adr: 'FAIL' }; // All candidates failed
}


/**
 * The main loop. It will scan all DGs and print the results
 * in a clean table every 5 seconds.
 */
async function scanAllDGs() {
  console.log('\n--- SCANNING ALL DGS --- ' + new Date().toLocaleTimeString());
  
  for (const dgKey of ['dg1', 'dg2', 'dg3', 'dg4']) {
    console.log(`\n--- Reading ${dgKey.toUpperCase()} ---`);

    // We MUST read Active Power first
    const { val: activePower, adr: powerAddr } = await readParam(dgKey, 'activePower');
    const paramName = 'activePower'.padEnd(14, ' ');
    const valueStr = activePower.toFixed(2).padStart(8, ' ');
    const addrStr = `(Address: ${powerAddr})`;
    console.log(`${dgKey} -> ${paramName}: ${valueStr} ${addrStr}`);
    
    // If the DG is running, read the rest of its parameters
    if (activePower > 2) { // 2kW threshold for test
      for (const param of Object.keys(electricalCandidates[dgKey])) {
        if (param === 'activePower') continue; // Already read

        const { val, adr } = await readParam(dgKey, param);
        
        const paramName = param.padEnd(14, ' ');
        const valueStr = val.toFixed(2).padStart(8, ' ');
        const addrStr = `(Address: ${adr})`;
        
        console.log(`${dgKey} -> ${paramName}: ${valueStr} ${addrStr}`);
        
        await wait(50); // Small delay between reads
      }
    } else {
      console.log(`${dgKey} -> DG is OFF. (All other values are 0)`);
    }
  }
  
  // Loop
  console.log('\n--- Scan complete. Next scan in 5 seconds... ---');
  setTimeout(scanAllDGs, 5000);
}


/**
 * Connects to the PLC and starts the scan.
 */
async function connectAndStart() {
  console.log('--- PLC Address Tester (v4) ---');
  console.log('IMPORTANT: Stop your main server first!');
  console.log('Run: pm2 stop diesel_dashboard');
  console.log('---');
  console.log(`Connecting to PLC on ${port}...`);
  try {
    await client.connectRTU(port, plcSettings);
    client.setID(plcSlaveID);
    client.setTimeout(2000);
    console.log('✓ PLC Connected. Starting scan loop.');
    console.log('Run your DGs one by one to see the values appear below.');
    scanAllDGs();
  } catch (err) {
    console.error('PLC CONNECTION FAILED:', err.message);
    console.error('Make sure no other program (like server.js) is using the port.');
    client.close();
  }
}

connectAndStart();