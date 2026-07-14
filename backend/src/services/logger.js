import fs from "node:fs";
import path from "node:path";
import winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";
import { config } from "../config.js";

fs.mkdirSync(config.logsDir, { recursive: true });

const baseFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

const fileTransport = new DailyRotateFile({
  dirname: config.logsDir,
  filename: "reaper-%DATE%.log",
  datePattern: "YYYY-MM-DD",
  maxSize: "100m",
  maxFiles: "10",
  zippedArchive: false
});

const consoleTransport = new winston.transports.Console();

export const logger = winston.createLogger({
  level: config.logLevel,
  format: baseFormat,
  defaultMeta: {
    service: "reaper-backend"
  },
  transports: [fileTransport, consoleTransport]
});

export const httpLogStream = {
  write(message) {
    logger.info("http_request", {
      source: "http",
      details: message.trim()
    });
  }
};

export function logServerEvent(level, message, meta = {}) {
  logger.log(level, message, {
    source: meta.source || "server",
    ...meta
  });
}

export function resolveLogDirectory() {
  return path.resolve(config.logsDir);
}
