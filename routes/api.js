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

// ============================================================
// ✅ FIXED: SMART LOGIC WITH 10-MINUTE WAIT PERIOD
// ============================================================
function calculateSmartConsumption(records, dgKey) {
    if (!records || records.length === 0) return { totalConsumption: 0, processedData: [], events: [] };

    records.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    let totalConsumption = 0;
    let events = [];
    let processedData = [];
    
    // Config
    const NOISE_THRESHOLD = 0.5; // Liters
    // ✅ CHANGED: Wait only 10 minutes instead of 2 hours
    const WAIT_PERIOD_MS = 10 * 60 * 1000; 

    let previousLevel = records[0][dgKey]?.level || 0;
    let pendingDrop = null; 

    for (let i = 0; i < records.length; i++) {
        const record = records[i];
        const currentLevel = record[dgKey]?.level || 0;
        const timestamp = new Date(record.timestamp);

        // Check Electrical Status
        let isElectricalRunning = false;
        if (dgKey === 'total') {
            isElectricalRunning = (record.dg1?.isRunning || record.dg2?.isRunning || record.dg3?.isRunning);
        } else {
            isElectricalRunning = record[dgKey]?.isRunning || false;
        }

        let consumption = 0;
        let note = "";

        const diff = previousLevel - currentLevel;

        // ====================================================
        // CONCEPT 1: Electrical ON + Drop = ACTUAL CONSUMPTION
        // ====================================================
        if (isElectricalRunning && diff > 0) {
            consumption = diff;
            totalConsumption += consumption;
            note = "Consumption (Verified)";
            pendingDrop = null; 
            previousLevel = currentLevel;
        }

        // ====================================================
        // CONCEPT 2: Electrical OFF + Drop = WAIT 10 MINS
        // ====================================================
        else if (!isElectricalRunning && diff > NOISE_THRESHOLD) {
            if (!pendingDrop) {
                // START WAITING
                pendingDrop = {
                    startTime: timestamp.getTime(),
                    startLevel: previousLevel,
                    lowestLevel: currentLevel
                };
                note = "Suspicious Drop (Waiting 10m)";
                consumption = 0; 
            } else {
                // ALREADY WAITING
                const timeElapsed = timestamp.getTime() - pendingDrop.startTime;
                
                if (currentLevel < pendingDrop.lowestLevel) pendingDrop.lowestLevel = currentLevel;

                if (timeElapsed < WAIT_PERIOD_MS) {
                    // Check recovery
                    if (currentLevel >= pendingDrop.startLevel - NOISE_THRESHOLD) {
                        note = "Noise Resolved (Restored)";
                        pendingDrop = null; 
                        previousLevel = currentLevel; 
                    } else {
                        note = `Waiting... (${(timeElapsed/60000).toFixed(0)}m)`;
                    }
                    consumption = 0;
                } else {
                    // 10 MINUTES PASSED!
                    // It didn't recover. Count it as 'Unverified Loss' (or Consumption if you prefer)
                    // Currently set to: IGNORE (Set consumption = 0) based on your request "don't calculate"
                    // If you want to COUNT it after 10 mins, change consumption = (pendingDrop.startLevel - currentLevel);
                    
                    note = "Unverified Loss (Ignored)";
                    consumption = 0; 
                    pendingDrop = null; 
                    previousLevel = currentLevel; 
                }
            }
        } 
        
        // ====================================================
        // HANDLING REFILLS / LEVEL INCREASES
        // ====================================================
        else if (diff < 0) {
            if (pendingDrop) {
                if (currentLevel >= pendingDrop.startLevel - NOISE_THRESHOLD) {
                    note = "Noise Resolved (Restored)";
                    pendingDrop = null;
                }
            } else {
                if (Math.abs(diff) > 10) { 
                    events.push({ type: 'refill', amount: Math.abs(diff), time: timestamp });
                }
                note = "Refill / Increase";
            }
            consumption = 0;
            previousLevel = currentLevel;
        }
        else {
            consumption = 0;
            if (!pendingDrop) previousLevel = currentLevel;
        }

        processedData.push({
            timestamp: record.timestamp,
            date: record.timestamp.toISOString().split('T')[0],
            cleanLevel: currentLevel,
            consumption: consumption,
            isRunning: isElectricalRunning,
            note: note,
            dgKey: dgKey 
        });
    }

    return { totalConsumption, processedData, events };
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