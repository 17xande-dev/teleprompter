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
	"time"
)

//go:embed all:dist
var distFS embed.FS

// frontendHandler serves the built frontend. Embedding happens at compile
// time, so a release binary is self-contained — but that also means a
// rebundle is invisible to a running server. In dev, read dist/ from disk
// instead so `deno task bundle-watch` output shows up on a page refresh
// rather than needing the Go process restarted.
func frontendHandler(dev bool) http.Handler {
	if dev {
		log.Println("serving frontend from ./dist on disk (dev mode)")
		return http.FileServer(http.Dir("dist"))
	}

	sub, err := fs.Sub(distFS, "dist")
	if err != nil {
		log.Fatalf("frontend: %v", err)
	}
	if entries, err := fs.ReadDir(sub, "."); err == nil && len(entries) <= 1 {
		log.Println("warning: embedded frontend looks empty — run `deno task build` before `go build`")
	}
	return http.FileServer(http.FS(sub))
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
func securityHeaders(next http.Handler) http.Handler {
	const csp = "default-src 'self'; " +
		"script-src 'self'; " +
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

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", h.serveWS)
	mux.HandleFunc("/ice", handleICE)
	mux.Handle("/", frontendHandler(*dev))

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
