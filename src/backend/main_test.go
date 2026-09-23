package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// csp runs one request through the middleware and returns the policy. dev is
// the server's -dev flag, which only frame-ancestors reads.
func csp(t *testing.T, dev bool) string {
	t.Helper()
	h := securityHeaders(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}), dev)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/control", nil))
	got := rec.Header().Get("Content-Security-Policy")
	if got == "" {
		t.Fatal("no Content-Security-Policy header was set")
	}
	return got
}

// directive returns the sources of one CSP directive, e.g. "script-src".
func directive(t *testing.T, policy, name string) string {
	t.Helper()
	for _, part := range strings.Split(policy, ";") {
		part = strings.TrimSpace(part)
		if after, ok := strings.CutPrefix(part, name+" "); ok {
			return after
		}
	}
	t.Fatalf("policy has no %s directive: %s", name, policy)
	return ""
}

// Cloudflare *injects* its analytics beacon into the HTML in front of this
// server, so the page requests a script this code never wrote. Refused, it
// logged a violation on every load and collected nothing — and the two hosts
// are easy to drop when someone tightens this policy later, because nothing
// in this repo references them and no other test would notice.
func TestCSPAdmitsTheAnalyticsBeacon(t *testing.T) {
	policy := csp(t, false)

	script := directive(t, policy, "script-src")
	if !strings.Contains(script, "https://static.cloudflareinsights.com") {
		t.Errorf("script-src must admit the beacon's host, got %q", script)
	}
	// The beacon reports to cloudflareinsights.com/cdn-cgi/rum, which is a
	// different host from the one it is served by: allowing only the script
	// leaves it loading and then failing to report, which looks like working
	// analytics right up until the dashboard stays empty.
	connect := directive(t, policy, "connect-src")
	if !strings.Contains(connect, "https://cloudflareinsights.com") {
		t.Errorf("connect-src must admit the beacon's reporting host, got %q", connect)
	}
}

// The relaxation above is one host in one directive. These are the properties
// that make it affordable, and they are worth failing over if they go.
func TestCSPStaysTightElsewhere(t *testing.T) {
	policy := csp(t, false)

	script := directive(t, policy, "script-src")
	// The pages render HTML pasted from Word and Google Docs (editor) and
	// pushed over a data channel (viewer). Neither can introduce a script
	// while these two are absent.
	for _, forbidden := range []string{"'unsafe-inline'", "'unsafe-eval'"} {
		if strings.Contains(script, forbidden) {
			t.Errorf("script-src must not carry %s, got %q", forbidden, script)
		}
	}
	// pdf.js's decoders are WebAssembly; Chromium refuses them under a bare
	// script-src 'self'. Not the same thing as 'unsafe-eval'.
	if !strings.Contains(script, "'wasm-unsafe-eval'") {
		t.Errorf("script-src must keep 'wasm-unsafe-eval' for pdf.js, got %q", script)
	}
	// No blob: relaxation: pdf.js only reaches for its blob: worker wrapper
	// when workerSrc is cross-origin, and /pdfworker.js is served from here.
	if strings.Contains(script, "blob:") {
		t.Errorf("script-src must not allow blob:, got %q", script)
	}

	for _, want := range []string{
		"default-src 'self'",
		"object-src 'none'",
		"base-uri 'none'",
		"frame-ancestors 'self'",
	} {
		if !strings.Contains(policy, want) {
			t.Errorf("policy lost %q: %s", want, policy)
		}
	}
}

// The marketing site's live demo is a pair of iframes pointed at /control and
// /viewer, and the only thing that permits them is this directive. A framing
// refusal never reaches this server's logs — it appears in the *framing*
// page's console — so nothing else would notice this being tightened back.
func TestCSPLetsTheMarketingSiteFrameTheApp(t *testing.T) {
	ancestors := directive(t, csp(t, false), "frame-ancestors")

	// 'self' stays: the control page frames /viewer as its own preview pane.
	if !strings.Contains(ancestors, "'self'") {
		t.Errorf("frame-ancestors must keep 'self' for the preview iframe, got %q", ancestors)
	}
	if !strings.Contains(ancestors, "https://17xande.dev ") &&
		!strings.HasSuffix(ancestors, "https://17xande.dev") {
		t.Errorf("frame-ancestors must admit the marketing site, got %q", ancestors)
	}
	// localhost belongs to -dev alone.
	if strings.Contains(ancestors, "localhost") {
		t.Errorf("frame-ancestors must not admit localhost without -dev, got %q", ancestors)
	}
}

// -dev is what lets the site's own dev server frame a local app. Its port
// moves, hence the wildcard; it must never reach the deployed policy.
func TestCSPAdmitsLocalhostOnlyInDev(t *testing.T) {
	ancestors := directive(t, csp(t, true), "frame-ancestors")

	for _, want := range []string{"http://localhost:*", "http://127.0.0.1:*"} {
		if !strings.Contains(ancestors, want) {
			t.Errorf("-dev frame-ancestors must admit %s, got %q", want, ancestors)
		}
	}
}

func TestSecurityHeadersSetNosniff(t *testing.T) {
	h := securityHeaders(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}), false)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/viewer", nil))
	if got := rec.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Errorf("X-Content-Type-Options = %q, want nosniff", got)
	}
}
