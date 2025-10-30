require('dotenv').config();
const ModbusRTU = require("modbus-serial");
const express = require('express');
const path = require('path');
const mongoose = require('mongoose');
const cors = require('cors');
const nodemailer = require('nodemailer');
const compression = require('compression');
const ExcelJS = require('exceljs');

// ============================================
// CONFIGURATION
// ============================================
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/dieselDB";
const PLC_PORT = process.env.PLC_PORT || '/dev/ttyUSB0';
const PLC_SLAVE_ID = parseInt(process.env.PLC_SLAVE_ID) || 1;
const CRITICAL_LEVEL = parseInt(process.env.CRITICAL_DIESEL_LEVEL) || 50;
const WARNING_LEVEL = parseInt(process.env.WARNING_DIESEL_LEVEL) || 200;

// ============================================
// PLC REGISTER MAPPING (From your documentation)
// ============================================
const REGISTERS = {
    // Diesel Generator Registers
    DIESEL: {
        DG1: 4104,  // D8 - DG-1 Diesel Level
        DG2: 4100,  // D4 - DG-2 Diesel Level
        DG3: 4102   // D6 - DG-3 Diesel Level
    },
    
    // Voltage Measurements (3-Phase)
    VOLTAGE: {
        L1_N: 4096,     // D0 - L1-N Voltage (Phase R)
        L2_N: 4097,     // D1 - L2-N Voltage (Phase Y)
        L3_N: 4098,     // D2 - L3-N Voltage (Phase B)
        L1_L2: 4099,    // D3 - L1-L2 Voltage
        L2_L3: 4100,    // D4 - L2-L3 Voltage
        L3_L1: 4101,    // D5 - L3-L1 Voltage
        AVG_LN: 4102,   // D6 - Average Line-Neutral
        AVG_LL: 4103,   // D7 - Average Line-Line
        UNBALANCE: 4104,// D8 - Voltage Unbalance
        THD_L1: 4105,   // D9 - Voltage THD L1
        THD_L2: 4106,   // D10 - Voltage THD L2
        THD_L3: 4107    // D11 - Voltage THD L3
    },
    
    // Current Measurements
    CURRENT: {
        L1: 4108,       // D12 - L1 Current (Phase R)
        L2: 4109,       // D13 - L2 Current (Phase Y)
        L3: 4110,       // D14 - L3 Current (Phase B)
        NEUTRAL: 4111,  // D15 - Neutral Current
        AVG: 4112,      // D16 - Average Line Current
        UNBALANCE: 4113,// D17 - Current Unbalance
        THD_L1: 4114,   // D18 - Current THD L1
        THD_L2: 4115,   // D19 - Current THD L2
        THD_L3: 4116    // D20 - Current THD L3
    },
    
    // Power Measurements
    POWER: {
        ACTIVE_L1: 4120,    // D24 - Active Power L1 (kW)
        ACTIVE_L2: 4121,    // D25 - Active Power L2 (kW)
        ACTIVE_L3: 4122,    // D26 - Active Power L3 (kW)
        TOTAL_ACTIVE: 4123, // D27 - Total Active Power (kW)
        REACTIVE_L1: 4124,  // D28 - Reactive Power L1 (kVAR)
        REACTIVE_L2: 4125,  // D29 - Reactive Power L2 (kVAR)
        REACTIVE_L3: 4126,  // D30 - Reactive Power L3 (kVAR)
        TOTAL_REACTIVE: 4127,// D31 - Total Reactive Power (kVAR)
        APPARENT_L1: 4128,  // D32 - Apparent Power L1 (kVA)
        APPARENT_L2: 4129,  // D33 - Apparent Power L2 (kVA)
        APPARENT_L3: 4130,  // D34 - Apparent Power L3 (kVA)
        TOTAL_APPARENT: 4131 // D35 - Total Apparent Power (kVA)
    },
    
    // Power Factor & Frequency
    PF_FREQ: {
        PF_L1: 4132,        // D36 - Power Factor L1
        PF_L2: 4133,        // D37 - Power Factor L2
        PF_L3: 4134,        // D38 - Power Factor L3
        TOTAL_PF: 4135,     // D39 - Total Power Factor
        FREQUENCY: 4136,    // D40 - Frequency
        FREQ_DEV: 4137      // D41 - Frequency Deviation
    },
    
    // Generator Output
    GENERATOR: {
        RATED_POWER: 4150,  // D54 - Generator Rated Power
        LOAD_PCT: 4151,     // D55 - Generator Load Percentage
        EFFICIENCY: 4152,   // D56 - Generator Efficiency
        TEMP: 4153          // D57 - Generator Temperature
    },
    
    // Battery System
    BATTERY: {
        VOLTAGE: 4159,      // D63 - Battery Voltage
        CURRENT: 4160,      // D64 - Battery Charging Current
        SOC: 4161           // D65 - Battery State of Charge
    }
};

// ============================================
// MONGODB SCHEMA
// ============================================
const DieselReadingSchema = new mongoose.Schema({
    timestamp: { type: Date, default: Date.now, index: true },
    dg1: { type: Number, required: true },
    dg2: { type: Number, required: true },
    dg3: { type: Number, required: true },
    total: { type: Number, required: true },
    
    // Electrical Parameters
    voltage: {
        l1n: Number,
        l2n: Number,
        l3n: Number,
        avg: Number,
        unbalance: Number
    },
    current: {
        l1: Number,
        l2: Number,
        l3: Number,
        avg: Number,
        unbalance: Number
    },
    power: {
        activeL1: Number,
        activeL2: Number,
        activeL3: Number,
        totalActive: Number,
        reactiveTotal: Number,
        apparentTotal: Number
    },
    frequency: Number,
    powerFactor: {
        l1: Number,
        l2: Number,
        l3: Number,
        total: Number
    },
    generator: {
        load: Number,
        efficiency: Number,
        temperature: Number
    },
    
    hour: { type: Number, index: true },
    date: { type: String, index: true }
});

DieselReadingSchema.index({ date: 1, hour: 1 });
DieselReadingSchema.index({ timestamp: -1 });

const DieselReading = mongoose.model('DieselReading', DieselReadingSchema);

// ============================================
// MONGODB CONNECTION
// ============================================
let isMongoConnected = false;

async function connectMongoDB() {
    try {
        await mongoose.connect(MONGODB_URI, {
            serverSelectionTimeoutMS: 10000,
            socketTimeoutMS: 45000
        });
        console.log('✅ MongoDB Connected Successfully');
        isMongoConnected = true;
    } catch (err) {
        console.error('❌ MongoDB Connection Error:', err.message);
        console.log('⚠️  System continues WITHOUT database (data not persistent)');
        isMongoConnected = false;
    }
}

connectMongoDB();

mongoose.connection.on('disconnected', () => {
    console.log('⚠️  MongoDB disconnected - attempting reconnect...');
    isMongoConnected = false;
    setTimeout(connectMongoDB, 5000);
});

// ============================================
// EMAIL CONFIGURATION
// ============================================
let emailTransporter = null;
let emailEnabled = false;

if (process.env.EMAIL_USER && process.env.EMAIL_APP_PASSWORD) {
    emailTransporter = nodemailer.createTransporter({
        service: 'gmail',
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_APP_PASSWORD
        }
    });
    emailEnabled = true;
    console.log('✅ Email alerts enabled');
} else {
    console.log('⚠️  Email alerts disabled (credentials not configured)');
}

const ALERT_RECIPIENTS = process.env.ALERT_RECIPIENTS || '';
const alertState = {
    lastAlertTime: {},
    currentAlerts: new Set()
};
const ALERT_COOLDOWN = 1800000; // 30 minutes

async function sendEmailAlert(alertType, data) {
    if (!emailEnabled || !ALERT_RECIPIENTS) return;
    
    const alertKey = `${alertType}_${Math.floor(Date.now() / ALERT_COOLDOWN)}`;
    if (alertState.currentAlerts.has(alertKey)) return;
    
    try {
        const template = {
            subject: '🚨 CRITICAL: Diesel Level Alert - Immediate Action Required',
            html: `
<!DOCTYPE html>
<html>
<head><style>
body { font-family: sans-serif; margin: 0; padding: 0; background: #f5f5f5; }
.container { max-width: 600px; margin: 20px auto; background: white; border-radius: 12px; overflow: hidden; }
.header { background: linear-gradient(135deg, #dc2626 0%, #b91c1c 100%); padding: 40px 24px; text-align: center; color: white; }
.content { padding: 32px 24px; }
.metric-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; margin: 24px 0; }
.metric { background: #f9fafb; padding: 20px; border-radius: 8px; text-align: center; }
.critical { color: #dc2626; font-weight: bold; }
</style></head>
<body>
<div class="container">
    <div class="header">
        <h1>🚨 Critical Diesel Alert</h1>
    </div>
    <div class="content">
        <p><strong>⚠️ IMMEDIATE ACTION REQUIRED</strong></p>
        <p>One or more diesel generators have reached critically low fuel levels (≤${CRITICAL_LEVEL}L).</p>
        <div class="metric-grid">
            <div class="metric">
                <div>DG-1 Level</div>
                <div class="${data.dg1 <= CRITICAL_LEVEL ? 'critical' : ''}" style="font-size: 32px">${data.dg1}L</div>
            </div>
            <div class="metric">
                <div>DG-2 Level</div>
                <div class="${data.dg2 <= CRITICAL_LEVEL ? 'critical' : ''}" style="font-size: 32px">${data.dg2}L</div>
            </div>
            <div class="metric">
                <div>DG-3 Level</div>
                <div class="${data.dg3 <= CRITICAL_LEVEL ? 'critical' : ''}" style="font-size: 32px">${data.dg3}L</div>
            </div>
            <div class="metric">
                <div>Total Diesel</div>
                <div style="font-size: 32px">${data.total}L</div>
            </div>
        </div>
        <p style="text-align: center; margin-top: 24px;">
            <strong>Alert Time:</strong> ${new Date().toLocaleString()}
        </p>
    </div>
</div>
</body>
</html>`
        };
        
        await emailTransporter.sendMail({
            from: `"DG Monitoring System" <${process.env.EMAIL_USER}>`,
            to: ALERT_RECIPIENTS,
            subject: template.subject,
            html: template.html
        });
        
        alertState.currentAlerts.add(alertKey);
        console.log(`📧 Alert email sent: ${alertType.toUpperCase()}`);
        
        setTimeout(() => {
            alertState.currentAlerts.delete(alertKey);
        }, ALERT_COOLDOWN);
        
    } catch (error) {
        console.error('❌ Email send error:', error.message);
    }
}

function checkDieselLevels(data) {
    if (data.dg1 <= CRITICAL_LEVEL || data.dg2 <= CRITICAL_LEVEL || data.dg3 <= CRITICAL_LEVEL) {
        sendEmailAlert('critical', data);
    }
}

// ============================================
// MODBUS RTU CLIENT
// ============================================
const client = new ModbusRTU();
let isPlcConnected = false;

const plcSettings = {
    baudRate: parseInt(process.env.PLC_BAUD_RATE) || 9600,
    parity: process.env.PLC_PARITY || 'none',
    dataBits: parseInt(process.env.PLC_DATA_BITS) || 8,
    stopBits: parseInt(process.env.PLC_STOP_BITS) || 1
};

async function connectPLC() {
    try {
        await client.connectRTUBuffered(PLC_PORT, plcSettings);
        client.setID(PLC_SLAVE_ID);
        client.setTimeout(5000);
        isPlcConnected = true;
        console.log('✅ PLC Connected Successfully');
        console.log(`   Port: ${PLC_PORT}`);
        console.log(`   Slave ID: ${PLC_SLAVE_ID}`);
    } catch (err) {
        console.error('❌ PLC Connection Error:', err.message);
        isPlcConnected = false;
        setTimeout(connectPLC, 10000); // Retry after 10 seconds
    }
}

connectPLC();

// ============================================
// READ DATA FROM PLC
// ============================================
async function readRegister(address) {
    if (!isPlcConnected) return 0;
    
    try {
        const data = await client.readHoldingRegisters(address, 1);
        return data.data[0];
    } catch (err) {
        console.error(`Error reading register ${address}:`, err.message);
        return 0;
    }
}

async function readAllData() {
    const data = {
        diesel: {
            dg1: 0,
            dg2: 0,
            dg3: 0,
            total: 0
        },
        electrical: {
            voltage: {},
            current: {},
            power: {},
            frequency: 0,
            powerFactor: {},
            generator: {},
            battery: {}
        },
        timestamp: new Date()
    };
    
    try {
        // Read Diesel Levels
        data.diesel.dg1 = await readRegister(REGISTERS.DIESEL.DG1);
        data.diesel.dg2 = await readRegister(REGISTERS.DIESEL.DG2);
        data.diesel.dg3 = await readRegister(REGISTERS.DIESEL.DG3);
        data.diesel.total = data.diesel.dg1 + data.diesel.dg2 + data.diesel.dg3;
        
        // Read Voltage Parameters
        data.electrical.voltage.l1n = await readRegister(REGISTERS.VOLTAGE.L1_N);
        data.electrical.voltage.l2n = await readRegister(REGISTERS.VOLTAGE.L2_N);
        data.electrical.voltage.l3n = await readRegister(REGISTERS.VOLTAGE.L3_N);
        data.electrical.voltage.avg = await readRegister(REGISTERS.VOLTAGE.AVG_LN);
        data.electrical.voltage.unbalance = await readRegister(REGISTERS.VOLTAGE.UNBALANCE);
        
        // Read Current Parameters
        data.electrical.current.l1 = await readRegister(REGISTERS.CURRENT.L1);
        data.electrical.current.l2 = await readRegister(REGISTERS.CURRENT.L2);
        data.electrical.current.l3 = await readRegister(REGISTERS.CURRENT.L3);
        data.electrical.current.avg = await readRegister(REGISTERS.CURRENT.AVG);
        data.electrical.current.unbalance = await readRegister(REGISTERS.CURRENT.UNBALANCE);
        
        // Read Power Parameters
        data.electrical.power.activeL1 = await readRegister(REGISTERS.POWER.ACTIVE_L1);
        data.electrical.power.activeL2 = await readRegister(REGISTERS.POWER.ACTIVE_L2);
        data.electrical.power.activeL3 = await readRegister(REGISTERS.POWER.ACTIVE_L3);
        data.electrical.power.totalActive = await readRegister(REGISTERS.POWER.TOTAL_ACTIVE);
        data.electrical.power.reactiveTotal = await readRegister(REGISTERS.POWER.TOTAL_REACTIVE);
        data.electrical.power.apparentTotal = await readRegister(REGISTERS.POWER.TOTAL_APPARENT);
        
        // Read Frequency & Power Factor
        data.electrical.frequency = await readRegister(REGISTERS.PF_FREQ.FREQUENCY);
        data.electrical.powerFactor.l1 = await readRegister(REGISTERS.PF_FREQ.PF_L1);
        data.electrical.powerFactor.l2 = await readRegister(REGISTERS.PF_FREQ.PF_L2);
        data.electrical.powerFactor.l3 = await readRegister(REGISTERS.PF_FREQ.PF_L3);
        data.electrical.powerFactor.total = await readRegister(REGISTERS.PF_FREQ.TOTAL_PF);
        
        // Read Generator Parameters
        data.electrical.generator.load = await readRegister(REGISTERS.GENERATOR.LOAD_PCT);
        data.electrical.generator.efficiency = await readRegister(REGISTERS.GENERATOR.EFFICIENCY);
        data.electrical.generator.temperature = await readRegister(REGISTERS.GENERATOR.TEMP);
        
        // Read Battery Parameters
        data.electrical.battery.voltage = await readRegister(REGISTERS.BATTERY.VOLTAGE);
        data.electrical.battery.current = await readRegister(REGISTERS.BATTERY.CURRENT);
        data.electrical.battery.soc = await readRegister(REGISTERS.BATTERY.SOC);
        
        // Check for critical levels
        checkDieselLevels(data.diesel);
        
    } catch (err) {
        console.error('Error reading PLC data:', err.message);
    }
    
    return data;
}

// ============================================
// DATA STORAGE & HISTORY
// ============================================
let currentData = null;
let dataHistory = [];
const MAX_HISTORY = 100;

// Read data every 5 seconds
setInterval(async () => {
    currentData = await readAllData();
    
    // Keep history of last 100 readings
    dataHistory.unshift({
        timestamp: currentData.timestamp,
        dg1: currentData.diesel.dg1,
        dg2: currentData.diesel.dg2,
        dg3: currentData.diesel.dg3,
        total: currentData.diesel.total
    });
    
    if (dataHistory.length > MAX_HISTORY) {
        dataHistory = dataHistory.slice(0, MAX_HISTORY);
    }
}, 5000);

// ============================================
// HOURLY DATA LOGGING (8AM - 8PM)
// ============================================
let lastSavedHour = -1;

setInterval(async () => {
    const now = new Date();
    const currentHour = now.getHours();
    
    // Only save between 8 AM and 8 PM
    if (currentHour >= 8 && currentHour <= 20) {
        // Save once per hour
        if (currentHour !== lastSavedHour && currentData && isMongoConnected) {
            try {
                const reading = new DieselReading({
                    timestamp: now,
                    dg1: currentData.diesel.dg1,
                    dg2: currentData.diesel.dg2,
                    dg3: currentData.diesel.dg3,
                    total: currentData.diesel.total,
                    voltage: currentData.electrical.voltage,
                    current: currentData.electrical.current,
                    power: currentData.electrical.power,
                    frequency: currentData.electrical.frequency,
                    powerFactor: currentData.electrical.powerFactor,
                    generator: currentData.electrical.generator,
                    hour: currentHour,
                    date: now.toISOString().split('T')[0]
                });
                
                await reading.save();
                lastSavedHour = currentHour;
                console.log(`✅ Hourly data saved for ${currentHour}:00`);
            } catch (err) {
                console.error('Error saving hourly data:', err.message);
            }
        }
    }
}, 60000); // Check every minute

// ============================================
// EXPRESS APP
// ============================================
const app = express();

app.use(compression());
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// API ENDPOINTS
// ============================================

// Get current real-time data
app.get('/api/current-data', (req, res) => {
    if (currentData) {
        res.json({
            diesel: currentData.diesel,
            electrical: currentData.electrical,
            history: dataHistory,
            timestamp: currentData.timestamp
        });
    } else {
        res.json({
            diesel: { dg1: 0, dg2: 0, dg3: 0, total: 0 },
            electrical: {},
            history: [],
            timestamp: new Date()
        });
    }
});

// Get hourly data from database
app.get('/api/hourly-data', async (req, res) => {
    if (!isMongoConnected) {
        return res.json({ readings: [] });
    }
    
    try {
        const { startDate, endDate } = req.query;
        const query = {};
        
        if (startDate && endDate) {
            query.date = { $gte: startDate, $lte: endDate };
        }
        
        const readings = await DieselReading.find(query)
            .sort({ timestamp: -1 })
            .limit(100);
        
        res.json({ readings });
    } catch (err) {
        console.error('Error fetching hourly data:', err.message);
        res.status(500).json({ error: 'Error fetching data' });
    }
});

// Export to Excel
app.get('/api/export-excel', async (req, res) => {
    try {
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('DG Report');
        
        // Define columns
        worksheet.columns = [
            { header: 'Date', key: 'date', width: 12 },
            { header: 'Hour', key: 'hour', width: 10 },
            { header: 'DG-1 (L)', key: 'dg1', width: 12 },
            { header: 'DG-2 (L)', key: 'dg2', width: 12 },
            { header: 'DG-3 (L)', key: 'dg3', width: 12 },
            { header: 'Total (L)', key: 'total', width: 12 },
            { header: 'Avg Voltage (V)', key: 'voltage', width: 15 },
            { header: 'Avg Current (A)', key: 'current', width: 15 },
            { header: 'Total Power (kW)', key: 'power', width: 15 },
            { header: 'Frequency (Hz)', key: 'frequency', width: 15 },
            { header: 'Power Factor', key: 'pf', width: 15 }
        ];
        
        // Style header
        worksheet.getRow(1).font = { bold: true };
        worksheet.getRow(1).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: '4472C4' }
        };
        
        // Add data
        if (isMongoConnected) {
            const readings = await DieselReading.find()
                .sort({ timestamp: -1 })
                .limit(1000);
            
            readings.forEach(reading => {
                worksheet.addRow({
                    date: reading.date,
                    hour: `${reading.hour}:00`,
                    dg1: reading.dg1,
                    dg2: reading.dg2,
                    dg3: reading.dg3,
                    total: reading.total,
                    voltage: reading.voltage?.avg || 0,
                    current: reading.current?.avg || 0,
                    power: reading.power?.totalActive || 0,
                    frequency: reading.frequency || 0,
                    pf: reading.powerFactor?.total || 0
                });
            });
        }
        
        // Send file
        res.setHeader(
            'Content-Type',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        );
        res.setHeader(
            'Content-Disposition',
            `attachment; filename=DG_Report_${new Date().toISOString().split('T')[0]}.xlsx`
        );
        
        await workbook.xlsx.write(res);
        res.end();
    } catch (err) {
        console.error('Error exporting to Excel:', err.message);
        res.status(500).json({ error: 'Error exporting data' });
    }
});

// System status
app.get('/api/status', (req, res) => {
    res.json({
        plc: isPlcConnected ? 'connected' : 'disconnected',
        database: isMongoConnected ? 'connected' : 'disconnected',
        email: emailEnabled ? 'enabled' : 'disabled',
        timestamp: new Date()
    });
});

// ============================================
// START SERVER
// ============================================
app.listen(PORT, () => {
    console.log('');
    console.log('===========================================');
    console.log('   DG MONITORING SYSTEM - v3.0');
    console.log('===========================================');
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`📊 Dashboard: http://localhost:${PORT}`);
    console.log('');
    console.log('System Status:');
    console.log(`   PLC Connection: ${isPlcConnected ? '✅ Connected' : '⚠️  Disconnected'}`);
    console.log(`   MongoDB: ${isMongoConnected ? '✅ Connected' : '⚠️  Disconnected'}`);
    console.log(`   Email Alerts: ${emailEnabled ? '✅ Enabled' : '⚠️  Disabled'}`);
    console.log('');
    console.log('Features:');
    console.log('   ✅ Real-time PLC data reading (every 5 seconds)');
    console.log('   ✅ Hourly database logging (8AM - 8PM)');
    console.log('   ✅ Email alerts for critical diesel levels');
    console.log('   ✅ Excel export with all parameters');
    console.log('   ✅ Comprehensive electrical parameter monitoring');
    console.log('===========================================');
    console.log('');
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down gracefully...');
    
    if (client.isOpen) {
        client.close();
    }
    
    if (isMongoConnected) {
        await mongoose.connection.close();
    }
    
    process.exit(0);
});