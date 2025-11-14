require('dotenv').config();
const ModbusRTU = require('modbus-serial');

// --- CONFIGURATION ---
const port = process.env.PLC_PORT || '/dev/ttyUSB0';
const plcSlaveID = parseInt(process.env.PLC_SLAVE_ID) || 1;
const plcSettings = {
  baudRate: parseInt(process.env.PLC_BAUD_RATE) || 9600,
  parity: process.env.PLC_PARITY || 'none',
  dataBits: parseInt(process.env.PLC_DATA_BITS) || 8,
  stopBits: parseInt(process.env.PLC_STOP_BITS) || 1
};

// Range of registers to scan.
// Your current map uses 4100 - 4352, so we'll scan a bit wider.
const START_REGISTER = 4096;
const END_REGISTER = 4500;
// ---------------------

const client = new ModbusRTU();

async function connectToPLC() {
  try {
    console.log(`Attempting to connect to PLC on ${port}...`);
    await client.connectRTU(port, plcSettings);
    client.setID(plcSlaveID);
    client.setTimeout(2000);
    console.log('✓ PLC Connected. Starting scan...');
    console.log('---');
    console.log('Watch this list while your DG is RUNNING.');
    console.log('Look for values you recognize (e.g., 230V, 50Hz, 100A).');
    console.log('Note: 230.5V will show as 2305. 50.0Hz will show as 500 or 5000.');
    console.log('---');
    scanRegisters();
  } catch (err) {
    console.error('PLC connection error:', err.message);
    console.log('Make sure no other program (like server.js) is using the port.');
    client.close();
  }
}

async function scanRegisters() {
  for (let addr = START_REGISTER; addr <= END_REGISTER; addr++) {
    try {
      // Read one register at a time
      const data = await client.readHoldingRegisters(addr, 1);
      const value = data.data[0];

      // Only print if the value is not 0, to reduce noise
      if (value !== 0 && value !== 65535) {
        console.log(`Register ${addr}: \t ${value}`);
      }

      // Wait a moment to not overload the Modbus
      await new Promise(resolve => setTimeout(resolve, 50)); 
    } catch (err) {
      // Ignore errors and keep scanning
    }
  }
  
  // Loop the scan
  console.log('--- Scan complete. Restarting in 5 seconds... ---');
  setTimeout(scanRegisters, 5000);
}

// --- IMPORTANT ---
// Before running this script, you MUST STOP your main server.
// Only one program can talk to /dev/ttyUSB0 at a time.
// ---

connectToPLC();