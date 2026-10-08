/** Size columns for the actual decimals across the whole section, including
 * padding, borders and a gutter. Numeric Times/Arial glyphs are half an em.
 */
export function registerColumnWidths(rows, weights, component, header = '') {
  const em = (component ? 6.2 : 8.5) * 25.4 / 72;
  const gutter = component ? 1 : 1.5;
  const widths = weights.map((weight) => Math.max(component ? 3.2 : 5, weight * (component ? 2.4 : 4)));
  const occupied = [];
  [...header.matchAll(/<tr>(.*?)<\/tr>/gs)].forEach((row, rowIndex) => {
    let column = 0;
    for (const cell of row[1].matchAll(/<th([^>]*)>(.*?)<\/th>/gs)) {
      while (occupied[rowIndex]?.[column]) column += 1;
      const columns = Number(cell[1].match(/colspan="(\d+)"/)?.[1] || 1);
      const rowSpan = Number(cell[1].match(/rowspan="(\d+)"/)?.[1] || 1);
      const headerEm = (component ? 5.6 : 7.5) * 25.4 / 72;
      const lines = cell[2].split(/<br\s*\/?\s*>/i);
      const units = /class="vertical"/.test(cell[1]) ? 1 : Math.max(...lines.map((line) =>
        [...line.replace(/&[^;]+;/g, 'W')].reduce((sum, char) => sum +
          (/\d/.test(char) ? .5 : /[il]/.test(char) ? .3 : char === 'r' ? .5 : char === 'W' ? 1 : /[A-Z]/.test(char) ? .85 : .65), 0)));
      for (let offset = 0; offset < columns; offset += 1) {
        if (column + offset >= 2) widths[column + offset - 2] = Math.max(widths[column + offset - 2], (units * headerEm + gutter) / columns);
        for (let depth = 0; depth < rowSpan; depth += 1) {
          occupied[rowIndex + depth] ||= [];
          occupied[rowIndex + depth][column + offset] = true;
        }
      }
      column += columns;
    }
  });
  for (const row of rows) {
    const cells = [...row.matchAll(/<td(?:\s[^>]*)?>(.*?)<\/td>/gs)].slice(2);
    cells.forEach((cell, index) => {
      const text = cell[1].replace(/&[^;]+;/g, 'W');
      const units = [...text].reduce((sum, char) => sum + (/\d/.test(char) ? .5 : char === '.' ? .25 : .75), 0);
      widths[index] = Math.max(widths[index], units * em + gutter);
    });
  }
  const available = component ? 245 : 220;
  const required = widths.reduce((sum, width) => sum + width, 0);
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  const fit = Math.min(1, available / required);
  // An unusually dense register must scale its text as well as its columns;
  // shrinking widths alone would reproduce the decimal overlap.
  const fontScale = fit === 1 ? 1 : Math.min(...widths.map((width) => (width * fit - gutter) / (width - gutter)));
  return {
    widths: widths.map((width, index) => fit === 1
      ? width + (available - required) * weights[index] / weightTotal : width * fit),
    fontSize: (component ? 6.2 : 8.5) * fontScale,
    headerFontSize: (component ? 5.6 : 7.5) * fontScale,
  };
}
