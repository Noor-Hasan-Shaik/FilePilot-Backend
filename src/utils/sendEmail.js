const nodemailer = require("nodemailer");
const logger = require("./logger");

let transporter = null;
let configured = null;

function isConfigured() {
  if (configured !== null) return configured;
  configured = Boolean(process.env.EMAIL_USER && process.env.EMAIL_PASS);
  if (!configured) {
    logger.warn("Email transport not configured (EMAIL_USER/EMAIL_PASS missing)");
  }
  return configured;
}

function getTransporter() {
  if (transporter) return transporter;
  if (!isConfigured()) return null;
  transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });
  return transporter;
}

const sendEmail = async (to, subject, html) => {
  const t = getTransporter();
  if (!t) {
    const err = new Error("Email service not configured");
    err.status = 503;
    throw err;
  }
  return t.sendMail({
    from: `"FilePilot" <${process.env.EMAIL_USER}>`,
    to,
    subject,
    html,
  });
};

const sendOTP = async (email, otp) => {
  return sendEmail(
    email,
    "Your FilePilot OTP Code",
    `
      <div style="font-family: Arial, sans-serif; max-width: 400px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #333;">OTP Verification</h2>
        <p>Your verification code is:</p>
        <h1 style="color: #4F46E5; letter-spacing: 4px; font-size: 32px;">${otp}</h1>
        <p style="color: #666; font-size: 14px;">This code will expire in 10 minutes. Do not share it with anyone.</p>
      </div>
    `
  );
};

module.exports = { sendEmail, sendOTP, isEmailConfigured: isConfigured };
