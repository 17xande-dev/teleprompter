// Command teleprompter-server serves the teleprompter frontend and a
// WebSocket endpoint that relays WebRTC signaling (SDP offers/answers and
// ICE candidates) between one controller and any number of viewers in a
// room. The server never inspects scroll/content data; peers exchange it
// directly over WebRTC data channels once signaling completes.
package main

import (
	"embed"
	"flag"
	"io/fs"
	"log"
	"net/http"
	"os"
	"time"
)

//go:embed all:dist
var distFS embed.FS

// frontendHandler serves the built frontend. Embedding happens at compile
// time, so a release binary is self-contained — but that also means a
// rebundle is invisible to a running server. In dev, read dist/ from disk
// instead so `deno task bundle-watch` output shows up on a page refresh
// rather than needing the Go process restarted.
func frontendFS(dev bool) fs.FS {
	if dev {
		log.Println("serving frontend from ./dist on disk (dev mode)")
		return os.DirFS("dist")
	}

	sub, err := fs.Sub(distFS, "dist")
	if err != nil {
		log.Fatalf("frontend: %v", err)
	}
	if entries, err := fs.ReadDir(sub, "."); err == nil && len(entries) <= 1 {
		log.Println("warning: embedded frontend looks empty — run `deno task build` before `go build`")
	}
	return sub
}

// pageHandler serves one of the two HTML entry points at a clean path.
//
// The two pages are /control and /viewer rather than /index.html and the
// bundler's own output path, because the viewer URL is typed by hand, read off
// a QR code and sent to people — and because a display's address is part of
// the setup an operator has to explain to someone else.
//
// It serves the file rather than redirecting to it so the clean path is the
// one that stays in the address bar. That is what makes the *relative* asset
// references in the built HTML work: deno bundle emits `./index-<hash>.js`,
// which resolves against the directory of the current URL, so a single-segment
// path like /control resolves it to /index-<hash>.js at the root. Both entries
// are bundled to the dist root for exactly this reason — the viewer used to
// live in dist/html/, where the same reference would have resolved to
// /viewer-<hash>.js and 404'd. A trailing slash would break it the same way,
// which is why both routes are exact patterns.
//
// ServeFileFS, not the file server this wraps elsewhere: http.FileServer
// canonicalises a request for ".../index.html" by redirecting to "./", so
// handing it the control page's filename sent /control to /, which this file
// redirects back to /control — a loop, found the first time the route was
// exercised. ServeFileFS passes redirect=false and does no such rewriting.
func pageHandler(fsys fs.FS, name string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.ServeFileFS(w, r, fsys, name)
	})
}

// securityHeaders sets a CSP appropriate for a same-origin app: no
// third-party *script* is ever loaded, and WebRTC's SDP/ICE signaling flows
// over the same-origin WebSocket ('self' already covers ws/wss to the
// page's own origin), while the data channels themselves are peer-to-peer
// and outside the CSP's remit.
//
// style-src needs 'unsafe-inline' and connect-src/img-src need the
// fontawesome CDN because the Web Awesome component library (predates this
// change) applies inline styles and fetches its icon SVGs remotely at
// runtime — neither is under this app's control without replacing that
// library. Recorded as a deliberate trade-off, not an oversight.
//
// script-src needs 'wasm-unsafe-eval' for pdf.js, whose image decoders and
// colour management are WebAssembly; Chromium refuses WebAssembly.instantiate
// under a bare script-src 'self'. It does *not* need any blob: relaxation:
// pdf.js only falls back to its blob: worker wrapper when workerSrc is
// cross-origin, and /pdfworker.js is served from here — which is precisely
// why the worker gets its own un-hashed bundle output (see deno.jsonc).
func securityHeaders(next http.Handler) http.Handler {
	const csp = "default-src 'self'; " +
		"script-src 'self' 'wasm-unsafe-eval'; " +
		"style-src 'self' 'unsafe-inline'; " +
		"connect-src 'self' https://ka-f.fontawesome.com data:; " +
		"img-src 'self' data:; " +
		"object-src 'none'; " +
		"base-uri 'none'; " +
		"frame-ancestors 'self'"

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", csp)
		w.Header().Set("X-Content-Type-Options", "nosniff")
		next.ServeHTTP(w, r)
	})
}

func main() {
	dev := flag.Bool("dev", false, "serve the frontend from ./dist on disk instead of the embedded copy")
	addr := flag.String("addr", ":8080", "address to listen on")
	flag.Parse()

	h := newHub()

	feFS := frontendFS(*dev)
	fe := http.FileServer(http.FS(feFS))

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", h.serveWS)
	mux.HandleFunc("/ice", handleICE)
	// The two pages, at paths worth typing. Exact patterns, so they do not
	// shadow the hashed assets the file server below still has to serve.
	mux.Handle("/control", pageHandler(feFS, "index.html"))
	mux.Handle("/viewer", pageHandler(feFS, "viewer.html"))
	// The bare root is where a browser lands when someone types the host, and
	// where every existing bookmark points. Redirected rather than served, so
	// there is one address for the control page rather than two that drift.
	mux.HandleFunc("/{$}", func(w http.ResponseWriter, r *http.Request) {
		target := "/control"
		if q := r.URL.RawQuery; q != "" {
			target += "?" + q
		}
		http.Redirect(w, r, target, http.StatusFound)
	})
	mux.Handle("/", fe)

	srv := &http.Server{
		Addr:              *addr,
		Handler:           securityHeaders(mux),
		ReadHeaderTimeout: 10 * time.Second,
	}

	log.Printf("listening on http://localhost%s", *addr)
	if err := srv.ListenAndServe(); err != nil {
		log.Fatal(err)
	}
}
