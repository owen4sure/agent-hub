import { test } from "node:test";
import assert from "node:assert/strict";
import { renderPdfToImages, selectPdfPageNumbers } from "./pdfRender";

/** 不依賴外部工具，組一份最小的一頁 PDF，專門回歸 PDF.js 升級後的真實瀏覽器渲染。 */
function minimalPdf(): Buffer {
  const stream = "BT /F1 24 Tf 72 720 Td (PDF LOGIC 842) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, body] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "ascii");
}

test("PDF 視覺理解：修補版 PDF.js 能把真實 PDF 渲染成圖片", async () => {
  const images = await renderPdfToImages(minimalPdf(), 1);
  assert.equal(images.length, 1);
  assert.equal(images[0].page, 1);
  assert.ok(Buffer.from(images[0].b64, "base64").length > 1_000);
});

test("PDF 視覺理解：長文件保留前後頁，不會永遠只看開頭", () => {
  assert.deepEqual(selectPdfPageNumbers(20, 4), [1, 2, 19, 20]);
  assert.deepEqual(selectPdfPageNumbers(3, 4), [1, 2, 3]);
});
