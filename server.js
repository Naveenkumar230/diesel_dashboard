require('dotenv').config();
const ModbusRTU = require("modbus-serial");
const express = require('express');
const path = require('path');
const mongoose = require('mongoose');
const cors = require('cors');
const nodemailer = require('nodemailer');

// ============================================
// MONGODB CONNECTION WITH IMPROVED ERROR HANDLING
// ============================================
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/dieselDB";

const mongooseOptions = {
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 45000,
    connectTimeoutMS: 10000,
    maxPoolSize: 10,
    minPoolSize: 2,
    retryWrites: true,
    retryReads: true,
    bufferCommands: false,
    autoIndex: true
};

let isMongoConnected = false;
let connectionAttempts = 0;
const MAX_RETRY_ATTEMPTS = 3;

async function connectMongoDB() {
    connectionAttempts++;
    
    try {
        console.log(`\n🔄 MongoDB connection attempt ${connectionAttempts}/${MAX_RETRY_ATTEMPTS}...`);
        await mongoose.connect(MONGODB_URI, mongooseOptions);
        console.log('✅ MongoDB Connected Successfully');
        console.log(`   Database: ${mongoose.connection.name}`);
        console.log(`   Host: ${mongoose.connection.host}`);
        isMongoConnected = true;
        connectionAttempts = 0;
    } catch (err) {
        console.error('❌ MongoDB Connection Error:', err.message);
        
        if (err.message.includes('IP') || err.message.includes('whitelist')) {
            console.log('\n💡 IP Whitelist Issue:');
            console.log('   1. Go to: https://cloud.mongodb.com');
            console.log('   2. Navigate to Network Access');
            console.log('   3. Add your IP or allow all (0.0.0.0/0)');
        } else if (err.message.includes('SSL') || err.message.includes('TLS')) {
            console.log('\n💡 SSL/TLS Issue:');
            console.log('   Add to .env: &tls=true&tlsAllowInvalidCertificates=true');
        } else if (err.message.includes('authentication')) {
            console.log('\n💡 Authentication Issue:');
            console.log('   Verify username/password in MONGODB_URI');
        }
        
        if (connectionAttempts < MAX_RETRY_ATTEMPTS) {
            console.log(`\n⏳ Retrying in 5 seconds...`);
            setTimeout(connectMongoDB, 5000);
        } else {
            console.log('\n⚠️  MongoDB unavailable after multiple attempts');
            console.log('⚠️  System continues WITHOUT database (data not persistent)');
            console.log('💡 Consider installing local MongoDB: sudo apt-get install mongodb\n');
        }
        
        isMongoConnected = false;
    }
}

mongoose.connection.on('connected', () => {
    console.log('✅ MongoDB connection established');
    isMongoConnected = true;
});

mongoose.connection.on('disconnected', () => {
    console.log('⚠️  MongoDB disconnected - attempting reconnect...');
    isMongoConnected = false;
    setTimeout(connectMongoDB, 5000);
});

mongoose.connection.on('error', (err) => {
    console.error('❌ MongoDB error:', err.message);
    isMongoConnected = false;
});

connectMongoDB();

// ============================================
// EMAIL CONFIGURATION
// ============================================
let emailTransporter = null;
let emailEnabled = false;

try {
    if (process.env.EMAIL_USER && process.env.EMAIL_APP_PASSWORD) {
        emailTransporter = nodemailer.createTransport({
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
} catch (error) {
    console.error('❌ Email configuration error:', error.message);
    emailEnabled = false;
}

const alertState = {
    lastAlertTime: {},
    currentAlerts: new Set()
};

const ALERT_COOLDOWN = parseInt(process.env.ALERT_COOLDOWN) || 1800000;
const CRITICAL_LEVEL = parseInt(process.env.CRITICAL_DIESEL_LEVEL) || 50;
const WARNING_LEVEL = parseInt(process.env.WARNING_DIESEL_LEVEL) || 30;
const ALERT_RECIPIENTS = process.env.ALERT_RECIPIENTS || '';

// ============================================
// MONGOOSE SCHEMA
// ============================================
const DieselReadingSchema = new mongoose.Schema({
    timestamp: { type: Date, default: Date.now, index: true },
    dg1: { type: Number, required: true },
    dg2: { type: Number, required: true },
    dg3: { type: Number, required: true },
    total: { type: Number, required: true },
    dg1_change: { type: Number, default: 0 },
    dg2_change: { type: Number, default: 0 },
    dg3_change: { type: Number, default: 0 }
});

DieselReadingSchema.index({ timestamp: -1 });
const DieselReading = mongoose.model('DieselReading', DieselReadingSchema);

// ============================================
// EMAIL TEMPLATES
// ============================================
function getEmailTemplate(alertType, data) {
    const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    const dashboardUrl = `http://${process.env.PI_IP_ADDRESS || '192.168.30.156'}:${process.env.PORT || 3000}`;
    
    const templates = {
        critical: {
            subject: '🚨 CRITICAL: Diesel Level Alert - Immediate Action Required',
            html: `
<!DOCTYPE html>
<html>
<head><style>
body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 0; padding: 0; background: #f5f5f5; }
.container { max-width: 600px; margin: 20px auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.15); }
.header { background: linear-gradient(135deg, #dc2626 0%, #b91c1c 100%); padding: 40px 24px; text-align: center; color: white; }
.header h1 { margin: 0; font-size: 28px; font-weight: 700; }
.content { padding: 32px 24px; }
.alert-box { background: #fef2f2; border-left: 4px solid #dc2626; padding: 20px; margin: 24px 0; border-radius: 8px; }
.alert-box h2 { color: #991b1b; margin: 0 0 12px 0; font-size: 18px; font-weight: 700; }
.alert-box p { color: #7f1d1d; margin: 0; line-height: 1.6; }
.metric-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; margin: 24px 0; }
.metric { background: #f9fafb; padding: 20px; border-radius: 8px; text-align: center; border: 1px solid #e5e7eb; }
.metric-label { font-size: 12px; color: #6b7280; text-transform: uppercase; font-weight: 600; margin-bottom: 8px; }
.metric-value { font-size: 32px; font-weight: 700; color: #111827; }
.critical { color: #dc2626; }
.button { display: inline-block; background: #2563eb; color: white; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; margin: 24px 0; }
.footer { background: #f9fafb; padding: 24px; text-align: center; font-size: 13px; color: #6b7280; border-top: 1px solid #e5e7eb; }
.timestamp { background: #f3f4f6; padding: 12px; border-radius: 6px; text-align: center; margin: 20px 0; color: #374151; font-size: 14px; }
</style></head>
<body>
<div class="container">
    <div class="header">
        <div style="font-size: 48px; margin-bottom: 12px;">🚨</div>
        <h1>Critical Diesel Alert</h1>
    </div>
    <div class="content">
        <div class="alert-box">
            <h2>⚠️ IMMEDIATE ACTION REQUIRED</h2>
            <p>One or more diesel generators have reached critically low fuel levels (≤${CRITICAL_LEVEL}L). Immediate refueling is required to prevent operational disruption.</p>
        </div>
        <div class="metric-grid">
            <div class="metric">
                <div class="metric-label">DG-1 Level</div>
                <div class="metric-value ${data.dg1 <= CRITICAL_LEVEL ? 'critical' : ''}">${data.dg1}L</div>
            </div>
            <div class="metric">
                <div class="metric-label">DG-2 Level</div>
                <div class="metric-value ${data.dg2 <= CRITICAL_LEVEL ? 'critical' : ''}">${data.dg2}L</div>
            </div>
            <div class="metric">
                <div class="metric-label">DG-3 Level</div>
                <div class="metric-value ${data.dg3 <= CRITICAL_LEVEL ? 'critical' : ''}">${data.dg3}L</div>
            </div>
            <div class="metric">
                <div class="metric-label">Total Diesel</div>
                <div class="metric-value">${data.total}L</div>
            </div>
        </div>
        <div class="timestamp">
            <strong>Alert Time:</strong> ${timestamp}
        </div>
        <div style="text-align: center;">
            <a href="${dashboardUrl}" class="button">View Live Dashboard →</a>
        </div>
    </div>
    <div class="footer">
        DG Monitoring System - Automated Alert<br>
        Critical Level Threshold: ${CRITICAL_LEVEL}L
    </div>
</div>
</body>
</html>`
        },
        warning: {
            subject: '⚠️ WARNING: Diesel Level Below Threshold',
            html: `
<!DOCTYPE html>
<html>
<head><style>
body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 0; padding: 0; background: #f5f5f5; }
.container { max-width: 600px; margin: 20px auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.15); }
.header { background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); padding: 40px 24px; text-align: center; color: white; }
.header h1 { margin: 0; font-size: 28px; font-weight: 700; }
.content { padding: 32px 24px; }
.alert-box { background: #fffbeb; border-left: 4px solid #f59e0b; padding: 20px; margin: 24px 0; border-radius: 8px; }
.alert-box h2 { color: #92400e; margin: 0 0 12px 0; font-size: 18px; font-weight: 700; }
.alert-box p { color: #78350f; margin: 0; line-height: 1.6; }
.metric-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; margin: 24px 0; }
.metric { background: #f9fafb; padding: 20px; border-radius: 8px; text-align: center; border: 1px solid #e5e7eb; }
.metric-label { font-size: 12px; color: #6b7280; text-transform: uppercase; font-weight: 600; margin-bottom: 8px; }
.metric-value { font-size: 32px; font-weight: 700; color: #111827; }
.warning { color: #f59e0b; }
.button { display: inline-block; background: #2563eb; color: white; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; margin: 24px 0; }
.footer { background: #f9fafb; padding: 24px; text-align: center; font-size: 13px; color: #6b7280; border-top: 1px solid #e5e7eb; }
.timestamp { background: #f3f4f6; padding: 12px; border-radius: 6px; text-align: center; margin: 20px 0; color: #374151; font-size: 14px; }
</style></head>
<body>
<div class="container">
    <div class="header">
        <div style="font-size: 48px; margin-bottom: 12px;">⚠️</div>
        <h1>Diesel Level Warning</h1>
    </div>
    <div class="content">
        <div class="alert-box">
            <h2>⚠️ LOW FUEL WARNING</h2>
            <p>Diesel levels have dropped below the warning threshold (${WARNING_LEVEL}L). Please schedule refueling soon to maintain operational continuity.</p>
        </div>
        <div class="metric-grid">
            <div class="metric">
                <div class="metric-label">DG-1 Level</div>
                <div class="metric-value ${data.dg1 <= WARNING_LEVEL ? 'warning' : ''}">${data.dg1}L</div>
            </div>
            <div class="metric">
                <div class="metric-label">DG-2 Level</div>
                <div class="metric-value ${data.dg2 <= WARNING_LEVEL ? 'warning' : ''}">${data.dg2}L</div>
            </div>
            <div class="metric">
                <div class="metric-label">DG-3 Level</div>
                <div class="metric-value ${data.dg3 <= WARNING_LEVEL ? 'warning' : ''}">${data.dg3}L</div>
            </div>
            <div class="metric">
                <div class="metric-label">Total Diesel</div>
                <div class="metric-value">${data.total}L</div>
            </div>
        </div>
        <div class="timestamp">
            <strong>Alert Time:</strong> ${timestamp}
        </div>
        <div style="text-align: center;">
            <a href="${dashboardUrl}" class="button">View Live Dashboard →</a>
        </div>
    </div>
    <div class="footer">
        DG Monitoring System - Automated Alert<br>
        Warning Level Threshold: ${WARNING_LEVEL}L
    </div>
</div>
</body>
</html>`
        }
    };
    
    return templates[alertType] || templates.warning;
}

async function sendEmailAlert(alertType, data) {
    if (!emailEnabled || !ALERT_RECIPIENTS) return;
    
    const alertKey = `${alertType}_${Math.floor(Date.now() / ALERT_COOLDOWN)}`;
    
    if (alertState.currentAlerts.has(alertKey)) return;
    
    try {
        const template = getEmailTemplate(alertType, data);
        
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
    // Only send alert when any DG reaches 50L or below
    if (data.dg1 <= 50 || data.dg2 <= 50 || data.dg3 <= 50) {
        sendEmailAlert('critical', data);
    }
}
// ============================================
// PLC SETTINGS
// ============================================
const port = process.env.PLC_PORT || '/dev/ttyUSB0';
const plcSettings = {
    baudRate: parseInt(process.env.PLC_BAUD_RATE) || 9600,
    parity: process.env.PLC_PARITY || 'none',
    dataBits: parseInt(process.env.PLC_DATA_BITS) || 8,
    stopBits: parseInt(process.env.PLC_STOP_BITS) || 1
};
const plcSlaveID = parseInt(process.env.PLC_SLAVE_ID) || 1;

const dgRegisters = {
    dg1: { address: 4104, name: "DG-1" },
    dg2: { address: 4100, name: "DG-2" },
    dg3: { address: 4102, name: "DG-3" }
};

let systemData = {
    dg1: 0,
    dg2: 0,
    dg3: 0,
    total: 0,
    lastUpdate: null
};

let previousReading = null;
let previousDieselData = { dg1: 0, dg2: 0, dg3: 0 };

const client = new ModbusRTU();
const app = express();
const webServerPort = parseInt(process.env.PORT) || 3000;
const piIpAddress = process.env.PI_IP_ADDRESS || '192.168.30.156';

// ============================================
// MIDDLEWARE
// ============================================
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ============================================
// DATA CONVERSION FUNCTIONS
// ============================================
function toSignedInt16(value) {
    if (value > 32767) return value - 65536;
    return value;
}

function isValidReading(value) {
    const signedValue = toSignedInt16(value);
    if (value === 65535 || value === 65534 || signedValue === -1) return false;
    return signedValue >= 0 && signedValue <= 600;
}

function smoothValue(currentValue, previousValue, maxChangePercent = 50) {
    if (previousValue === 0 || previousValue === null) return currentValue;
    const changePercent = Math.abs((currentValue - previousValue) / previousValue * 100);
    if (changePercent > maxChangePercent) {
        console.log(`⚠️  Smoothing: ${previousValue} -> ${currentValue} (${changePercent.toFixed(1)}% change - keeping previous)`);
        return previousValue;
    }
    return currentValue;
}

async function readSingleRegister(address, name, dataKey) {
    try {
        const data = await client.readHoldingRegisters(address, 1);
        
        if (!data || !data.data || data.data.length < 1) {
            console.error(`${name}: Invalid data received`);
            return systemData[dataKey] || 0;
        }
        
        const rawValue = data.data[0];
        
        if (!isValidReading(rawValue)) {
            console.log(`⚠️  Invalid reading: ${rawValue} for ${name}`);
            return systemData[dataKey] || 0;
        }
        
        const signedValue = toSignedInt16(rawValue);
        let value = Math.max(0, signedValue);
        
        const previousValue = previousDieselData[dataKey] || 0;
        value = smoothValue(value, previousValue, 30);
        previousDieselData[dataKey] = value;
        
        console.log(`${name} (Addr: ${address}): ${value}L [Raw: ${rawValue}]`);
        
        systemData[dataKey] = value;
        return value;
        
    } catch (e) {
        console.error(`${name} Read Error at address ${address}: ${e.message}`);
        return systemData[dataKey] || 0;
    }
}

async function readAllSystemData() {
    try {
        console.log('═'.repeat(80));
        console.log(`⏱️  ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`);
        console.log('─'.repeat(80));
        
        console.log('🔋 Reading Diesel Levels...');
        await readSingleRegister(dgRegisters.dg1.address, dgRegisters.dg1.name, 'dg1');
        await new Promise(resolve => setTimeout(resolve, 250));
        
        await readSingleRegister(dgRegisters.dg2.address, dgRegisters.dg2.name, 'dg2');
        await new Promise(resolve => setTimeout(resolve, 250));
        
        await readSingleRegister(dgRegisters.dg3.address, dgRegisters.dg3.name, 'dg3');
        await new Promise(resolve => setTimeout(resolve, 250));
        
        systemData.total = (systemData.dg1 || 0) + (systemData.dg2 || 0) + (systemData.dg3 || 0);
        systemData.lastUpdate = new Date().toISOString();
        
        console.log('═'.repeat(80));
        console.log(`📊 SYSTEM STATUS:`);
        console.log(`   DG-1: ${systemData.dg1}L | DG-2: ${systemData.dg2}L | DG-3: ${systemData.dg3}L | Total: ${systemData.total}L`);
        console.log('═'.repeat(80));
        console.log('');
        
        checkDieselLevels(systemData);
        await saveToDatabase(systemData);
        
    } catch (e) {
        console.error(`\n❌ MODBUS EXCEPTION: ${e.message}`);
        console.error('Reconnecting to PLC...\n');
        client.close();
        setTimeout(connectToPLC, 5000);
    }
}

function calculateChange(current, previous) {
    if (!previous) return 0;
    return current - previous;
}

async function saveToDatabase(data) {
    if (mongoose.connection.readyState !== 1) {
        return;
    }
    
    try {
        const changes = {
            dg1_change: calculateChange(data.dg1, previousReading?.dg1),
            dg2_change: calculateChange(data.dg2, previousReading?.dg2),
            dg3_change: calculateChange(data.dg3, previousReading?.dg3)
        };

        const reading = new DieselReading({
            timestamp: new Date(),
            dg1: data.dg1,
            dg2: data.dg2,
            dg3: data.dg3,
            total: data.total,
            ...changes
        });

        await reading.save();
        previousReading = data;
        console.log('💾 Data saved to MongoDB');
    } catch (error) {
        console.error('❌ MongoDB Save Error:', error.message);
        if (error.name === 'MongoNetworkError') {
            isMongoConnected = false;
            console.log('⚠️  Lost MongoDB connection - attempting reconnect...');
            setTimeout(connectMongoDB, 5000);
        }
    }
}

function connectToPLC() {
    client.connectRTU(port, plcSettings)
        .then(() => {
            console.log(`\n╔════════════════════════════════════════════════════════╗`);
            console.log(`║  DG MONITORING SYSTEM - PROFESSIONAL EDITION          ║`);
            console.log(`║     PLC CONNECTION SUCCESS                            ║`);
            console.log(`╚════════════════════════════════════════════════════════╝`);
            console.log(`\n📡 Connection Details:`);
            console.log(`   Port: ${port}`);
            console.log(`   Baud Rate: ${plcSettings.baudRate}`);
            console.log(`   Data Bits: ${plcSettings.dataBits}`);
            console.log(`   Parity: ${plcSettings.parity.toUpperCase()}`);
            console.log(`   Stop Bits: ${plcSettings.stopBits}`);
            console.log(`   Slave ID: ${plcSlaveID}`);
            console.log(`\n📧 Email Alert Configuration:`);
            console.log(`   Status: ${emailEnabled ? 'ENABLED' : 'DISABLED'}`);
            if (emailEnabled) {
                console.log(`   Recipients: ${ALERT_RECIPIENTS}`);
                console.log(`   Warning Level: ${WARNING_LEVEL}L`);
                console.log(`   Critical Level: ${CRITICAL_LEVEL}L`);
                console.log(`   Cooldown Period: ${ALERT_COOLDOWN / 60000} minutes`);
            }
            console.log(`\n📋 Register Mapping:`);
            Object.entries(dgRegisters).forEach(([key, reg]) => {
                console.log(`   ${reg.name.padEnd(10)} → Address ${reg.address}`);
            });
            console.log(`\n💾 Database:`);
            console.log(`   MongoDB: ${mongoose.connection.readyState === 1 ? '✓ Connected' : '✗ Disconnected'}`);
            
            client.setID(plcSlaveID);
            client.setTimeout(3000);
            
            setTimeout(() => {
                console.log(`\n${'═'.repeat(60)}`);
                console.log(`🚀 Starting live data monitoring...`);
                console.log(`   Update Interval: 2 seconds`);
                console.log(`   Data Smoothing: Enabled (30% max change threshold)`);
                console.log(`${'═'.repeat(60)}\n`);
                readAllSystemData();
                setInterval(readAllSystemData, 2000);
            }, 1000);
        })
        .catch((e) => {
            console.error(`\n${'═'.repeat(60)}`);
            console.error(`❌ PLC CONNECTION FAILED`);
            console.error(`${'═'.repeat(60)}`);
            console.error(`Port: ${port}`);
            console.error(`Error: ${e.message}`);
            console.error(`\n⚠️  Troubleshooting:`);
            console.error(`   1. Check if PLC is powered on`);
            console.error(`   2. Verify USB cable connection`);
            console.error(`   3. Confirm port name (ls /dev/ttyUSB*)`);
            console.error(`   4. Check user permissions (sudo usermod -a -G dialout $USER)`);
            console.error(`\n🔄 Retrying connection in 5 seconds...\n`);
            client.close();
            setTimeout(connectToPLC, 5000);
        });
}

// ============================================
// EXPRESS API ENDPOINTS
// ============================================

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/data', (req, res) => {
    res.json({
        timestamp: systemData.lastUpdate || new Date().toISOString(),
        dg1: systemData.dg1,
        dg2: systemData.dg2,
        dg3: systemData.dg3,
        total: systemData.total
    });
});

app.get('/api/historical', async (req, res) => {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.json({
                success: false,
                error: 'Database not connected',
                data: []
            });
        }

        const { timeRange = '24h', generator, fromDate, toDate, limit = 1000 } = req.query;

        let query = {};
        
        if (fromDate && toDate && fromDate !== 'null' && toDate !== 'null') {
            const from = new Date(fromDate);
            const to = new Date(toDate);
            
            if (!isNaN(from.getTime()) && !isNaN(to.getTime())) {
                query.timestamp = { $gte: from, $lte: to };
            }
        } else if (timeRange && timeRange !== 'custom') {
            const now = new Date();
            let startTime;
            
            switch(timeRange) {
                case '1h': 
                    startTime = new Date(now.getTime() - 60 * 60 * 1000); 
                    break;
                case '24h': 
                    startTime = new Date(now.getTime() - 24 * 60 * 60 * 1000); 
                    break;
                case '7d': 
                    startTime = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); 
                    break;
                case '30d': 
                    startTime = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000); 
                    break;
                default: 
                    startTime = new Date(now.getTime() - 24 * 60 * 60 * 1000);
            }
            
            query.timestamp = { $gte: startTime };
        } else {
            const now = new Date();
            query.timestamp = { $gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) };
        }

        const readings = await DieselReading.find(query)
            .sort({ timestamp: -1 })
            .limit(parseInt(limit));

        const processedData = readings.map(reading => ({
            timestamp: reading.timestamp,
            dg1: reading.dg1,
            dg2: reading.dg2,
            dg3: reading.dg3,
            total: reading.total,
            dg1_change: reading.dg1_change || 0,
            dg2_change: reading.dg2_change || 0,
            dg3_change: reading.dg3_change || 0
        }));

        res.json({
            success: true,
            count: processedData.length,
            timeRange: timeRange,
            data: processedData.reverse()
        });

    } catch (error) {
        console.error('Historical data error:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            data: []
        });
    }
});

app.get('/api/export', async (req, res) => {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({
                success: false,
                error: 'Database not connected'
            });
        }

        const { timeRange = '24h', generator, fromDate, toDate } = req.query;
        
        const now = new Date();
        let query = {};
        
        if (fromDate && toDate && fromDate !== 'null' && toDate !== 'null') {
            const from = new Date(fromDate);
            const to = new Date(toDate);
            
            if (!isNaN(from.getTime()) && !isNaN(to.getTime())) {
                query.timestamp = { $gte: from, $lte: to };
            }
        } else {
            let startTime;
            switch(timeRange) {
                case '1h': 
                    startTime = new Date(now.getTime() - 60 * 60 * 1000); 
                    break;
                case '24h': 
                    startTime = new Date(now.getTime() - 24 * 60 * 60 * 1000); 
                    break;
                case '7d': 
                    startTime = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); 
                    break;
                case '30d': 
                    startTime = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000); 
                    break;
                default: 
                    startTime = new Date(now.getTime() - 24 * 60 * 60 * 1000);
            }
            query.timestamp = { $gte: startTime };
        }

        const readings = await DieselReading.find(query).sort({ timestamp: 1 });

        let csv = 'Date,Time,DG-1 (L),DG-2 (L),DG-3 (L),Total (L),DG-1 Change,DG-2 Change,DG-3 Change\n';
        
        readings.forEach(r => {
            const d = new Date(r.timestamp);
            const dateStr = `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
            let hours = d.getHours();
            const minutes = String(d.getMinutes()).padStart(2, '0');
            const seconds = String(d.getSeconds()).padStart(2, '0');
            const ampm = hours >= 12 ? 'PM' : 'AM';
            hours = hours % 12 || 12;
            const timeStr = `${String(hours).padStart(2, '0')}:${minutes}:${seconds} ${ampm}`;
            
            csv += `${dateStr},${timeStr},${r.dg1},${r.dg2},${r.dg3},${r.total},${r.dg1_change || 0},${r.dg2_change || 0},${r.dg3_change || 0}\n`;
        });

        const filename = `dg_data_${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}.csv`;
        
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(csv);

        console.log(`📥 Data exported: ${filename} (${readings.length} records)`);

    } catch (error) {
        console.error('Export error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

app.get('/api/health', (req, res) => {
    res.json({
        success: true,
        status: 'running',
        timestamp: new Date().toISOString(),
        mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
        lastDataUpdate: systemData.lastUpdate,
        systemStatus: {
            totalDiesel: systemData.total,
            dg1: systemData.dg1,
            dg2: systemData.dg2,
            dg3: systemData.dg3
        },
        alerts: {
            enabled: emailEnabled,
            warningLevel: WARNING_LEVEL,
            criticalLevel: CRITICAL_LEVEL,
            recipients: ALERT_RECIPIENTS,
            cooldown: `${ALERT_COOLDOWN / 60000} minutes`
        },
        plc: {
            port: port,
            baudRate: plcSettings.baudRate,
            slaveId: plcSlaveID
        }
    });
});

app.get('/api/analytics', async (req, res) => {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.json({
                success: false,
                error: 'Database not connected',
                data: null
            });
        }

        const { period = '24h', fromDate, toDate } = req.query;
        
        let query = {};
        
        if (fromDate && toDate && fromDate !== 'null' && toDate !== 'null') {
            const from = new Date(fromDate);
            const to = new Date(toDate);
            
            if (!isNaN(from.getTime()) && !isNaN(to.getTime())) {
                query.timestamp = { $gte: from, $lte: to };
            }
        } else {
            const now = new Date();
            let startTime;
            
            switch(period) {
                case '1h': startTime = new Date(now.getTime() - 60 * 60 * 1000); break;
                case '24h': startTime = new Date(now.getTime() - 24 * 60 * 60 * 1000); break;
                case '7d': startTime = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); break;
                case '30d': startTime = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000); break;
                default: startTime = new Date(now.getTime() - 24 * 60 * 60 * 1000);
            }
            
            query.timestamp = { $gte: startTime };
        }

        const readings = await DieselReading.find(query).sort({ timestamp: 1 });

        if (readings.length < 2) {
            return res.json({
                success: true,
                message: 'Insufficient data for analysis',
                data: null
            });
        }

        const dgs = ['dg1', 'dg2', 'dg3'];
        const analytics = {};

        dgs.forEach(dg => {
            const firstReading = readings[0][dg];
            const lastReading = readings[readings.length - 1][dg];
            const consumption = Math.max(0, firstReading - lastReading);
            
            const levels = readings.map(r => r[dg]);
            const avgLevel = levels.reduce((sum, val) => sum + val, 0) / levels.length;
            const maxLevel = Math.max(...levels);
            const minLevel = Math.min(...levels);

            const refills = [];
            for (let i = 1; i < readings.length; i++) {
                const diff = readings[i][dg] - readings[i-1][dg];
                if (diff > 50) {
                    refills.push({
                        date: readings[i].timestamp,
                        amount: diff,
                        from: readings[i-1][dg],
                        to: readings[i][dg]
                    });
                }
            }

            analytics[dg] = {
                startLevel: firstReading,
                endLevel: lastReading,
                consumption: consumption,
                avgLevel: parseFloat(avgLevel.toFixed(1)),
                maxLevel: maxLevel,
                minLevel: minLevel,
                refillCount: refills.length,
                refills: refills
            };
        });

        const totalConsumption = analytics.dg1.consumption + analytics.dg2.consumption + analytics.dg3.consumption;
        const avgConsumptionPerDay = (totalConsumption / (readings.length / (1440 / 2))) || 0;

        res.json({
            success: true,
            period: period,
            recordCount: readings.length,
            analytics: analytics,
            summary: {
                totalConsumption: totalConsumption,
                avgConsumptionPerDay: parseFloat(avgConsumptionPerDay.toFixed(2)),
                currentTotal: systemData.total
            }
        });

    } catch (error) {
        console.error('Analytics error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ============================================
// ERROR HANDLERS
// ============================================

app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Endpoint not found'
    });
});

app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({
        success: false,
        error: 'Internal server error'
    });
});

// ============================================
// GRACEFUL SHUTDOWN
// ============================================

process.on('SIGINT', async () => {
    console.log('\n\n🛑 Shutting down gracefully...');
    
    try {
        client.close();
        console.log('✓ PLC connection closed');
        
        await mongoose.connection.close();
        console.log('✓ MongoDB connection closed');
        
        console.log('✓ Shutdown complete\n');
        process.exit(0);
    } catch (error) {
        console.error('Error during shutdown:', error);
        process.exit(1);
    }
});

process.on('SIGTERM', async () => {
    console.log('\n\n🛑 Received SIGTERM, shutting down...');
    
    try {
        client.close();
        await mongoose.connection.close();
        console.log('✓ Shutdown complete\n');
        process.exit(0);
    } catch (error) {
        console.error('Error during shutdown:', error);
        process.exit(1);
    }
});

// ============================================
// START WEB SERVER
// ============================================

app.listen(webServerPort, () => {
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`║${' '.repeat(68)}║`);
    console.log(`║    🚀 DG MONITORING SYSTEM - PROFESSIONAL EDITION 🚀${' '.repeat(14)}║`);
    console.log(`║${' '.repeat(68)}║`);
    console.log(`${'═'.repeat(70)}`);
    console.log(`\n📡 WEB SERVER STARTED SUCCESSFULLY`);
    console.log(`${'─'.repeat(70)}`);
    console.log(`\n🌐 Access Points:`);
    console.log(`   Dashboard:        http://${piIpAddress}:${webServerPort}/`);
    console.log(`   Live Data API:    http://${piIpAddress}:${webServerPort}/api/data`);
    console.log(`   Historical API:   http://${piIpAddress}:${webServerPort}/api/historical`);
    console.log(`   Analytics API:    http://${piIpAddress}:${webServerPort}/api/analytics`);
    console.log(`   Export CSV:       http://${piIpAddress}:${webServerPort}/api/export`);
    console.log(`   Health Check:     http://${piIpAddress}:${webServerPort}/api/health`);
    console.log(`\n📱 Features:`);
    console.log(`   ✓ Real-time diesel monitoring (2s refresh)`);
    console.log(`   ✓ Historical data with custom date ranges`);
    console.log(`   ✓ Advanced analytics with consumption tracking`);
    console.log(`   ✓ Automatic refill detection`);
    console.log(`   ✓ Email alerts (Warning: ${WARNING_LEVEL}L, Critical: ${CRITICAL_LEVEL}L)`);
    console.log(`   ✓ CSV export with filter support`);
    console.log(`   ✓ Professional dashboard UI`);
    console.log(`\n🔧 System Configuration:`);
    console.log(`   Server Port: ${webServerPort}`);
    console.log(`   PLC Port: ${port}`);
    console.log(`   Database: ${mongoose.connection.readyState === 1 ? '✓ Connected' : '⏳ Connecting...'}`);
    console.log(`   Email Alerts: ${emailEnabled ? '✓ Enabled' : '✗ Disabled'}`);
    console.log(`\n${'═'.repeat(70)}\n`);
    
    connectToPLC();
});

// ============================================
// INITIAL STARTUP LOG
// ============================================

console.log(`\n${'═'.repeat(70)}`);
console.log(`  DG MONITORING SYSTEM v2.0.0 - PROFESSIONAL EDITION`);
console.log(`  Starting up...`);
console.log(`${'═'.repeat(70)}\n`);
console.log(`📅 Startup Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`);
console.log(`💻 Node Version: ${process.version}`);
console.log(`🖥️  Platform: ${process.platform}`);
console.log(`📂 Working Directory: ${__dirname}`);
console.log(`\n⚙️  Loading configuration...`);
console.log(`   PORT: ${webServerPort}`);
console.log(`   PLC_PORT: ${port}`);
console.log(`   PLC_BAUD_RATE: ${plcSettings.baudRate}`);
console.log(`   PLC_SLAVE_ID: ${plcSlaveID}`);
console.log(`   PI_IP_ADDRESS: ${piIpAddress}`);
console.log(`   WARNING_LEVEL: ${WARNING_LEVEL}L`);
console.log(`   CRITICAL_LEVEL: ${CRITICAL_LEVEL}L`);
console.log(`   ALERT_COOLDOWN: ${ALERT_COOLDOWN / 60000} minutes`);
console.log(`   ALERT_RECIPIENTS: ${ALERT_RECIPIENTS || 'Not configured'}`);
console.log(`\n✅ Configuration loaded successfully`);
console.log(`🔌 Initializing web server...\n`);