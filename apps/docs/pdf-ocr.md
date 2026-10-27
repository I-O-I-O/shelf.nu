# PDF OCR fallback

PDF imports try the built-in text extractor and PDF.js first. If neither finds
readable text, Shelf renders PDF pages and runs Tesseract OCR. Recovered text
continues through the same supplier detection, line-item analysis, validation,
and staff review flow as extracted text. OCR fragments are never imported as
inventory rows directly.

## Runtime requirements

The server needs Tesseract plus its English and Swedish trained data. The app's
Docker release images install these Debian packages:

```sh
apt-get install tesseract-ocr tesseract-ocr-eng tesseract-ocr-swe
```

For local development on Debian or Ubuntu, install the same packages. On
macOS, install Tesseract with Homebrew and verify that both language models are
listed by `tesseract --list-langs`. Set `TESSDATA_PREFIX` if the trained data
is in a nonstandard directory. Set `IOIO_TESSERACT_BINARY` if the executable
is not named `tesseract` on `PATH`.

The app checks the executable and both language models before OCR. If they are
not available, PDF import returns: “This PDF requires OCR before it can be
analyzed.” No system OCR binary is invoked silently.

## Rendering and limits

PDF.js renders each page to a PNG with `@napi-rs/canvas`. Tesseract processes
one page image at a time with the combined `eng+swe` language mode and TSV
output. Shelf reconstructs page text from the OCR words and retains their
bounding boxes internally for vendor table parsing; coordinates are not added
to the Claude helper contract. Page images are written with private
permissions to a temporary directory and removed in `finally` cleanup.

OCR is limited to 20 pages per document, 4,000 pixels per image dimension, and
16 megapixels per rendered page. A document has a 120-second OCR deadline, a
page has a 15-second OCR timeout, at most two documents run OCR concurrently,
and up to four more wait for a slot. Oversized or timed-out documents fail
closed instead of returning partial proposals.

The OCR engine only produces page text. Existing Mouser parsing or generic
Claude analysis then groups commercial items, and Shelf validates the result
before review.
