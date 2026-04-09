const ModbusRTU = require('modbus-serial');
const fs = require('fs');
require('dotenv').config();

const client = new ModbusRTU();
const port = process.env.PLC_PORT || '/dev/ttyUSB0';
const slaveID = parseInt(process.env.PLC_SLAVE_ID) || 1;

// These are the exact registers your code is looking for
const importantRegisters = [
    4100, 4102, 4104, // Diesel Levels
    4728, 4730, 4732, // DG1 Voltages
    4704, 4706, 4708, // DG1 Currents
    4696, 4752, 4760, // Power, Freq, PF
    4518, 4768, 4776  // Hours, Consumption, Load
];

async function scan() {
    try {
        console.log(`Connecting to PLC on ${port}...`);
        await client.connectRTU(port, { baudRate: 9600 });
        await client.setID(slaveID);
        
        let report = `PLC Register Report - Slave ID: ${slaveID}\n`;
        report += `Generated: ${new Date().toLocaleString()}\n`;
        report += "Address | Value | Description\n----------------------------\n";

        for (let addr of importantRegisters) {
            try {
                const data = await client.readHoldingRegisters(addr, 1);
                const val = data.data[0];
                console.log(`✓ Read Address ${addr}: ${val}`);
                report += `${addr} | ${val} | OK\n`;
            } catch (err) {
                console.warn(`❌ Address ${addr} failed: ${err.message}`);
                report += `${addr} | ERROR | ${err.message}\n`;
            }
            await new Promise(r => setTimeout(r, 100)); // Delay for bus stability
        }

        fs.writeFileSync('plc_report.txt', report);
        console.log("\n✅ Precision Report saved to 'plc_report.txt'.");

    } catch (e) {
        console.error("❌ Critical Error:", e.message);
    } finally {
        client.close();
        process.exit();
    }
}

scan();