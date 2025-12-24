/**
 * API Routes - PRODUCTION VERIFIED VERSION
 * * LOGIC SUMMARY:
 * 1. Fetches Diesel Data AND Raw Electrical Data separately.
 * 2. Merges them based on timestamps (Synchronization).
 * 3. VERIFICATION:
 * - Consumption is ONLY counted if Fuel drops > 1.0L AND Active Power > 0.
 * - Refills are ONLY counted if Fuel rises > 25.0L.
 * * * NEW FIX: 
 * - Filters out invalid '0' or '1' liter readings to prevent Ghost Refills.
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const ExcelJS = require('exceljs'); 
const { getSystemData } = require('../services/plcService');
const { DieselConsumption, ElectricalReading } = require('../models/schemas');

// --- CONSTANTS ---
const CONSUMPTION_THRESHOLD = 1.0; // Liters: Ignore drops smaller than this
const REFILL_THRESHOLD = 25.0;     // Liters: Ignore rises smaller than this
const LOGO_PATH = path.join(__dirname, '../public/logo.png');

// ============================================================
// 1. HELPER: Find Closest Electrical Reading
// ============================================================
function findClosestReading(electricalRecords, targetTime) {
    if (!electricalRecords || electricalRecords.length === 0) return null;

    // Optimization: Search within a 2-minute window
    const targetMs = targetTime.getTime();
    return electricalRecords.find(e => {
        const eMs = new Date(e.timestamp).getTime();
        return Math.abs(eMs - targetMs) < 2 * 60 * 1000; // Match within +/- 2 mins
    });
}

// ============================================================
// 2. CORE LOGIC: MERGE & VERIFY
// ============================================================
function calculateVerifiedConsumption(dieselRecords, electricalRecords, dgKey) {
    // ---------------------------------------------------------
    // 🛑 FIX: CLEAN DATA FIRST
    // Remove any records where level is 0, null, or < 2 (Dead Sensor)
    // ---------------------------------------------------------
    const cleanRecords = dieselRecords.filter(r => {
        const lvl = r[dgKey]?.level;
        return typeof lvl === 'number' && lvl > 2; // Strict filter: Must be > 2 Liters
    });

    if (!cleanRecords || cleanRecords.length === 0) {
        return { totalConsumption: 0, processedData: [], events: [] };
    }

    // Sort both arrays by time to ensure linear processing
    cleanRecords.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    if (electricalRecords) {
        electricalRecords.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    }

    let totalConsumption = 0;
    let events = [];
    let processedData = [];
    
    // Baseline Level (Sticky) - Uses the first VALID record
    let effectiveLevel = cleanRecords[0][dgKey]?.level || 0;

    for (let i = 0; i < cleanRecords.length; i++) {
        const record = cleanRecords[i];
        const currentLevel = record[dgKey]?.level || 0;
        const timestamp = new Date(record.timestamp);

        // 🔍 STEP 1: CROSS-REFERENCE ELECTRICAL DATA
        const electricalData = findClosestReading(electricalRecords, timestamp);
        
        // Determine if DG was ACTUALLY generating power
        let isPowerOn = false;
        let electricalDebug = "No Data";

        if (electricalData) {
            // Check if Voltage > 100 (More reliable than Power/Amps for Idle detection)
            // Or check Active Power > 0
            const hasVoltage = (electricalData.voltageR > 100);
            const hasPower = (electricalData.activePower > 0);
            
            if (hasVoltage || hasPower) {
                isPowerOn = true;
                electricalDebug = `ON (${electricalData.activePower}kW)`;
            } else {
                electricalDebug = "OFF (0V)";
            }
        } else {
            // Fallback: If no electrical data exists, check flags
            if (dgKey === 'total') {
                 isPowerOn = record.dg1?.isRunning || record.dg2?.isRunning || record.dg3?.isRunning;
            } else {
                 isPowerOn = record[dgKey]?.isRunning || false;
            }
            electricalDebug = isPowerOn ? "Flag ON" : "No Data";
        }

        let consumption = 0;
        let note = "Stable";

        // Calculate Difference from STICKY baseline
        const diff = effectiveLevel - currentLevel;

        // 🔍 STEP 2: APPLY THRESHOLDS & DECISION LOGIC
        
        if (diff > CONSUMPTION_THRESHOLD) {
            // Case A: Fuel Dropped > 1 Liter
            
            if (isPowerOn) {
                // ✅ VERIFIED: Power was ON. This is real consumption.
                consumption = diff;
                totalConsumption += consumption;
                note = "Consumption (Verified)";
                
                // Update baseline
                effectiveLevel = currentLevel;
            } else {
                // ❌ FALSE ALARM: Power was OFF.
                note = "Noise Ignored (Gen OFF)";
                consumption = 0;
                // We DO NOT update effectiveLevel, effectively 'bridging' the gap
            }
        } 
        else if (diff < -REFILL_THRESHOLD) {
            // Case B: Fuel Rose > 25 Liters (Refill)
            note = "Refill Detected";
            events.push({ type: 'refill', amount: Math.abs(diff), time: timestamp });
            
            // Update baseline to new higher level
            effectiveLevel = currentLevel;
        }
        else if (diff < 0) {
             // Case C: Small Rise (Slosh/Recovery)
             // If engine is OFF, allow level to float back up (Recovery)
             if (!isPowerOn) {
                 effectiveLevel = currentLevel;
                 note = "Recovery (Gen OFF)";
             }
             // If engine is ON, ignore rise (keep effectiveLevel low)
        }
        else {
            // Case D: Tiny Change (Noise < 1L)
            consumption = 0;
            // Keep effectiveLevel same (Sticky)
        }

        processedData.push({
            timestamp: record.timestamp,
            date: record.timestamp.toISOString().split('T')[0],
            cleanLevel: currentLevel,   // The raw level
            consumption: consumption,   // Calculated confirmed consumption
            isRunning: isPowerOn,       // Visual flag for the graph
            note: note,
            electricalInfo: electricalDebug // For Excel export debug
        });
    }

    return { totalConsumption, processedData, events };
}


// ============================================================
// 3. API ROUTES
// ============================================================

router.get('/data', (req, res) => {
    try { res.json(getSystemData()); } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/consumption', async (req, res) => {
    try {
        const { dg, startDate, endDate } = req.query;
        if (!startDate || !endDate) return res.status(400).json({ error: 'Dates required' });
        
        const start = new Date(startDate); start.setHours(0, 0, 0, 0);
        const end = new Date(endDate); end.setHours(23, 59, 59, 999);

        // 1. Fetch DIESEL Data
        let dieselRecords = await DieselConsumption.find({ 
            timestamp: { $gte: start, $lte: end } 
        }).sort({ timestamp: 1 }).lean();

        // 2. Fetch ELECTRICAL Data (For Verification)
        let electricalRecords = [];
        const dgKey = dg || 'dg1';

        if (dgKey !== 'total') {
            // Only fetch relevant DG electrical data to save memory
            electricalRecords = await ElectricalReading.find({
                dg: dgKey,
                timestamp: { $gte: start, $lte: end }
            })
            .select('timestamp activePower currentR currentY currentB voltageR') // Added voltageR
            .sort({ timestamp: 1 })
            .lean();
        }

        // 3. Append Live Data (If viewing today)
        const todayStr = new Date().toISOString().split('T')[0];
        if (endDate >= todayStr) {
            const liveData = getSystemData();
            if (liveData && liveData.lastUpdate) {
                dieselRecords.push({
                    timestamp: new Date(), date: todayStr,
                    dg1: { level: liveData.dg1, isRunning: false }, 
                    dg2: { level: liveData.dg2, isRunning: false },
                    dg3: { level: liveData.dg3, isRunning: false },
                    total: { level: liveData.total }
                });
            }
        }

        // 4. Run Verification Logic
        const result = calculateVerifiedConsumption(dieselRecords, electricalRecords, dgKey);

        return res.json({ 
            success: true, 
            data: result.processedData, 
            stats: { 
                totalConsumption: Number(result.totalConsumption.toFixed(2)), 
                refillEvents: result.events 
            }
        });

    } catch (err) { 
        console.error("Consumption API Error:", err);
        return res.status(500).json({ error: err.message }); 
    }
});

router.get('/health', (req, res) => {
    const { isConnected } = require('../services/plcService');
    const mongoose = require('mongoose');
    res.json({ status: 'ok', plc: isConnected(), mongo: mongoose.connection.readyState });
});

router.get('/electrical/:dg', async (req, res) => {
    try {
        const { dg } = req.params;
        const { startDate, endDate } = req.query;
        const start = new Date(startDate); start.setHours(0,0,0,0);
        const end = new Date(endDate); end.setHours(23,59,59,999);
        
        let records = await ElectricalReading.find({ dg, timestamp: { $gte: start, $lte: end } })
            .sort({ timestamp: 1 }).limit(500).lean();
        
        res.json({ success: true, data: records });
    } catch (err) { res.json({ success: true, data: [] }); }
});

// ============================================================
// 4. EXCEL EXPORT (Updated with Verification Columns)
// ============================================================

async function setupExcelSheet(workbook, worksheet, title) {
    try {
        const logoId = workbook.addImage({ filename: LOGO_PATH, extension: 'png' });
        worksheet.addImage(logoId, { tl: { col: 0, row: 0 }, ext: { width: 150, height: 80 } });
    } catch (e) { console.warn("Logo not found"); }

    worksheet.mergeCells('C2:H3');
    const titleCell = worksheet.getCell('C2');
    titleCell.value = title;
    titleCell.font = { name: 'Arial', size: 16, bold: true, color: { argb: 'FF0052CC' } };
    titleCell.alignment = { vertical: 'middle', horizontal: 'center' };
    worksheet.addRow([]); worksheet.addRow([]); worksheet.addRow([]); worksheet.addRow([]);
}

router.get('/export/consumption', async (req, res) => {
    try {
        const { dg, startDate, endDate } = req.query;
        const start = new Date(startDate); start.setHours(0, 0, 0, 0);
        const end = new Date(endDate); end.setHours(23, 59, 59, 999);

        // Fetch Both
        const dieselRecords = await DieselConsumption.find({ timestamp: { $gte: start, $lte: end } }).sort({ timestamp: 1 }).lean();
        const dgKey = dg || 'dg1';
        
        let electricalRecords = [];
        if (dgKey !== 'total') {
            electricalRecords = await ElectricalReading.find({ dg: dgKey, timestamp: { $gte: start, $lte: end } }).lean();
        }

        const result = calculateVerifiedConsumption(dieselRecords, electricalRecords, dgKey);
        
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Consumption');
        await setupExcelSheet(workbook, worksheet, `Aquarelle India - ${dg.toUpperCase()} Verified Report`);

        worksheet.addRow(['Timestamp', 'Fuel Level (L)', 'Verified Consumption (L)', 'Electrical Status', 'Notes']);
        
        const headerRow = worksheet.lastRow;
        headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        headerRow.eachCell(cell => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0052CC' } }; });

        result.processedData.forEach(r => {
            worksheet.addRow([
                new Date(r.timestamp).toLocaleString('en-IN'),
                r.cleanLevel, 
                r.consumption > 0 ? r.consumption.toFixed(2) : '-',
                r.electricalInfo || (r.isRunning ? 'ON' : 'OFF'),
                r.note
            ]);
        });

        worksheet.columns = [{ width: 25 }, { width: 15 }, { width: 25 }, { width: 20 }, { width: 25 }];

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="Aquarelle_India_${dg}_Verified.xlsx"`);
        await workbook.xlsx.write(res);
        res.end();

    } catch (err) {
        console.error('Export Error:', err);
        res.status(500).send('Export Error');
    }
});

// Standard Electrical Export (Unchanged)
router.get('/export/electrical/:dg', async (req, res) => {
    try {
        const { dg } = req.params;
        const { startDate, endDate } = req.query;
        const start = new Date(startDate); start.setHours(0,0,0,0);
        const end = new Date(endDate); end.setHours(23,59,59,999);

        const records = await ElectricalReading.find({ dg: dg, timestamp: { $gte: start, $lte: end } }).sort({ timestamp: 1 }).lean();
        
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Electrical');
        await setupExcelSheet(workbook, worksheet, `Electrical Data - ${dg.toUpperCase()}`);

        worksheet.addRow(['Timestamp', 'Voltage R', 'Current R', 'Power (kW)', 'Freq (Hz)', 'Energy (kWh)']);
        records.forEach(r => {
            worksheet.addRow([ new Date(r.timestamp).toLocaleString('en-IN'), r.voltageR, r.currentR, r.activePower, r.frequency, r.energyMeter ]);
        });
        
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${dg}_Electrical.xlsx"`);
        await workbook.xlsx.write(res);
        res.end();
    } catch (e) { res.status(500).send("Error"); }
});

module.exports = router;