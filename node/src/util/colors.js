// Лёгкие ANSI-цвета. Уважает NO_COLOR и не-TTY.
const enabled = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code) => (s) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : String(s));

export const c = {
  green: wrap('32'),
  red: wrap('31'),
  yellow: wrap('33'),
  cyan: wrap('36'),
  gray: wrap('90'),
  bold: wrap('1'),
  magenta: wrap('35'),
  dim: wrap('2'),
};
