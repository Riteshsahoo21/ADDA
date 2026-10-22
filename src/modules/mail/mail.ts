import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../../config/env.js';

interface SendOtpEmailParams {
  email: string;
  otp: string;
  type: 'sign-in' | 'email-verification' | 'forget-password' | 'change-email' | string;
}

let cachedTransporter: Transporter | null = null;

function getSmtpTransporter(): Transporter | null {
  if (!env.smtpHost) return null;
  if (cachedTransporter) return cachedTransporter;

  cachedTransporter = nodemailer.createTransport({
    host: env.smtpHost,
    port: env.smtpPort,
    secure: env.smtpSecure,
    auth: env.smtpUser
      ? {
          user: env.smtpUser,
          pass: env.smtpPass,
        }
      : undefined,
  });

  return cachedTransporter;
}

function getFromAddress(): string {
  if (env.emailFrom) return env.emailFrom;
  if (env.resendApiKey) return 'ADDA <onboarding@resend.dev>';
  return 'ADDA <no-reply@ritzla.in>';
}

function renderOtpEmailHtml(email: string, otp: string, type: string): string {
  const isSignUp = type === 'email-verification' || type === 'sign-in';
  const isPasswordReset = type === 'forget-password';
  const title = isSignUp ? 'Verify Your Email' : isPasswordReset ? 'Reset Your Password' : 'Verification Code';
  const intro = isSignUp
    ? 'Welcome to ADDA! Please use the verification code below to confirm your email and complete your registration.'
    : isPasswordReset
      ? 'Use this code to reset your ADDA password. If you did not request a reset, ignore this email.'
      : 'Use the verification code below to continue with your ADDA account.';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    body {
      margin: 0;
      padding: 0;
      background-color: #0b0e14;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      color: #e2e8f0;
    }
    .wrapper {
      width: 100%;
      background-color: #0b0e14;
      padding: 40px 16px;
    }
    .container {
      max-width: 520px;
      margin: 0 auto;
      background-color: #121722;
      border: 1px solid #1e2638;
      border-radius: 16px;
      overflow: hidden;
      box-shadow: 0 10px 25px rgba(0, 0, 0, 0.5);
    }
    .header {
      background: linear-gradient(135deg, #1a2234 0%, #151a26 100%);
      padding: 32px 32px 24px;
      text-align: center;
      border-bottom: 1px solid #1e2638;
    }
    .logo {
      font-size: 28px;
      font-weight: 900;
      letter-spacing: 4px;
      color: #f59e0b;
      margin: 0;
      text-transform: uppercase;
    }
    .tagline {
      font-size: 13px;
      color: #94a3b8;
      margin-top: 6px;
      letter-spacing: 1px;
    }
    .content {
      padding: 32px;
    }
    .greeting {
      font-size: 18px;
      font-weight: 700;
      color: #f8fafc;
      margin-top: 0;
      margin-bottom: 12px;
    }
    .message {
      font-size: 15px;
      line-height: 1.6;
      color: #cbd5e1;
      margin-bottom: 24px;
    }
    .otp-box {
      background-color: #0d121c;
      border: 2px dashed #f59e0b;
      border-radius: 12px;
      padding: 24px 16px;
      text-align: center;
      margin: 28px 0;
    }
    .otp-code {
      font-family: 'SF Mono', Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
      font-size: 38px;
      font-weight: 800;
      letter-spacing: 10px;
      color: #f59e0b;
      margin: 0;
      display: inline-block;
      padding-left: 10px; /* balance out letter spacing */
    }
    .expiry {
      font-size: 13px;
      color: #fbbf24;
      text-align: center;
      margin-top: -12px;
      margin-bottom: 24px;
      font-weight: 600;
    }
    .security-note {
      font-size: 13px;
      color: #64748b;
      line-height: 1.5;
      background-color: #0a0d13;
      border-radius: 8px;
      padding: 12px 16px;
      margin-top: 24px;
    }
    .footer {
      padding: 20px 32px;
      background-color: #0d121c;
      text-align: center;
      border-top: 1px solid #1e2638;
      font-size: 12px;
      color: #64748b;
    }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="container">
      <div class="header">
        <h1 class="logo">ADDA</h1>
        <div class="tagline">3D Realtime Social Hangout</div>
      </div>
      <div class="content">
        <h2 class="greeting">${title}</h2>
        <p class="message">${intro}</p>
        
        <div class="otp-box">
          <div class="otp-code">${otp}</div>
        </div>
        <div class="expiry">⏱ This code expires in 5 minutes</div>

        <div class="security-note">
          <strong>Security note:</strong> Never share this code with anyone. ADDA support will never ask for your verification code. If you did not request this, please ignore this email.
        </div>
      </div>
      <div class="footer">
        © 2026 ADDA Hangout. All rights reserved.<br>
        Sent to ${email}
      </div>
    </div>
  </div>
</body>
</html>`;
}

export async function sendOtpEmail({ email, otp, type }: SendOtpEmailParams): Promise<void> {
  const from = getFromAddress();
  const subject = type === 'forget-password'
    ? 'Reset your ADDA password'
    : 'Verify your ADDA email';
  const html = renderOtpEmailHtml(email, otp, type);
  const text = `Your ADDA verification code is: ${otp}. It expires in 5 minutes. If you did not request this code, please ignore this email.`;

  console.log(`[ADDA Mail] Sending ${type} code to ${email}`);

  // 1. Try Resend REST API if RESEND_API_KEY is configured
  if (env.resendApiKey) {
    try {
      console.log(`[ADDA Mail] Sending via Resend API to ${email}...`);
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.resendApiKey}`,
          'Content-Type': 'application/json',
          'User-Agent': 'ADDA-Backend/1.0',
        },
        body: JSON.stringify({
          from,
          to: [email],
          subject,
          html,
          text,
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error(`[ADDA Mail/Resend ERROR] Status ${response.status}: ${errText}`);
        throw new Error(`Resend API error (${response.status}): ${errText}`);
      }

      const data = await response.json().catch(() => ({}));
      console.log(`[ADDA Mail/Resend SUCCESS] Email delivered. ID: ${(data as any)?.id || 'ok'}`);
      return;
    } catch (err: unknown) {
      console.error('[ADDA Mail/Resend ERROR]', err);
      // Fall through to SMTP if available.
      if (!env.smtpHost) {
        throw err;
      }
    }
  }

  // 2. Try SMTP via Nodemailer if SMTP_HOST is configured
  const transporter = getSmtpTransporter();
  if (transporter) {
    try {
      console.log(`[ADDA Mail] Sending via SMTP (${env.smtpHost}:${env.smtpPort}) to ${email}...`);
      const info = await transporter.sendMail({
        from,
        to: email,
        subject,
        html,
        text,
      });
      console.log(`[ADDA Mail/SMTP SUCCESS] Email delivered. MessageId: ${info.messageId}`);
      return;
    } catch (err: unknown) {
      console.error('[ADDA Mail/SMTP ERROR]', err);
      throw err;
    }
  }

  // Never report success or write the OTP into logs when no delivery provider exists.
  throw new Error('Email delivery is not configured. Set RESEND_API_KEY or SMTP_HOST.');
}
