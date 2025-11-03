require('dotenv').config();
const ModbusRTU = require("modbus-serial");
const express = require('express');
const mongoose = require('mongoose');

// ===== CONFIG =====
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/dieselDB";
const PLC_PORT = process.env.PLC_PORT || '/dev/ttyUSB0';
const SERVER_PORT = parseInt(process.env.PORT) || 3000;
const CRITICAL_LEVEL = 50;

// ===== DIESEL REGISTERS (2 Fallbacks Each) =====
const dieselRegs = {
  dg1: { primary: 4104, fallback: [4105, 4106] },
  dg2: { primary: 4100, fallback: [4101, 4102] },
  dg3: { primary: 4102, fallback: [4103, 4107] },
  dg4: { primary: 4108, fallback: [4109, 4110] }
};

// ===== ELECTRICAL REGISTERS (2 Fallbacks Each) =====
const electricalRegs = {
  dg1: {
    voltageR: { addr: [4276, 4100, 4101], scale: 0.1 },
    voltageY: { addr: [4278, 4125, 4126], scale: 0.1 },
    voltageB: { addr: [4280, 4150, 4151], scale: 0.1 },
    currentR: { addr: [4282, 4175, 4176], scale: 0.1 },
    currentY: { addr: [4284, 4205, 4207], scale: 0.1 },
    currentB: { addr: [4286, 4255, 4257], scale: 0.1 },
    frequency: { addr: [4288, 4305, 4307], scale: 0.1 },
    powerFactor: { addr: [4290, 4355, 4357], scale: 0.01 },
    activePower: { addr: [5705, 5707, 5709], scale: 0.1 },
    reactivePower: { addr: [4294, 5755, 5757], scale: 0.1 }
  },
  dg2: {
    voltageR: { addr: [4236, 4655, 4657], scale: 0.1 },
    voltageY: { addr: [4238, 4705, 4707], scale: 0.1 },
    voltageB: { addr: [4240, 4755, 4757], scale: 0.1 },
    currentR: { addr: [4242, 4805, 4807], scale: 0.1 },
    currentY: { addr: [4244, 4855, 4857], scale: 0.1 },
    currentB: { addr: [4246, 4905, 4907], scale: 0.1 },
    frequency: { addr: [4248, 4955, 4957], scale: 0.1 },
    powerFactor: { addr: [4250, 5005, 5007], scale: 0.01 },
    activePower: { addr: [4252, 5055, 5057], scale: 0.1 },
    reactivePower: { addr: [4254, 5105, 5107], scale: 0.1 }
  },
  dg3: {
    voltageR: { addr: [4276, 5305, 5307], scale: 0.1 },
    voltageY: { addr: [4278, 5355, 5357], scale: 0.1 },
    voltageB: { addr: [4280, 5405, 5407], scale: 0.1 },
    currentR: { addr: [4282, 5455, 5457], scale: 0.1 },
    currentY: { addr: [4284, 5505, 5507], scale: 0.1 },
    currentB: { addr: [4286, 5555, 5557], scale: 0.1 },
    frequency: { addr: [4288, 5605, 5607], scale: 0.1 },
    powerFactor: { addr: [4290, 5655, 5657], scale: 0.01 },
    activePower: { addr: [4292, 5705, 5707], scale: 0.1 },
    reactivePower: { addr: [4294, 5755, 5757], scale: 0.1 }
  }
};

// ===== STATE =====
let systemData = {
  dg1: 0, dg2: 0, dg3: 0, total: 0,
  electrical: { dg1: {}, dg2: {}, dg3: {} }
};
let plcConnected = false;
let mongoConnected = false;

// ===== MODBUS CLIENT =====
const client = new ModbusRTU();

// ===== MONGODB =====
mongoose.connect(MONGODB_URI, {
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000
}).then(() => {
  console.log('✓ MongoDB connected');
  mongoConnected = true;
}).catch(err => {
  console.log('MongoDB unavailable:', err.message);
  mongoConnected = false;
});

const DieselSchema = new mongoose.Schema({
  timestamp: { type: Date, default: Date.now },
  dg1: Number,
  dg2: Number,
  dg3: Number,
  total: Number
});
const DieselReading = mongoose.model('DieselReading', DieselSchema);

// ===== HELPER FUNCTIONS =====
function toSigned(val) {
  return val > 32767 ? val - 65536 : val;
}

function isValid(val) {
  const signed = toSigned(val);
  return val !== 65535 && val !== 65534 && signed >= 0 && signed <= 600;
}

// ===== READ WITH FALLBACK =====
async function readWithFallback(addresses) {
  for (const addr of addresses) {
    try {
      const data = await client.readHoldingRegisters(addr, 1);
      if (data?.data?.[0] !== undefined) {
        const val = data.data[0];
        if (isValid(val)) {
          return toSigned(val);
        }
      }
    } catch (err) {
      // Try next address
    }
    await new Promise(r => setTimeout(r, 50));
  }
  return 0;
}

// ===== READ DIESEL LEVELS =====
async function readDiesel() {
  systemData.dg1 = await readWithFallback([dieselRegs.dg1.primary, ...dieselRegs.dg1.fallback]);
  await new Promise(r => setTimeout(r, 100));
  
  systemData.dg2 = await readWithFallback([dieselRegs.dg2.primary, ...dieselRegs.dg2.fallback]);
  await new Promise(r => setTimeout(r, 100));
  
  systemData.dg3 = await readWithFallback([dieselRegs.dg3.primary, ...dieselRegs.dg3.fallback]);
  
  systemData.total = systemData.dg1 + systemData.dg2 + systemData.dg3;
  
  console.log(`Diesel: DG1=${systemData.dg1}L DG2=${systemData.dg2}L DG3=${systemData.dg3}L Total=${systemData.total}L`);
}

// ===== READ ELECTRICAL =====
async function readElectrical(dgKey) {
  const params = electricalRegs[dgKey];
  const result = {};
  
  for (const [key, config] of Object.entries(params)) {
    const raw = await readWithFallback(config.addr);
    result[key] = Math.round(raw * config.scale * 100) / 100;
    await new Promise(r => setTimeout(r, 50));
  }
  
  systemData.electrical[dgKey] = result;
  console.log(`${dgKey.toUpperCase()}: V=${result.voltageR}/${result.voltageY}/${result.voltageB}V I=${result.currentR}/${result.currentY}/${result.currentB}A P=${result.activePower}kW`);
}

// ===== MAIN READ LOOP =====
async function readAll() {
  if (!plcConnected) return;
  
  try {
    await readDiesel();
    await readElectrical('dg1');
    await readElectrical('dg2');
    await readElectrical('dg3');
    
    // Save to DB every hour
    const hour = new Date().getHours();
    if (!readAll.lastHour || readAll.lastHour !== hour) {
      if (mongoConnected) {
        await new DieselReading(systemData).save();
        console.log('✓ Saved to database');
      }
      readAll.lastHour = hour;
    }
    
  } catch (err) {
    console.error('Read error:', err.message);
  }
}

// ===== PLC CONNECTION =====
function connectPLC() {
  console.log('Connecting to PLC...');
  client.connectRTU(PLC_PORT, {
    baudRate: 9600,
    parity: 'none',
    dataBits: 8,
    stopBits: 1
  }).then(() => {
    client.setID(1);
    client.setTimeout(5000);
    plcConnected = true;
    console.log('✓ PLC connected');
    
    setTimeout(() => {
      readAll();
      setInterval(readAll, 5000);
    }, 2000);
  }).catch(err => {
    console.error('PLC connection failed:', err.message);
    plcConnected = false;
    setTimeout(connectPLC, 10000);
  });
}

// ===== EXPRESS SERVER =====
const app = express();

app.use(express.static(__dirname));

app.get('/api/data', (req, res) => {
  res.json(systemData);
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'running',
    plc: plcConnected ? 'connected' : 'disconnected',
    mongo: mongoConnected ? 'connected' : 'disconnected',
    data: systemData
  });
});

app.listen(SERVER_PORT, () => {
  console.log(`\n======================`);
  console.log(`Server: http://localhost:${SERVER_PORT}`);
  console.log(`PLC Port: ${PLC_PORT}`);
  console.log(`======================\n`);
  connectPLC();
});

// ===== GRACEFUL SHUTDOWN =====
process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  client.close();
  await mongoose.connection.close();
  process.exit(0);
});