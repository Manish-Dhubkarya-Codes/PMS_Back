var express = require('express');
var router = express.Router();
const latex = require('node-latex');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

router.get('/', function (req, res, next) {
  res.send('respond with a resource');
});

const latexToPdf = (latexCode) =>
  new Promise((resolve, reject) => {
    const output = latex(latexCode, { cmd: 'pdflatex', passes: 2 });
    let data = Buffer.alloc(0);
    output.on('data', (chunk) => { data = Buffer.concat([data, chunk]); });
    output.on('error', reject);
    output.on('end', () => resolve(data));
  });

const latexToDocx = async (latexCode) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'latex-docx-'));
  const inputPath = path.join(tempDir, 'input.tex');
  const outputPath = path.join(tempDir, 'output.docx');
  try {
    fs.writeFileSync(inputPath, latexCode, 'utf8');
    await execAsync(
      `pandoc --from=latex --to=docx --standalone "${inputPath}" -o "${outputPath}"`,
      { timeout: 30_000, maxBuffer: 20 * 1024 * 1024 }
    );
    const buffer = fs.readFileSync(outputPath);
    return { buffer, tempDir };
  } catch (err) {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
    throw err;
  }
};

const docxToPdf = async (docxBuffer) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-pdf-'));
  const docxPath = path.join(tempDir, 'input.docx');
  const pdfPath = path.join(tempDir, 'input.pdf');
  try {
    fs.writeFileSync(docxPath, docxBuffer);
    await execAsync(
      `soffice --headless --convert-to pdf --outdir "${tempDir}" "${docxPath}"`,
      { timeout: 60_000, maxBuffer: 50 * 1024 * 1024 }
    );
    return fs.readFileSync(pdfPath);
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  }
};

router.post('/compile-latex', async (req, res) => {
  const { latexCode, format = 'pdf' } = req.body;

  if (!latexCode || typeof latexCode !== 'string') {
    return res.status(400).json({ status: false, message: 'Valid LaTeX code string is required' });
  }

  // IMPORTANT: this list MUST include 'docx-preview'
  if (!['pdf', 'docx', 'docx-preview'].includes(format)) {
    return res.status(400).json({ status: false, message: `Invalid format: ${format}` });
  }

  try {
    if (format === 'pdf') {
      const pdfBuffer = await latexToPdf(latexCode);
      res.set({
        'Content-Type': 'application/pdf',
        'Content-Length': pdfBuffer.length,
      });
      return res.send(pdfBuffer);
    }

    if (format === 'docx') {
      const { buffer, tempDir } = await latexToDocx(latexCode);
      res.set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Length': buffer.length,
        'Content-Disposition': 'inline; filename="document.docx"',
      });
      res.send(buffer);
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
      return;
    }

    // docx-preview: latex → docx (pandoc) → pdf (libreoffice) → return pdf
    const { buffer: docxBuffer, tempDir } = await latexToDocx(latexCode);
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
    const previewPdf = await docxToPdf(docxBuffer);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Length': previewPdf.length,
    });
    return res.send(previewPdf);
  } catch (error) {
    console.error(`Compilation error (${format}):`, error);
    if (!res.headersSent) {
      res.status(500).json({
        status: false,
        message: `Failed to compile LaTeX (${format})`,
        error: error.message,
      });
    }
  }
});

module.exports = router;