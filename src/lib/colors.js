// Simple ANSI color utility (replaces chalk dependency)

const codes = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
}

const wrap = (code) => (str) => `${code}${str}${codes.reset}`

const colors = {
  red: wrap(codes.red),
  green: wrap(codes.green),
  yellow: wrap(codes.yellow),
  blue: wrap(codes.blue),
  cyan: wrap(codes.cyan),
  gray: wrap(codes.gray),
  bold: wrap(codes.bold),
}

module.exports = colors
