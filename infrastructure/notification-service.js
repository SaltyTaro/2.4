/**
 * Notification service for MEV strategies
 * Handles alerts, notifications, and reporting through multiple channels
 */
const axios = require('axios');
const nodemailer = require('nodemailer');
const ethers = require('ethers');
const { Logger } = require('./logging');

// Logger setup
const logger = new Logger('NotificationService');

class NotificationService {
  constructor(options = {}) {
    this.options = {
      enableEmail: process.env.ENABLE_EMAIL === 'true',
      enableSlack: process.env.ENABLE_SLACK === 'true',
      enableTelegram: process.env.ENABLE_TELEGRAM === 'true',
      enableDiscord: process.env.ENABLE_DISCORD === 'true',
      enableSms: process.env.ENABLE_SMS === 'true',
      emailConfig: {
        host: process.env.EMAIL_HOST || 'smtp.example.com',
        port: parseInt(process.env.EMAIL_PORT || '587'),
        secure: process.env.EMAIL_SECURE === 'true',
        auth: {
          user: process.env.EMAIL_USER || '',
          pass: process.env.EMAIL_PASS || ''
        }
      },
      emailRecipients: (process.env.EMAIL_RECIPIENTS || '').split(',').filter(Boolean),
      slackWebhook: process.env.SLACK_WEBHOOK || '',
      telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
      telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
      discordWebhook: process.env.DISCORD_WEBHOOK || '',
      smsConfig: {
        accountSid: process.env.TWILIO_ACCOUNT_SID || '',
        authToken: process.env.TWILIO_AUTH_TOKEN || '',
        fromNumber: process.env.TWILIO_FROM_NUMBER || '',
        toNumbers: (process.env.SMS_RECIPIENTS || '').split(',').filter(Boolean)
      },
      notificationThresholds: {
        opportunity: ethers.utils.parseEther('0.1'), // 0.1 ETH
        profit: ethers.utils.parseEther('0.05'),     // 0.05 ETH
        loss: ethers.utils.parseEther('0.02'),       // 0.02 ETH
      },
      alertCooldowns: {
        opportunity: 60000,    // 1 minute
        error: 300000,         // 5 minutes
        warning: 1800000,      // 30 minutes
        status: 3600000        // 1 hour
      },
      ...options
    };
    
    this.emailTransporter = null;
    this.lastAlerts = {
      opportunity: 0,
      error: 0,
      warning: 0,
      status: 0
    };
  }

  /**
   * Initialize the notification service
   */
  async initialize() {
    try {
      logger.info('Initializing notification service...');
      
      // Set up email transporter
      if (this.options.enableEmail) {
        this.emailTransporter = nodemailer.createTransport(this.options.emailConfig);
        
        // Verify connection
        await this.emailTransporter.verify();
        logger.info('Email service configured successfully');
      }
      
      logger.info('Notification service initialized successfully');
      return true;
    } catch (error) {
      logger.error('Failed to initialize notification service:', error);
      // Don't throw - allow system to run even if notifications fail
      return false;
    }
  }

  /**
   * Send an opportunity alert
   * @param {Object} opportunity The detected opportunity
   */
  async sendOpportunityAlert(opportunity) {
    try {
      // Skip if below threshold
      const profit = ethers.BigNumber.from(opportunity.estimatedProfit || '0');
      if (profit.lt(this.options.notificationThresholds.opportunity)) {
        return;
      }
      
      // Check cooldown
      if (this.checkCooldown('opportunity')) {
        return;
      }
      
      const title = `MEV Opportunity: ${opportunity.type} - $${opportunity.estimatedProfitUsd}`;
      const message = `
Detected ${opportunity.type} opportunity:
- Hash: ${opportunity.hash}
- Estimated profit: ${ethers.utils.formatEther(profit)} ETH ($${opportunity.estimatedProfitUsd})
- Token pair: ${opportunity.targetTx?.tokenInSymbol || ''}-${opportunity.targetTx?.tokenOutSymbol || ''}
- ROI: ${opportunity.bestStrategy?.roiBps ? (opportunity.bestStrategy.roiBps / 100).toFixed(2) : 0}%
      `.trim();
      
      // Send through enabled channels
      await this.sendNotification(title, message, 'opportunity');
    } catch (error) {
      logger.error('Error sending opportunity alert:', error);
    }
  }

  /**
   * Send an execution result notification
   * @param {Object} execution The execution result
   * @param {boolean} success Whether the execution was successful
   */
  async sendExecutionResult(execution, success) {
    try {
      // Skip if below threshold
      const profit = ethers.BigNumber.from(execution.profit || '0');
      const threshold = success ? 
        this.options.notificationThresholds.profit : 
        this.options.notificationThresholds.loss;
      
      if (profit.lt(threshold)) {
        return;
      }
      
      const profitStr = ethers.utils.formatEther(profit);
      const profitUsd = execution.profitUsd || '0.00';
      
      const title = success ? 
        `MEV Executed: ${execution.type} - $${profitUsd}` : 
        `MEV Failed: ${execution.type} - Loss $${profitUsd}`;
      
      const message = `
${success ? 'Successfully executed' : 'Failed to execute'} ${execution.type} strategy:
- Transaction: ${execution.transactionHash}
- ${success ? 'Profit' : 'Loss'}: ${profitStr} ETH ($${profitUsd})
- Gas used: ${execution.gasUsed}
- Time: ${new Date().toISOString()}
      `.trim();
      
      // Send through enabled channels
      await this.sendNotification(title, message, success ? 'profit' : 'error');
    } catch (error) {
      logger.error('Error sending execution result notification:', error);
    }
  }

  /**
   * Send an error notification
   * @param {string} title Error title
   * @param {string} message Error message
   * @param {Object} details Additional details
   */
  async sendErrorNotification(title, message, details = {}) {
    try {
      // Check cooldown
      if (this.checkCooldown('error')) {
        return;
      }
      
      const fullMessage = `
ERROR: ${message}
${Object.entries(details).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}
Time: ${new Date().toISOString()}
      `.trim();
      
      // Send through enabled channels
      await this.sendNotification(`MEV Error: ${title}`, fullMessage, 'error');
    } catch (error) {
      logger.error('Error sending error notification:', error);
    }
  }

  /**
   * Send a warning notification
   * @param {string} title Warning title
   * @param {string} message Warning message
   * @param {Object} details Additional details
   */
  async sendWarningNotification(title, message, details = {}) {
    try {
      // Check cooldown
      if (this.checkCooldown('warning')) {
        return;
      }
      
      const fullMessage = `
WARNING: ${message}
${Object.entries(details).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}
Time: ${new Date().toISOString()}
      `.trim();
      
      // Send through enabled channels
      await this.sendNotification(`MEV Warning: ${title}`, fullMessage, 'warning');
    } catch (error) {
      logger.error('Error sending warning notification:', error);
    }
  }

  /**
   * Send a system status notification
   * @param {Object} status System status
   */
  async sendStatusNotification(status) {
    try {
      // Check cooldown
      if (this.checkCooldown('status')) {
        return;
      }
      
      const title = 'MEV System Status Update';
      const message = `
System Status Update:
- Current exposure: ${ethers.utils.formatEther(status.currentExposure || '0')} ETH
- Daily profit: ${ethers.utils.formatEther(status.dailyProfit || '0')} ETH
- Opportunities detected: ${status.opportunitiesDetected || 0}
- Opportunities executed: ${status.opportunitiesExecuted || 0}
- Success rate: ${status.successRate ? (status.successRate * 100).toFixed(2) : 0}%
- Active circuit breakers: ${status.circuitBreakers || 'None'}
- Time: ${new Date().toISOString()}
      `.trim();
      
      // Send through enabled channels
      await this.sendNotification(title, message, 'status');
    } catch (error) {
      logger.error('Error sending status notification:', error);
    }
  }

  /**
   * Check alert cooldown
   * @param {string} alertType Alert type
   * @returns {boolean} Whether to skip alert due to cooldown
   */
  checkCooldown(alertType) {
    const now = Date.now();
    const lastAlert = this.lastAlerts[alertType] || 0;
    const cooldown = this.options.alertCooldowns[alertType] || 0;
    
    if (now - lastAlert < cooldown) {
      return true; // Skip due to cooldown
    }
    
    // Update last alert time
    this.lastAlerts[alertType] = now;
    return false; // OK to send
  }

  /**
   * Send notification through all enabled channels
   * @param {string} title Notification title
   * @param {string} message Notification message
   * @param {string} type Notification type
   */
  async sendNotification(title, message, type) {
    const promises = [];
    
    // Send via email
    if (this.options.enableEmail && this.emailTransporter) {
      promises.push(this.sendEmail(title, message, type));
    }
    
    // Send via Slack
    if (this.options.enableSlack && this.options.slackWebhook) {
      promises.push(this.sendSlack(title, message, type));
    }
    
    // Send via Telegram
    if (this.options.enableTelegram && this.options.telegramBotToken && this.options.telegramChatId) {
      promises.push(this.sendTelegram(title, message, type));
    }
    
    // Send via Discord
    if (this.options.enableDiscord && this.options.discordWebhook) {
      promises.push(this.sendDiscord(title, message, type));
    }
    
    // Send via SMS
    if (this.options.enableSms && 
        this.options.smsConfig.accountSid && 
        this.options.smsConfig.authToken &&
        this.options.smsConfig.toNumbers.length > 0) {
      promises.push(this.sendSms(title, message, type));
    }
    
    // Wait for all notifications to complete
    await Promise.allSettled(promises);
  }

  /**
   * Send notification via email
   * @param {string} title Notification title
   * @param {string} message Notification message
   * @param {string} type Notification type
   */
  async sendEmail(title, message, type) {
    try {
      // Skip if no recipients
      if (!this.options.emailRecipients.length) {
        return;
      }
      
      // Prepare email
      const mailOptions = {
        from: this.options.emailConfig.auth.user,
        to: this.options.emailRecipients.join(','),
        subject: title,
        text: message,
        html: `<pre>${message}</pre>`
      };
      
      // Send email
      await this.emailTransporter.sendMail(mailOptions);
      logger.debug(`Email notification sent: ${title}`);
    } catch (error) {
      logger.error('Error sending email notification:', error);
    }
  }

  /**
   * Send notification via Slack
   * @param {string} title Notification title
   * @param {string} message Notification message
   * @param {string} type Notification type
   */
  async sendSlack(title, message, type) {
    try {
      // Prepare Slack message
      const color = this.getColorForType(type);
      
      const payload = {
        attachments: [
          {
            color,
            title,
            text: message,
            ts: Math.floor(Date.now() / 1000)
          }
        ]
      };
      
      // Send to Slack
      await axios.post(this.options.slackWebhook, payload);
      logger.debug(`Slack notification sent: ${title}`);
    } catch (error) {
      logger.error('Error sending Slack notification:', error);
    }
  }

  /**
   * Send notification via Telegram
   * @param {string} title Notification title
   * @param {string} message Notification message
   * @param {string} type Notification type
   */
  async sendTelegram(title, message, type) {
    try {
      // Prepare Telegram message
      const text = `*${title}*\n\n${message}`;
      const url = `https://api.telegram.org/bot${this.options.telegramBotToken}/sendMessage`;
      
      const payload = {
        chat_id: this.options.telegramChatId,
        text,
        parse_mode: 'Markdown'
      };
      
      // Send to Telegram
      await axios.post(url, payload);
      logger.debug(`Telegram notification sent: ${title}`);
    } catch (error) {
      logger.error('Error sending Telegram notification:', error);
    }
  }

  /**
   * Send notification via Discord
   * @param {string} title Notification title
   * @param {string} message Notification message
   * @param {string} type Notification type
   */
  async sendDiscord(title, message, type) {
    try {
      // Prepare Discord message
      const color = this.getColorForType(type);
      
      const payload = {
        embeds: [
          {
            title,
            description: `\`\`\`${message}\`\`\``,
            color: parseInt(color.replace('#', ''), 16),
            timestamp: new Date().toISOString()
          }
        ]
      };
      
      // Send to Discord
      await axios.post(this.options.discordWebhook, payload);
      logger.debug(`Discord notification sent: ${title}`);
    } catch (error) {
      logger.error('Error sending Discord notification:', error);
    }
  }

  /**
   * Send notification via SMS
   * @param {string} title Notification title
   * @param {string} message Notification message
   * @param {string} type Notification type
   */
  async sendSms(title, message, type) {
    try {
      // Skip for non-critical alerts to avoid SMS costs
      if (!['error', 'warning'].includes(type)) {
        return;
      }
      
      // Set up Twilio client
      const twilioClient = require('twilio')(
        this.options.smsConfig.accountSid,
        this.options.smsConfig.authToken
      );
      
      // Prepare and send SMS to each recipient
      const smsText = `${title}: ${message.slice(0, 140)}`;
      
      for (const toNumber of this.options.smsConfig.toNumbers) {
        await twilioClient.messages.create({
          body: smsText,
          from: this.options.smsConfig.fromNumber,
          to: toNumber
        });
      }
      
      logger.debug(`SMS notification sent: ${title}`);
    } catch (error) {
      logger.error('Error sending SMS notification:', error);
    }
  }

  /**
   * Get color for notification type
   * @param {string} type Notification type
   * @returns {string} Color hex code
   */
  getColorForType(type) {
    switch (type) {
      case 'opportunity':
        return '#36a64f'; // Green
      case 'profit':
        return '#2eb886'; // Bright green
      case 'error':
        return '#d00000'; // Red
      case 'warning':
        return '#ffaa00'; // Orange
      case 'status':
        return '#3296f8'; // Blue
      default:
        return '#cccccc'; // Grey
    }
  }
}

module.exports = {
  NotificationService
};