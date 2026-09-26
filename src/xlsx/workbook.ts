import { createZip, type ZipEntry } from './zip.js';

/**
 * A minimal SpreadsheetML (OOXML) workbook writer.
 *
 * It produces a real .xlsx: an Open Packaging Convention container holding
 * workbook.xml, one worksheet per sheet, a styles part and document properties.
 * Excel, LibreOffice, Numbers and `openpyxl` all read it, which is verified by
 * tests that parse the generated archive back and by an external reader.
 *
 * Scope is deliberate: a titled header row, typed cells (text, number, integer),
 * column widths, a frozen header and an autofilter. That is everything a data
 * table needs. Formulas, charts, merged cells and conditional formatting are not
 * emitted — nothing in a weather export calls for them, and each one would be
 * another place to get the schema subtly wrong.
 *
 * Strings are written as `inlineStr` rather than through a shared-strings part:
 * a shared string table only pays off when values repeat heavily, and inlining
 * removes a whole part, an index mapping and a class of off-by-one bugs.
 */

/** Any value a cell may hold. `null`/`undefined` leave the cell empty. */
export type CellValue = string | number | boolean | null | undefined;

/** Selects the number format applied to a column. Defaults to `text`. */
export type ColumnKind = 'text' | 'number' | 'integer' | 'decimal2';

/** Extra emphasis applied to a column, orthogonal to its number format. */
export type ColumnStyle = 'plain' | 'bold' | 'wrapped';

export interface ColumnSpec {
  header: string;
  /** Excel column width in characters. Omitted means the default width. */
  width?: number;
  kind?: ColumnKind;
  /**
   * `bold` marks label columns, `wrapped` lets a long free-text column wrap and
   * top-align inside its row instead of overflowing into the next column.
   */
  style?: ColumnStyle;
}

export interface SheetSpec {
  name: string;
  columns: readonly ColumnSpec[];
  /** One row per entry; each row is aligned to `columns` positionally. */
  rows: readonly (readonly CellValue[])[];
  /** Freeze the header row so it stays visible while scrolling. Defaults to true. */
  freezeHeader?: boolean;
  /** Attach an autofilter over the header row. Defaults to true when there are rows. */
  autoFilter?: boolean;
}

export interface WorkbookSpec {
  sheets: readonly SheetSpec[];
  /** Written to the document properties, not into any sheet. */
  title?: string;
  creator?: string;
  createdAt?: Date;
}

/** Style indexes into the fixed `cellXfs` table below. */
const STYLE = {
  default: 0,
  bold: 1,
  header: 2,
  decimal1: 3,
  decimal2: 4,
  integer: 5,
  wrapped: 6,
} as const;

const NUMBER_FORMAT_IDS = { decimal1: 164, decimal2: 165, integer: 166 } as const;

const SHEET_NAME_MAX = 31;
/** Excel's hard limit on columns per sheet. */
const MAX_COLUMNS = 16_384;

export function buildXlsx(spec: WorkbookSpec): Buffer {
  const sheets = spec.sheets.map((sheet) => normaliseSheet(sheet));
  if (sheets.length === 0) throw new Error('a workbook needs at least one sheet');

  const createdAt = spec.createdAt ?? new Date();
  const creator = spec.creator ?? 'open-meteo-mcp';

  const parts: ZipEntry[] = [
    { name: '[Content_Types].xml', data: contentTypesXml(sheets.length) },
    { name: '_rels/.rels', data: rootRelationshipsXml() },
    { name: 'docProps/core.xml', data: corePropertiesXml({ title: spec.title, creator, createdAt }) },
    { name: 'docProps/app.xml', data: appPropertiesXml(sheets.map((sheet) => sheet.name)) },
    { name: 'xl/workbook.xml', data: workbookXml(sheets) },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRelationshipsXml(sheets.length) },
    { name: 'xl/styles.xml', data: STYLES_XML },
  ];

  sheets.forEach((sheet, index) => {
    parts.push({ name: `xl/worksheets/sheet${index + 1}.xml`, data: sheetXml(sheet) });
  });

  return createZip(parts, { modifiedAt: createdAt });
}

interface NormalisedSheet {
  name: string;
  columns: readonly ColumnSpec[];
  rows: readonly (readonly CellValue[])[];
  freezeHeader: boolean;
  autoFilter: boolean;
}

function normaliseSheet(sheet: SheetSpec): NormalisedSheet {
  const columns = sheet.columns.slice(0, MAX_COLUMNS);
  return {
    name: sheet.name,
    columns,
    rows: sheet.rows,
    freezeHeader: sheet.freezeHeader ?? true,
    autoFilter: sheet.autoFilter ?? sheet.rows.length > 0,
  };
}

/* ------------------------------------------------------------------ sheets -- */

function sheetXml(sheet: NormalisedSheet): string {
  const rowCount = sheet.rows.length + 1;
  const lastColumn = columnName(Math.max(1, sheet.columns.length));
  const dimension = `A1:${lastColumn}${rowCount}`;

  const parts: string[] = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    `<dimension ref="${dimension}"/>`,
    '<sheetViews><sheetView workbookViewId="0">',
  ];

  if (sheet.freezeHeader) {
    parts.push('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>');
    parts.push('<selection pane="bottomLeft" activeCell="A2" sqref="A2"/>');
  } else {
    parts.push('<selection activeCell="A1" sqref="A1"/>');
  }
  parts.push('</sheetView></sheetViews>', '<sheetFormatPr defaultRowHeight="15"/>');

  const widths = sheet.columns
    .map((column, index) => ({ index, width: column.width }))
    .filter((entry): entry is { index: number; width: number } => typeof entry.width === 'number' && entry.width > 0);
  if (widths.length > 0) {
    parts.push('<cols>');
    for (const { index, width } of widths) {
      parts.push(`<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`);
    }
    parts.push('</cols>');
  }

  parts.push('<sheetData>');
  // Header row.
  parts.push(`<row r="1" ht="18" customHeight="1">`);
  sheet.columns.forEach((column, index) => {
    const ref = `${columnName(index + 1)}1`;
    parts.push(inlineStringCell(ref, column.header, STYLE.header));
  });
  parts.push('</row>');

  sheet.rows.forEach((row, rowIndex) => {
    const excelRow = rowIndex + 2;
    parts.push(`<row r="${excelRow}">`);
    sheet.columns.forEach((column, columnIndex) => {
      const value = row[columnIndex];
      if (value === null || value === undefined || value === '') return;
      const ref = `${columnName(columnIndex + 1)}${excelRow}`;
      parts.push(cellXml(ref, value, styleFor(column, value)));
    });
    parts.push('</row>');
  });
  parts.push('</sheetData>');

  if (sheet.autoFilter && sheet.columns.length > 0) {
    parts.push(`<autoFilter ref="A1:${lastColumn}${rowCount}"/>`);
  }
  parts.push('</worksheet>');
  return parts.join('');
}

/**
 * Picks the cell style.
 *
 * A numeric column that actually holds a string (a note filed in the temperature
 * column, say) falls back to a text style: a number format on a string cell makes
 * Excel render the raw value oddly and gains nothing.
 */
function styleFor(column: ColumnSpec, value: CellValue): number {
  const isText = typeof value === 'string' || typeof value === 'boolean';
  const isNumeric = typeof value === 'number' && Number.isFinite(value);

  if (column.style === 'wrapped' && !isNumeric) return STYLE.wrapped;
  if (column.style === 'bold' && !isNumeric) return STYLE.bold;
  if (isText || !isNumeric) return STYLE.default;

  switch (column.kind) {
    case 'number':
      return STYLE.decimal1;
    case 'decimal2':
      return STYLE.decimal2;
    case 'integer':
      return STYLE.integer;
    default:
      return STYLE.default;
  }
}

export function cellXml(ref: string, value: CellValue, style: number): string {
  const styleAttribute = style === STYLE.default ? '' : ` s="${style}"`;

  if (typeof value === 'boolean') {
    return `<c r="${ref}"${styleAttribute} t="b"><v>${value ? 1 : 0}</v></c>`;
  }
  if (typeof value === 'number') {
    // Non-finite numbers cannot be represented in SpreadsheetML at all, so they
    // are degraded to text rather than emitting an invalid value element.
    if (Number.isFinite(value)) return `<c r="${ref}"${styleAttribute}><v>${value}</v></c>`;
    return inlineStringCell(ref, String(value), style);
  }
  // Nullish cells are normally skipped by the caller; this keeps the function
  // total for direct use in tests.
  if (value === null || value === undefined) return '';
  return inlineStringCell(ref, value, style);
}

function inlineStringCell(ref: string, value: string, style: number): string {
  const styleAttribute = style === STYLE.default ? '' : ` s="${style}"`;
  return `<c r="${ref}"${styleAttribute} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

/* ------------------------------------------------------------- fixed parts -- */

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="3">
<numFmt numFmtId="${NUMBER_FORMAT_IDS.decimal1}" formatCode="#,##0.0"/>
<numFmt numFmtId="${NUMBER_FORMAT_IDS.decimal2}" formatCode="#,##0.00"/>
<numFmt numFmtId="${NUMBER_FORMAT_IDS.integer}" formatCode="#,##0"/>
</numFmts>
<fonts count="3">
<font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>
<font><b/><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>
<font><b/><sz val="11"/><color rgb="FF1F3864"/><name val="Calibri"/><family val="2"/></font>
</fonts>
<fills count="3">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFD9E1F2"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left/><right/><top/><bottom style="thin"><color rgb="FF8EA9DB"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="7">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="${NUMBER_FORMAT_IDS.decimal1}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="${NUMBER_FORMAT_IDS.decimal2}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="${NUMBER_FORMAT_IDS.integer}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
<dxfs count="0"/>
<tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>
</styleSheet>`;

function contentTypesXml(sheetCount: number): string {
  const sheetOverrides = Array.from(
    { length: sheetCount },
    (_, index) =>
      `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
  ).join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
${sheetOverrides}
</Types>`;
}

function rootRelationshipsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
}

function workbookXml(sheets: readonly NormalisedSheet[]): string {
  const entries = sheets
    .map((sheet, index) => `<sheet name="${escapeXmlAttribute(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
    .join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<fileVersion appName="xl" lastEdited="5" lowestEdited="5" rupBuild="9303"/>
<workbookPr/>
<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="24000" windowHeight="12000"/></bookViews>
<sheets>${entries}</sheets>
<calcPr calcId="124519" fullCalcOnLoad="1"/>
</workbook>`;
}

function workbookRelationshipsXml(sheetCount: number): string {
  const sheets = Array.from(
    { length: sheetCount },
    (_, index) =>
      `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
  ).join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets}
<Relationship Id="rId${sheetCount + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
}

function corePropertiesXml(options: { title?: string | undefined; creator: string; createdAt: Date }): string {
  const stamp = options.createdAt.toISOString();
  const title = options.title === undefined ? '' : `<dc:title>${escapeXml(options.title)}</dc:title>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:creator>${escapeXml(options.creator)}</dc:creator>
<cp:lastModifiedBy>${escapeXml(options.creator)}</cp:lastModifiedBy>
<dcterms:created xsi:type="dcterms:W3CDTF">${stamp}</dcterms:created>
<dcterms:modified xsi:type="dcterms:W3CDTF">${stamp}</dcterms:modified>
${title}
</cp:coreProperties>`;
}

function appPropertiesXml(sheetNames: readonly string[]): string {
  const titles = sheetNames.map((name) => `<vt:lpstr>${escapeXml(name)}</vt:lpstr>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
<Application>open-meteo-mcp</Application>
<DocSecurity>0</DocSecurity>
<ScaleCrop>false</ScaleCrop>
<HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant><vt:i4>${sheetNames.length}</vt:i4></vt:variant></vt:vector></HeadingPairs>
<TitlesOfParts><vt:vector size="${sheetNames.length}" baseType="lpstr">${titles}</vt:vector></TitlesOfParts>
<Company></Company>
<LinksUpToDate>false</LinksUpToDate>
<SharedDoc>false</SharedDoc>
<HyperlinksChanged>false</HyperlinksChanged>
<AppVersion>16.0300</AppVersion>
</Properties>`;
}

/* ----------------------------------------------------------------- helpers -- */

/** 1 -> "A", 27 -> "AA". */
export function columnName(index: number): string {
  if (!Number.isInteger(index) || index < 1) throw new Error(`invalid column index: ${String(index)}`);
  let remaining = index;
  let name = '';
  while (remaining > 0) {
    const remainder = (remaining - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return name;
}

/**
 * Makes a sheet name legal.
 *
 * Excel rejects `[]:*?/\`, ignores leading/trailing apostrophes, and refuses
 * names longer than 31 characters — a dataset title used verbatim would produce a
 * workbook that will not open. Duplicates are suffixed because a workbook with two
 * identically named sheets is equally unopenable.
 */
export function sanitiseSheetName(name: string, taken: ReadonlySet<string> = new Set()): string {
  const cleaned = name
    .replace(/[[\]:*?/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^'+|'+$/g, '')
    .slice(0, SHEET_NAME_MAX)
    .trim();

  const base = cleaned === '' ? 'Sheet' : cleaned;
  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const truncated = base.slice(0, SHEET_NAME_MAX - String(suffix).length - 1);
    const candidate = `${truncated} ${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return base.slice(0, SHEET_NAME_MAX - 4) + Date.now().toString(36).slice(-3);
}

/**
 * Escapes text for XML content and strips characters XML 1.0 cannot represent.
 *
 * Weather notes come from an agent and are free text; a stray control character
 * or an unpaired surrogate would make the whole workbook invalid, so they are
 * dropped here rather than corrupting the file.
 */
export function escapeXml(value: string): string {
  return stripInvalidXmlChars(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeXmlAttribute(value: string): string {
  return escapeXml(value).replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function stripInvalidXmlChars(value: string): string {
  return value
    // XML 1.0 allows tab, LF, CR and #x20+, and forbids most C0/C1 controls.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u0084\u0086-\u009F\uFFFE\uFFFF]/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}
