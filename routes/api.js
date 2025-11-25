/**
 * API Routes - OPTIMIZED FOR ANTI-502 & DATABASE EFFICIENCY
 * KEY CHANGES:
 * 1. Indexed queries (date + dg composite index)
 * 2. Cached last-known electrical data per DG
 * 3. Single query fallback (today OR yesterday, not both)
 * 4. Request deduplication to prevent pile-ups
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const ExcelJS = require('exceljs'); 
const { getSystemData } = require('../services/plcService');
const { DieselConsumption, ElectricalReading } = require('../models/schemas');

// ✅ CONFIGURATION
const REFILL_THRESHOLD = 20;
const NOISE_THRESHOLD = 0.5;
const LOGO_PATH = path.join(__dirname, '../public/logo.png');
const CACHE_TTL = 300000; // 5 minutes (electrical data cache)

// ✅ IN-MEMORY CACHE: Store last known electrical data per DG
const electricalCache = {
  dg1: { data: null, timestamp: 0 },
  dg2: { data: null, timestamp: 0 },
  dg3: { data: null, timestamp: 0 },
  dg4: { data: null, timestamp: 0 }
};

// ✅ REQUEST DEDUPLICATION: Prevent multiple identical queries
const pendingRequests = new Map();

// 🎨 HELPER: Setup Excel Header & Logo
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

router.get('/consumption', async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        if (!startDate || !endDate) {
            return res.status(400).json({ success: false, error: 'Dates required' });
        }

        const start = new Date(startDate);
        start.setHours(0, 0, 0, 0);
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);

        // ✅ OPTIMIZED: Use indexed field 'date' instead of timestamp range
        const dateStr = startDate === endDate ? startDate : null;
        const query = dateStr 
            ? { date: dateStr }
            : { timestamp: { $gte: start, $lte: end } };

        const records = await DieselConsumption.find(query)
            .sort({ timestamp: 1 })
            .lean(); // ✅ Faster: Returns plain objects, not Mongoose docs

        if (records.length === 0 && startDate === endDate && 
            startDate === new Date().toISOString().split('T')[0]) {
            return res.json({ success: true, data: [], liveData: getSystemData() });
        }
        
        res.json({ success: true, data: records });

    } catch (err) {
        console.error('Consumption API Error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ✅ CRITICAL: This is the endpoint causing 502 errors
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

        const today = new Date().toISOString().split('T')[0];
        const isToday = startDate === today && endDate === today;

        // ✅ DEDUPLICATION: If same request is already running, wait for it
        const requestKey = `${dg}-${startDate}-${endDate}`;
        if (pendingRequests.has(requestKey)) {
            const result = await pendingRequests.get(requestKey);
            return res.json(result);
        }

        // ✅ CACHE CHECK: For today's requests, return cached data if fresh
        if (isToday) {
            const cache = electricalCache[dg];
            const age = Date.now() - cache.timestamp;
            
            if (cache.data && age < CACHE_TTL) {
                return res.json({ 
                    success: true, 
                    data: cache.data,
                    cached: true 
                });
            }
        }

        // ✅ EXECUTE QUERY (with deduplication)
        const queryPromise = executeElectricalQuery(dg, startDate, endDate, isToday);
        pendingRequests.set(requestKey, queryPromise);

        try {
            const result = await queryPromise;
            
            // Update cache if today
            if (isToday) {
                electricalCache[dg] = {
                    data: result.data,
                    timestamp: Date.now()
                };
            }

            res.json(result);
        } finally {
            pendingRequests.delete(requestKey);
        }

    } catch (err) {
        console.error(`Electrical API Error [${req.params.dg}]:`, err.message);
        res.status(500).json({ success: false, error: 'Database temporarily unavailable' });
    }
});

// ✅ OPTIMIZED QUERY FUNCTION
async function executeElectricalQuery(dg, startDate, endDate, isToday) {
    try {
        // Try today first
        let records = await ElectricalReading.find({
            dg: dg,
            date: startDate,
            activePower: { $gt: 5 }
        })
        .sort({ timestamp: 1 })
        .limit(100) // ✅ Limit results to prevent huge payloads
        .lean()
        .maxTimeMS(5000); // ✅ Timeout after 5 seconds

        // If no data today and it's a single-day query, try yesterday
        if (records.length === 0 && startDate === endDate) {
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            const yesterdayStr = yesterday.toISOString().split('T')[0];

            records = await ElectricalReading.find({
                dg: dg,
                date: yesterdayStr,
                activePower: { $gt: 5 }
            })
            .sort({ timestamp: -1 }) // ✅ Get most recent first
            .limit(1) // ✅ Just need the last known value
            .lean()
            .maxTimeMS(5000);
        }

        return { success: true, data: records };

    } catch (err) {
        console.error(`Query failed for ${dg}:`, err.message);
        
        // ✅ FALLBACK: Return cached data if query fails
        const cache = electricalCache[dg];
        if (cache.data) {
            return { 
                success: true, 
                data: cache.data, 
                cached: true,
                warning: 'Using cached data due to database timeout'
            };
        }

        return { success: true, data: [] };
    }
}

// =================================================================
// 📥 EXCEL EXPORT ROUTES
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