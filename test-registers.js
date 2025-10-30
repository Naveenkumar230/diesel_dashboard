require('dotenv').config();
const ModbusRTU = require("modbus-serial");

const client = new ModbusRTU();
const PLC_PORT = process.env.PLC_PORT || '/dev/ttyUSB0';
const PLC_SLAVE_ID = parseInt(process.env.PLC_SLAVE_ID) || 1;

const plcSettings = {
    baudRate: parseInt(process.env.PLC_BAUD_RATE) || 9600,
    parity: process.env.PLC_PARITY || 'none',
    dataBits: parseInt(process.env.PLC_DATA_BITS) || 8,
    stopBits: parseInt(process.env.PLC_STOP_BITS) || 1
};

// CANDIDATES from scan results
const CANDIDATES = [
    { name: 'D4', address: 4100, description: 'Candidate 1 (was 115L)' },
    { name: 'D6', address: 4102, description: 'Candidate 2 (was 154L)' },
    { name: 'D8', address: 4104, description: 'Candidate 3 (was 144L)' },
    { name: 'D10', address: 4106, description: 'Candidate 4 (was 17L)' },
    { name: 'D200', address: 4296, description: 'Candidate 5 (was 11L)' },
    { name: 'D202', address: 4298, description: 'Candidate 6 (was 1L)' },
    { name: 'D204', address: 4300, description: 'Candidate 7 (was 11L)' },
    { name: 'D210', address: 4306, description: 'Candidate 8 (was 30L)' },
    { name: 'D212', address: 4308, description: 'Candidate 9 (was 30L)' }
];

// Store historical values
const history = {};
CANDIDATES.forEach(c => {
    history[c.name] = {
        values: [],
        changes: 0,
        min: Infinity,
        max: -Infinity,
        lastValue: null
    };
});

let readCount = 0;
const MAX_READS = 30; // Monitor for 30 cycles (60 seconds)

async function readAndAnalyze() {
    console.log('\n' + '═'.repeat(100));
    console.log(`📊 READING CYCLE ${readCount + 1}/${MAX_READS} - ${new Date().toLocaleTimeString()}`);
    console.log('═'.repeat(100));
    
    console.log(`\n${'Register'.padEnd(10)} | ${'Address'.padEnd(8)} | ${'Current'.padEnd(10)} | ${'Previous'.padEnd(10)} | ${'Change'.padEnd(10)} | ${'Min'.padEnd(6)} | ${'Max'.padEnd(6)} | ${'Changes'.padEnd(8)} | Status`);
    console.log('─'.repeat(100));

    for (const candidate of CANDIDATES) {
        try {
            const data = await client.readHoldingRegisters(candidate.address, 1);
            const value = data.data[0];
            
            const h = history[candidate.name];
            const prevValue = h.lastValue;
            const change = prevValue !== null ? value - prevValue : 0;
            
            // Update history
            h.values.push(value);
            if (prevValue !== null && value !== prevValue) {
                h.changes++;
            }
            h.min = Math.min(h.min, value);
            h.max = Math.max(h.max, value);
            h.lastValue = value;
            
            // Determine status
            let status = '⚪';
            if (value >= 0 && value <= 600) {
                if (h.changes > 0) {
                    status = '🟢 CHANGING!'; // Good candidate - changes and in diesel range
                } else {
                    status = '🟡 STABLE'; // In range but not changing
                }
            } else {
                status = '🔴 OUT OF RANGE'; // Not diesel
            }
            
            console.log(
                `${candidate.name.padEnd(10)} | ` +
                `${candidate.address.toString().padEnd(8)} | ` +
                `${value.toString().padEnd(10)} | ` +
                `${(prevValue !== null ? prevValue : '-').toString().padEnd(10)} | ` +
                `${(change !== 0 ? (change > 0 ? '+' : '') + change : '-').toString().padEnd(10)} | ` +
                `${(h.min !== Infinity ? h.min : '-').toString().padEnd(6)} | ` +
                `${(h.max !== -Infinity ? h.max : '-').toString().padEnd(6)} | ` +
                `${h.changes.toString().padEnd(8)} | ` +
                `${status}`
            );
            
            await new Promise(resolve => setTimeout(resolve, 200));
            
        } catch (err) {
            console.log(`${candidate.name.padEnd(10)} | ERROR: ${err.message}`);
        }
    }
    
    readCount++;
    
    if (readCount >= MAX_READS) {
        await showFinalAnalysis();
        client.close();
        process.exit(0);
    } else {
        setTimeout(readAndAnalyze, 2000); // Read every 2 seconds
    }
}

async function showFinalAnalysis() {
    console.log('\n\n' + '═'.repeat(100));
    console.log('🎯 FINAL ANALYSIS - DIESEL REGISTER IDENTIFICATION');
    console.log('═'.repeat(100));
    
    // Sort by number of changes (most likely diesel tanks change slowly)
    const ranked = CANDIDATES.map(c => ({
        ...c,
        ...history[c.name],
        avgValue: history[c.name].values.reduce((a, b) => a + b, 0) / history[c.name].values.length,
        variance: calculateVariance(history[c.name].values)
    })).sort((a, b) => {
        // Prioritize: in range (0-600), has changes, reasonable variance
        const aScore = getScore(a);
        const bScore = getScore(b);
        return bScore - aScore;
    });
    
    console.log('\n🏆 TOP CANDIDATES (Most Likely Diesel Registers):\n');
    
    ranked.slice(0, 3).forEach((r, idx) => {
        console.log(`${idx + 1}. ${r.name} (Address: ${r.address})`);
        console.log(`   Average Value: ${r.avgValue.toFixed(1)}L`);
        console.log(`   Range: ${r.min}L - ${r.max}L`);
        console.log(`   Total Changes: ${r.changes}`);
        console.log(`   Variance: ${r.variance.toFixed(2)}`);
        console.log(`   Behavior: ${analyzeBehavior(r)}`);
        console.log('');
    });
    
    // Check for 3 consecutive registers
    console.log('\n🔍 CHECKING FOR CONSECUTIVE REGISTER PATTERNS:\n');
    
    for (let i = 0; i < ranked.length - 2; i++) {
        const r1 = ranked[i];
        const r2 = ranked[i + 1];
        const r3 = ranked[i + 2];
        
        // Check if addresses are consecutive
        if (r2.address === r1.address + 1 && r3.address === r2.address + 1) {
            console.log(`✅ FOUND CONSECUTIVE PATTERN:`);
            console.log(`   ${r1.name} (${r1.address}) = ${r1.avgValue.toFixed(1)}L avg`);
            console.log(`   ${r2.name} (${r2.address}) = ${r2.avgValue.toFixed(1)}L avg`);
            console.log(`   ${r3.name} (${r3.address}) = ${r3.avgValue.toFixed(1)}L avg`);
            console.log(`   Total: ${(r1.avgValue + r2.avgValue + r3.avgValue).toFixed(1)}L\n`);
        }
    }
    
    console.log('\n💻 RECOMMENDED CONFIGURATION:\n');
    console.log('Based on the analysis, update your code with:');
    console.log('```javascript');
    console.log('const dgRegisters = {');
    console.log(`    dg1: { address: ${ranked[0].address}, name: "DG-1" },  // ${ranked[0].name} - ${ranked[0].avgValue.toFixed(1)}L avg`);
    console.log(`    dg2: { address: ${ranked[1].address}, name: "DG-2" },  // ${ranked[1].name} - ${ranked[1].avgValue.toFixed(1)}L avg`);
    console.log(`    dg3: { address: ${ranked[2].address}, name: "DG-3" }   // ${ranked[2].name} - ${ranked[2].avgValue.toFixed(1)}L avg`);
    console.log('};');
    console.log('```\n');
    
    console.log('📝 NOTES:');
    console.log('1. Diesel levels should be in range 0-600L');
    console.log('2. Values should change slowly over time');
    console.log('3. Three tanks should ideally be in consecutive registers');
    console.log('4. If values are too high or change erratically, they are likely NOT diesel\n');
}

function calculateVariance(values) {
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const squaredDiffs = values.map(v => Math.pow(v - avg, 2));
    return squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
}

function getScore(r) {
    let score = 0;
    
    // In diesel range (0-600L)
    if (r.avgValue >= 0 && r.avgValue <= 600) score += 100;
    
    // Has changes (diesel consumption)
    score += r.changes * 10;
    
    // Reasonable variance (not too stable, not too erratic)
    if (r.variance > 0 && r.variance < 1000) score += 50;
    
    // Reasonable range
    const range = r.max - r.min;
    if (range > 0 && range < 100) score += 30;
    
    return score;
}

function analyzeBehavior(r) {
    if (r.changes === 0) return '❌ Static (not changing - unlikely diesel)';
    if (r.avgValue < 0 || r.avgValue > 600) return '❌ Out of range (not diesel)';
    if (r.variance > 1000) return '⚠️  High variance (erratic - check carefully)';
    if (r.changes > 10) return '✅ Actively changing (likely diesel tank)';
    if (r.changes > 3) return '✅ Slowly changing (typical diesel consumption)';
    return '🟡 Minor changes (possible diesel, but verify)';
}

async function startMonitoring() {
    console.log('\n' + '═'.repeat(100));
    console.log('  🔍 ADVANCED DIESEL REGISTER FINDER');
    console.log('  Real-time monitoring to identify correct diesel registers');
    console.log('═'.repeat(100));
    
    try {
        await client.connectRTUBuffered(PLC_PORT, plcSettings);
        client.setID(PLC_SLAVE_ID);
        client.setTimeout(5000);
        
        console.log('\n✅ PLC Connected');
        console.log(`   Port: ${PLC_PORT}`);
        console.log(`   Baud Rate: ${plcSettings.baudRate}`);
        console.log(`   Slave ID: ${PLC_SLAVE_ID}\n`);
        
        console.log('📋 Monitoring Candidates:');
        CANDIDATES.forEach(c => {
            console.log(`   - ${c.name.padEnd(6)} (${c.address}) - ${c.description}`);
        });
        
        console.log(`\n⏱️  Will monitor for ${MAX_READS * 2} seconds (${MAX_READS} readings every 2 seconds)`);
        console.log('   Watch for registers that:');
        console.log('   1. Stay in range 0-600L');
        console.log('   2. Change slowly over time');
        console.log('   3. Are in consecutive addresses\n');
        
        console.log('Press Ctrl+C to stop early...\n');
        
        await readAndAnalyze();
        
    } catch (err) {
        console.error('\n❌ Connection Error:', err.message);
        console.error('\n🔧 Troubleshooting:');
        console.error('   1. Check PLC power and connection');
        console.error('   2. Verify port: ls -l /dev/ttyUSB*');
        console.error('   3. Check permissions: sudo usermod -a -G dialout $USER\n');
        
        client.close();
        process.exit(1);
    }
}

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n\n⚠️  Interrupted by user');
    if (readCount > 0) {
        await showFinalAnalysis();
    }
    client.close();
    process.exit(0);
});

console.log('\n🚀 Starting Advanced Diesel Register Finder...\n');
startMonitoring();