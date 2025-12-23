/**
 * API Routes - SYNCED VERSION
 * KEY FIX: Accumulator Logic for Instant & Accurate Consumption
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const ExcelJS = require('exceljs'); 
const { getSystemData } = require('../services/plcService');
const { DieselConsumption, ElectricalReading } = require('../models/schemas');

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

// ============================================================
// ✅ FIXED: ACCUMULATOR LOGIC (Captures Slow Drains & Fast Drops)
// ============================================================
function calculateSmartConsumption(records, dgKey) {
    if (!records || records.length === 0) return { totalConsumption: 0, processedData: [], events: [] };

    // 1. Sort by time
    records.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    let totalConsumption = 0;
    let events = [];
    let processedData = [];
    
    // Config
    const CONSUMPTION_THRESHOLD = 0.20; // Count any accumulated drop > 0.20 Liters
    const REFILL_THRESHOLD = 5.0;       // Detect refills > 5 Liters

    // 'effectiveLevel' is our baseline. We ONLY update it when we confirm a drop or refill.
    // This allows us to track slow drains (e.g., 0.05L -> 0.10L -> 0.25L).
    let effectiveLevel = records[0][dgKey]?.level || 0;

    for (let i = 0; i < records.length; i++) {
        const record = records[i];
        const currentLevel = record[dgKey]?.level || 0;
        const timestamp = new Date(record.timestamp);

        // Check Electrical (Visual only - does not stop calculation)
        let isElectricalRunning = false;
        if (dgKey === 'total') {
            isElectricalRunning = (record.dg1?.isRunning || record.dg2?.isRunning || record.dg3?.isRunning);
        } else {
            isElectricalRunning = record[dgKey]?.isRunning || false;
        }

        let consumption = 0;
        let note = "Stable";

        // Compare current level against our STICKY baseline (effectiveLevel)
        const diff = effectiveLevel - currentLevel;

        if (diff > CONSUMPTION_THRESHOLD) {
            // ✅ CASE 1: ACCUMULATED DROP DETECTED
            // We have dropped enough from the last baseline to count it.
            consumption = diff;
            totalConsumption += consumption;
            
            note = isElectricalRunning ? "Consumption (Verified)" : "Consumption (Fuel Drop)";
            
            // Sync baseline to the new lower level
            effectiveLevel = currentLevel;
        } 
        else if (diff < -REFILL_THRESHOLD) {
            // ✅ CASE 2: REFILL DETECTED
            // The level went UP significantly.
            note = "Refill Detected";
            events.push({ type: 'refill', amount: Math.abs(diff), time: timestamp });
            
            // Sync baseline to the new higher level
            effectiveLevel = currentLevel;
        }
        else {
            // ✅ CASE 3: TINY CHANGE (NOISE)
            // The change is too small (e.g., 0.05L). 
            // CRITICAL: We do NOT update 'effectiveLevel' here.
            // We keep the old baseline so the next tiny drop adds to this one.
            consumption = 0;
        }

        processedData.push({
            timestamp: record.timestamp,
            date: record.timestamp.toISOString().split('T')[0],
            cleanLevel: currentLevel,
            consumption: consumption,
            isRunning: consumption > 0, // Force "Running" bars if we have consumption
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

        const dgKey = dg || 'dg1';
        const result = calculateSmartConsumption(records, dgKey);
        
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Consumption');

        await setupExcelSheet(workbook, worksheet, `Aquarelle India - ${dg.toUpperCase()} Consumption`);

        worksheet.addRow(['Timestamp', 'Stable Level (L)', 'Raw Level (L)', 'Consumption (L)', 'Running', 'Notes']);
        
        const headerRow = worksheet.lastRow;
        headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        headerRow.eachCell(cell => {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0052CC' } };
        });

        result.processedData.forEach(r => {
            worksheet.addRow([
                new Date(r.timestamp).toLocaleString('en-IN'),
                r.cleanLevel, 
                r.cleanLevel, // Using cleanLevel as raw since we aren't storing raw separately here
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
        const start = new Date(startDate); start.setHours(0, 0, 0, 0);
        const end = new Date(endDate); end.setHours(23, 59, 59, 999);

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

        const records = await DieselConsumption.find({ 
            timestamp: { $gte: start, $lte: end } 
        }).sort({ timestamp: 1 }).lean();

        const r1 = calculateSmartConsumption(records, 'dg1');
        const r2 = calculateSmartConsumption(records, 'dg2');
        const r3 = calculateSmartConsumption(records, 'dg3');

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Total Report');
        await setupExcelSheet(workbook, worksheet, `Aquarelle India - Complete DG Report`);

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

        for (let i = 0; i < records.length; i++) {
            const d1 = r1.processedData[i];
            const d2 = r2.processedData[i];
            const d3 = r3.processedData[i];

            if (!d1 || !d2 || !d3) continue;

            const getRefillAmt = (events, time) => {
                const evt = events.find(e => e.time === time);
                return evt ? evt.amount : 0;
            };

            const refill1 = getRefillAmt(r1.events, d1.timestamp);
            const refill2 = getRefillAmt(r2.events, d2.timestamp);
            const refill3 = getRefillAmt(r3.events, d3.timestamp);

            const totalLevel = d1.cleanLevel + d2.cleanLevel + d3.cleanLevel;
            const totalUsed = d1.consumption + d2.consumption + d3.consumption;

            worksheet.addRow([
                new Date(d1.timestamp).toLocaleString('en-IN'),
                d1.cleanLevel, 
                d1.consumption > 0 ? d1.consumption.toFixed(1) : '-', 
                refill1 > 0 ? refill1.toFixed(1) : '-',
                d2.cleanLevel, 
                d2.consumption > 0 ? d2.consumption.toFixed(1) : '-', 
                refill2 > 0 ? refill2.toFixed(1) : '-',
                d3.cleanLevel, 
                d3.consumption > 0 ? d3.consumption.toFixed(1) : '-', 
                refill3 > 0 ? refill3.toFixed(1) : '-',
                totalLevel.toFixed(1),
                totalUsed > 0 ? totalUsed.toFixed(1) : '-'
            ]);
        }

        worksheet.columns.forEach(col => col.width = 12);
        worksheet.getColumn(1).width = 25;

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