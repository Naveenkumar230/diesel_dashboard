require('dotenv').config();
const nodemailer = require('nodemailer');

// Email configuration
const emailConfig = {
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_APP_PASSWORD
    }
};

const recipients = process.env.ALERT_RECIPIENTS || 'recipient@example.com';

console.log('\n╔════════════════════════════════════════════════════════════╗');
console.log('║          DG MONITORING - EMAIL TEST UTILITY               ║');
console.log('╚════════════════════════════════════════════════════════════╝\n');

console.log('📧 Email Configuration:');
console.log(`   From: ${emailConfig.auth.user}`);
console.log(`   To: ${recipients}`);
console.log(`   Service: Gmail\n`);

// Create transporter
const transporter = nodemailer.createTransport(emailConfig);

// Verify configuration
console.log('🔍 Verifying email configuration...');
transporter.verify((error, success) => {
    if (error) {
        console.error('\n❌ Email Configuration Error:');
        console.error(`   ${error.message}\n`);
        console.log('💡 Troubleshooting Tips:');
        console.log('   1. Make sure EMAIL_USER is set correctly in .env');
        console.log('   2. Verify EMAIL_APP_PASSWORD is your Google App Password (not regular password)');
        console.log('   3. Enable 2-Step Verification in your Google Account');
        console.log('   4. Generate a new App Password at: https://myaccount.google.com/apppasswords\n');
        process.exit(1);
    } else {
        console.log('✅ Email configuration verified successfully!\n');
        sendTestEmail();
    }
});

// Send test email
async function sendTestEmail() {
    console.log('📤 Sending test email...\n');
    
    const mailOptions = {
        from: `"DG Monitoring System" <${emailConfig.auth.user}>`,
        to: recipients,
        subject: '[TEST] DG Monitoring System - Email Test',
        html: `
        <!DOCTYPE html>
        <html>
        <head>
            <style>
                body { font-family: Arial, sans-serif; background: #f4f4f4; margin: 0; padding: 20px; }
                .container { max-width: 600px; margin: 0 auto; background: white; border-radius: 4px; overflow: hidden; box-shadow: 0 4px 8px rgba(0,0,0,0.1); }
                .header { background: #0f62fe; color: white; padding: 24px; text-align: center; }
                .header h1 { margin: 0; font-size: 24px; }
                .content { padding: 32px; }
                .success-box { background: #d4f1f4; border-left: 4px solid #24a148; padding: 16px; margin: 20px 0; }
                .info-table { width: 100%; border-collapse: collapse; margin: 20px 0; }
                .info-table th { background: #f4f4f4; padding: 12px; text-align: left; font-size: 12px; font-weight: 600; }
                .info-table td { padding: 12px; border-bottom: 1px solid #e0e0e0; font-size: 14px; }
                .footer { background: #f4f4f4; padding: 20px; text-align: center; font-size: 12px; color: #8d8d8d; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>⚡ DG Monitoring System</h1>
                </div>
                <div class="content">
                    <div class="success-box">
                        <strong>✅ Success!</strong><br>
                        Email notifications are configured correctly and working.
                    </div>
                    
                    <h2>Test Email Details</h2>
                    <table class="info-table">
                        <tr>
                            <th>Parameter</th>
                            <th>Value</th>
                        </tr>
                        <tr>
                            <td>Test Type</td>
                            <td>Email Configuration Test</td>
                        </tr>
                        <tr>
                            <td>Sender</td>
                            <td>${emailConfig.auth.user}</td>
                        </tr>
                        <tr>
                            <td>Recipients</td>
                            <td>${recipients}</td>
                        </tr>
                        <tr>
                            <td>Timestamp</td>
                            <td>${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</td>
                        </tr>
                        <tr>
                            <td>Status</td>
                            <td style="color: #24a148; font-weight: bold;">Operational</td>
                        </tr>
                    </table>
                    
                    <h3>What This Means:</h3>
                    <ul>
                        <li>Your email configuration is correct</li>
                        <li>The system can send alert notifications</li>
                        <li>You will receive alerts for:
                            <ul>
                                <li>Critical diesel levels (≤ ${process.env.CRITICAL_DIESEL_LEVEL || 100}L)</li>
                                <li>Low diesel warnings (≤ ${process.env.WARNING_DIESEL_LEVEL || 150}L)</li>
                                <li>Power loss events</li>
                                <li>Power restoration events</li>
                            </ul>
                        </li>
                    </ul>
                    
                    <p style="margin-top: 24px; padding: 16px; background: #f9f9f9; border-left: 3px solid #0f62fe;">
                        <strong>Note:</strong> Alerts have a cooldown period of ${(process.env.ALERT_COOLDOWN || 1800000) / 60000} minutes to prevent spam. 
                        You won't receive duplicate alerts for the same issue within this timeframe.
                    </p>
                </div>
                <div class="footer">
                    DG Monitoring System - Automated Test Email<br>
                    Dashboard: http://${process.env.PI_IP_ADDRESS || '192.168.2.241'}:${process.env.PORT || 3000}
                </div>
            </div>
        </body>
        </html>
        `
    };

    try {
        const info = await transporter.sendMail(mailOptions);
        console.log('✅ Test email sent successfully!\n');
        console.log('📬 Email Details:');
        console.log(`   Message ID: ${info.messageId}`);
        console.log(`   Response: ${info.response}\n`);
        console.log('🎉 Email system is ready to use!');
        console.log('   Check your inbox at:', recipients.split(',')[0]);
        console.log('   (Also check spam/junk folder)\n');
        process.exit(0);
    } catch (error) {
        console.error('\n❌ Failed to send test email:');
        console.error(`   ${error.message}\n`);
        
        if (error.code === 'EAUTH') {
            console.log('💡 Authentication Error - Possible causes:');
            console.log('   1. Incorrect App Password');
            console.log('   2. App Password not generated yet');
            console.log('   3. 2-Step Verification not enabled\n');
            console.log('📝 Steps to fix:');
            console.log('   1. Go to: https://myaccount.google.com/security');
            console.log('   2. Enable 2-Step Verification');
            console.log('   3. Go to: https://myaccount.google.com/apppasswords');
            console.log('   4. Generate new App Password for "Mail"');
            console.log('   5. Update EMAIL_APP_PASSWORD in .env file\n');
        } else if (error.code === 'ESOCKET') {
            console.log('💡 Connection Error - Possible causes:');
            console.log('   1. No internet connection');
            console.log('   2. Firewall blocking port 587/465');
            console.log('   3. Gmail SMTP servers temporarily unavailable\n');
        }
        
        process.exit(1);
    }
}