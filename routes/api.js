/**
 * API Routes - COMPLETE VERSION
 * Features: Live Data, History, Excel Export (With Logo + Noise Filter)
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const ExcelJS = require('exceljs'); 
const { getSystemData } = require('../services/plcService');
const { DieselConsumption, ElectricalReading } = require('../models/schemas');

// ✅ CONFIGURATION
const REFILL_THRESHOLD = 20; // Liters
const NOISE_THRESHOLD = 0.5; // Liters (Ignore changes smaller than this)
const LOGO_PATH = path.join(__dirname, '../public/logo.png'); 

// 🎨 HELPER: Setup Excel Header & Logo
async function setupExcelSheet(workbook, worksheet, title) {
    // 1. Add Image (Logo)
    try {
        const logoId = workbook.addImage({
            filename: LOGO_PATH,
            extension: 'png',
        });
        // Place image in top-left (Cells A1:B4)
        worksheet.addImage(logoId, {
            tl: { col: 0, row: 0 },
            ext: { width: 150, height: 80 }
        });
    } catch (e) {
        console.warn("Logo not found at " + LOGO_PATH + ". Skipping image.");
    }

    // 2. Add Title "Aquarelle India..."
    // Merge cells C2 to H3 for a big centered title
    worksheet.mergeCells('C2:H3');
    const titleCell = worksheet.getCell('C2');
    titleCell.value = title;
    titleCell.font = { name: 'Arial', size: 16, bold: true, color: { argb: 'FF0052CC' } }; // Blue color
    titleCell.alignment = { vertical: 'middle', horizontal: 'center' };

    // 3. Add Spacer Rows so data doesn't overlap image
    worksheet.addRow([]); 
    worksheet.addRow([]); 
    worksheet.addRow([]); 
    worksheet.addRow([]); 
}

// =================================================================
// 📡 DATA API ROUTES (Used by Dashboard & Graphs)
// =================================================================

// Get LIVE System Data
router.get('/data', (req, res) => {
    try {
        res.json(getSystemData());
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Get Consumption History (For Graphs)
router.get('/consumption', async (req, res) => {
    try {
        const { dg, startDate, endDate } = req.query;
        if (!startDate || !endDate) return res.status(400).json({ success: false, error: 'Dates required' });

        const start = new Date(startDate); start.setHours(0, 0, 0, 0);
        const end = new Date(endDate); end.setHours(23, 59, 59, 999);

        const records = await DieselConsumption.find({ timestamp: { $gte: start, $lte: end } }).sort({ timestamp: 1 });

        // If no history yet today, send live data to help graph draw line
        if (records.length === 0 && startDate === endDate && startDate === new Date().toISOString().split('T')[0]) {
            return res.json({ success: true, data: [], liveData: getSystemData() });
        }
        
        // Send raw records (Frontend handles the noise logic for graphs)
        res.json({ success: true, data: records }); 

    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Get Electrical History (For Graphs)
router.get('/electrical/:dg', async (req, res) => {
    try {
        const { dg } = req.params;
        const { startDate, endDate } = req.query;
        const start = new Date(startDate); start.setHours(0, 0, 0, 0);
        const end = new Date(endDate); end.setHours(23, 59, 59, 999);

        // Only fetch records where Active Power > 5 (Running)
        const records = await ElectricalReading.find({
            dg: dg, timestamp: { $gte: start, $lte: end }, activePower: { $gt: 5 }
        }).sort({ timestamp: 1 });
        
        res.json({ success: true, data: records });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});


// =================================================================
// 📥 EXCEL EXPORT ROUTES (With Image & Styling)
// =================================================================

// 1. EXPORT CONSUMPTION REPORT
router.get('/export/consumption', async (req, res) => {
    try {
        const { dg, startDate, endDate } = req.query;
        const start = new Date(startDate); start.setHours(0, 0, 0, 0);
        const end = new Date(endDate); end.setHours(23, 59, 59, 999);

        const records = await DieselConsumption.find({ timestamp: { $gte: start, $lte: end } }).sort({ timestamp: 1 });

        // Setup Workbook
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Consumption');

        // Add Logo & Title
        await setupExcelSheet(workbook, worksheet, `Aquarelle India - ${dg.toUpperCase()} Consumption`);

        // Add Column Headers
        worksheet.addRow(['Timestamp', 'Level (L)', 'Consumed (L)', 'Refilled (L)', 'Running', 'Notes']);
        
        // Style Header Row (Blue Background, White Text)
        const headerRow = worksheet.lastRow;
        headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        headerRow.eachCell(cell => {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0052CC' } };
        });

        // --- LOGIC: CALCULATE CONSUMPTION WITH NOISE FILTER ---
        let previousLevel = null;

        records.forEach(record => {
            const currentLevel = record[dg]?.level || 0;
            let consumption = 0;
            let refilled = 0;
            let notes = '';

            if (previousLevel !== null) {
                const diff = currentLevel - previousLevel;
                
                if (diff > REFILL_THRESHOLD) {
                    // Huge Jump -> Refill
                    refilled = diff;
                    notes = 'REFILL';
                } else if (diff < -NOISE_THRESHOLD) {
                    // Valid Drop -> Consumption
                    consumption = Math.abs(diff);
                }
                // Else: Small change (-0.5 to +20) is considered Noise -> 0 Consumption
            }

            worksheet.addRow([
                new Date(record.timestamp).toLocaleString('en-IN'),
                currentLevel.toFixed(2),
                consumption > 0 ? consumption.toFixed(2) : '-',
                refilled > 0 ? refilled.toFixed(2) : '-',
                record[dg]?.isRunning ? 'Yes' : 'No',
                notes
            ]);

            // Update previous level (We use RAW level for tracking to avoid drift)
            previousLevel = currentLevel;
        });

        // Set Column Widths
        worksheet.columns = [
            { width: 25 }, { width: 15 }, { width: 15 }, { width: 15 }, { width: 10 }, { width: 20 }
        ];

        // Send File
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="Aquarelle_India_${dg}_Consumption.xlsx"`);
        await workbook.xlsx.write(res);
        res.end();

    } catch (err) {
        console.error(err);
        res.status(500).send('Export Error');
    }
});

// 2. EXPORT ELECTRICAL REPORT
router.get('/export/electrical/:dg', async (req, res) => {
    try {
        const { dg } = req.params;
        const { startDate, endDate } = req.query;
        const start = new Date(startDate); start.setHours(0, 0, 0, 0);
        const end = new Date(endDate); end.setHours(23, 59, 59, 999);

        const records = await ElectricalReading.find({
            dg: dg, timestamp: { $gte: start, $lte: end }
        }).sort({ timestamp: 1 });

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Electrical');

        await setupExcelSheet(workbook, worksheet, `Aquarelle India - ${dg.toUpperCase()} Electrical Details`);

        worksheet.addRow(['Timestamp', 'Volt R', 'Volt Y', 'Volt B', 'Amp R', 'Amp Y', 'Amp B', 'Freq', 'PF', 'kW', 'kVAR', 'kWh', 'Run Hrs']);
        
        const headerRow = worksheet.lastRow;
        headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        headerRow.eachCell(cell => cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF00875A' } }); // Green Header

        records.forEach(r => {
            worksheet.addRow([
                new Date(r.timestamp).toLocaleString('en-IN'),
                r.voltageR, r.voltageY, r.voltageB,
                r.currentR, r.currentY, r.currentB,
                r.frequency, r.powerFactor, r.activePower, r.reactivePower,
                r.energyMeter, r.runningHours
            ]);
        });

        worksheet.columns.forEach(column => { column.width = 12; });
        worksheet.getColumn(1).width = 25; // Timestamp column wider

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="Aquarelle_India_${dg}_Electrical.xlsx"`);
        await workbook.xlsx.write(res);
        res.end();

    } catch (err) {
        res.status(500).send('Export Error');
    }
});

// 3. EXPORT ALL DATA REPORT (The Big One)
router.get('/export/all', async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        const start = new Date(startDate); start.setHours(0, 0, 0, 0);
        const end = new Date(endDate); end.setHours(23, 59, 59, 999);

        const records = await DieselConsumption.find({ timestamp: { $gte: start, $lte: end } }).sort({ timestamp: 1 });

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Total Report');

        await setupExcelSheet(workbook, worksheet, `Aquarelle India - Complete DG Report`);

        worksheet.addRow([
            'Timestamp', 
            'DG1 Lvl', 'DG1 Used', 'DG1 Refill', 
            'DG2 Lvl', 'DG2 Used', 'DG2 Refill', 
            'DG3 Lvl', 'DG3 Used', 'DG3 Refill', 
            'Total Lvl', 'Total Used'
        ]);
        
        const headerRow = worksheet.lastRow;
        headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        headerRow.eachCell(cell => cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDE350B' } }); // Red Header

        let previousLevels = { dg1: null, dg2: null, dg3: null };

        records.forEach(record => {
            let rowData = [new Date(record.timestamp).toLocaleString('en-IN')];
            let totalConsumption = 0;

            ['dg1', 'dg2', 'dg3'].forEach(dg => {
                const current = record[dg]?.level || 0;
                let consumption = 0;
                let refilled = 0;

                if (previousLevels[dg] !== null) {
                    const diff = current - previousLevels[dg];
                    
                    if (diff > REFILL_THRESHOLD) {
                        refilled = diff;
                    } else if (diff < -NOISE_THRESHOLD) {
                        // Valid Consumption
                        consumption = Math.abs(diff);
                        totalConsumption += consumption;
                    }
                    // Else: Noise -> 0
                }

                rowData.push(
                    current.toFixed(1), 
                    consumption > 0 ? consumption.toFixed(1) : '-', 
                    refilled > 0 ? refilled.toFixed(1) : '-'
                );
                previousLevels[dg] = current;
            });

            // Total Columns
            rowData.push((record.total?.level || 0).toFixed(1));
            rowData.push(totalConsumption > 0 ? totalConsumption.toFixed(1) : '-');

            worksheet.addRow(rowData);
        });

        worksheet.columns.forEach(col => col.width = 12);
        worksheet.getColumn(1).width = 25;

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="Aquarelle_India_All_Data.xlsx"`);
        await workbook.xlsx.write(res);
        res.end();

    } catch (err) {
        console.error(err);
        res.status(500).send('Export Error');
    }
});

module.exports = router;