/* Formatting for the tabs we write.
 *
 * The numbers were already right; the sheet was just unreadable — truncated
 * labels, raw floats, no separation between the summary and the table. Andrew
 * opens this to check what people are owed, so it should be scannable in a few
 * seconds rather than parsed.
 *
 * The palette is the dashboard's, adapted for a white page: warm near-black
 * headers, the orange used on the TV as the single accent, and colour carrying
 * meaning rather than decoration — green is being paid, amber is short on
 * hours, red is forfeited.
 */

const rgb = hex => ({
  red:   parseInt(hex.slice(1, 3), 16) / 255,
  green: parseInt(hex.slice(3, 5), 16) / 255,
  blue:  parseInt(hex.slice(5, 7), 16) / 255
});

export const INK      = rgb("#1a1815");   // header bands
export const ACCENT   = rgb("#f0762e");   // the TV's orange
export const PAPER    = rgb("#ffffff");
export const BAND     = rgb("#faf8f5");   // barely-there row striping
export const RULE     = rgb("#e4e0d9");
export const MUTED    = rgb("#8b857a");
export const GOOD     = rgb("#0a7d0a");
export const WARN     = rgb("#a8710a");
export const CRIT     = rgb("#c0392b");

export const MONEY = '"$"#,##0.00';
export const NUM   = "#,##0";
export const HOURS = "#,##0.##";

const cell = (sheetId, r0, r1, c0, c1, format, fields) => ({
  repeatCell: {
    range: { sheetId, startRowIndex: r0, endRowIndex: r1, startColumnIndex: c0, endColumnIndex: c1 },
    cell: { userEnteredFormat: format },
    fields
  }
});

const width = (sheetId, index, px) => ({
  updateDimensionProperties: {
    range: { sheetId, dimension: "COLUMNS", startIndex: index, endIndex: index + 1 },
    properties: { pixelSize: px }, fields: "pixelSize"
  }
});

const border = (sheetId, r0, r1, c0, c1, side, style = "SOLID") => ({
  updateBorders: {
    range: { sheetId, startRowIndex: r0, endRowIndex: r1, startColumnIndex: c0, endColumnIndex: c1 },
    [side]: { style, width: 1, color: RULE }
  }
});

/**
 * The month summary. `marks` carries the row positions worked out while the
 * values were built, so nothing here has to guess where the table starts.
 */
export function summaryRequests(sheetId, marks, width_) {
  const W = width_;
  const R = [];

  /* clear any formatting left from a previous shape before laying it on again */
  R.push(cell(sheetId, 0, 200, 0, W,
    { backgroundColor: PAPER, textFormat: { bold: false, italic: false, foregroundColor: rgb("#1a1815"), fontSize: 10 },
      numberFormat: { type: "TEXT" }, horizontalAlignment: "LEFT" },
    "userEnteredFormat(backgroundColor,textFormat,numberFormat,horizontalAlignment)"));

  /* column widths — the old sheet truncated every label */
  const widths = [155, 175, 72, 72, 82, 105, 105, 92, 100, 115, 300];
  widths.slice(0, W).forEach((px, i) => R.push(width(sheetId, i, px)));

  /* title band */
  R.push({ mergeCells: { range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: W }, mergeType: "MERGE_ALL" } });
  R.push(cell(sheetId, 0, 1, 0, W,
    { backgroundColor: INK, verticalAlignment: "MIDDLE", padding: { left: 10 },
      textFormat: { bold: true, fontSize: 15, foregroundColor: PAPER } },
    "userEnteredFormat(backgroundColor,textFormat,verticalAlignment,padding)"));
  R.push({ updateDimensionProperties: {
    range: { sheetId, dimension: "ROWS", startIndex: 0, endIndex: 1 },
    properties: { pixelSize: 34 }, fields: "pixelSize" } });

  /* the "generated, do not edit" line */
  R.push({ mergeCells: { range: { sheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: W }, mergeType: "MERGE_ALL" } });
  R.push(cell(sheetId, 1, 2, 0, W,
    { backgroundColor: rgb("#2e2a24"), padding: { left: 10 },
      textFormat: { italic: true, fontSize: 9, foregroundColor: rgb("#c9c3b6") } },
    "userEnteredFormat(backgroundColor,textFormat,padding)"));

  /* the figures block: labels bold-ish, values as money */
  const { kvStart, kvEnd, poolRow, headerRow, bodyStart, bodyEnd, totalRow, states } = marks;

  R.push(cell(sheetId, kvStart, kvEnd, 0, 1,
    { textFormat: { bold: false, fontSize: 10 }, padding: { left: 6 } },
    "userEnteredFormat(textFormat,padding)"));
  R.push(cell(sheetId, kvStart, kvEnd, 1, 2,
    { numberFormat: { type: "NUMBER", pattern: MONEY }, horizontalAlignment: "RIGHT",
      textFormat: { fontSize: 10 } },
    "userEnteredFormat(numberFormat,horizontalAlignment,textFormat)"));
  R.push(cell(sheetId, kvStart, kvEnd, 3, W,
    { textFormat: { fontSize: 9, foregroundColor: MUTED, italic: true } },
    "userEnteredFormat(textFormat)"));

  /* the pool line is the number people look for */
  if (poolRow != null) {
    R.push(cell(sheetId, poolRow, poolRow + 1, 0, 2,
      { backgroundColor: rgb("#fdf1e8"),
        textFormat: { bold: true, fontSize: 12, foregroundColor: rgb("#8a3d0f") } },
      "userEnteredFormat(backgroundColor,textFormat)"));
    R.push(cell(sheetId, poolRow, poolRow + 1, 1, 2,
      { numberFormat: { type: "NUMBER", pattern: MONEY }, horizontalAlignment: "RIGHT" },
      "userEnteredFormat(numberFormat,horizontalAlignment)"));
    R.push(border(sheetId, poolRow, poolRow + 1, 0, W, "top"));
    R.push(border(sheetId, poolRow, poolRow + 1, 0, W, "bottom"));
  }

  /* table header */
  R.push(cell(sheetId, headerRow, headerRow + 1, 0, W,
    { backgroundColor: INK, verticalAlignment: "MIDDLE",
      textFormat: { bold: true, fontSize: 9, foregroundColor: PAPER } },
    "userEnteredFormat(backgroundColor,textFormat,verticalAlignment)"));
  R.push(cell(sheetId, headerRow, headerRow + 1, 2, W - 1,
    { horizontalAlignment: "RIGHT" }, "userEnteredFormat(horizontalAlignment)"));
  R.push({ updateDimensionProperties: {
    range: { sheetId, dimension: "ROWS", startIndex: headerRow, endIndex: headerRow + 1 },
    properties: { pixelSize: 26 }, fields: "pixelSize" } });

  /* body: numbers right-aligned and formatted */
  if (bodyEnd > bodyStart) {
    R.push(cell(sheetId, bodyStart, bodyEnd, 0, 1,
      { textFormat: { bold: true, fontSize: 10 }, padding: { left: 6 } },
      "userEnteredFormat(textFormat,padding)"));
    R.push(cell(sheetId, bodyStart, bodyEnd, 2, 3,
      { numberFormat: { type: "NUMBER", pattern: HOURS }, horizontalAlignment: "RIGHT" },
      "userEnteredFormat(numberFormat,horizontalAlignment)"));
    R.push(cell(sheetId, bodyStart, bodyEnd, 3, 5,
      { numberFormat: { type: "NUMBER", pattern: NUM }, horizontalAlignment: "RIGHT" },
      "userEnteredFormat(numberFormat,horizontalAlignment)"));
    R.push(cell(sheetId, bodyStart, bodyEnd, 5, 10,
      { numberFormat: { type: "NUMBER", pattern: MONEY }, horizontalAlignment: "RIGHT" },
      "userEnteredFormat(numberFormat,horizontalAlignment)"));
    /* take-home is the column that gets read */
    R.push(cell(sheetId, bodyStart, bodyEnd, 9, 10,
      { textFormat: { bold: true, fontSize: 10 }, backgroundColor: rgb("#f4f9f4") },
      "userEnteredFormat(textFormat,backgroundColor)"));
    R.push(cell(sheetId, bodyStart, bodyEnd, 10, 11,
      { textFormat: { fontSize: 9, italic: true, foregroundColor: MUTED },
        wrapStrategy: "CLIP" },
      "userEnteredFormat(textFormat,wrapStrategy)"));

    /* striping */
    for (let r = bodyStart; r < bodyEnd; r++) {
      if ((r - bodyStart) % 2 === 1) {
        R.push(cell(sheetId, r, r + 1, 0, 9,
          { backgroundColor: BAND }, "userEnteredFormat(backgroundColor)"));
      }
    }

    /* colour carries the state: paid, short on hours, walked out */
    for (const r of states.forfeited) {
      R.push(cell(sheetId, r, r + 1, 0, W,
        { backgroundColor: rgb("#fdeceb"), textFormat: { foregroundColor: CRIT, fontSize: 10 } },
        "userEnteredFormat(backgroundColor,textFormat)"));
    }
    for (const r of states.short) {
      R.push(cell(sheetId, r, r + 1, 0, 2,
        { textFormat: { foregroundColor: MUTED, fontSize: 10 } },
        "userEnteredFormat(textFormat)"));
    }
    for (const r of states.paid) {
      R.push(cell(sheetId, r, r + 1, 9, 10,
        { textFormat: { bold: true, fontSize: 10, foregroundColor: GOOD } },
        "userEnteredFormat(textFormat)"));
    }
  }

  /* totals */
  if (totalRow != null) {
    R.push(cell(sheetId, totalRow, totalRow + 1, 0, W,
      { backgroundColor: rgb("#efece7"), textFormat: { bold: true, fontSize: 10 } },
      "userEnteredFormat(backgroundColor,textFormat)"));
    R.push(cell(sheetId, totalRow, totalRow + 1, 5, 10,
      { numberFormat: { type: "NUMBER", pattern: MONEY }, horizontalAlignment: "RIGHT" },
      "userEnteredFormat(numberFormat,horizontalAlignment)"));
    R.push(cell(sheetId, totalRow, totalRow + 1, 3, 5,
      { numberFormat: { type: "NUMBER", pattern: NUM }, horizontalAlignment: "RIGHT" },
      "userEnteredFormat(numberFormat,horizontalAlignment)"));
    R.push(border(sheetId, totalRow, totalRow + 1, 0, W, "top", "SOLID_MEDIUM"));
  }

  /* keep the table header in view while scrolling the roster */
  R.push({ updateSheetProperties: {
    properties: { sheetId, gridProperties: { frozenRowCount: headerRow + 1 } },
    fields: "gridProperties.frozenRowCount" } });

  return R;
}

/** The backup tab — dense, but it should still be findable. */
export function backupRequests(sheetId, headerRow, rowCount, W) {
  const R = [];
  R.push(cell(sheetId, 0, rowCount + 5, 0, W,
    { backgroundColor: PAPER, textFormat: { bold: false, italic: false, fontSize: 10 } },
    "userEnteredFormat(backgroundColor,textFormat)"));

  [90, 95, 90, 165, 330, 85, 105, 130].slice(0, W).forEach((px, i) => R.push(width(sheetId, i, px)));

  R.push({ mergeCells: { range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: W }, mergeType: "MERGE_ALL" } });
  R.push(cell(sheetId, 0, 1, 0, W,
    { backgroundColor: INK, padding: { left: 10 }, verticalAlignment: "MIDDLE",
      textFormat: { bold: true, fontSize: 13, foregroundColor: PAPER } },
    "userEnteredFormat(backgroundColor,textFormat,padding,verticalAlignment)"));
  R.push({ mergeCells: { range: { sheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: W }, mergeType: "MERGE_ALL" } });
  R.push(cell(sheetId, 1, 2, 0, W,
    { backgroundColor: rgb("#fdf1e8"), padding: { left: 10 },
      textFormat: { italic: true, fontSize: 9, foregroundColor: rgb("#8a3d0f") } },
    "userEnteredFormat(backgroundColor,textFormat,padding)"));

  R.push(cell(sheetId, headerRow, headerRow + 1, 0, W,
    { backgroundColor: INK, textFormat: { bold: true, fontSize: 9, foregroundColor: PAPER } },
    "userEnteredFormat(backgroundColor,textFormat)"));
  R.push(cell(sheetId, headerRow + 1, headerRow + 1 + rowCount, 0, 1,
    { textFormat: { bold: true, fontSize: 9 } }, "userEnteredFormat(textFormat)"));
  R.push(cell(sheetId, headerRow + 1, headerRow + 1 + rowCount, 5, 6,
    { horizontalAlignment: "RIGHT" }, "userEnteredFormat(horizontalAlignment)"));
  R.push(cell(sheetId, headerRow + 1, headerRow + 1 + rowCount, 6, W,
    { textFormat: { fontSize: 9, foregroundColor: MUTED } }, "userEnteredFormat(textFormat)"));

  R.push({ updateSheetProperties: {
    properties: { sheetId, gridProperties: { frozenRowCount: headerRow + 1 } },
    fields: "gridProperties.frozenRowCount" } });
  return R;
}

/** Matthew's Hours tab — the one a person types into every week. */
export function hoursRequests(sheetId, rowCount) {
  const R = [];
  [200, 120, 90, 260].forEach((px, i) => R.push(width(sheetId, i, px)));
  R.push(cell(sheetId, 0, 1, 0, 4,
    { backgroundColor: INK, verticalAlignment: "MIDDLE",
      textFormat: { bold: true, fontSize: 10, foregroundColor: PAPER } },
    "userEnteredFormat(backgroundColor,textFormat,verticalAlignment)"));
  R.push({ updateDimensionProperties: {
    range: { sheetId, dimension: "ROWS", startIndex: 0, endIndex: 1 },
    properties: { pixelSize: 28 }, fields: "pixelSize" } });
  R.push(cell(sheetId, 1, Math.max(rowCount + 1, 60), 2, 3,
    { numberFormat: { type: "NUMBER", pattern: HOURS }, horizontalAlignment: "RIGHT" },
    "userEnteredFormat(numberFormat,horizontalAlignment)"));
  R.push(cell(sheetId, 1, Math.max(rowCount + 1, 60), 0, 1,
    { textFormat: { bold: true, fontSize: 10 } }, "userEnteredFormat(textFormat)"));
  R.push({ updateSheetProperties: {
    properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
    fields: "gridProperties.frozenRowCount" } });
  return R;
}
