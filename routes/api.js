/**
 * API Routes - FIXED VERSION
 * KEY FIXES:
 * 1. Proper data structure for consumption endpoint
 * 2. Better error handling for electrical endpoint
 * 3. Removed caching that was causing stale data
 * 4. Added proper logging
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const ExcelJS = require('exceljs'); 
const { getSystemData } = require('../services/plcService');
const { DieselConsumption, ElectricalReading } = require('../models/schemas');

const REFILL_THRESHOLD = 20;
const NOISE_THRESHOLD = 0.5;
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

// ✅ FIXED: Consumption endpoint with proper structure
router.get('/consumption', async (req, res) => {
    try {
        const { dg, startDate, endDate } = req.query;
        
        if (!startDate || !endDate) {
            return res.status(400).json({ success: false, error: 'Dates required' });
        }

        const start = new Date(startDate);
        start.setHours(0, 0, 0, 0);
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);

        console.log(`📊 Consumption query: ${dg || 'total'} from ${startDate} to ${endDate}`);

        // Query database
        const records = await DieselConsumption.find({
            timestamp: { $gte: start, $lte: end }
        })
        .sort({ timestamp: 1 })
        .lean();

        console.log(`📦 Found ${records.length} consumption records`);

        // ✅ FIX: Return proper structure based on DG selection
        let responseData = [];

        if (!dg || dg === 'total') {
            // Return all DG data for total view
            responseData = records.map(r => ({
                timestamp: r.timestamp,
                date: r.date,
                dg1: {
                    level: r.dg1?.level || 0,
                    consumption: r.dg1?.consumption || 0,
                    isRunning: r.dg1?.isRunning || false
                },
                dg2: {
                    level: r.dg2?.level || 0,
                    consumption: r.dg2?.consumption || 0,
                    isRunning: r.dg2?.isRunning || false
                },
                dg3: {
                    level: r.dg3?.level || 0,
                    consumption: r.dg3?.consumption || 0,
                    isRunning: r.dg3?.isRunning || false
                },
                total: {
                    level: r.total?.level || 0,
                    consumption: r.total?.consumption || 0
                }
            }));
        } else {
            // Return specific DG data
            responseData = records.map(r => ({
                timestamp: r.timestamp,
                date: r.date,
                level: r[dg]?.level || 0,
                consumption: r[dg]?.consumption || 0,
                isRunning: r[dg]?.isRunning || false,
                // Include other DGs for context in frontend processing
                dg1: r.dg1,
                dg2: r.dg2,
                dg3: r.dg3,
                total: r.total
            }));
        }

        // If today and no data, return live data
        const today = new Date().toISOString().split('T')[0];
        if (responseData.length === 0 && startDate === today && endDate === today) {
            const liveData = getSystemData();
            console.log('📡 No historical data, returning live data');
            return res.json({ 
                success: true, 
                data: [], 
                liveData: liveData 
            });
        }
        
        res.json({ success: true, data: responseData });

    } catch (err) {
        console.error('❌ Consumption API Error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ✅ FIXED: Electrical endpoint without problematic caching
router.get('/electrical/:dg', async (req, res) => {
    try {
        const { dg } = req.params;
        const { startDate, endDate } = req.query;

        if (!['dg1', 'dg2', 'dg3', 'dg4'].includes(dg)) {
            return res.status(400).json({ success: false, error: 'Invalid DG' });
        }

        if (!startDate || !endDate) {
            return res.status(400).json({ success: false, error: 'Dates required' });
        }

        const start = new Date(startDate);
        start.setHours(0, 0, 0, 0);
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);

        console.log(`⚡ Electrical query: ${dg} from ${startDate} to ${endDate}`);

        const today = new Date().toISOString().split('T')[0];
        const isToday = startDate === today && endDate === today;

        // Query with timeout
        let records = await ElectricalReading.find({
            dg: dg,
            timestamp: { $gte: start, $lte: end }
        })
        .sort({ timestamp: 1 })
        .limit(200) // Prevent huge payloads
        .lean()
        .maxTimeMS(8000); // 8 second timeout

        console.log(`📦 Found ${records.length} electrical records for ${dg}`);

        // If no data today, try to get last known values from yesterday
        if (records.length === 0 && isToday) {
            console.log(`🔍 No data today for ${dg}, checking yesterday...`);
            
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
            .lean()
            .maxTimeMS(5000);

            if (yesterdayRecords.length > 0) {
                console.log(`✅ Found yesterday's last record for ${dg}`);
                records = yesterdayRecords;
            }
        }

        return res.json({ success: true, data: records });

    } catch (err) {
        console.error(`❌ Electrical API Error [${req.params.dg}]:`, err.message);
        
        // Return empty array instead of error to prevent frontend crash
        return res.json({ 
            success: true, 
            data: [],
            warning: 'Database query failed, showing empty data' 
        });
    }
});

// =================================================================
// 📥 EXCEL EXPORT ROUTES (Unchanged - working fine)
// =================================================================

router.get('/export/consumption', async (req, res) => {
    try {
        const { dg, startDate, endDate } = req.query;
        const start = new Date(startDate);
        start.setHours(0, 0, 0, 0);
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);

        const records = await DieselConsumption.find({ 
            timestamp: { $gte: start, $lte: end } 
        }).sort({ timestamp: 1 }).lean();

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Consumption');

        await setupExcelSheet(workbook, worksheet, 
            `Aquarelle India - ${dg.toUpperCase()} Consumption`);

        worksheet.addRow(['Timestamp', 'Level (L)', 'Consumed (L)', 
                         'Refilled (L)', 'Running', 'Notes']);
        
        const headerRow = worksheet.lastRow;
        headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        headerRow.eachCell(cell => {
            cell.fill = { type: 'pattern', pattern: 'solid', 
                         fgColor: { argb: 'FF0052CC' } };
        });

        let previousLevel = null;

        records.forEach(record => {
            const currentLevel = record[dg]?.level || 0;
            let consumption = 0;
            let refilled = 0;
            let notes = '';

            if (previousLevel !== null) {
                const diff = currentLevel - previousLevel;
                
                if (diff > REFILL_THRESHOLD) {
                    refilled = diff;
                    notes = 'REFILL';
                } else if (diff < -NOISE_THRESHOLD) {
                    consumption = Math.abs(diff);
                }
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

        worksheet.columns = [
            { width: 25 }, { width: 15 }, { width: 15 }, 
            { width: 15 }, { width: 10 }, { width: 20 }
        ];

        res.setHeader('Content-Type', 
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 
            `attachment; filename="Aquarelle_India_${dg}_Consumption.xlsx"`);
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
            dg: dg, 
            timestamp: { $gte: start, $lte: end }
        }).sort({ timestamp: 1 }).lean();

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Electrical');

        await setupExcelSheet(workbook, worksheet, 
            `Aquarelle India - ${dg.toUpperCase()} Electrical Details`);

        worksheet.addRow(['Timestamp', 'Volt R', 'Volt Y', 'Volt B', 
                         'Amp R', 'Amp Y', 'Amp B', 'Freq', 'PF', 
                         'kW', 'kVAR', 'kWh', 'Run Hrs']);
        
        const headerRow = worksheet.lastRow;
        headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        headerRow.eachCell(cell => cell.fill = { 
            type: 'pattern', pattern: 'solid', 
            fgColor: { argb: 'FF00875A' } 
        });

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

        res.setHeader('Content-Type', 
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 
            `attachment; filename="Aquarelle_India_${dg}_Electrical.xlsx"`);
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
        const start = new Date(startDate);
        start.setHours(0, 0, 0, 0);
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);

        const records = await DieselConsumption.find({ 
            timestamp: { $gte: start, $lte: end } 
        }).sort({ timestamp: 1 }).lean();

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Total Report');

        await setupExcelSheet(workbook, worksheet, 
            `Aquarelle India - Complete DG Report`);

        worksheet.addRow([
            'Timestamp', 
            'DG1 Lvl', 'DG1 Used', 'DG1 Refill', 
            'DG2 Lvl', 'DG2 Used', 'DG2 Refill', 
            'DG3 Lvl', 'DG3 Used', 'DG3 Refill', 
            'Total Lvl', 'Total Used'
        ]);
        
        const headerRow = worksheet.lastRow;
        headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        headerRow.eachCell(cell => cell.fill = { 
            type: 'pattern', pattern: 'solid', 
            fgColor: { argb: 'FFDE350B' } 
        });

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
                        consumption = Math.abs(diff);
                        totalConsumption += consumption;
                    }
                }

                rowData.push(
                    current.toFixed(1), 
                    consumption > 0 ? consumption.toFixed(1) : '-', 
                    refilled > 0 ? refilled.toFixed(1) : '-'
                );
                previousLevels[dg] = current;
            });

            rowData.push((record.total?.level || 0).toFixed(1));
            rowData.push(totalConsumption > 0 ? totalConsumption.toFixed(1) : '-');

            worksheet.addRow(rowData);
        });

        worksheet.columns.forEach(col => col.width = 12);
        worksheet.getColumn(1).width = 25;

        res.setHeader('Content-Type', 
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 
            `attachment; filename="Aquarelle_India_All_Data.xlsx"`);
        await workbook.xlsx.write(res);
        res.end();

    } catch (err) {
        console.error('Export Error:', err);
        res.status(500).send('Export Error');
    }
});

module.exports = router;