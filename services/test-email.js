//
// --- test-email.js ---
//
// This script tests your email configuration by sending a
// single "DG Startup" email.
//

// 1. Load all variables from your .env file
require('dotenv').config({ path: '../.env' });
// 2. Import the functions from your existing email service
const { initializeEmail, sendStartupAlert, isEmailEnabled } = require('./emailService');
// 3. Define an async function to run the test
async function runTest() {
  console.log('Initializing email service...');
  
  // This reads the .env file and sets up Nodemailer
  initializeEmail();

  // Check if email was enabled (i.e., .env variables were found)
  if (!isEmailEnabled()) {
    console.error('----------------------------------------------------');
    console.error('🛑 ERROR: Email service is not enabled.');
    console.error('   Please check your .env file. Make sure');
    console.error('   EMAIL_USER, EMAIL_APP_PASSWORD, and ALERT_RECIPIENTS are set correctly.');
    console.error('----------------------------------------------------');
    return;
  }

  console.log(`Attempting to send a test email to: ${process.env.ALERT_RECIPIENTS}`);

  // 1. Create some fake data for the email template
  const dgName = 'TEST GENERATOR';
  const fakeValues = {
    activePower: 150.5,
    frequency: 50.1,
    powerFactor: 0.98,
    voltageR: 230.1,
    voltageY: 230.2,
    voltageB: 230.3,
    currentR: 50.1,
    currentY: 50.2,
    currentB: 50.3,
    reactivePower: 25.0,
    energyMeter: 12345,
    runningHours: 987,
    windingTemp: 65
  };

  try {
    // 2. Call the *exact same function* your main app uses
    await sendStartupAlert(dgName, fakeValues);
    
    console.log('----------------------------------------------------');
    console.log('✅ Test email sent successfully!');
    console.log(`   Please check the inbox for: ${process.env.ALERT_RECIPIENTS}`);
    console.log('----------------------------------------------------');
  
  } catch (error) {
    console.error('----------------------------------------------------');
    console.error('🛑 ERROR: Failed to send test email:');
    console.error(error.message);
    console.error('----------------------------------------------------');
  }
}

// 4. Run the test
runTest();