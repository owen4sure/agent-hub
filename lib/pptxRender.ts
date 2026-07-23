import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { renderPdfToImages, type RenderedPdfPage } from "./pdfRender";

const execFileAsync = promisify(execFile);

/**
 * A PPTX's XML text cannot describe its real slide layout.  Convert it in an
 * isolated, throw-away LibreOffice profile, then reuse our network-blocked PDF
 * renderer.  Failure intentionally falls back to text extraction: uploading a
 * document must never block the chat just because this optional visual pass is
 * unavailable on a machine.
 */
export async function renderPptxToImages(buffer: Buffer, maxPages = 4): Promise<RenderedPdfPage[]> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hub-pptx-"));
  try {
    const source = path.join(dir, "presentation.pptx");
    const profile = path.join(dir, "profile");
    await fs.mkdir(profile, { recursive: true });
    await fs.writeFile(source, buffer, { mode: 0o600 });
    // LibreOffice discovers soffice from PATH.  The app installer / doctor is
    // responsible for installing it; no network or browser session is used.
    await execFileAsync("soffice", [
      "--headless", "--safe-mode", "--nologo", "--nodefault", "--nolockcheck", "--nofirststartwizard", "--norestore",
      `-env:UserInstallation=${new URL(`file://${profile}/`).href}`,
      "--convert-to", "pdf:impress_pdf_Export",
      "--outdir", dir,
      source,
    ], { timeout: 45_000, maxBuffer: 1024 * 1024 });
    const pdf = await fs.readFile(path.join(dir, "presentation.pdf"));
    return await renderPdfToImages(pdf, maxPages);
  } catch {
    return [];
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
