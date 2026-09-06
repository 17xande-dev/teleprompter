// Command teleprompter-server serves the teleprompter frontend and a
// WebSocket endpoint that relays WebRTC signaling (SDP offers/answers and
// ICE candidates) between one controller and any number of viewers in a
// room. The server never inspects scroll/content data; peers exchange it
// directly over WebRTC data channels once signaling completes.
package main

import (
	"embed"
	"io/fs"
	"log"
	"net/http"
	"time"
)

//go:embed all:dist
var distFS embed.FS

func frontendHandler() http.Handler {
	sub, err := fs.Sub(distFS, "dist")
	if err != nil {
		log.Fatalf("frontend: %v", err)
	}
	return http.FileServer(http.FS(sub))
}

// securityHeaders sets a CSP appropriate for a same-origin, no-third-party-
// script app: the frontend is entirely self-hosted, and WebRTC's SDP/ICE
// signaling flows over the same-origin WebSocket ('self' already covers
// ws/wss to the page's own origin), while the data channels themselves are
// peer-to-peer and outside the CSP's remit.
func securityHeaders(next http.Handler) http.Handler {
	const csp = "default-src 'self'; " +
		"script-src 'self'; " +
		"style-src 'self'; " +
		"connect-src 'self'; " +
		"img-src 'self'; " +
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
	h := newHub()

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", h.serveWS)
	mux.HandleFunc("/ice", handleICE)
	mux.Handle("/", frontendHandler())

	srv := &http.Server{
		Addr:              ":8080",
		Handler:           securityHeaders(mux),
		ReadHeaderTimeout: 10 * time.Second,
	}

	log.Println("listening on http://localhost:8080")
	if err := srv.ListenAndServe(); err != nil {
		log.Fatal(err)
	}
}
