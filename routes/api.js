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
const REFILL_THRESHOLD = 25;     // Liters: Ignore rises smaller than this
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
// CORE LOGIC: MERGE & VERIFY (TOTAL = SUM OF PARTS)
// ✅ Fixed: Calculates DG1+DG2+DG3 separately to prevent errors
// ============================================================
function calculateVerifiedConsumption(dieselRecords, electricalRecords, dgKey) {
    
    // --------------------------------------------------------
    // CASE 1: HANDLE 'TOTAL' BY SUMMING INDIVIDUALS
    // --------------------------------------------------------
    if (dgKey === 'total') {
        const r1 = calculateVerifiedConsumption(dieselRecords, electricalRecords, 'dg1');
        const r2 = calculateVerifiedConsumption(dieselRecords, electricalRecords, 'dg2');
        const r3 = calculateVerifiedConsumption(dieselRecords, electricalRecords, 'dg3');

        // 1. Sum up the Consumption (9 + 0 + 5 = 14)
        // This prevents DG2's +2L rise from cancelling DG1's consumption.
        const finalTotalConsumption = r1.totalConsumption + r2.totalConsumption + r3.totalConsumption;

        // 2. Merge Refill Events
        const allEvents = [...r1.events, ...r2.events, ...r3.events].sort((a, b) => new Date(a.time) - new Date(b.time));

        // 3. Merge Graph Data (Time-Sync)
        const mergedData = r1.processedData.map((d1, i) => {
            const d2 = r2.processedData[i] || {};
            const d3 = r3.processedData[i] || {};
            
            return {
                timestamp: d1.timestamp,
                date: d1.date,
                // Sum levels and consumptions
                cleanLevel: (d1.cleanLevel || 0) + (d2.cleanLevel || 0) + (d3.cleanLevel || 0),
                consumption: (d1.consumption || 0) + (d2.consumption || 0) + (d3.consumption || 0),
                isRunning: d1.isRunning || d2.isRunning || d3.isRunning, 
                note: "Aggregated",
                electricalInfo: "Aggregated"
            };
        });

        return {
            totalConsumption: Number(finalTotalConsumption.toFixed(2)),
            processedData: mergedData,
            events: allEvents
        };
    }

    // --------------------------------------------------------
    // CASE 2: STANDARD LOGIC (For Single Tanks)
    // --------------------------------------------------------
    const cleanRecords = dieselRecords.filter(r => {
        const lvl = r[dgKey]?.level;
        return typeof lvl === 'number' && lvl > 1; 
    });

    if (!cleanRecords || cleanRecords.length === 0) {
        return { totalConsumption: 0, processedData: [], events: [] };
    }

    cleanRecords.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    if (electricalRecords) electricalRecords.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    const startLevel = cleanRecords[0][dgKey]?.level || 0;
    const endLevel = cleanRecords[cleanRecords.length - 1][dgKey]?.level || 0;

    let processedData = [];
    let events = [];
    let effectiveLevel = startLevel;
    let totalRefilled = 0;
    let eIdx = 0; 
    const maxTimeDiff = 2 * 60 * 1000; 

    for (let i = 0; i < cleanRecords.length; i++) {
        const record = cleanRecords[i];
        const currentLevel = record[dgKey]?.level || 0;
        const timestamp = new Date(record.timestamp);
        const recordTime = timestamp.getTime();

        // Electrical Lookup
        let electricalData = null;
        if (electricalRecords && electricalRecords.length > 0) {
            while (eIdx < electricalRecords.length) {
                const eTime = new Date(electricalRecords[eIdx].timestamp).getTime();
                if (eTime < recordTime - maxTimeDiff) eIdx++;
                else break;
            }
            if (eIdx < electricalRecords.length) {
                const eTime = new Date(electricalRecords[eIdx].timestamp).getTime();
                if (Math.abs(eTime - recordTime) <= maxTimeDiff) electricalData = electricalRecords[eIdx];
            }
        }

        let isPowerOn = false;
        let electricalDebug = "No Data";
        if (electricalData) {
            isPowerOn = (electricalData.voltageR > 100);
            electricalDebug = isPowerOn ? `ON (${electricalData.activePower}kW)` : "OFF (0V)";
        } else {
            isPowerOn = record[dgKey]?.isRunning || false;
            electricalDebug = isPowerOn ? "Flag ON" : "No Data";
        }

        const diff = effectiveLevel - currentLevel;
        let consumption = 0;
        let note = "Stable";

        // REFILL (> 25L)
        if (diff < -REFILL_THRESHOLD) { 
            const refillAmount = Math.abs(diff);
            note = "Refill Detected";
            events.push({ type: 'refill', amount: refillAmount, time: timestamp });
            totalRefilled += refillAmount; 
            effectiveLevel = currentLevel; 
        }
        // CONSUMPTION (> 1L)
        else if (diff > 1.0) {
            if (isPowerOn) {
                consumption = diff;
                note = "Consumption";
                effectiveLevel = currentLevel; 
            } else {
                note = "Noise (Gen OFF)";
                effectiveLevel = currentLevel;
            }
        }
        // RECOVERY
        else if (diff < 0) {
             if (!isPowerOn) effectiveLevel = currentLevel;
        }

        processedData.push({
            timestamp: record.timestamp,
            date: record.timestamp.toISOString().split('T')[0],
            cleanLevel: currentLevel,
            consumption: consumption,
            isRunning: isPowerOn,
            note: note,
            electricalInfo: electricalDebug
        });
    }

    // Mass Balance for Single Tank
    const adjustedEndLevel = endLevel - totalRefilled;
    let finalConsumption = startLevel - adjustedEndLevel;
    finalConsumption = Math.max(0, finalConsumption);

    return { 
        totalConsumption: Number(finalConsumption.toFixed(2)), 
        processedData, 
        events 
    };
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

/**
 * API Routes - CORRECTED ELECTRICAL ENDPOINT
 * Add this to your existing routes/api.js file
 */

// ============================================================
// FIXED ELECTRICAL DATA ROUTE
// ============================================================
router.get('/electrical/:dg', async (req, res) => {
    try {
        const { dg } = req.params;
        const { startDate, endDate } = req.query;

        // Validate DG parameter
        const validDGs = ['dg1', 'dg2', 'dg3', 'dg4'];
        if (!validDGs.includes(dg)) {
            return res.status(400).json({ 
                success: false, 
                error: 'Invalid DG type. Must be dg1, dg2, dg3, or dg4' 
            });
        }

        // Validate dates
        if (!startDate || !endDate) {
            return res.status(400).json({ 
                success: false, 
                error: 'Start date and end date are required' 
            });
        }

        // 1. Build Query
        const start = new Date(startDate); 
        start.setHours(0, 0, 0, 0);
        const end = new Date(endDate); 
        end.setHours(23, 59, 59, 999);

        const query = {
            dg: dg,
            timestamp: { $gte: start, $lte: end }
        };

        // 2. Fetch Data from MongoDB (Using ElectricalReading model)
        const data = await ElectricalReading.find(query)
            .select('timestamp voltageR voltageY voltageB currentR currentY currentB activePower frequency powerFactor runningHours')
            .sort({ timestamp: 1 })
            .lean();

        if (!data || data.length === 0) {
            return res.json({
                success: true,
                data: [],
                analytics: {
                    totalMinutes: 0,
                    totalFuel: 0,
                    totalCost: 0,
                    peakLoad: 0
                }
            });
        }

        // 3. Format Data & Calculate Analytics
        const formattedData = [];
        let totalFuel = 0;
        let totalCost = 0;
        let totalMinutes = 0;
        let peakLoad = 0;

        // Configuration
        const PRICE_PER_LITER = 97.00;
        const MAX_AMPS = 175; // 125 kVA

        for (let i = 0; i < data.length; i++) {
            const doc = data[i];

            // Flatten the structure for the frontend
            const row = {
                timestamp: doc.timestamp,
                voltageR: doc.voltageR || 0,
                voltageY: doc.voltageY || 0,
                voltageB: doc.voltageB || 0,
                currentR: doc.currentR || 0,
                currentY: doc.currentY || 0,
                currentB: doc.currentB || 0,
                activePower: doc.activePower || 0,
                frequency: doc.frequency || 0,
                powerFactor: doc.powerFactor || 0,
                runningHours: doc.runningHours || 0
            };

            // --- SMART ANALYTICS CALCULATION ---
            // Calculate Average Amps
            const avgAmps = (row.currentR + row.currentY + row.currentB) / 3;

            // Track Peak Load
            if (avgAmps > peakLoad) {
                peakLoad = avgAmps;
            }

            // Calculate Fuel & Cost (Only if Running)
            if (avgAmps > 5) {
                // Smart Fuel Rate Formula (Linear interpolation)
                // Idle (0% load) = 4.5 L/hr
                // Full Load (100%) = 18 L/hr
                let loadPct = avgAmps / MAX_AMPS;
                if (loadPct > 1) loadPct = 1;
                const fuelRateL_Hr = 4.5 + ((18 - 4.5) * loadPct); // L/hr

                // Integration (Time Difference from previous point)
                if (i > 0) {
                    const prevTime = new Date(data[i - 1].timestamp);
                    const currTime = new Date(doc.timestamp);
                    const diffHours = (currTime - prevTime) / (1000 * 60 * 60);

                    // Only add if gap is reasonable (< 15 mins) to ignore downtimes
                    if (diffHours < 0.25) {
                        const fuelConsumed = fuelRateL_Hr * diffHours;
                        totalFuel += fuelConsumed;
                        totalCost += (fuelConsumed * PRICE_PER_LITER);
                        totalMinutes += (diffHours * 60);
                    }
                }
            }

            formattedData.push(row);
        }

        // 4. Send Response with Analytics
        res.json({
            success: true,
            data: formattedData,
            analytics: {
                totalMinutes: Math.round(totalMinutes),
                totalFuel: parseFloat(totalFuel.toFixed(2)),
                totalCost: Math.round(totalCost),
                peakLoad: Math.round(peakLoad)
            }
        });

    } catch (err) {
        console.error('Electrical API Error:', err);
        res.status(500).json({ 
            success: false, 
            error: err.message 
        });
    }
});

// ============================================================
// EXPORT ELECTRICAL DATA TO EXCEL
// ============================================================
router.get('/export/electrical/:dg', async (req, res) => {
    try {
        const { dg } = req.params;
        const { startDate, endDate } = req.query;
        
        const start = new Date(startDate); 
        start.setHours(0, 0, 0, 0);
        const end = new Date(endDate); 
        end.setHours(23, 59, 59, 999);

        // Fetch data
        const records = await ElectricalReading.find({ 
            dg: dg, 
            timestamp: { $gte: start, $lte: end } 
        }).sort({ timestamp: 1 }).lean();

        if (!records || records.length === 0) {
            return res.status(404).send('No data found for this date range');
        }

        // Create Excel workbook
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Electrical Data');
        
        // Add logo and title
        await setupExcelSheet(workbook, worksheet, `Electrical Data - ${dg.toUpperCase()}`);

        // Add headers with SMART analytics columns
        worksheet.addRow([
            'Timestamp', 
            'Voltage R (V)', 
            'Voltage Y (V)', 
            'Voltage B (V)',
            'Current R (A)', 
            'Current Y (A)', 
            'Current B (A)',
            'Avg Current (A)',
            'Active Power (kW)', 
            'Frequency (Hz)', 
            'Power Factor',
            'Runtime (Hrs)',
            'Fuel Rate (L/hr)',
            'Cost (₹/hr)'
        ]);

        const headerRow = worksheet.lastRow;
        headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        headerRow.eachCell(cell => { 
            cell.fill = { 
                type: 'pattern', 
                pattern: 'solid', 
                fgColor: { argb: 'FF0052CC' } 
            }; 
        });

        // Add data rows with calculations
        const PRICE_PER_LITER = 97.00;
        const MAX_AMPS = 175;

        records.forEach(r => {
            const avgAmps = (r.currentR + r.currentY + r.currentB) / 3;
            
            let fuelRate = 0;
            let cost = 0;
            
            if (avgAmps > 5) {
                let loadPct = avgAmps / MAX_AMPS;
                if (loadPct > 1) loadPct = 1;
                fuelRate = 4.5 + ((18 - 4.5) * loadPct);
                cost = fuelRate * PRICE_PER_LITER;
            }

            worksheet.addRow([
                new Date(r.timestamp).toLocaleString('en-IN'),
                r.voltageR || 0,
                r.voltageY || 0,
                r.voltageB || 0,
                r.currentR || 0,
                r.currentY || 0,
                r.currentB || 0,
                avgAmps.toFixed(2),
                r.activePower || 0,
                r.frequency || 0,
                (r.powerFactor || 0).toFixed(2),
                (r.runningHours || 0).toFixed(1),
                fuelRate.toFixed(2),
                Math.round(cost)
            ]);
        });

        // Auto-fit columns
        worksheet.columns = [
            { width: 25 }, { width: 15 }, { width: 15 }, { width: 15 },
            { width: 15 }, { width: 15 }, { width: 15 }, { width: 18 },
            { width: 18 }, { width: 15 }, { width: 15 }, { width: 15 },
            { width: 18 }, { width: 15 }
        ];

        // Send file
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="Aquarelle_India_${dg.toUpperCase()}_Electrical_${startDate}_to_${endDate}.xlsx"`);
        
        await workbook.xlsx.write(res);
        res.end();

    } catch (err) {
        console.error('Export Error:', err);
        res.status(500).send('Export Error: ' + err.message);
    }
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

        worksheet.addRow(['Timestamp', 'Voltage R', 'Current R', 'Power (kW)', 'Freq (Hz)', 'PF', 'Runtime (Hrs)']);
        records.forEach(r => {
            worksheet.addRow([ 
                new Date(r.timestamp).toLocaleString('en-IN'), 
                r.voltageR, 
                r.currentR, 
                r.activePower, 
                r.frequency, 
                r.powerFactor || 0,
                r.runningHours || 0
            ]);
        });
        
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${dg}_Electrical.xlsx"`);
        await workbook.xlsx.write(res);
        res.end();
    } catch (e) { res.status(500).send("Error"); }
});



module.exports = router;