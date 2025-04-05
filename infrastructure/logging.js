/**
 * Logging infrastructure for MEV strategies
 * Provides structured logging with different levels and formats
 */
const winston = require('winston');
const { format, transports, createLogger } = winston;
const path = require('path');
const fs = require('fs');
require('winston-daily-rotate-file');

// Constants
const LOG_LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  verbose: 4,
  debug: 5,
  silly: 6
};

// Create logs directory if it doesn't exist
const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

/**
 * Custom format for console logs
 */
const consoleFormat = format.combine(
  format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  format.colorize(),
  format.printf(({ timestamp, level, message, module, ...meta }) => {
    const moduleStr = module ? `[${module}] ` : '';
    const metaStr = Object.keys(meta).length ? `\n${JSON.stringify(meta, null, 2)}` : '';
    return `${timestamp} ${level}: ${moduleStr}${message}${metaStr}`;
  })
);

/**
 * Custom format for file logs (JSON)
 */
const fileFormat = format.combine(
  format.timestamp(),
  format.json()
);

/**
 * Create a daily rotate file transport
 * @param {string} level Log level
 * @param {string} filename Base filename
 * @returns {Object} Transport
 */
const createDailyRotateTransport = (level, filename) => {
  return new transports.DailyRotateFile({
    level,
    filename: path.join(logsDir, `${filename}-%DATE%.log`),
    datePattern: 'YYYY-MM-DD',
    zippedArchive: true,
    maxSize: '20m',
    maxFiles: '14d'
  });
};

/**
 * Global logger configuration
 */
const globalLoggerConfig = {
  levels: LOG_LEVELS,
  level: process.env.LOG_LEVEL || 'info',
  defaultMeta: { service: 'mev-strategy' },
  transports: [
    // Console transport (all levels)
    new transports.Console({
      format: consoleFormat
    }),
    
    // File transports (separate files for different levels)
    createDailyRotateTransport('error', 'error'),
    createDailyRotateTransport('info', 'combined')
  ],
  exceptionHandlers: [
    new transports.Console({
      format: consoleFormat
    }),
    createDailyRotateTransport('error', 'exceptions')
  ],
  rejectionHandlers: [
    new transports.Console({
      format: consoleFormat
    }),
    createDailyRotateTransport('error', 'rejections')
  ]
};

// Create global logger
const globalLogger = createLogger(globalLoggerConfig);

/**
 * Create a child logger with module information
 */
class Logger {
  constructor(module) {
    this.module = module;
    this.logger = globalLogger.child({ module });
  }

  /**
   * Log at error level
   * @param {string} message Log message
   * @param {Object} meta Additional metadata
   */
  error(message, meta = {}) {
    this.logger.error(message, meta);
  }

  /**
   * Log at warn level
   * @param {string} message Log message
   * @param {Object} meta Additional metadata
   */
  warn(message, meta = {}) {
    this.logger.warn(message, meta);
  }

  /**
   * Log at info level
   * @param {string} message Log message
   * @param {Object} meta Additional metadata
   */
  info(message, meta = {}) {
    this.logger.info(message, meta);
  }

  /**
   * Log at http level
   * @param {string} message Log message
   * @param {Object} meta Additional metadata
   */
  http(message, meta = {}) {
    this.logger.http(message, meta);
  }

  /**
   * Log at verbose level
   * @param {string} message Log message
   * @param {Object} meta Additional metadata
   */
  verbose(message, meta = {}) {
    this.logger.verbose(message, meta);
  }

  /**
   * Log at debug level
   * @param {string} message Log message
   * @param {Object} meta Additional metadata
   */
  debug(message, meta = {}) {
    this.logger.debug(message, meta);
  }

  /**
   * Log at silly level
   * @param {string} message Log message
   * @param {Object} meta Additional metadata
   */
  silly(message, meta = {}) {
    this.logger.silly(message, meta);
  }

  /**
   * Log the start of a process
   * @param {string} processName Name of the process
   */
  startProcess(processName) {
    this.info(`Starting process: ${processName}`);
  }

  /**
   * Log the end of a process
   * @param {string} processName Name of the process
   * @param {number} durationMs Duration in milliseconds
   */
  endProcess(processName, durationMs) {
    this.info(`Completed process: ${processName}`, { durationMs });
  }

  /**
   * Log a transaction
   * @param {Object} tx Transaction details
   */
  transaction(tx) {
    this.info(`Transaction ${tx.hash}`, { tx });
  }

  /**
   * Log an opportunity
   * @param {Object} opportunity Opportunity details
   */
  opportunity(opportunity) {
    this.info(`Detected opportunity ${opportunity.type}`, { opportunity });
  }

  /**
   * Log an execution
   * @param {Object} execution Execution details
   */
  execution(execution) {
    this.info(`Executed strategy ${execution.type}`, { execution });
  }
}

// Create metrics logger for tracking performance data
const metricsLogger = createLogger({
  level: 'info',
  format: fileFormat,
  defaultMeta: { service: 'mev-metrics' },
  transports: [
    createDailyRotateTransport('info', 'metrics')
  ]
});

/**
 * Log metrics data
 * @param {string} metricName Name of the metric
 * @param {Object} data Metric data
 */
const logMetrics = (metricName, data) => {
  metricsLogger.info(`${metricName}`, { ...data, timestamp: new Date().toISOString() });
};

module.exports = {
  Logger,
  globalLogger,
  logMetrics
};