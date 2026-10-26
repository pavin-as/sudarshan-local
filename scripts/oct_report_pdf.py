"""Text of one IMAGEnet thickness report saved as PDF (D-050 check, docs/OCT_PLAN.md Step 7).

Run by `node dist/cli.js oct-report-check <file.pdf>` in the isolated Python on shichika:
  D:\\Sudarshan\\tools\\oct-venv\\Scripts\\python.exe -I scripts\\oct_report_pdf.py <file.pdf>
Prints one JSON line for the CLI only: pages, images per page, the PDF's producer and the selectable text. The text
names the patient, so the CLI keeps it in memory and prints only checks and measurements. Writes nothing.
"""
import json
import sys

from pypdf import PdfReader


def main(path: str) -> None:
    reader = PdfReader(path)
    if reader.is_encrypted:
        reader.decrypt("")
    pages, texts = [], []
    for page in reader.pages:
        text = page.extract_text() or ""
        try:
            images = len(page.images)
        except Exception:
            images = None
        pages.append({"chars": len(text.strip()), "images": images})
        texts.append(text)
    meta = reader.metadata or {}
    print(json.dumps({"pages": pages, "producer": str(meta.get("/Producer") or ""), "creator": str(meta.get("/Creator") or ""),
                      "text": "\n".join(texts)}, ensure_ascii=False))


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: oct_report_pdf.py <file.pdf>")
    main(sys.argv[1])
