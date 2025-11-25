/**
 * API Routes - ANTI-CRASH VERSION
 * Fixes 502 Errors by enforcing strict timeouts and connection checks.
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const ExcelJS = require('exceljs'); 
const mongoose = require('mongoose'); // Needed for connection check
const { getSystemData } = require('../services/plcService');
const { DieselConsumption, ElectricalReading } = require('../models/schemas');

// ✅ CONFIGURATION
const REFILL_THRESHOLD = 20;
const NOISE_THRESHOLD = 0.5;
const LOGO_PATH = path.join(__dirname, '../public/logo.png');
const DB_TIMEOUT = 2000; // 2 Seconds Max wait time (Prevents 502)

// ✅ IN-MEMORY CACHE (Reduces DB Load)
const electricalCache = {
  dg1: { data: [], timestamp: 0 },
  dg2: { data: [], timestamp: 0 },
  dg3: { data: [], timestamp: 0 },
  dg4: { data: [], timestamp: 0 }
};

// Helper: Setup Excel Header
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
        console.warn("Logo not found, skipping.");
    }
    worksheet.mergeCells('C2:H3');
    const titleCell = worksheet.getCell('C2');
    titleCell.value = title;
    titleCell.font = { name: 'Arial', size: 16, bold: true, color: { argb: 'FF0052CC' } };
    titleCell.alignment = { vertical: 'middle', horizontal: 'center' };
    worksheet.addRow([]); worksheet.addRow([]); worksheet.addRow([]); worksheet.addRow([]);
}

// =================================================================
// 📡 ROBUST DATA API ROUTES
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
        // 1. Fast Fail: Check DB Connection
        if (mongoose.connection.readyState !== 1) {
            console.warn("DB Not Connected. Returning empty.");
            return res.json({ success: true, data: [] });
        }

        const { startDate, endDate } = req.query;
        if (!startDate || !endDate) return res.status(400).json({ success: false, error: 'Dates required' });

        const start = new Date(startDate); start.setHours(0, 0, 0, 0);
        const end = new Date(endDate); end.setHours(23, 59, 59, 999);

        // 2. Optimized Query with Timeout
        const records = await DieselConsumption.find({ timestamp: { $gte: start, $lte: end } })
            .sort({ timestamp: 1 })
            .limit(1000) // Safety limit
            .lean()      // Faster
            .maxTimeMS(DB_TIMEOUT); // STOP if taking too long

        // Live Data fallback logic
        if (records.length === 0 && startDate === endDate && startDate === new Date().toISOString().split('T')[0]) {
            return res.json({ success: true, data: [], liveData: getSystemData() });
        }
        
        res.json({ success: true, data: records });

    } catch (err) {
        console.error('Consumption Error:', err.message);
        // Return empty array instead of 500 error to keep UI alive
        res.json({ success: false, data: [], error: 'Database busy' });
    }
});

// ✅ THE PROBLEM SOLVER: ELECTRICAL ROUTE
router.get('/electrical/:dg', async (req, res) => {
    const { dg } = req.params;
    try {
        // 1. Fast Fail: Check DB Connection
        if (mongoose.connection.readyState !== 1) {
            return res.json({ success: true, data: [] }); // Return empty, don't hang
        }

        const { startDate, endDate } = req.query;
        const start = new Date(startDate); start.setHours(0, 0, 0, 0);
        const end = new Date(endDate); end.setHours(23, 59, 59, 999);
        
        const isToday = startDate === new Date().toISOString().split('T')[0];

        // 2. Serve from Cache if Today (Anti-Spam)
        if (isToday && electricalCache[dg].data.length > 0 && (Date.now() - electricalCache[dg].timestamp < 60000)) {
            return res.json({ success: true, data: electricalCache[dg].data, cached: true });
        }

        // 3. Execute Query with STRICT Timeout
        let records = await ElectricalReading.find({
            dg: dg, 
            timestamp: { $gte: start, $lte: end }, 
            activePower: { $gt: 5 }
        })
        .sort({ timestamp: 1 })
        .limit(500) // Never fetch more than 500 points for a graph
        .lean()
        .maxTimeMS(DB_TIMEOUT); // ✅ KEY FIX: Fail fast (2s) if DB is slow

        // Update Cache
        if (isToday && records.length > 0) {
            electricalCache[dg] = { data: records, timestamp: Date.now() };
        }
        
        res.json({ success: true, data: records });

    } catch (err) {
        console.error(`Electrical Error [${dg}]:`, err.message);
        
        // ✅ FALLBACK: If DB fails, return Cache (even if old) or Empty
        // This prevents the 502 page from showing up.
        const cached = electricalCache[dg]?.data || [];
        res.json({ success: true, data: cached, warning: "Data retrieved from cache due to DB timeout" });
    }
});

// =================================================================
// 📥 EXCEL EXPORT ROUTES
// =================================================================

router.get('/export/consumption', async (req, res) => {
    try {
        const { dg, startDate, endDate } = req.query;
        const start = new Date(startDate); start.setHours(0, 0, 0, 0);
        const end = new Date(endDate); end.setHours(23, 59, 59, 999);

        const records = await DieselConsumption.find({ timestamp: { $gte: start, $lte: end } }).sort({ timestamp: 1 }).lean();

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Consumption');
        await setupExcelSheet(workbook, worksheet, `Aquarelle India - ${dg.toUpperCase()} Consumption`);

        worksheet.addRow(['Timestamp', 'Level (L)', 'Consumed (L)', 'Refilled (L)', 'Running', 'Notes']);
        worksheet.lastRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        worksheet.lastRow.eachCell(cell => cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0052CC' } });

        let previousLevel = null;
        records.forEach(record => {
            const currentLevel = record[dg]?.level || 0;
            let consumption = 0; let refilled = 0; let notes = '';

            if (previousLevel !== null) {
                const diff = currentLevel - previousLevel;
                if (diff > REFILL_THRESHOLD) { refilled = diff; notes = 'REFILL'; }
                else if (diff < -NOISE_THRESHOLD) { consumption = Math.abs(diff); }
            }
            worksheet.addRow([
                new Date(record.timestamp).toLocaleString('en-IN'),
                currentLevel.toFixed(2),
                consumption > 0 ? consumption.toFixed(2) : '-',
                refilled > 0 ? refilled.toFixed(2) : '-',
                record[dg]?.isRunning ? 'Yes' : 'No',
                notes
            ]);
            previousLevel = currentLevel;
        });

        worksheet.columns = [{ width: 25 }, { width: 15 }, { width: 15 }, { width: 15 }, { width: 10 }, { width: 20 }];
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="Aquarelle_India_${dg}_Consumption.xlsx"`);
        await workbook.xlsx.write(res);
        res.end();
    } catch (err) { res.status(500).send('Export Error'); }
});

router.get('/export/electrical/:dg', async (req, res) => {
    try {
        const { dg } = req.params;
        const { startDate, endDate } = req.query;
        const start = new Date(startDate); start.setHours(0, 0, 0, 0);
        const end = new Date(endDate); end.setHours(23, 59, 59, 999);

        const records = await ElectricalReading.find({ dg: dg, timestamp: { $gte: start, $lte: end } }).sort({ timestamp: 1 }).lean();

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Electrical');
        await setupExcelSheet(workbook, worksheet, `Aquarelle India - ${dg.toUpperCase()} Electrical Details`);

        worksheet.addRow(['Timestamp', 'Volt R', 'Volt Y', 'Volt B', 'Amp R', 'Amp Y', 'Amp B', 'Freq', 'PF', 'kW', 'kVAR', 'kWh', 'Run Hrs']);
        worksheet.lastRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        worksheet.lastRow.eachCell(cell => cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF00875A' } });

        records.forEach(r => {
            worksheet.addRow([
                new Date(r.timestamp).toLocaleString('en-IN'),
                r.voltageR, r.voltageY, r.voltageB, r.currentR, r.currentY, r.currentB,
                r.frequency, r.powerFactor, r.activePower, r.reactivePower, r.energyMeter, r.runningHours
            ]);
        });

        worksheet.columns.forEach(col => col.width = 12); worksheet.getColumn(1).width = 25;
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="Aquarelle_India_${dg}_Electrical.xlsx"`);
        await workbook.xlsx.write(res);
        res.end();
    } catch (err) { res.status(500).send('Export Error'); }
});

router.get('/export/all', async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        const start = new Date(startDate); start.setHours(0, 0, 0, 0);
        const end = new Date(endDate); end.setHours(23, 59, 59, 999);

        const records = await DieselConsumption.find({ timestamp: { $gte: start, $lte: end } }).sort({ timestamp: 1 }).lean();

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Total Report');
        await setupExcelSheet(workbook, worksheet, `Aquarelle India - Complete DG Report`);

        worksheet.addRow(['Timestamp', 'DG1 Lvl', 'DG1 Used', 'DG1 Refill', 'DG2 Lvl', 'DG2 Used', 'DG2 Refill', 'DG3 Lvl', 'DG3 Used', 'DG3 Refill', 'Total Lvl', 'Total Used']);
        worksheet.lastRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        worksheet.lastRow.eachCell(cell => cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDE350B' } });

        let previousLevels = { dg1: null, dg2: null, dg3: null };
        records.forEach(record => {
            let rowData = [new Date(record.timestamp).toLocaleString('en-IN')];
            let totalConsumption = 0;
            ['dg1', 'dg2', 'dg3'].forEach(dg => {
                const current = record[dg]?.level || 0;
                let consumption = 0; let refilled = 0;
                if (previousLevels[dg] !== null) {
                    const diff = current - previousLevels[dg];
                    if (diff > REFILL_THRESHOLD) refilled = diff;
                    else if (diff < -NOISE_THRESHOLD) { consumption = Math.abs(diff); totalConsumption += consumption; }
                }
                rowData.push(current.toFixed(1), consumption > 0 ? consumption.toFixed(1) : '-', refilled > 0 ? refilled.toFixed(1) : '-');
                previousLevels[dg] = current;
            });
            rowData.push((record.total?.level || 0).toFixed(1));
            rowData.push(totalConsumption > 0 ? totalConsumption.toFixed(1) : '-');
            worksheet.addRow(rowData);
        });

        worksheet.columns.forEach(col => col.width = 12); worksheet.getColumn(1).width = 25;
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="Aquarelle_India_All_Data.xlsx"`);
        await workbook.xlsx.write(res);
        res.end();
    } catch (err) { res.status(500).send('Export Error'); }
});

module.exports = router;