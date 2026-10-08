import qrcode from "qrcode-generator";

/** Visible width of qrLines() output. */
export function qrWidth(text: string, margin = 2): number {
  const code = qrcode(0, "M");
  code.addData(text, "Byte");
  code.make();
  return code.getModuleCount() + margin * 2;
}
/** Terminal lines for a QR code: two modules per row with half blocks, dark on an explicit light background. */
export function qrLines(text: string, margin = 2): string[] {
  const code = qrcode(0, "M");
  code.addData(text, "Byte");
  code.make();
  const count = code.getModuleCount();
  const dark = (row: number, col: number) => row >= 0 && col >= 0 && row < count && col < count && code.isDark(row, col);
  const lines: string[] = [];
  for (let row = -margin; row < count + margin; row += 2) {
    let line = "";
    for (let col = -margin; col < count + margin; col++) {
      const top = dark(row, col);
      const bottom = dark(row + 1, col);
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    // Black on white regardless of the terminal theme, so phones can scan it.
    lines.push(`\x1b[30;107m${line}\x1b[0m`);
  }
  return lines;
}
