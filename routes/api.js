/**
 * API Routes - SYNCED VERSION
 * KEY FIX: Merges Historical DB Data + Live PLC Data
 * Result: Graph "End Level" matches Dashboard "Current Level" perfectly.
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const ExcelJS = require('exceljs'); 
const { getSystemData } = require('../services/plcService');
const { DieselConsumption, ElectricalReading } = require('../models/schemas');

// --- SMART LOGIC CONFIGURATION ---
const REFILL_THRESHOLD = 25;       // Liters: Only increase > 25L is a refill
const NOISE_THRESHOLD = 2;         // Liters: Ignore changes smaller than this
const STABILITY_WINDOW_MINS = 45;  // Minutes: Level must stay low this long to count
const SMA_WINDOW = 3;              // Points: Moving Average window for smoothing

const LOGO_PATH = path.join(__dirname, '../public/logo.png');

async function setupExcelSheet(workbook, worksheet, title) {
    try {
        const logoId = workbook.addImage({
            filename: LOGO_PATH,
            extension: 'png',
        });
        worksheet.addImage(logoId, {
            tl: { col: 0, row: 0 },
            ext: { width: 150, height: 80 }
        });
    } catch (e) {
        console.warn("Logo not found, skipping image.");
    }

    worksheet.mergeCells('C2:H3');
    const titleCell = worksheet.getCell('C2');
    titleCell.value = title;
    titleCell.font = { name: 'Arial', size: 16, bold: true, color: { argb: 'FF0052CC' } };
    titleCell.alignment = { vertical: 'middle', horizontal: 'center' };

    worksheet.addRow([]);
    worksheet.addRow([]);
    worksheet.addRow([]);
    worksheet.addRow([]);
}

function smoothData(records, dgKey, windowSize) {
    if (records.length === 0) return [];
    
    return records.map((record, index) => {
        // Calculate SMA
        let sum = 0;
        let count = 0;
        for (let i = Math.max(0, index - windowSize + 1); i <= index; i++) {
            let val = (dgKey === 'total') ? (records[i].total?.level || 0) : (records[i][dgKey]?.level || 0);
            sum += val;
            count++;
        }
        
        return {
            ...record,
            timestamp: new Date(record.timestamp).getTime(),
            originalTimestamp: record.timestamp,
            level: Number((sum / count).toFixed(2)) // Smoothed Level
        };
    });
}

/**
 * 2. CORE LOGIC: State Machine with "Running Override"
 */
function calculateSmartConsumption(rawRecords, dgKey) {
    // Step 1: Smooth the raw data
    const data = smoothData(rawRecords, dgKey, SMA_WINDOW);
    if (data.length === 0) return { totalConsumption: 0, events: [], processedData: [] };

    let processedData = [];
    let events = [];
    let totalConsumption = 0;

    // Initialize Baseline
    let baseline = data[0].level;

    for (let i = 0; i < data.length; i++) {
        const current = data[i];
        const diff = current.level - baseline;
        
        // CHECK IF DG IS RUNNING (Electrical Data)
        // If total, we can't easily know which one is running, so we default to false
        const isRunning = (dgKey === 'total') ? false : (current[dgKey]?.isRunning || false);

        let isConsumption = false;
        let note = '';

        // --- CASE 1: REFILL DETECTION ---
        if (diff >= REFILL_THRESHOLD) {
            events.push({ type: 'REFILL', amount: diff, time: current.originalTimestamp });
            baseline = current.level; 
            note = 'Refill';
        }
        
        // --- CASE 2: DG IS RUNNING (OVERRIDE RULE) ---
        // If DG is ON, we trust ANY drop, even if it's small (e.g. 1 Liter)
        // We do NOT check for stability/recovery here. If it's running, fuel IS burning.
        else if (isRunning && diff < 0) {
            const consumed = baseline - current.level;
            totalConsumption += consumed;
            baseline = current.level; // Immediate Lock-in
            isConsumption = true;
            note = 'Running Consumption';
        }

        // --- CASE 3: STANDARD DROP DETECTION (DG OFF) ---
        // If DG is OFF, we use the strict Stability Window to avoid noise
        else if (diff < -NOISE_THRESHOLD) {
            let isPermanent = true;
            
            // Look ahead to see if it bounces back (Sloshing/Temperature)
            for (let j = i + 1; j < data.length; j++) {
                const future = data[j];
                const timeDiffMins = (future.timestamp - current.timestamp) / (1000 * 60);
                if (timeDiffMins > STABILITY_WINDOW_MINS) break; 

                if (future.level >= (baseline - NOISE_THRESHOLD)) {
                    isPermanent = false; // It recovered -> It was noise
                    break;
                }
            }

            if (isPermanent) {
                totalConsumption += (baseline - current.level);
                baseline = current.level; 
                isConsumption = true;
                note = 'Passive Consumption'; // Leak or theft
            } else {
                note = 'Ignored (Dip)';
            }
        }

        // --- CASE 4: NOISE / EXPANSION ---
        else {
            // If level goes UP slightly (e.g. 129 -> 130) but less than refill threshold,
            // we IGNORE it. This handles the "Return to 130" scenario.
            // The Baseline stays at 129.
        }

        processedData.push({
            timestamp: current.originalTimestamp,
            date: current.date,
            cleanLevel: Number(baseline.toFixed(2)), 
            rawLevel: current.level, 
            consumption: isConsumption ? (baseline - current.level) : 0,
            isRunning: isRunning,
            note: note
        });
    }

    return { totalConsumption, events, processedData };
}

// =================================================================
// 📡 DATA API ROUTES
// =================================================================

router.get('/data', (req, res) => {
    try {
        res.json(getSystemData());
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/consumption', async (req, res) => {
    try {
        const { dg, startDate, endDate } = req.query;
        
        if (!startDate || !endDate) return res.status(400).json({ success: false, error: 'Dates required' });
        
        const start = new Date(startDate); start.setHours(0, 0, 0, 0);
        const end = new Date(endDate); end.setHours(23, 59, 59, 999);

        // Fetch Data
        let records = await DieselConsumption.find({
            timestamp: { $gte: start, $lte: end }
        }).sort({ timestamp: 1 }).lean();

        // Append Live Data if today
        const todayStr = new Date().toISOString().split('T')[0];
        if (endDate >= todayStr) {
            const liveData = getSystemData();
            if (liveData && liveData.lastUpdate) {
                records.push({
                    timestamp: new Date(),
                    date: todayStr,
                    dg1: { level: liveData.dg1, isRunning: false },
                    dg2: { level: liveData.dg2, isRunning: false },
                    dg3: { level: liveData.dg3, isRunning: false },
                    total: { level: liveData.total }
                });
            }
        }

        // CALCULATE SMART LOGIC
        const dgKey = dg || 'dg1';
        const result = calculateSmartConsumption(records, dgKey);

        return res.json({ 
            success: true, 
            data: result.processedData, 
            stats: {
                totalConsumption: Number(result.totalConsumption.toFixed(2)),
                refillEvents: result.events
            }
        });

    } catch (err) {
        console.error('❌ Consumption API Error:', err.message);
        return res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/health', (req, res) => {
    const { isConnected } = require('../services/plcService');
    const mongoose = require('mongoose');
    
    const health = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        services: {
            mongodb: {
                status: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
                readyState: mongoose.connection.readyState,
                // 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting
                host: mongoose.connection.host || 'unknown'
            },
            plc: {
                status: isConnected() ? 'connected' : 'disconnected'
            }
        },
        uptime: {
            seconds: process.uptime(),
            formatted: formatUptime(process.uptime())
        },
        memory: {
            used: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`,
            total: `${Math.round(process.memoryUsage().heapTotal / 1024 / 1024)}MB`
        }
    };
    
    // Set HTTP status based on critical services
    const httpStatus = (health.services.mongodb.status === 'connected' && 
                       health.services.plc.status === 'connected') ? 200 : 503;
    
    res.status(httpStatus).json(health);
});

function formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${days}d ${hours}h ${minutes}m`;
}

// ✅ FIXED: Electrical endpoint (Robust error handling)
router.get('/electrical/:dg', async (req, res) => {
    try {
        const { dg } = req.params;
        const { startDate, endDate } = req.query;

        if (!['dg1', 'dg2', 'dg3', 'dg4'].includes(dg)) {
            return res.status(400).json({ success: false, error: 'Invalid DG' });
        }

        const start = new Date(startDate);
        start.setHours(0, 0, 0, 0);
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);

        let records = await ElectricalReading.find({
            dg: dg,
            timestamp: { $gte: start, $lte: end }
        })
        .sort({ timestamp: 1 })
        .limit(200)
        .lean()
        .maxTimeMS(8000);

        // Fallback: Check yesterday if today is empty
        const today = new Date().toISOString().split('T')[0];
        if (records.length === 0 && startDate === today && endDate === today) {
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            yesterday.setHours(0, 0, 0, 0);
            const yesterdayEnd = new Date(yesterday);
            yesterdayEnd.setHours(23, 59, 59, 999);

            const yesterdayRecords = await ElectricalReading.find({
                dg: dg,
                timestamp: { $gte: yesterday, $lte: yesterdayEnd }
            })
            .sort({ timestamp: -1 })
            .limit(1)
            .lean();

            if (yesterdayRecords.length > 0) records = yesterdayRecords;
        }

        return res.json({ success: true, data: records });

    } catch (err) {
        console.error(`❌ Electrical API Error [${req.params.dg}]:`, err.message);
        return res.json({ success: true, data: [], warning: 'Database error' });
    }
});

router.get('/export/consumption', async (req, res) => {
    try {
        const { dg, startDate, endDate } = req.query;
        const start = new Date(startDate); start.setHours(0, 0, 0, 0);
        const end = new Date(endDate); end.setHours(23, 59, 59, 999);

        const records = await DieselConsumption.find({ 
            timestamp: { $gte: start, $lte: end } 
        }).sort({ timestamp: 1 }).lean();

        // Use the SAME Smart Logic for Excel so numbers match
        const dgKey = dg || 'dg1';
        const result = calculateSmartConsumption(records, dgKey);
        
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Consumption');

        await setupExcelSheet(workbook, worksheet, `Aquarelle India - ${dg.toUpperCase()} Consumption`);

        // Added 'Stable Level' column to see the difference
        worksheet.addRow(['Timestamp', 'Stable Level (L)', 'Raw Level (L)', 'Consumption (L)', 'Running', 'Notes']);
        
        const headerRow = worksheet.lastRow;
        headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        headerRow.eachCell(cell => {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0052CC' } };
        });

        result.processedData.forEach(r => {
            worksheet.addRow([
                new Date(r.timestamp).toLocaleString('en-IN'),
                r.cleanLevel,   // The Smart Stable Level
                r.rawLevel,     // The Noisy Raw Level (for reference)
                r.consumption > 0 ? r.consumption.toFixed(2) : '-',
                r.isRunning ? 'Yes' : 'No',
                r.note
            ]);
        });

        worksheet.columns = [{ width: 25 }, { width: 15 }, { width: 15 }, { width: 15 }, { width: 10 }, { width: 20 }];

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="Aquarelle_India_${dg}_Consumption.xlsx"`);
        await workbook.xlsx.write(res);
        res.end();

    } catch (err) {
        console.error('Export Error:', err);
        res.status(500).send('Export Error');
    }
});

router.get('/export/electrical/:dg', async (req, res) => {
    try {
        const { dg } = req.params;
        const { startDate, endDate } = req.query;
        const start = new Date(startDate);
        start.setHours(0, 0, 0, 0);
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);

        const records = await ElectricalReading.find({
            dg: dg, timestamp: { $gte: start, $lte: end }
        }).sort({ timestamp: 1 }).lean();

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Electrical');

        await setupExcelSheet(workbook, worksheet, `Aquarelle India - ${dg.toUpperCase()} Electrical Details`);

        worksheet.addRow(['Timestamp', 'Volt R', 'Volt Y', 'Volt B', 'Amp R', 'Amp Y', 'Amp B', 'Freq', 'PF', 'kW', 'kVAR', 'kWh', 'Run Hrs']);
        
        const headerRow = worksheet.lastRow;
        headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        headerRow.eachCell(cell => cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF00875A' } });

        records.forEach(r => {
            worksheet.addRow([
                new Date(r.timestamp).toLocaleString('en-IN'),
                r.voltageR, r.voltageY, r.voltageB,
                r.currentR, r.currentY, r.currentB,
                r.frequency, r.powerFactor, r.activePower, 
                r.reactivePower, r.energyMeter, r.runningHours
            ]);
        });

        worksheet.columns.forEach(column => { column.width = 12; });
        worksheet.getColumn(1).width = 25;

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="Aquarelle_India_${dg}_Electrical.xlsx"`);
        await workbook.xlsx.write(res);
        res.end();

    } catch (err) {
        console.error('Export Error:', err);
        res.status(500).send('Export Error');
    }
});

router.get('/export/all', async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        const start = new Date(startDate); start.setHours(0, 0, 0, 0);
        const end = new Date(endDate); end.setHours(23, 59, 59, 999);

        // 1. Fetch Raw Data
        const records = await DieselConsumption.find({ 
            timestamp: { $gte: start, $lte: end } 
        }).sort({ timestamp: 1 }).lean();

        // 2. Run Smart Logic for EACH DG separately
        // This ensures each tank gets its own noise filtering and stability check
        const r1 = calculateSmartConsumption(records, 'dg1');
        const r2 = calculateSmartConsumption(records, 'dg2');
        const r3 = calculateSmartConsumption(records, 'dg3');

        // 3. Setup Excel
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Total Report');
        await setupExcelSheet(workbook, worksheet, `Aquarelle India - Complete DG Report`);

        // Header
        worksheet.addRow([
            'Timestamp', 
            'DG1 Level', 'DG1 Used', 'DG1 Refill', 
            'DG2 Level', 'DG2 Used', 'DG2 Refill', 
            'DG3 Level', 'DG3 Used', 'DG3 Refill', 
            'Total Level', 'Total Used'
        ]);
        
        const headerRow = worksheet.lastRow;
        headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        headerRow.eachCell(cell => cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDE350B' } });

        // 4. Merge Data & Build Rows
        // Since all 3 results come from the same 'records' array, they have the same length and order.
        for (let i = 0; i < records.length; i++) {
            const d1 = r1.processedData[i];
            const d2 = r2.processedData[i];
            const d3 = r3.processedData[i];

            if (!d1 || !d2 || !d3) continue; // Safety skip

            // Helper to check if a refill happened at this specific timestamp
            // We look into the 'events' array returned by the smart logic
            const getRefillAmt = (events, time) => {
                const evt = events.find(e => e.time === time);
                return evt ? evt.amount : 0;
            };

            const refill1 = getRefillAmt(r1.events, d1.timestamp);
            const refill2 = getRefillAmt(r2.events, d2.timestamp);
            const refill3 = getRefillAmt(r3.events, d3.timestamp);

            // Calculate Totals based on Clean (Smart) Data
            const totalLevel = d1.cleanLevel + d2.cleanLevel + d3.cleanLevel;
            const totalUsed = d1.consumption + d2.consumption + d3.consumption;

            worksheet.addRow([
                new Date(d1.timestamp).toLocaleString('en-IN'),
                
                // DG1
                d1.cleanLevel, 
                d1.consumption > 0 ? d1.consumption.toFixed(1) : '-', 
                refill1 > 0 ? refill1.toFixed(1) : '-',

                // DG2
                d2.cleanLevel, 
                d2.consumption > 0 ? d2.consumption.toFixed(1) : '-', 
                refill2 > 0 ? refill2.toFixed(1) : '-',

                // DG3
                d3.cleanLevel, 
                d3.consumption > 0 ? d3.consumption.toFixed(1) : '-', 
                refill3 > 0 ? refill3.toFixed(1) : '-',

                // Totals
                totalLevel.toFixed(1),
                totalUsed > 0 ? totalUsed.toFixed(1) : '-'
            ]);
        }

        // Styling widths
        worksheet.columns.forEach(col => col.width = 12);
        worksheet.getColumn(1).width = 25; // Timestamp column wider

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="Aquarelle_India_All_Data_Smart.xlsx"`);
        await workbook.xlsx.write(res);
        res.end();

    } catch (err) {
        console.error('Export All Error:', err);
        res.status(500).send('Export Error');
    }
});

module.exports = router;