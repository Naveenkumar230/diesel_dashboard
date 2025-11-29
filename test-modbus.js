const ModbusRTU = require('modbus-serial');

const baudRates = [9600, 19200, 38400, 57600, 115200];

async function testBaudRate(baud) {
  const client = new ModbusRTU();
  
  try {
    await client.connectRTU('/dev/ttyUSB0', {
      baudRate: baud,
      parity: 'none',
      dataBits: 8,
      stopBits: 1
    });
    
    client.setID(1);
    client.setTimeout(2000);
    
    const result = await client.readHoldingRegisters(4104, 1);
    console.log(`✅ Baud ${baud}: SUCCESS! Value: ${result.data[0]}`);
    client.close();
    return true;
  } catch (err) {
    console.log(`❌ Baud ${baud}: ${err.message}`);
    client.close();
    return false;
  }
}

async function testAll() {
  console.log('Testing different baud rates...\n');
  
  for (const baud of baudRates) {
    const success = await testBaudRate(baud);
    if (success) {
      console.log(`\n🎉 FOUND WORKING BAUD RATE: ${baud}`);
      process.exit(0);
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  
  console.log('\n❌ No working baud rate found');
}

testAll();