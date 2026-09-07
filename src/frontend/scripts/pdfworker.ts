// Bundle entry for pdf.js's worker, built on its own (see the
// "bundle-pdfworker" task) so it lands at the un-hashed /pdfworker.js that
// GlobalWorkerOptions.workerSrc points at. Loading it same-origin also keeps
// it inside the CSP: pdf.js only reaches for its blob: CDN wrapper when
// workerSrc is cross-origin, and default-src 'self' would refuse that.
import "pdfjs-dist/build/pdf.worker.mjs";
