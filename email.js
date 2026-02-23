const nodemailer = require('nodemailer');

function getTransporter() {
  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASS;
  if (!user || !pass) return null;

  return nodemailer.createTransport({
    service: process.env.EMAIL_SERVICE || 'gmail',
    auth: { user, pass },
  });
}

async function sendInviteEmail({ to, name, bookclubName, loginUrl, tempPassword }) {
  const transporter = getTransporter();

  if (!transporter) {
    console.log('\n[EMAIL NOT SENT — set EMAIL_USER and EMAIL_PASS to enable]');
    console.log(`  To: ${to}  |  Temp password: ${tempPassword}\n`);
    return { sent: false };
  }

  await transporter.sendMail({
    from: `"Book Club" <${process.env.EMAIL_USER}>`,
    to,
    subject: `You've been invited to ${bookclubName} Book Club`,
    html: `
      <div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:24px;border:1px solid #d4c9b8;border-radius:8px;">
        <h2 style="color:#2c5f2e;margin-top:0;">Welcome to ${bookclubName}!</h2>
        <p>Hi ${name},</p>
        <p>You've been added to the <strong>${bookclubName}</strong> book club. Use the details below to log in.</p>
        <div style="background:#f5f1eb;border-radius:6px;padding:16px;margin:20px 0;">
          <p style="margin:4px 0;"><strong>Login URL:</strong> <a href="${loginUrl}">${loginUrl}</a></p>
          <p style="margin:4px 0;"><strong>Email:</strong> ${to}</p>
          <p style="margin:4px 0;"><strong>Password:</strong> <code style="background:#fff;padding:2px 6px;border-radius:4px;border:1px solid #d4c9b8;">${tempPassword}</code></p>
        </div>
        <p style="color:#6b6b6b;font-size:0.9em;">Happy reading!</p>
      </div>
    `,
  });

  return { sent: true };
}

module.exports = { sendInviteEmail };
