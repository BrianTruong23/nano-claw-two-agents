---
name: document-processing
description: Create, read, edit, and convert PDF, DOCX, and XLSX files. Use when the user asks to generate documents, extract text, convert formats, or work with spreadsheets.
---

# Document Processing

Use globally installed npm packages for PDF, DOCX, and XLSX.

## Libraries

- **pdf-lib** -- create/edit PDFs (pages, text, images, merge)
- **pdf-parse** -- extract text from PDFs
- **docx** -- create DOCX (paragraphs, tables, images)
- **mammoth** -- read DOCX, convert to HTML/text
- **exceljs** -- read/write XLSX (cells, formulas, styling)

## Quick Start Patterns

### Read a PDF

```javascript
const fs = require('fs');
const pdf = require('pdf-parse');
const buf = fs.readFileSync('/workspace/common/input.pdf');
const data = await pdf(buf);
console.log(data.text);
```

### Create a PDF

```javascript
const { PDFDocument, StandardFonts } = require('pdf-lib');
const doc = await PDFDocument.create();
const page = doc.addPage();
const font = await doc.embedFont(StandardFonts.Helvetica);
page.drawText('Hello World', { x: 50, y: 700, font, size: 24 });
const bytes = await doc.save();
require('fs').writeFileSync('/workspace/common/output.pdf', bytes);
```

### Read a DOCX

```javascript
const mammoth = require('mammoth');
const result = await mammoth.extractRawText({ path: '/workspace/common/doc.docx' });
console.log(result.value);
```

### Create a DOCX

```javascript
const { Document, Packer, Paragraph } = require('docx');
const doc = new Document({ sections: [{ children: [new Paragraph('Hello')] }] });
const buf = await Packer.toBuffer(doc);
require('fs').writeFileSync('/workspace/common/out.docx', buf);
```

### Read/Write XLSX

```javascript
const ExcelJS = require('exceljs');
const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile('/workspace/common/data.xlsx');
const ws = wb.getWorksheet(1);
ws.getCell('A1').value = 'Updated';
await wb.xlsx.writeFile('/workspace/common/data.xlsx');
```

## Pitfalls

- Run code as `node -e "..."` or save a script with `workspace-write` then `node /path/to/script.js`. Wrap in async IIFE: `(async()=>{...})()`.
- pdf-lib cannot extract text -- use pdf-parse for reading, pdf-lib for creating/editing.
- ExcelJS formula recalc needs `wb.calcProperties = { fullCalcOnLoad: true }`.
- File paths must be absolute (`/workspace/common/...`).
